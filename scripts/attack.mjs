#!/usr/bin/env node
// Compromised-agent drill. Holds the REAL agent key and tries to steal or misuse the
// vault's money; then the risk feeder and owner run the response: on-chain risk cap,
// block, kill switch, exit without the agent, owner restore. Every attempt is recorded with its
// on-chain evidence to ../demo/attack-<net>.json (no secrets in that file).
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, near, TGAS, NEAR, NET, ROOT } from './lib.mjs';

const net = process.argv[2] || 'testnet';
const s = loadState(net);
// The agent key signs as the vault account (it is a function-call key on it).
const nc = await near(net, { signers: { [s.vault]: s.agentKey.secret, [s.feeder]: s.signers[s.feeder], [s.owner]: s.signers[s.owner] } });
const agent = await nc.account(s.vault);
const feeder = await nc.account(s.feeder);
const owner = await nc.account(s.owner);
const ex = NET[net].explorer;
const results = [];
const ACTOR = {"feeder-blocks": "feeder", "feeder-unblock": "feeder", "feeder-raises-cap": "feeder", "kill-switch": "feeder", "guardian-exit": "feeder", "owner-restores-key": "owner", "owner-unblocks": "owner"};

function failureText(o) {
  const all = [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)];
  for (const st of all) if (st?.Failure) return JSON.stringify(st.Failure).replace(/\\"/g, '"').slice(0, 300);
  return null;
}

async function attempt(name, intent, expect, fn, why) {
  let rec = { name, intent, expect };
  try {
    const o = await fn();
    const fail = failureText(o);
    rec = { ...rec, outcome: fail ? 'rejected' : 'executed', reason: fail, tx: `${ex}/txns/${o.transaction.hash}` };
  } catch (e) {
    // Rejected before reaching the chain: the access key itself forbids the action.
    rec = { ...rec, outcome: 'rejected', reason: (e.type ? `${e.type}: ` : '') + String(e.message).slice(0, 300), tx: null };
  }
  rec.actor = ACTOR[name] || 'agent';
  rec.pass = rec.outcome === expect && (!why || why.test(rec.reason || ''));
  if (why) rec.expect_reason = String(why);
  results.push(rec);
  console.log(`${rec.pass ? 'PASS' : 'FAIL'}  ${name}: ${rec.outcome}${rec.reason ? `  (${rec.reason.slice(0, 140)})` : ''}`);
  if (rec.tx) console.log(`      ${rec.tx}`);
}

// Preflight: start from a known state (venue open, cooldown elapsed). Not recorded.
const getVault = async () => JSON.parse(Buffer.from((await nc.connection.provider.query({ request_type: 'call_function', finality: 'final', account_id: s.vault, method_name: 'get_venues', args_base64: 'e30=' })).result).toString());
if ((await getVault()).some((v) => v.venue.blocked_reason)) {
  await owner.functionCall({ contractId: s.vault, methodName: 'unblock_venue', args: { venue_id: 'burrow-usdc' }, gas: 30n * TGAS });
  console.log('preflight: owner unblocked burrow-usdc');
}
const vs = JSON.parse(Buffer.from((await nc.connection.provider.query({ request_type: 'call_function', finality: 'final', account_id: s.vault, method_name: 'get_vault', args_base64: 'e30=' })).result).toString());
const waitMs = vs.last_move_ns ? Number(BigInt(vs.last_move_ns) / 1_000_000n) + vs.policy.cooldown_s * 1000 + 3000 - Date.now() : 0;
if (waitMs > 0) { console.log(`preflight: waiting ${Math.ceil(waitMs / 1000)}s for cooldown`); await new Promise((r) => setTimeout(r, waitMs)); }

const fc = (method, args, deposit = 0n) => transactions.functionCall(method, args, 150n * TGAS, deposit);
const send = (actor, receiverId, actions) => actor.signAndSendTransaction({ receiverId, actions, returnError: true });
const usdc = (n) => String(n * 1e6);

await attempt('send-native-near', 'Transfer 0.1 NEAR from the vault to the attacker', 'rejected',
  () => send(agent, 'attacker.testnet', [transactions.transfer(NEAR(0.1))]), /RequiresFullAccess|transfer/i);
await attempt('call-owner-withdraw', 'Call owner_withdraw with the agent key', 'rejected',
  () => send(agent, s.vault, [fc('owner_withdraw', { token: 'usdc.fakes.testnet', amount: usdc(60) })]), /MethodNameMismatch/);
await attempt('call-token-directly', 'Call ft_transfer on the USDC contract as the vault', 'rejected',
  () => send(agent, 'usdc.fakes.testnet', [fc('ft_transfer', { receiver_id: 'attacker.testnet', amount: usdc(60) }, 1n)]), /DepositWithFunctionCall|MethodNameMismatch|ReceiverMismatch/);
await attempt('unknown-venue', 'Supply into a venue the owner never approved', 'rejected',
  () => send(agent, s.vault, [fc('agent_supply', { venue_id: 'attacker-pool', amount: usdc(10) })]), /unknown venue attacker-pool/);
await attempt('over-cap', 'Supply 25 USDC when the per-move cap is 20', 'rejected',
  () => send(agent, s.vault, [fc('agent_supply', { venue_id: 'burrow-usdc', amount: usdc(25) })]), /exceeds per-move cap/);
await attempt('exit', 'Withdraw 10 USDC from the venue back to the vault', 'executed',
  () => send(agent, s.vault, [fc('agent_withdraw', { venue_id: 'burrow-usdc', amount: usdc(10) })]));
await attempt('legit-supply', 'Supply 5 USDC to the approved lending venue', 'executed',
  () => send(agent, s.vault, [fc('agent_supply', { venue_id: 'burrow-usdc', amount: usdc(5) })]));
await attempt('over-risk-cap', 'Supply 10 USDC more, past the 25 USDC risk cap the feeder set from the policy', 'rejected',
  () => send(agent, s.vault, [fc('agent_supply', { venue_id: 'burrow-usdc', amount: usdc(10) })]), /would exceed risk cap/);
await attempt('cooldown', 'Supply 1 USDC again straight away', 'rejected',
  () => send(agent, s.vault, [fc('agent_supply', { venue_id: 'burrow-usdc', amount: usdc(1) })]), /cooldown/);
await attempt('feeder-raises-cap', 'Risk feeder tries to raise the risk cap to 50 USDC', 'rejected',
  () => send(feeder, s.vault, [fc('set_risk_cap', { venue_id: 'burrow-usdc', cap: usdc(50) })]), /can only lower the cap/);
await attempt('feeder-blocks', 'Risk feeder blocks the venue with a reason', 'executed',
  () => send(feeder, s.vault, [fc('block_venue', { venue_id: 'burrow-usdc', reason: 'drill: venue exploited via spot price manipulation' })]));
await attempt('supply-blocked', 'Supply into the blocked venue', 'rejected',
  () => send(agent, s.vault, [fc('agent_supply', { venue_id: 'burrow-usdc', amount: usdc(1) })]), /venue blocked/);
await attempt('kill-switch', 'Risk feeder deletes the agent key from the vault', 'executed',
  () => send(feeder, s.vault, [fc('remove_agent_key', {})]));
await attempt('dead-key', 'The removed agent key tries to withdraw', 'rejected',
  () => send(agent, s.vault, [fc('agent_withdraw', { venue_id: 'burrow-usdc', amount: usdc(1) })]), /access ?key|AccessKey|no matching key|does not exist/i);
await attempt('guardian-exit', 'Risk feeder pulls 5 USDC out of the blocked venue, with no agent key', 'executed',
  () => send(feeder, s.vault, [fc('guardian_exit', { venue_id: 'burrow-usdc', amount: usdc(5) })]));
await attempt('feeder-unblock', 'Risk feeder tries to unblock (owner only)', 'rejected',
  () => send(feeder, s.vault, [fc('unblock_venue', { venue_id: 'burrow-usdc' })]), /owner only/);
await attempt('owner-restores-key', 'Owner adds the agent key back', 'executed',
  () => send(owner, s.vault, [fc('add_agent_key', { allowance: NEAR(0.5).toString() })]));
await attempt('owner-unblocks', 'Owner reviews and unblocks the venue', 'executed',
  () => send(owner, s.vault, [fc('unblock_venue', { venue_id: 'burrow-usdc' })]));

const out = { network: net, vault: s.vault, owner: s.owner, feeder: s.feeder, agent_key: s.agentKey.public, ran_at: new Date().toISOString(), results };
fs.writeFileSync(path.join(ROOT, 'demo', `attack-${net}.json`), JSON.stringify(out, null, 2));
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} as expected`);
process.exit(passed === results.length ? 0 : 1);
