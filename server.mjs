/* NEARnest site: static page plus JSON endpoints. No dependencies.
     /api/scan    live mainnet venues judged by the policy (cached 10 min)
     /api/vault   live read of the deployed vault: keys, balances, venues, positions
     /api/drill   recorded compromised-agent drill with transaction links
     /api/plan    the move the agent would make next (read only, nothing is signed)
     /api/agent   moves the agent made, with the policy reasons and transaction links
     /api/scenario?id=  a what-if event run through the same policy and planner (read only)
   Only public account ids are read here (demo/deployment-*.json); keys never ship. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readInputs, judgeInputs } from './agent/report.mjs';
import { SCENARIOS, scenario, scenarioMeta } from './agent/scenarios.mjs';
import { planMoves, spendableNative, cooldownLeft, stepJSON } from './agent/plan.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const PUB = path.join(DIR, 'public');
const PORT = Number(process.env.PORT || 8787);
const NET = process.env.NEARNEST_NETWORK || 'testnet';
const RPC = { testnet: 'https://rpc.testnet.fastnear.com', mainnet: 'https://free.rpc.fastnear.com' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function query(net, params) {
  const r = await fetch(RPC[net], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return j.result;
}
const view = async (net, c, m, a = {}) => JSON.parse(Buffer.from((await query(net, { request_type: 'call_function', account_id: c, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') })).result).toString());

async function vaultSnapshot(net) {
  const dep = JSON.parse(await readFile(path.join(DIR, 'demo', `deployment-${net}.json`), 'utf8'));
  const [keys, acct, vault, venues] = await Promise.all([
    query(net, { request_type: 'view_access_key_list', account_id: dep.vault }),
    query(net, { request_type: 'view_account', account_id: dep.vault }),
    view(net, dep.vault, 'get_vault'),
    view(net, dep.vault, 'get_venues'),
  ]);
  const balances = {};
  for (const t of [...new Set(venues.map((v) => v.venue.token).filter((t) => t !== 'near'))]) {
    balances[t] = await view(net, t, 'ft_balance_of', { account_id: dep.vault }).catch(() => null);
  }
  // Unstaked NEAR is claimable once the staking venue says so.
  for (const v of venues) {
    if (v.venue.kind === 'LiquidStake' && BigInt(v.unbonding ?? 0) > 0n) {
      v.claimable = !!(await view(net, v.venue.contract, 'get_account', { account_id: dep.vault }).catch(() => null))?.can_withdraw;
    }
  }
  const lending = {};
  for (const c of [...new Set(venues.filter((v) => v.venue.kind === 'LendingFt').map((v) => v.venue.contract))]) {
    lending[c] = await view(net, c, 'get_account', { account_id: dep.vault }).catch(() => null);
  }
  return {
    network: net, read_at: new Date().toISOString(), deployment: dep,
    access_keys: keys.keys, native_yocto: acct.amount, locked_yocto: acct.locked, code_hash: acct.code_hash, storage_usage: acct.storage_usage,
    vault, venues, balances, lending,
  };
}

const inputs = () => cached('inputs', 600_000, () => readInputs());
const scan = async () => judgeInputs(await inputs());

function idleOf(snap) {
  const idle = { near: spendableNative({ amount: snap.native_yocto, storage_usage: snap.storage_usage }) };
  for (const [t, b] of Object.entries(snap.balances)) idle[t] = BigInt(b ?? 0);
  return idle;
}

/** Live inputs and vault, then the same inputs changed by one scenario: verdicts and plans side by side. */
async function whatIf(net, id) {
  const s = scenario(id);
  if (!s) return null;
  const [base, snap] = await Promise.all([inputs(), cached(`vault-${net}`, 15_000, () => vaultSnapshot(net))]);
  const before = judgeInputs(base);
  const after = judgeInputs(s.apply(base));
  const idle = idleOf(snap);
  const pick = (v) => ({ verdict: v.judgement.verdict, cap: v.judgement.capMult, target: v.target, reasons: v.judgement.reasons });
  return {
    ...scenarioMeta(s), network: net, read_at: snap.read_at, scan_at: before.generated_at,
    venues: before.venues.map((v, k) => ({ id: v.id, label: v.label, symbol: v.symbol, apr: v.live.apr_base, before: pick(v), after: pick(after.venues[k]) })),
    plan_before: planMoves(before, snap.venues, idle).map(stepJSON),
    plan_after: planMoves(after, snap.venues, idle).map(stepJSON),
  };
}

async function nextPlan(net) {
  const [report, snap] = await Promise.all([scan(), cached(`vault-${net}`, 15_000, () => vaultSnapshot(net))]);
  const idle = idleOf(snap);
  const steps = planMoves(report, snap.venues, idle).map(stepJSON);
  return { network: net, read_at: snap.read_at, scan_at: report.generated_at, cooldown_ms: cooldownLeft(snap.vault),
    idle: Object.fromEntries(Object.entries(idle).map(([k, v]) => [k, String(v)])), steps };
}

/* SimpleAnalytics, first-party, as every web3wagmi property runs it (same handler as web3wagmi-tx). /proxy.js is SA's script compiled with this host as its beacon base, and /simple/*
   carries the beacons to SA's queue, so blockers that drop third-party analytics hosts see only
   this origin. Reporting under web3wagmi.com is set by data-hostname in index.html. */
async function analytics(req, res, url) {
  if (url.pathname === '/proxy.js') {
    const r = await fetch('https://simpleanalyticsexternal.com/proxy.js?hostname=' + encodeURIComponent(url.hostname) + '&path=/simple');
    res.writeHead(r.status, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    res.end(Buffer.from(await r.arrayBuffer()));
    return true;
  }
  if (url.pathname.startsWith('/simple/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const h of ['content-type', 'user-agent', 'accept-language', 'referer']) if (req.headers[h]) headers[h] = req.headers[h];
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (ip) headers['x-forwarded-for'] = ip;
    const r = await fetch('https://queue.simpleanalyticscdn.com/' + url.pathname.slice('/simple/'.length) + url.search, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = { 'cache-control': 'no-store' };
    const ct = r.headers.get('content-type');
    if (ct) out['content-type'] = ct;
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
    return true;
  }
  return false;
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (await analytics(req, res, url)) return;
    if (url.pathname === '/api/scan') return send(res, 200, await scan());
    if (url.pathname === '/api/scenarios') return send(res, 200, SCENARIOS.map(scenarioMeta));
    if (url.pathname === '/api/scenario') {
      const r = await whatIf(NET, url.searchParams.get('id'));
      return r ? send(res, 200, r) : send(res, 404, { error: 'unknown scenario', ids: SCENARIOS.map((x) => x.id) });
    }
    if (url.pathname === '/api/vault') return send(res, 200, await cached(`vault-${NET}`, 15_000, () => vaultSnapshot(NET)));
    if (url.pathname === '/api/plan') return send(res, 200, await nextPlan(NET));
    if (url.pathname === '/api/drill') return send(res, 200, await readFile(path.join(DIR, 'demo', `attack-${NET}.json`)));
    if (url.pathname === '/api/agent') return send(res, 200, await readFile(path.join(DIR, 'demo', `agent-${NET}.json`)));
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(PUB, '.' + p);
    if (!file.startsWith(PUB + path.sep)) return send(res, 404, 'Not found', 'text/plain');
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return send(res, 404, await readFile(path.join(PUB, 'index.html')), TYPES['.html']);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=300' });
    res.end(await readFile(file));
  } catch (e) {
    send(res, 502, { error: String(e.message || e).slice(0, 300) });
  }
});
server.listen(PORT, () => console.log(`nearnest on :${PORT} (${NET})`));
