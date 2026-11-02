#!/usr/bin/env node
// Testnet factory: create its account (faucet helper), deploy and init it with the same
// preset as the demo vault, then prove the visitor flow with a fresh visitor account:
// create_vault, mint test USDC into it. Idempotent; state in ../keys/testnet.json.
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, saveState, newKey, near, NEAR, TGAS, txUrl, ROOT } from './lib.mjs';

const net = 'testnet';
const s = loadState(net);
const FACTORY_WASM = path.join(ROOT, 'factory/target/wasm32-unknown-unknown/release/nearnest_factory.wasm');
const BURROW = 'contract.1638481328.burrow.testnet';
const USDC = 'usdc.fakes.testnet';
const log = (k, o) => { s.txs[k] = txUrl(net, o); saveState(net, s); console.log(`${k}: ${s.txs[k]}`); };

async function faucetAccount(prefix) {
  const id = `${prefix}-${Date.now().toString(36)}.testnet`;
  const k = newKey();
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: k.public }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${(await r.text()).slice(0, 300)}`);
  s.signers[id] = k.secret; saveState(net, s);
  await new Promise((res) => setTimeout(res, 4000));
  return id;
}

export const PRESET = {
  policy: { cooldown_s: 60, max_moves_per_day: 10 },
  venues: [
    ['burrow-usdc', { kind: 'LendingFt', contract: BURROW, token: USDC, max_alloc: String(50e6), enabled: true, blocked_reason: null, extra_decimals: 12 }],
    ['linear', { kind: 'LiquidStake', contract: 'linear-protocol.testnet', token: 'near', max_alloc: NEAR(3).toString(), enabled: true, blocked_reason: null, extra_decimals: 0 }],
  ],
  max_moves: [[USDC, String(20e6)], ['near', NEAR(1).toString()]],
  storage: [[BURROW, NEAR(0.1).toString()], [USDC, NEAR(0.0125).toString()]],
};

if (!s.factory) { s.factory = await faucetAccount('nearnest-factory'); saveState(net, s); console.log('factory account', s.factory); }
let nc = await near(net, s);
const factory = await nc.account(s.factory);
console.log('factory balance', Number((await factory.getAccountBalance()).available) / 1e24);

if (!s.txs.factory_deploy) {
  const o = await factory.signAndSendTransaction({ receiverId: s.factory, actions: [
    transactions.deployContract(fs.readFileSync(FACTORY_WASM)),
    transactions.functionCall('new', { owner: s.owner, agent_key: s.agentKey.public, risk_feeder: s.feeder, preset: JSON.stringify(PRESET) }, 50n * TGAS, 0n),
  ] });
  log('factory_deploy', o);
}

// Visitor flow, signed by a fresh visitor account exactly as the web page would.
if (!s.visitor) { s.visitor = await faucetAccount('nearnest-visitor'); saveState(net, s); nc = await near(net, s); }
const visitor = await nc.account(s.visitor);
const min = BigInt(await visitor.viewFunction({ contractId: s.factory, methodName: 'get_min_deposit' }));
console.log('min deposit', Number(min) / 1e24, 'NEAR');
if (!s.txs.visitor_create) {
  const o = await visitor.functionCall({ contractId: s.factory, methodName: 'create_vault', args: { name: 'demo' }, gas: 300n * TGAS, attachedDeposit: min + NEAR(1) });
  log('visitor_create', o);
}
s.visitorVault = `demo.${s.factory}`; saveState(net, s);
if (!s.txs.visitor_mint) {
  const o = await visitor.functionCall({ contractId: USDC, methodName: 'mint', args: { account_id: s.visitorVault, amount: String(40e6) }, gas: 30n * TGAS });
  log('visitor_mint', o);
}
const keys = await nc.connection.provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: s.visitorVault });
console.log('visitor vault', s.visitorVault, 'keys:', keys.keys.map((k) => `${k.public_key} ${k.access_key.permission === 'FullAccess' ? 'FULL' : k.access_key.permission.FunctionCall.method_names.join(',')}`));
console.log('vaults', JSON.stringify(await visitor.viewFunction({ contractId: s.factory, methodName: 'get_vaults', args: {} })));
