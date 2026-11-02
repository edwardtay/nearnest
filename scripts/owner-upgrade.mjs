#!/usr/bin/env node
// Owner upgrades the vault's code (the vault has no full-access key; update_contract is
// owner-only), then checks the old state still loads and syncs every venue's position
// from the venue's own account.
// Usage: node owner-upgrade.mjs [testnet]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { transactions } from 'near-api-js';
import { loadState, near, TGAS, txUrl, WASM, NET } from './lib.mjs';

const net = process.argv[2] || 'testnet';
const s = loadState(net);
const nc = await near(net, { signers: { [s.owner]: s.signers[s.owner] } });
const owner = await nc.account(s.owner);
const wasm = fs.readFileSync(WASM);
console.log(`wasm ${wasm.length} bytes, sha256 ${crypto.createHash('sha256').update(wasm).digest('hex')}`);

const call = async (method, args, gas = 100n) => {
  const o = await owner.signAndSendTransaction({ receiverId: s.vault, actions: [transactions.functionCall(method, args, gas * TGAS, 0n)], returnError: true });
  const fail = [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)].find((x) => x?.Failure);
  console.log(`${fail ? 'FAILED' : 'done  '} ${method}  ${txUrl(net, o)}${fail ? `\n  ${JSON.stringify(fail.Failure).slice(0, 300)}` : ''}`);
  return { o, fail };
};

const up = await call('update_contract', wasm, 300n);
if (up.fail) process.exit(1);
const acct = await nc.connection.provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: s.vault });
console.log(`code hash now ${acct.code_hash}`);
const venues = await owner.viewFunction({ contractId: s.vault, methodName: 'get_venues' });
for (const v of venues) await call('sync_position', { venue_id: v.id });
const after = await owner.viewFunction({ contractId: s.vault, methodName: 'get_venues' });
for (const v of after) console.log(`${v.id.padEnd(12)} position ${v.position}  unbonding ${v.unbonding}  cap ${v.effective_cap}${v.risk_cap ? ` (risk cap ${v.risk_cap})` : ''}`);
s.txs = s.txs || {};
s.txs[`upgrade_${new Date().toISOString().slice(0, 10)}`] = txUrl(net, up.o);
