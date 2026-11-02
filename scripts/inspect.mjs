#!/usr/bin/env node
// Read-only snapshot of a deployment: keys on the vault, balances, venue state.
import { loadState, NET } from './lib.mjs';
const net = process.argv[2] || 'testnet';
const s = loadState(net);
const url = NET[net].nodeUrl;
const q = async (params) => {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }) })).json();
  if (r.error || r.result?.error) throw new Error(JSON.stringify(r.error || r.result.error).slice(0, 300));
  return r.result;
};
const view = async (c, m, a = {}) => JSON.parse(Buffer.from((await q({ request_type: 'call_function', account_id: c, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') })).result).toString());
const keys = (await q({ request_type: 'view_access_key_list', account_id: s.vault })).keys;
console.log('vault', s.vault);
console.log('access keys on vault:', keys.length);
for (const k of keys) console.log('  ', k.public_key, JSON.stringify(k.access_key.permission));
const acct = await q({ request_type: 'view_account', account_id: s.vault });
console.log('native balance', (Number(BigInt(acct.amount) / 10n ** 21n) / 1000).toFixed(3), 'NEAR; code hash', acct.code_hash);
console.log('venues', JSON.stringify(await view(s.vault, 'get_venues'), null, 1));
console.log('vault', JSON.stringify(await view(s.vault, 'get_vault')));
for (const t of process.argv.slice(3)) console.log(t, 'balance', await view(t, 'ft_balance_of', { account_id: s.vault }));
