#!/usr/bin/env node
// Redeploy the factory's code (it keeps its state) after the vault or factory changes.
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, near, txUrl, ROOT } from './lib.mjs';
const s = loadState('testnet');
const nc = await near('testnet', s);
const f = await nc.account(s.factory);
const o = await f.signAndSendTransaction({ receiverId: s.factory, actions: [transactions.deployContract(fs.readFileSync(path.join(ROOT, 'factory/target/wasm32-unknown-unknown/release/nearnest_factory.wasm')))] });
console.log('factory redeployed', txUrl('testnet', o));
const cfg = await f.viewFunction({ contractId: s.factory, methodName: 'get_config' });
console.log('vault code', cfg.vault_code_bytes, 'bytes, sha256', cfg.vault_code_sha256);
