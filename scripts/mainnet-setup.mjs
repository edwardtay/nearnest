#!/usr/bin/env node
/* Mainnet vault setup. The owner signs two transactions in their own wallet; no key is ever
   added on the owner's behalf, and this script never sees the owner's key.

     node scripts/mainnet-setup.mjs [--owner web3wagmi.near] [--name nearnest]

   First run: makes the agent key and the risk feeder key (keys/mainnet.json, gitignored)
   and the exact transactions, then tells you to open the local signing page:
     1. to <name>.<owner>: create the account, send it 4.5 NEAR, deploy the vault code
        (the same wasm as the testnet vault), new_preset (owner, risk feeder, venues, caps,
        storage registration) and add_agent_key. The vault never gets a full-access key.
     2. to the risk feeder, an implicit account of a key made here: send it 0.1 NEAR.
   Next run: checks the result on chain (code hash, owner, feeder, keys) and writes
   demo/deployment-mainnet.json. Safe to re-run. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { utils } from 'near-api-js';
import { loadState, saveState, newKey, WASM, NEAR, ROOT } from './lib.mjs';

const net = 'mainnet';
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BURROW = 'contract.main.burrow.near';
const LINEAR = 'linear-protocol.near';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (buf) => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };

const s = loadState(net);
s.owner ||= flag('--owner', 'web3wagmi.near');
s.vault ||= `${flag('--name', 'nearnest')}.${s.owner}`;
if (!s.agentKey) s.agentKey = newKey();
if (!s.feederKey) s.feederKey = newKey();
// An implicit account: its id is the hex of the public key, and it exists once it receives NEAR.
s.feeder = Buffer.from(utils.PublicKey.from(s.feederKey.public).data).toString('hex');
s.signers = { [s.feeder]: s.feederKey.secret };
delete s.temp;
delete s.txs;
s.preset = {
  fund_yocto: NEAR(4.5).toString(),
  feeder_yocto: NEAR(0.1).toString(),
  agent_allowance: NEAR(0.25).toString(),
  init: {
    owner: s.owner,
    agent_key: s.agentKey.public,
    policy: { cooldown_s: 600, max_moves_per_day: 6 },
    risk_feeder: s.feeder,
    venues: [
      ['burrow-usdc', { kind: 'LendingFt', contract: BURROW, token: USDC, max_alloc: String(50e6), enabled: true, blocked_reason: null, extra_decimals: 12 }],
      ['linear', { kind: 'LiquidStake', contract: LINEAR, token: 'near', max_alloc: NEAR(0.5).toString(), enabled: true, blocked_reason: null, extra_decimals: 0 }],
    ],
    max_moves: [[USDC, String(20e6)], ['near', NEAR(0.5).toString()]],
    storage: [[BURROW, NEAR(0.1).toString()], [USDC, NEAR(0.00125).toString()], [LINEAR, NEAR(0.00125).toString()]],
  },
  code_hash: base58(crypto.createHash('sha256').update(fs.readFileSync(WASM)).digest()),
};
saveState(net, s);

const rpc = async (params) => {
  const r = await fetch('https://free.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }) });
  const j = await r.json();
  return j.error || j.result?.error ? null : j.result;
};
const view = async (c, m, a = {}) => {
  const r = await rpc({ request_type: 'call_function', account_id: c, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') });
  return r ? JSON.parse(Buffer.from(r.result).toString()) : null;
};

const acct = await rpc({ request_type: 'view_account', account_id: s.vault });
const feederAcct = await rpc({ request_type: 'view_account', account_id: s.feeder });
if (!acct || !feederAcct) {
  console.log(`Your turn: sign ${acct ? 'transaction 2 (fund the risk feeder)' : 'both transactions'} with ${s.owner} on the local page.

  NEARNEST_SETUP=1 npm start          # in ${ROOT}
  http://localhost:8787/setup/mainnet

  1. ${s.vault}: create, send 4.5 NEAR, deploy the vault code (${s.preset.code_hash}), new_preset, add_agent_key
  2. ${s.feeder} (risk feeder): send 0.1 NEAR
Then run this script again.`);
  process.exit(0);
}

const keyList = (await rpc({ request_type: 'view_access_key_list', account_id: s.vault })).keys;
const vault = await view(s.vault, 'get_vault');
const venues = await view(s.vault, 'get_venues');
const checks = {
  code_hash_matches_testnet_vault: acct.code_hash === s.preset.code_hash,
  owner: vault?.owner === s.owner,
  risk_feeder: vault?.risk_feeder === s.feeder,
  agent_key_on_vault: keyList.some((k) => k.public_key === s.agentKey.public && k.access_key.permission !== 'FullAccess'),
  no_full_access_key: !keyList.some((k) => k.access_key.permission === 'FullAccess'),
  venues: (venues || []).map((v) => v.id).sort().join(',') === 'burrow-usdc,linear',
};
for (const [k, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${k}`);
const dep = {
  network: net, vault: s.vault, owner: s.owner, feeder: s.feeder, agent_key: s.agentKey.public,
  code_hash: acct.code_hash, checks, access_keys: keyList.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission })),
  explorer: `https://nearblocks.io/address/${s.vault}`,
};
fs.writeFileSync(path.join(ROOT, 'demo', 'deployment-mainnet.json'), JSON.stringify(dep, null, 2) + '\n');
console.log(`\nwrote demo/deployment-mainnet.json${Object.values(checks).every(Boolean) ? '' : '\nsome checks failed: look before using the vault'}`);
