#!/usr/bin/env node
/* Mainnet vault setup. The owner only sends NEAR from their own wallet (two plain transfers);
   no key is added to any account of theirs, and this script never sees the owner's key.
   (Meteor blocks apps from adding keys or deploying code, so a named sub-account vault is
   not possible from a wallet; the vault is an implicit account instead.)

     node scripts/mainnet-setup.mjs [--owner web3wagmi.near]

   First run: makes a vault key, the agent key and the risk feeder key (keys/mainnet.json,
   gitignored). The vault and the feeder are implicit accounts: each id is the hex of its
   public key, and the account exists once it receives NEAR. Then open the local page and send
     1. 4.6 NEAR to the vault        2. 0.1 NEAR to the risk feeder
   Next run: one transaction signed by the vault key on the vault itself deploys the vault code
   (the same wasm as the testnet vault), runs new_preset (owner, feeder, venues, caps, storage),
   adds the agent's function-call key and deletes the vault key. No full-access key remains,
   so from then on only the contract's rules decide what happens to the money. Then it checks
   everything on chain and writes demo/deployment-mainnet.json. Safe to re-run. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { utils } from 'near-api-js';
import { transactions } from 'near-api-js';
import { loadState, saveState, newKey, near, WASM, NEAR, TGAS, ROOT } from './lib.mjs';

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
const hexOf = (pub) => Buffer.from(utils.PublicKey.from(pub).data).toString('hex');
if (!s.vaultKey) s.vaultKey = newKey();
s.vault = hexOf(s.vaultKey.public);
if (!s.agentKey) s.agentKey = newKey();
if (!s.feederKey) s.feederKey = newKey();
// An implicit account: its id is the hex of the public key, and it exists once it receives NEAR.
s.feeder = hexOf(s.feederKey.public);
s.signers = { [s.feeder]: s.feederKey.secret, [s.vault]: s.vaultKey.secret };
s.txs ||= {};
delete s.temp;
s.preset = {
  fund_yocto: NEAR(4.6).toString(),
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

let acct = await rpc({ request_type: 'view_account', account_id: s.vault });
const feederAcct = await rpc({ request_type: 'view_account', account_id: s.feeder });
if (!acct || !feederAcct) {
  console.log(`Your turn: on the local page, send from ${s.owner}:
${acct ? '' : `  1. 4.6 NEAR to the vault        ${s.vault}\n`}${feederAcct ? '' : `  2. 0.1 NEAR to the risk feeder  ${s.feeder}\n`}
  NEARNEST_SETUP=1 npm start          # in ${ROOT}
  http://localhost:8787/setup/mainnet
Then run this script again.`);
  process.exit(0);
}

if (acct.code_hash === '11111111111111111111111111111111') {
  if (BigInt(acct.amount) < NEAR(4.4)) { console.error(`the vault holds ${acct.amount} yocto; send the full 4.6 NEAR first`); process.exit(1); }
  const nc = await near(net, s);
  const self = await nc.account(s.vault);
  const o = await self.signAndSendTransaction({ receiverId: s.vault, actions: [
    transactions.deployContract(fs.readFileSync(WASM)),
    transactions.functionCall('new_preset', s.preset.init, 100n * TGAS, 0n),
    transactions.addKey(utils.PublicKey.from(s.agentKey.public), transactions.functionCallAccessKey(s.vault, ['agent_supply', 'agent_withdraw', 'agent_claim_unstaked'], BigInt(s.preset.agent_allowance))),
    transactions.deleteKey(utils.PublicKey.from(s.vaultKey.public)),
  ] });
  s.txs.deploy_init_agent_key_delete_vault_key = `https://nearblocks.io/txns/${o.transaction.hash}`;
  saveState(net, s);
  console.log(`deployed: ${s.txs.deploy_init_agent_key_delete_vault_key}`);
  await new Promise((r) => setTimeout(r, 3000));
  acct = await rpc({ request_type: 'view_account', account_id: s.vault });
}

const keyList = (await rpc({ request_type: 'view_access_key_list', account_id: s.vault })).keys;
const vault = await view(s.vault, 'get_vault');
const venues = await view(s.vault, 'get_venues');
const checks = {
  code_hash_matches_local_build: acct.code_hash === s.preset.code_hash,
  owner: vault?.owner === s.owner,
  risk_feeder: vault?.risk_feeder === s.feeder,
  agent_key_on_vault: keyList.some((k) => k.public_key === s.agentKey.public && k.access_key.permission !== 'FullAccess'),
  no_full_access_key: !keyList.some((k) => k.access_key.permission === 'FullAccess'),
  venues: (venues || []).map((v) => v.id).sort().join(',') === 'burrow-usdc,linear',
};
for (const [k, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${k}`);
const dep = {
  network: net, vault: s.vault, owner: s.owner, feeder: s.feeder, agent_key: s.agentKey.public,
  code_hash: acct.code_hash, checks, setup_txs: s.txs, access_keys: keyList.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission })),
  explorer: `https://nearblocks.io/address/${s.vault}`,
};
fs.writeFileSync(path.join(ROOT, 'demo', 'deployment-mainnet.json'), JSON.stringify(dep, null, 2) + '\n');
console.log(`\nwrote demo/deployment-mainnet.json${Object.values(checks).every(Boolean) ? '' : '\nsome checks failed: look before using the vault'}`);
