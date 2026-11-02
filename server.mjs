/* NEARnest site: static page plus three JSON endpoints. No dependencies.
     /api/scan    live mainnet venues judged by the policy (cached 10 min)
     /api/vault   live read of the deployed vault: keys, balances, venues, positions
     /api/drill   recorded compromised-agent drill with transaction links
   Only public account ids are read here (demo/deployment-*.json); keys never ship. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildReport } from './agent/report.mjs';

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

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/scan') return send(res, 200, await cached('scan', 600_000, () => buildReport()));
    if (url.pathname === '/api/vault') return send(res, 200, await cached(`vault-${NET}`, 15_000, () => vaultSnapshot(NET)));
    if (url.pathname === '/api/drill') return send(res, 200, await readFile(path.join(DIR, 'demo', `attack-${NET}.json`)));
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
