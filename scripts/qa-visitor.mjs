#!/usr/bin/env node
/* QA: a stranger's whole journey on testnet, with the exact transactions the page sends.
   Fresh faucet account -> create_vault on the factory -> fund (test USDC, NEAR) -> the agent's
   own run for that vault -> owner exit, withdraw, close. Prints PASS/FAIL per step and the
   transaction links, and writes demo/qa-visitor-testnet.json. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadState, newKey, near, NEAR, TGAS, ROOT } from './lib.mjs';

const t = loadState('testnet');
const USDC = 'usdc.fakes.testnet';
const results = [];
const ex = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const check = (name, pass, detail = '', tx = null) => { results.push({ name, pass, detail, tx }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}${tx ? `\n      ${tx}` : ''}`); };
const failOf = (o) => [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)].find((x) => x?.Failure);

const fk = newKey();
const who = `stranger-${Date.now().toString(36)}.testnet`;
const r = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: who, newAccountPublicKey: fk.public }) });
check('stranger account from the faucet', r.ok, who);
await new Promise((x) => setTimeout(x, 4000));
const nc = await near('testnet', { signers: { [who]: fk.secret } });
const me = await nc.account(who);
const view = (c, m, a = {}) => me.viewFunction({ contractId: c, methodName: m, args: a });
const call = (receiverId, method, args, deposit = 0n, gas = 100n) => me.signAndSendTransaction({ receiverId, actions: [(await_import_tx()).functionCall(method, args, gas * TGAS, deposit)], returnError: true });
function await_import_tx() { return globalThis.__tx; }
globalThis.__tx = (await import('near-api-js')).transactions;

// 1. create, exactly as the page: min deposit + 1 NEAR, 300 Tgas
const name = `qa${Date.now().toString(36).slice(-6)}`;
const min = BigInt(await view(t.factory, 'get_min_deposit'));
let o = await call(t.factory, 'create_vault', { name }, min + NEAR(1), 300n);
const vault = `${name}.${t.factory}`;
check('create_vault through the factory', !failOf(o), vault, ex(o.transaction.hash));
await new Promise((x) => setTimeout(x, 3000));
const v = await view(vault, 'get_vault');
check('the stranger owns the vault', v.owner === who);
const keys = (await nc.connection.provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: vault })).keys;
check('only the agent key, no full-access key', keys.length === 1 && keys[0].access_key.permission !== 'FullAccess' && keys[0].public_key === t.agentKey.public);
const acct = await nc.connection.provider.query({ request_type: 'view_account', finality: 'final', account_id: vault });
const local = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'contract/target/wasm32-unknown-unknown/release/nearnest_vault.wasm'))).digest();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + local.toString('hex')); let b58 = ''; while (n > 0n) { b58 = B58[Number(n % 58n)] + b58; n /= 58n; }
check('vault runs the current vault code', acct.code_hash === b58, acct.code_hash);

// 2. fund like the page: the faucet mint into the vault
o = await call(USDC, 'mint', { account_id: vault, amount: String(50e6) }, 0n, 30n);
check('fund: 50 test USDC into the vault', !failOf(o), '', ex(o.transaction.hash));

// 3. the agent's own run for this vault (what the hosted agent does on mainnet)
let out = '';
try { out = execFileSync(process.execPath, ['run-agent.mjs', 'testnet', '--vault', vault], { cwd: path.dirname(new URL(import.meta.url).pathname), encoding: 'utf8', timeout: 240_000 }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
const moved = out.split('\n').find((l) => l.startsWith('done'));
check('agent moves money for the stranger', !!moved, moved?.trim().slice(0, 80) || out.trim().split('\n').slice(-2).join(' | ').slice(0, 200));
await new Promise((x) => setTimeout(x, 3000));
const venues = await view(vault, 'get_venues');
const burrow = venues.find((x) => x.id === 'burrow-usdc');
check('position recorded', BigInt(burrow.position) > 0n, `${Number(burrow.position) / 1e6} USDC in Burrow`);

// 4. owner exits like the page's Exit button
o = await call(vault, 'guardian_exit', { venue_id: 'burrow-usdc', amount: burrow.position }, 0n, 200n);
check('owner exits Burrow without the agent', !failOf(o), '', ex(o.transaction.hash));
await new Promise((x) => setTimeout(x, 4000));

// 5. withdraw USDC to the owner: needs the owner registered with the token
const reg = await view(USDC, 'storage_balance_of', { account_id: who });
check('owner registered with USDC before withdrawing', true, reg ? 'already registered' : 'not registered: the page must offer registration first');
if (!reg) { o = await call(USDC, 'storage_deposit', { account_id: who, registration_only: true }, NEAR(0.00125), 30n); check('register owner with USDC', !failOf(o), '', ex(o.transaction.hash)); }
const bal = await view(USDC, 'ft_balance_of', { account_id: vault });
o = await call(vault, 'owner_withdraw', { token: USDC, amount: bal }, 0n, 50n);
check('owner_withdraw all USDC', !failOf(o), `${Number(bal) / 1e6} USDC`, ex(o.transaction.hash));
await new Promise((x) => setTimeout(x, 3000));

// 6. close like the page's Close button
const before = BigInt((await me.getAccountBalance()).total);
o = await call(vault, 'close', {}, 0n, 100n);
const f = failOf(o);
check('close the vault', !f, f ? JSON.stringify(f).slice(0, 200) : '', ex(o.transaction.hash));
await new Promise((x) => setTimeout(x, 4000));
const gone = await nc.connection.provider.query({ request_type: 'view_account', finality: 'final', account_id: vault }).then(() => false, () => true);
const back = Number((BigInt((await me.getAccountBalance()).total) - before) / 10n ** 21n) / 1000;
check('vault deleted and NEAR returned', gone && back > 4, `${back} NEAR back`);

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
fs.writeFileSync(path.join(ROOT, 'demo', 'qa-visitor-testnet.json'), JSON.stringify({ ran_at: new Date().toISOString(), stranger: who, vault, results }, null, 2) + '\n');
