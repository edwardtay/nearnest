#!/usr/bin/env node
// The agent's run loop. Reads live mainnet yields and risk, plans the vault's moves,
// and signs them with the agent's function-call key. The vault contract re-checks
// every limit on chain, so a bug here can at worst make a move the vault refuses.
//
// The testnet vault mirrors mainnet venues: its Burrow testnet market takes the
// judgement of Rhea Lend USDC on mainnet, its LiNEAR testnet venue takes LiNEAR's.
//
// Usage: node run-agent.mjs [testnet] [--dry] [--loop]
//   --dry   print the plan, sign nothing
//   --loop  keep going (waiting out the cooldown) until the plan is empty
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, near, TGAS, NET, ROOT } from './lib.mjs';
import { buildReport } from '../agent/report.mjs';

const args = process.argv.slice(2);
const net = args.find((a) => !a.startsWith('--')) || 'testnet';
const DRY = args.includes('--dry');
const LOOP = args.includes('--loop');
const MIRROR = { 'burrow-usdc': 'rhea-usdc', linear: 'linear' };
const DECIMALS = { 'usdc.fakes.testnet': 6, near: 24 };
// Moves smaller than this share of the venue cap are not worth the gas.
const MIN_MOVE_SHARE = 0.02;

const s = loadState(net);
const nc = await near(net, { signers: { [s.vault]: s.agentKey.secret, [s.feeder]: s.signers[s.feeder] } });
const agent = await nc.account(s.vault);
const feeder = await nc.account(s.feeder);
const ex = NET[net].explorer;

const view = async (account_id, method_name, a = {}) => JSON.parse(Buffer.from((await nc.connection.provider.query({
  request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(a)).toString('base64'),
})).result).toString());
const human = (raw, token) => Number(BigInt(raw) * 1000n / 10n ** BigInt(DECIMALS[token])) / 1000;
const raw = (n, token) => (BigInt(Math.floor(n * 1e6)) * 10n ** BigInt(DECIMALS[token]) / 1_000_000n);
const min = (a, b) => (a < b ? a : b);

function failureText(o) {
  for (const st of [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)]) {
    if (st?.Failure) return JSON.stringify(st.Failure).replace(/\\"/g, '"').slice(0, 300);
  }
  return null;
}
const fc = (method, a) => transactions.functionCall(method, a, 150n * TGAS, 0n);

async function idle(token) {
  if (token === 'near') {
    const st = await nc.connection.provider.query({ request_type: 'view_account', finality: 'final', account_id: s.vault });
    const spendable = BigInt(st.amount) - BigInt(st.storage_usage) * 10n ** 19n - 5n * 10n ** 23n; // contract keeps 0.5 NEAR
    return spendable > 0n ? spendable : 0n;
  }
  return BigInt(await view(token, 'ft_balance_of', { account_id: s.vault }));
}

/** One plan: block what the policy blocks, then exits, then supplies by best base rate. */
async function plan(report) {
  const [vault, venues] = await Promise.all([view(s.vault, 'get_vault'), view(s.vault, 'get_venues')]);
  const steps = [];
  for (const v of venues) {
    const m = report.venues.find((x) => x.id === MIRROR[v.id]);
    if (!m) continue;
    const j = m.judgement;
    const max = BigInt(v.venue.max_alloc);
    const pos = BigInt(v.position);
    const why = j.reasons.filter((r) => r.level !== 'note').map((r) => r.text);
    // Share of the venue cap the policy allows, from the mainnet judgement and exit liquidity.
    const share = m.max_alloc ? Math.min(1, m.target / m.max_alloc) : 0;
    const want = (max * BigInt(Math.round(share * 1e6))) / 1_000_000n;
    const base = { venue: v.id, mirrors: m.id, verdict: j.verdict, apr: m.live.apr_base, reasons: why, token: v.venue.token };

    if (j.verdict === 'block' && !v.venue.blocked_reason) {
      steps.push({ ...base, kind: 'block', reason: `policy: ${why[0] || 'blocked'}`.slice(0, 280), prio: 0 });
    }
    const floor = (max * BigInt(Math.round(MIN_MOVE_SHARE * 1e6))) / 1_000_000n;
    const cap = BigInt(v.max_move);
    if (pos > want && pos - want >= floor) {
      steps.push({ ...base, kind: 'withdraw', amount: min(pos - want, cap), prio: 1, have: pos, want });
    } else if (want > pos && want - pos >= floor && j.verdict !== 'block' && !v.venue.blocked_reason) {
      const free = await idle(v.venue.token);
      const amt = min(min(want - pos, cap), free);
      if (amt >= floor) steps.push({ ...base, kind: 'supply', amount: amt, prio: 2, have: pos, want });
      else steps.push({ ...base, kind: 'hold', note: 'not enough idle balance', prio: 3, have: pos, want });
    } else {
      steps.push({ ...base, kind: 'hold', note: 'at target', prio: 3, have: pos, want });
    }
  }
  steps.sort((a, b) => a.prio - b.prio || b.apr - a.apr);
  return { vault, steps };
}

const fmtStep = (p) => {
  const amt = p.amount != null ? ` ${human(p.amount, p.token)} ${p.token === 'near' ? 'NEAR' : 'USDC'}` : '';
  const at = p.want != null ? ` (holds ${human(p.have, p.token)}, policy target ${human(p.want, p.token)})` : '';
  return `${p.kind.padEnd(8)} ${p.venue}${amt}${at}  [${p.mirrors}: ${p.verdict}, ${(p.apr * 100).toFixed(2)}%]${p.note ? `  ${p.note}` : ''}`;
};

async function execute(step) {
  const send = (actor, actions) => actor.signAndSendTransaction({ receiverId: s.vault, actions, returnError: true });
  let o;
  if (step.kind === 'block') o = await send(feeder, [fc('block_venue', { venue_id: step.venue, reason: step.reason })]);
  else if (step.kind === 'withdraw') o = await send(agent, [fc('agent_withdraw', { venue_id: step.venue, amount: String(step.amount) })]);
  else o = await send(agent, [fc('agent_supply', { venue_id: step.venue, amount: String(step.amount) })]);
  const fail = failureText(o);
  return { ok: !fail, reason: fail, tx: `${ex}/txns/${o.transaction.hash}` };
}

const log = [];
const report = await buildReport();
console.log(`mainnet read ${report.generated_at}`);
for (const v of report.venues) console.log(`  ${v.id.padEnd(10)} ${(v.live.apr_base * 100).toFixed(2)}%  ${v.judgement.verdict}`);

for (let round = 0; round < 12; round++) {
  const { vault, steps } = await plan(report);
  console.log(`\nplan (round ${round + 1}):`);
  for (const p of steps) console.log(`  ${fmtStep(p)}`);
  const next = steps.find((p) => p.kind !== 'hold');
  if (!next || DRY) { if (!next) console.log(steps.some((p) => p.note === 'not enough idle balance') ? '\nnothing more to do: the rest waits for idle funds' : '\nnothing to do: every venue is at its policy target'); break; }

  // Supplies wait out the cooldown; exits and blocks never wait.
  if (next.kind === 'supply' && vault.last_move_ns) {
    const waitMs = Number(BigInt(vault.last_move_ns) / 1_000_000n) + vault.policy.cooldown_s * 1000 + 3000 - Date.now();
    if (waitMs > 0) {
      if (!LOOP) { console.log(`\ncooldown: next supply allowed in ${Math.ceil(waitMs / 1000)}s (run with --loop to wait)`); break; }
      console.log(`\nwaiting ${Math.ceil(waitMs / 1000)}s for the vault cooldown`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  const r = await execute(next);
  console.log(`${r.ok ? 'done' : 'REFUSED'}  ${next.kind} ${next.venue}  ${r.tx}${r.reason ? `\n  ${r.reason}` : ''}`);
  log.push({ at: new Date().toISOString(), kind: next.kind, venue: next.venue, mirrors: next.mirrors, verdict: next.verdict,
    apr: next.apr, reasons: next.reasons, amount: next.amount != null ? String(next.amount) : null,
    target: next.want != null ? String(next.want) : null, ok: r.ok, reason: r.reason, tx: r.tx });
  if (!LOOP && next.kind === 'supply') break;
}

if (!DRY && log.length) {
  const file = path.join(ROOT, 'demo', `agent-${net}.json`);
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')).moves || []; } catch {}
  const out = { network: net, vault: s.vault, agent_key: s.agentKey.public, updated_at: new Date().toISOString(),
    mirror: MIRROR, moves: [...prev, ...log].slice(-50) };
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nlogged ${log.length} move(s) to demo/agent-${net}.json`);
}
