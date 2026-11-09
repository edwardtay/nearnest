#!/usr/bin/env node
/* Mainnet vault setup. The owner signs ONE transaction in their own wallet; this script never
   sees the owner's key.

     node scripts/mainnet-setup.mjs [--owner web3wagmi.near] [--name nearnest]

   1. First run: makes a temporary setup key, the agent key and the risk feeder key
      (keys/mainnet.json, gitignored) and tells you to open the local signing page. There the
      owner signs: create <name>.<owner>, send it 4.6 NEAR, add the temporary key.
   2. Next run: with the temporary key the vault account creates its risk feeder
      (risk.<vault>), deploys the vault code and runs new_preset (owner, venues, caps, storage),
      adds the agent's function-call key, and deletes the temporary key. The vault ends with
      no full-access key, as on testnet. Public ids and transaction links go to
      demo/deployment-mainnet.json. Safe to re-run: done steps are skipped. */
import fs from 'node:fs';
import path from 'node:path';
import { transactions, utils } from 'near-api-js';
import { loadState, saveState, newKey, near, WASM, NEAR, TGAS, txUrl, ROOT } from './lib.mjs';

const net = 'mainnet';
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BURROW = 'contract.main.burrow.near';
const LINEAR = 'linear-protocol.near';
const FUND_NEAR = '4.6';

const s = loadState(net);
s.owner ||= flag('--owner', 'web3wagmi.near');
s.vault ||= `${flag('--name', 'nearnest')}.${s.owner}`;
s.feeder ||= `risk.${s.vault}`;
s.signers ||= {};
s.txs ||= {};
if (!s.temp) s.temp = newKey();
if (!s.agentKey) s.agentKey = newKey();
if (!s.feederKey) s.feederKey = newKey();
s.signers[s.feeder] = s.feederKey.secret;
saveState(net, s);

const rpc = async (params) => {
  const r = await fetch('https://free.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }) });
  const j = await r.json();
  return j.error || j.result?.error ? null : j.result;
};
// null when the account does not exist (the key list RPC answers [] for unknown accounts).
const keys = async (id) => ((await rpc({ request_type: 'view_account', account_id: id })) ? (await rpc({ request_type: 'view_access_key_list', account_id: id })).keys.map((k) => k.public_key) : null);
const log = (k, o) => { s.txs[k] = txUrl(net, o); saveState(net, s); console.log(`${k}: ${s.txs[k]}`); };

const vaultKeys = await keys(s.vault);
if (!vaultKeys) {
  console.log(`Step 1 is yours. Start the page with the setup route on, then open it and sign with ${s.owner}:

  NEARNEST_SETUP=1 npm start          # in ${ROOT}
  http://localhost:8787/setup/mainnet

It asks your wallet for one transaction to ${s.vault}: create the account, send it ${FUND_NEAR} NEAR,
add a temporary setup key (${s.temp.public}). Then run this script again.`);
  process.exit(0);
}

const tempOn = vaultKeys.includes(s.temp.public);
if (!tempOn && !s.txs.delete_setup_key) { console.error(`${s.vault} exists but does not carry this setup key. Stop and check its keys.`); process.exit(1); }
if (tempOn) s.signers[s.vault] = s.temp.secret;
s.txs.owner_create_fund_addkey ||= 'signed by the owner in their wallet (see the vault account history)';
saveState(net, s);
const nc = await near(net, s);

if (tempOn) {
  const vault = await nc.account(s.vault);

  if (!(await keys(s.feeder))) {
    log('feeder_create', await vault.signAndSendTransaction({ receiverId: s.feeder, actions: [
      transactions.createAccount(), transactions.transfer(NEAR(0.1)), transactions.addKey(utils.PublicKey.from(s.feederKey.public), transactions.fullAccessKey()),
    ] }));
  }

  if (!s.txs.deploy_init) {
    log('deploy_init', await vault.signAndSendTransaction({ receiverId: s.vault, actions: [
      transactions.deployContract(fs.readFileSync(WASM)),
      transactions.functionCall('new_preset', {
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
      }, 200n * TGAS, 0n),
    ] }));
  }

  // The agent's function-call key, then the setup key goes: no full-access key remains.
  log('agent_key_and_delete_setup_key', await vault.signAndSendTransaction({ receiverId: s.vault, actions: [
    transactions.addKey(utils.PublicKey.from(s.agentKey.public), transactions.functionCallAccessKey(s.vault, ['agent_supply', 'agent_withdraw', 'agent_claim_unstaked'], NEAR(0.25))),
    transactions.deleteKey(utils.PublicKey.from(s.temp.public)),
  ] }));
  s.txs.delete_setup_key = s.txs.agent_key_and_delete_setup_key;
  delete s.signers[s.vault];
  saveState(net, s);
}

const final = await keys(s.vault);
const dep = {
  network: net, vault: s.vault, owner: s.owner, feeder: s.feeder, agent_key: s.agentKey.public,
  access_keys_now: final, full_access_keys: (await rpc({ request_type: 'view_access_key_list', account_id: s.vault })).keys.filter((k) => k.access_key.permission === 'FullAccess').length,
  setup_txs: s.txs,
};
fs.writeFileSync(path.join(ROOT, 'demo', 'deployment-mainnet.json'), JSON.stringify(dep, null, 2) + '\n');
console.log(`\n${s.vault} owner ${s.owner}, feeder ${s.feeder}\naccess keys: ${final.join(', ')} (${dep.full_access_keys} full-access)\nwrote demo/deployment-mainnet.json`);
