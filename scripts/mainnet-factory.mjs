#!/usr/bin/env node
/* Mainnet factory at nearnest.near, so anyone can create a vault from their wallet in one call.

     node scripts/mainnet-factory.mjs

   First run: makes the factory's maintenance key and a separate agent key for visitor vaults
   (the published key is only for web3wagmi.near's vault), then asks the owner to sign one call
   on the local page: near.create_account({new_account_id: "nearnest.near", new_public_key})
   with 6.2 NEAR, which pays the factory code's storage (it embeds the vault code).
   Next run: deploys the factory and runs new(owner, agent key, risk feeder, mainnet preset),
   then records it in demo/deployment-mainnet.json. The maintenance key stays on the factory so
   its code can be redeployed; the factory holds no vault funds, only refund credits for
   failed creations. */
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, saveState, newKey, near, NEAR, TGAS, ROOT } from './lib.mjs';

const net = 'mainnet';
const FACTORY = 'nearnest.near';
const WASM = path.join(ROOT, 'factory/target/wasm32-unknown-unknown/release/nearnest_factory.wasm');
const s = loadState(net);
if (!s.vault) { console.error('run mainnet-setup.mjs first'); process.exit(1); }
s.factory = FACTORY;
if (!s.factoryKey) s.factoryKey = newKey();
if (!s.factoryAgentKey) s.factoryAgentKey = newKey();
s.factoryPreset = { fund_yocto: NEAR(6.2).toString(), new_public_key: s.factoryKey.public };
saveState(net, s);

const rpc = async (params) => {
  const r = await fetch('https://free.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }) });
  const j = await r.json();
  return j.error || j.result?.error ? null : j.result;
};
const acct = await rpc({ request_type: 'view_account', account_id: FACTORY });
if (!acct) {
  console.log(`Your turn: on http://localhost:8787/setup/mainnet (NEARNEST_SETUP=1 npm start), sign
"Create nearnest.near" with ${s.owner}: near.create_account with 6.2 NEAR and the key
${s.factoryKey.public}. Then run this script again.`);
  process.exit(0);
}

const preset = {
  policy: { cooldown_s: 600, max_moves_per_day: 6 },
  venues: s.preset.init.venues,
  max_moves: s.preset.init.max_moves,
  storage: s.preset.init.storage,
};
const nc = await near(net, { signers: { [FACTORY]: s.factoryKey.secret } });
const f = await nc.account(FACTORY);
if (acct.code_hash === '11111111111111111111111111111111') {
  const o = await f.signAndSendTransaction({ receiverId: FACTORY, actions: [
    transactions.deployContract(fs.readFileSync(WASM)),
    transactions.functionCall('new', { owner: s.owner, agent_key: s.factoryAgentKey.public, risk_feeder: s.feeder, preset: JSON.stringify(preset) }, 50n * TGAS, 0n),
  ] });
  console.log(`deployed: https://nearblocks.io/txns/${o.transaction.hash}`);
  s.txs.factory_deploy_init = `https://nearblocks.io/txns/${o.transaction.hash}`;
  saveState(net, s);
}
const cfg = await f.viewFunction({ contractId: FACTORY, methodName: 'get_config' });
const min = await f.viewFunction({ contractId: FACTORY, methodName: 'get_min_deposit' });
console.log(`factory ${FACTORY}: owner ${cfg.owner}, vault code ${cfg.vault_code_bytes} bytes (sha256 ${cfg.vault_code_sha256}), min deposit ${Number(BigInt(min) / 10n ** 21n) / 1000} NEAR`);
const depPath = path.join(ROOT, 'demo', 'deployment-mainnet.json');
const dep = JSON.parse(fs.readFileSync(depPath, 'utf8'));
Object.assign(dep, { factory: FACTORY, factory_agent_key: s.factoryAgentKey.public, factory_setup: s.txs.factory_deploy_init });
fs.writeFileSync(depPath, JSON.stringify(dep, null, 2) + '\n');
console.log('recorded in demo/deployment-mainnet.json');
