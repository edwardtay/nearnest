#!/usr/bin/env node
// Builds the full NEARnest testnet deployment, step by step, idempotently.
// State (account ids, keys, tx links) lives in ../keys/testnet.json (gitignored).
import fs from 'node:fs';
import { transactions, utils } from 'near-api-js';
import { loadState, saveState, newKey, near, WASM, NEAR, TGAS, txUrl } from './lib.mjs';

const net = 'testnet';
const s = loadState(net);
s.signers ||= {};
s.txs ||= {};
const log = (k, o) => { s.txs[k] = txUrl(net, o); saveState(net, s); console.log(`${k}: ${s.txs[k]}`); };

// 1. Owner account from the public testnet faucet helper.
if (!s.owner) {
  const id = `nearnest-${Date.now().toString(36)}.testnet`;
  const k = newKey();
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: k.public }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${(await r.text()).slice(0, 300)}`);
  s.owner = id; s.signers[id] = k.secret; saveState(net, s);
  console.log('owner created', id);
  await new Promise((res) => setTimeout(res, 3000));
}
const nc = await near(net, s);
const owner = await nc.account(s.owner);
console.log('owner balance', utils.format.formatNearAmount((await owner.getAccountBalance()).available, 3), 'NEAR');

// 2. Agent key (no account: it only ever exists as a function-call key on the vault).
if (!s.agentKey) { s.agentKey = newKey(); saveState(net, s); }

// 3. Vault: create + fund + deploy + init in ONE transaction signed by the owner.
//    No access key is ever added to the vault account, so nobody can redeploy it.
if (!s.vault) {
  const id = `${process.env.VAULT_NAME || "vault"}.${s.owner}`;
  const o = await owner.signAndSendTransaction({
    receiverId: id,
    actions: [
      transactions.createAccount(),
      transactions.transfer(NEAR(4.5)),
      transactions.deployContract(fs.readFileSync(WASM)),
      transactions.functionCall('new', {
        owner: s.owner,
        agent_key: s.agentKey.public,
        policy: { cooldown_s: 60, max_moves_per_day: 10 },
      }, 50n * TGAS, 0n),
    ],
  });
  s.vault = id; saveState(net, s); log('vault_create_deploy_init', o);
}

// 4. Risk feeder account (can block and pause only).
if (!s.feeder) {
  const id = `risk.${s.owner}`;
  const k = newKey();
  const o = await owner.signAndSendTransaction({
    receiverId: id,
    actions: [transactions.createAccount(), transactions.transfer(NEAR(0.5)), transactions.addKey(utils.PublicKey.from(k.public), transactions.fullAccessKey())],
  });
  s.feeder = id; s.signers[id] = k.secret; saveState(net, s); log('feeder_create', o);
}

const call = async (k, method, args, deposit = 0n, gas = 100n * TGAS) => {
  if (s.txs[k]) return;
  const o = await owner.functionCall({ contractId: s.vault, methodName: method, args, gas, attachedDeposit: deposit });
  log(k, o);
};

// 5. Configure the vault.
const BURROW = 'contract.1638481328.burrow.testnet';
const USDC = 'usdc.fakes.testnet';
await call('set_risk_feeder', 'set_risk_feeder', { feeder: s.feeder });
await call('add_venue_burrow_usdc', 'add_venue', {
  venue_id: 'burrow-usdc',
  venue: { kind: 'LendingFt', contract: BURROW, token: USDC, max_alloc: String(50e6), enabled: true, blocked_reason: null, extra_decimals: 12 },
});
await call('add_venue_linear', 'add_venue', {
  venue_id: 'linear',
  venue: { kind: 'LiquidStake', contract: 'linear-protocol.testnet', token: 'near', max_alloc: NEAR(3).toString(), enabled: true, blocked_reason: null, extra_decimals: 0 },
});
await call('max_move_usdc', 'set_max_move', { token: USDC, amount: String(20e6) });
await call('max_move_near', 'set_max_move', { token: 'near', amount: NEAR(1).toString() });
await call('storage_burrow', 'storage_deposit_on', { target: BURROW }, NEAR(0.1), 100n * TGAS);
await call('storage_usdc', 'storage_deposit_on', { target: USDC }, NEAR(0.01), 100n * TGAS);
await call('add_agent_key', 'add_agent_key', { allowance: NEAR(0.5).toString() });

// 6. Fund the vault with 60 test USDC (public mint on the fake token).
if (!s.txs.mint_usdc) {
  const o = await owner.functionCall({ contractId: USDC, methodName: 'mint', args: { account_id: s.vault, amount: String(60e6) }, gas: 30n * TGAS });
  log('mint_usdc', o);
}

console.log('\nvault', s.vault, '\nowner', s.owner, '\nfeeder', s.feeder, '\nagent key', s.agentKey.public);
