/* NEARnest site: static page plus JSON endpoints. No dependencies.
     /api/scan    live mainnet venues judged by the policy (cached 10 min)
     /api/vault   live read of the deployed vault: keys, balances, venues, positions
     /api/drill   recorded compromised-agent drill with transaction links
     /api/plan    the move the agent would make next (read only, nothing is signed)
     /api/agent   moves the agent made, with the policy reasons and transaction links
     /api/scenario?id=  a what-if event run through the same policy and planner (read only)
     /api/ai            NEAR AI proposals: what the model proposed, what the policy let through, signature checks
     /api/ai/evidence?chat_id=  the exact request and response bytes a proposal's signature covers
     /api/fund/tokens   origins a vault can be funded from through NEAR Intents (1Click), with prices
     /api/fund/quote?asset=&amount=  a dry 1Click quote: that asset on its own chain -> NEAR USDC to the vault
   Only public account ids are read here (demo/deployment-*.json); keys never ship. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readInputs, judgeInputs } from './agent/report.mjs';
import { SCENARIOS, scenario, scenarioMeta } from './agent/scenarios.mjs';
import { planMoves, spendableNative, cooldownLeft, stepJSON } from './agent/plan.mjs';
import * as intents from './agent/intents.mjs';

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

/** ?net=mainnet|testnet. Mainnet is the default once a mainnet vault is deployed. */
const MAINNET_LIVE = await stat(path.join(DIR, 'demo', 'deployment-mainnet.json')).then(() => true, () => false);
const netOf = (url) => (['mainnet', 'testnet'].includes(url.searchParams.get('net')) ? url.searchParams.get('net') : MAINNET_LIVE ? 'mainnet' : NET);
const deployment = async (net) => JSON.parse(await readFile(path.join(DIR, 'demo', `deployment-${net}.json`), 'utf8'));

/** The demo vault, or a vault made by the factory (`<name>.<factory>`). Anything else is refused. */
async function vaultId(net, asked) {
  const dep = await deployment(net);
  if (!asked || asked === dep.vault) return dep.vault;
  if (dep.factory && asked.endsWith(`.${dep.factory}`) && /^[a-z0-9-]{2,32}$/.test(asked.slice(0, -dep.factory.length - 1))) return asked;
  return null;
}

async function vaultSnapshot(net, id) {
  const base = await deployment(net);
  const dep = id && id !== base.vault ? { vault: id, factory: base.factory, feeder: base.feeder, agent_key: base.agent_key } : base;
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
async function whatIf(net, sid, id) {
  const s = scenario(sid);
  if (!s) return null;
  const [base, snap] = await Promise.all([inputs(), cached(`vault-${net}-${id}`, 15_000, () => vaultSnapshot(net, id))]);
  const before = judgeInputs(base);
  const after = judgeInputs(s.apply(base));
  const idle = idleOf(snap);
  const pick = (v) => ({ verdict: v.judgement.verdict, cap: v.judgement.capMult, target: v.target, reasons: v.judgement.reasons });
  return {
    ...scenarioMeta(s), network: net, read_at: snap.read_at, scan_at: before.generated_at,
    venues: before.venues.map((v, k) => ({ id: v.id, label: v.label, symbol: v.symbol, apr: v.live.apr_base, before: pick(v), after: pick(after.venues[k]) })),
    plan_before: planMoves(before, snap.venues, idle, undefined, 'policy', snap.vault).map(stepJSON),
    plan_after: planMoves(after, snap.venues, idle, undefined, 'policy', snap.vault).map(stepJSON),
  };
}

async function factoryInfo(net) {
  const dep = await deployment(net);
  if (!dep.factory) return { network: net, factory: null, vaults: [] };
  const [config, vaults, min] = await Promise.all([
    view(net, dep.factory, 'get_config'), view(net, dep.factory, 'get_vaults', { limit: 200 }), view(net, dep.factory, 'get_min_deposit'),
  ]);
  return { network: net, factory: dep.factory, min_deposit: min, config, vaults: vaults.map(([id, r]) => ({ id, owner: r.owner, created_at: new Date(Number(BigInt(r.created_ns) / 1_000_000n)).toISOString() })) };
}

async function nextPlan(net, id) {
  const [report, snap] = await Promise.all([scan(), cached(`vault-${net}-${id}`, 15_000, () => vaultSnapshot(net, id))]);
  const idle = idleOf(snap);
  const steps = planMoves(report, snap.venues, idle, undefined, 'policy', snap.vault).map(stepJSON);
  return { network: net, read_at: snap.read_at, scan_at: report.generated_at, cooldown_ms: cooldownLeft(snap.vault),
    idle: Object.fromEntries(Object.entries(idle).map(([k, v]) => [k, String(v)])), steps };
}

/** Where Intents deliveries go: the mainnet vault once deployed, else a stand-in mainnet account (dry quotes only). */
async function fundRecipient() {
  const mainnet = process.env.NEARNEST_MAINNET_VAULT || (await deployment('mainnet').catch(() => null))?.vault;
  return mainnet ? { recipient: mainnet, stand_in: false } : { recipient: intents.STAND_IN, stand_in: true };
}

async function fundTokens() {
  const [list, to] = await Promise.all([cached('fund-tokens', 600_000, () => intents.tokens()), fundRecipient()]);
  return { ...to, testnet_vault: (await deployment(NET)).vault, destination: { asset: intents.USDC_ASSET, symbol: 'USDC', chain: 'NEAR' }, tokens: list };
}

async function fundQuote(assetId, amount) {
  const { tokens, recipient, stand_in } = await fundTokens();
  const t = tokens.find((x) => x.assetId === assetId);
  if (!t) return { status: 400, body: { error: 'unknown origin asset' } };
  let raw;
  try { raw = intents.toBaseUnits(amount, t.decimals); } catch (e) { return { status: 400, body: { error: e.message } }; }
  const ready = await cached(`ready-${recipient}`, 600_000, () => intents.recipientReady(recipient));
  if (!ready.ok) return { status: 400, body: { error: ready.reason } };
  try {
    const q = await cached(`quote-${assetId}-${raw}`, 20_000, () => intents.quote({ originAsset: assetId, amount: raw, recipient }));
    return { status: 200, body: { origin: t, recipient, stand_in, dry: true, quoted_at: q.timestamp, quote: q.quote } };
  } catch (e) {
    cache.delete(`quote-${assetId}-${raw}`);
    return { status: 400, body: { error: String(e.message || e).slice(0, 300) } };
  }
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
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  try {
    if (await analytics(req, res, url)) return;
    if (url.pathname === '/api/scan') return send(res, 200, await scan());
    if (url.pathname === '/api/scenarios') return send(res, 200, SCENARIOS.map(scenarioMeta));
    if (url.pathname === '/api/scenario') {
      const net = netOf(url);
      const r = await whatIf(net, url.searchParams.get('id'), (await deployment(net)).vault);
      return r ? send(res, 200, r) : send(res, 404, { error: 'unknown scenario', ids: SCENARIOS.map((x) => x.id) });
    }
    if (url.pathname === '/api/vault' || url.pathname === '/api/plan') {
      const net = netOf(url);
      const id = await vaultId(net, url.searchParams.get('vault'));
      if (!id) return send(res, 404, { error: 'not a NEARnest vault' });
      if (url.pathname === '/api/plan') return send(res, 200, await nextPlan(net, id));
      return send(res, 200, await cached(`vault-${net}-${id}`, 15_000, () => vaultSnapshot(net, id)));
    }
    if (url.pathname === '/api/name') {
      const dep = await deployment(NET);
      const n = url.searchParams.get('n') || '';
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) || n.length < 2 || n.length > 32) return send(res, 200, { name: n, valid: false });
      const taken = await query(NET, { request_type: 'view_account', account_id: `${n}.${dep.factory}` }).then(() => true, () => false);
      return send(res, 200, { name: n, valid: true, free: !taken, account: `${n}.${dep.factory}` });
    }
    if (url.pathname === '/api/factory') return send(res, 200, await cached(`factory-${NET}`, 15_000, () => factoryInfo(NET)));
    if (url.pathname === '/api/drill') return send(res, 200, await readFile(path.join(DIR, 'demo', `attack-${NET}.json`)));
    if (url.pathname === '/api/agent') {
      const net = netOf(url);
      const id = await vaultId(net, url.searchParams.get('vault'));
      if (!id) return send(res, 404, { error: 'not a NEARnest vault' });
      const file = id === (await deployment(net)).vault ? path.join(DIR, 'demo', `agent-${net}.json`) : path.join(DIR, 'demo', 'vaults', `${id}.json`);
      return send(res, 200, await readFile(file).catch(() => JSON.stringify({ network: net, vault: id, moves: [] })));
    }
    // Mainnet setup signing page: only with NEARNEST_SETUP=1 and only on localhost. Never in production.
    if (url.pathname.startsWith('/setup/')) {
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
      if (process.env.NEARNEST_SETUP !== '1' || !local) return send(res, 404, 'Not found', 'text/plain');
      if (url.pathname === '/setup/mainnet') return send(res, 200, await readFile(path.join(DIR, 'scripts', 'setup-mainnet.html')), TYPES['.html']);
      if (url.pathname === '/setup/mainnet.json') {
        const st = JSON.parse(await readFile(path.join(DIR, 'keys', 'mainnet.json'), 'utf8'));
        return send(res, 200, { owner: st.owner, vault: st.vault, feeder: st.feeder, ...st.preset });
      }
      if (url.pathname === '/setup/vault.wasm') {
        return send(res, 200, await readFile(path.join(DIR, 'contract', 'target', 'wasm32-unknown-unknown', 'release', 'nearnest_vault.wasm')), 'application/wasm');
      }
      return send(res, 404, 'Not found', 'text/plain');
    }
    if (url.pathname === '/api/ai' || url.pathname === '/api/ai/evidence') {
      // Proposals from every network the agent ran on (testnet demo vault and the mainnet vault), newest first.
      const d = { proposals: [] };
      for (const n of ['mainnet', 'testnet']) {
        const f = JSON.parse(await readFile(path.join(DIR, 'demo', `ai-${n}.json`), 'utf8').catch(() => '{"proposals":[]}'));
        d.proposals.push(...f.proposals.map((p) => ({ network: n, vault: f.vault, ...p })));
      }
      d.proposals.sort((x, y) => (x.at < y.at ? -1 : 1));
      if (url.pathname === '/api/ai/evidence') {
        const p = d.proposals.find((x) => x.chat_id && x.chat_id === url.searchParams.get('chat_id'));
        if (!p) return send(res, 404, { error: 'no proposal with that chat_id' });
        const e = p.evidence;
        return send(res, 200, { chat_id: p.chat_id, model: p.model, signed_text: e.hashes, signature: e.signature, signing_address: e.signing_address,
          how_to_check: 'sha256(request) + ":" + sha256(response) must equal signed_text; recover the EIP-191 signer of signed_text from signature; it must equal signing_address, which GET https://cloud-api.near.ai/v1/attestation/report?model=<model>&signing_algo=ecdsa names in its TEE report.',
          request: e.request, response: e.response });
      }
      const strip = (p) => (p.evidence ? { ...p, evidence: { ...p.evidence, request: undefined, response: undefined } } : p);
      return send(res, 200, { ...d, proposals: [...d.proposals].reverse().map(strip) });
    }
    if (url.pathname === '/api/fund/tokens') return send(res, 200, await fundTokens());
    if (url.pathname === '/api/fund/quote') {
      const r = await fundQuote(url.searchParams.get('asset') || '', url.searchParams.get('amount') || '');
      return send(res, r.status, r.body);
    }
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
