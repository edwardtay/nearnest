#!/usr/bin/env node
// Register an account held in the state file on an FT/venue contract (storage_deposit).
// Usage: node register.mjs <net> <signerRole: owner|feeder> <contract> [near=0.01]
import { loadState, near, TGAS, NEAR } from './lib.mjs';
const [net, role, contract, amt = '0.01'] = process.argv.slice(2);
const s = loadState(net);
const id = s[role];
const acct = await (await near(net, s)).account(id);
const o = await acct.functionCall({ contractId: contract, methodName: 'storage_deposit', args: { account_id: id, registration_only: true }, gas: 30n * TGAS, attachedDeposit: NEAR(Number(amt)) });
console.log(`${id} registered on ${contract}: ${o.transaction.hash}`);
