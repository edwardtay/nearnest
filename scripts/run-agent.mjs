#!/usr/bin/env node
// The agent's run loop. Reads live mainnet yields and risk, plans the vault's moves,
// and signs them with the agent's function-call key. The vault contract re-checks
// every limit on chain, so a bug here can at worst make a move the vault refuses.
//
// The testnet vault mirrors mainnet venues: its Burrow testnet market takes the
// judgement of Rhea Lend USDC on mainnet, its LiNEAR testnet venue takes LiNEAR's.
//
// Usage: node run-agent.mjs [testnet] [--dry] [--loop] [--scenario <id>] [--watch <min>]
//   --dry       print the plan, sign nothing
//   --loop      keep going (waiting out the cooldown) until the plan is empty
//   --watch     run again every <min> minutes (a foreground process, nothing scheduled)
//   Every round reads mainnet risk again before it signs; a failed read signs nothing.
//   --scenario  apply a what-if event (agent/scenarios.mjs) to the live mainnet read
//               first, so the vault responds to it for real; owner-unblock.mjs undoes it
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, near, TGAS, NET, ROOT } from './lib.mjs';
import { readInputs, judgeInputs } from '../agent/report.mjs';
import { scenario, SCENARIOS } from '../agent/scenarios.mjs';
import { planMoves, spendableNative, cooldownLeft, MIRROR } from '../agent/plan.mjs';

const args = process.argv.slice(2);
const net = args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--scenario') || 'testnet';
const DRY = args.includes('--dry');
const LOOP = args.includes('--loop');
const SC = args.includes('--scenario') ? scenario(args[args.indexOf('--scenario') + 1]) : null;
if (args.includes('--scenario') && !SC) { console.error(`unknown scenario; one of: ${SCENARIOS.map((x) => x.id).join(', ')}`); process.exit(1); }
const DECIMALS = { 'usdc.fakes.testnet': 6, near: 24 };

const s = loadState(net);
const nc = await near(net, { signers: { [s.vault]: s.agentKey.secret, [s.feeder]: s.signers[s.feeder] } });
const agent = await nc.account(s.vault);
const feeder = await nc.account(s.feeder);
const ex = NET[net].explorer;

const view = async (account_id, method_name, a = {}) => JSON.parse(Buffer.from((await nc.connection.provider.query({
  request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(a)).toString('base64'),
})).result).toString());
const human = (raw, token) => Number(BigInt(raw) * 1000n / 10n ** BigInt(DECIMALS[token])) / 1000;
const SIGNER_OF = { block: 'feeder', tighten: 'feeder', withdraw: 'agent', supply: 'agent', claim: 'agent' };

function failureText(o) {
  for (const st of [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)]) {
    if (st?.Failure) return JSON.stringify(st.Failure).replace(/\\"/g, '"').slice(0, 300);
  }
  return null;
}
const fc = (method, a) => transactions.functionCall(method, a, 150n * TGAS, 0n);

/** Read the vault and plan its moves with the shared planner. */
async function plan(report) {
  const [vault, venues, acct] = await Promise.all([view(s.vault, 'get_vault'), view(s.vault, 'get_venues'),
    nc.connection.provider.query({ request_type: 'view_account', finality: 'final', account_id: s.vault })]);
  const idle = { near: spendableNative(acct) };
  for (const tk of new Set(venues.map((v) => v.venue.token).filter((x) => x !== 'near'))) {
    idle[tk] = BigInt(await view(tk, 'ft_balance_of', { account_id: s.vault }));
  }
  // Unstaked NEAR is claimable once the staking venue says so.
  for (const v of venues) {
    if (v.venue.kind === 'LiquidStake' && BigInt(v.unbonding ?? 0) > 0n) {
      v.claimable = !!(await view(v.venue.contract, 'get_account', { account_id: s.vault }).catch(() => null))?.can_withdraw;
    }
  }
  // Reads use final finality, a block or two behind; skip cap changes this run already sent.
  return { vault, steps: planMoves(report, venues, idle, undefined, SC ? `simulated ${SC.id}` : 'policy', vault).filter((p) => !sentThisRun.has(`${p.kind} ${p.venue}`)) };
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
  else if (step.kind === 'tighten') o = await send(feeder, [fc('set_risk_cap', { venue_id: step.venue, cap: String(step.amount) })]);
  else if (step.kind === 'claim') o = await send(agent, [fc('agent_claim_unstaked', { venue_id: step.venue })]);
  else if (step.kind === 'withdraw') o = await send(agent, [fc('agent_withdraw', { venue_id: step.venue, amount: String(step.amount) })]);
  else o = await send(agent, [fc('agent_supply', { venue_id: step.venue, amount: String(step.amount) })]);
  const fail = failureText(o);
  return { ok: !fail, reason: fail, tx: `${ex}/txns/${o.transaction.hash}` };
}

const sentThisRun = new Set();
const WATCH_MIN = args.includes('--watch') ? Number(args[args.indexOf('--watch') + 1]) || 30 : 0;

/** Fresh mainnet read and judgement. Called before every signature, never reused. */
async function judgeNow(first) {
  const live = await readInputs();
  const report = judgeInputs(SC ? SC.apply(live) : live);
  if (first) {
    console.log(`mainnet read ${report.generated_at}${SC ? `\nscenario: ${SC.title}. ${SC.story}` : ''}`);
    for (const v of report.venues) console.log(`  ${v.id.padEnd(10)} ${(v.live.apr_base * 100).toFixed(2)}%  ${v.judgement.verdict}`);
  }
  return report;
}

async function runOnce() {
  const log = [];
  sentThisRun.clear();
  let result = 'nothing to do';
  try {
    for (let round = 0; round < 12; round++) {
      const report = await judgeNow(round === 0);
      const { vault, steps } = await plan(report);
      console.log(`\nplan (round ${round + 1}):`);
      for (const p of steps) console.log(`  ${fmtStep(p)}`);
      const next = steps.find((p) => p.kind !== 'hold');
      if (!next || DRY) {
        if (!next) {
          const why = steps.find((p) => p.note && p.note !== 'at target')?.note;
          result = why ? `nothing to do: ${why}` : 'nothing to do: every venue is at its policy target';
          console.log(`\n${result}`);
        }
        break;
      }
      // Supplies wait out the cooldown, then plan again from a fresh read; exits never wait.
      if (next.kind === 'supply' && cooldownLeft(vault) > 0) {
        const waitMs = cooldownLeft(vault) + 3000;
        if (!LOOP) { result = `cooldown: next supply in ${Math.ceil(waitMs / 1000)}s`; console.log(`\n${result} (run with --loop to wait)`); break; }
        console.log(`\nwaiting ${Math.ceil(waitMs / 1000)}s for the vault cooldown, then reading risk again`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const r = await execute(next);
      if ((next.kind === 'block' || next.kind === 'tighten' || next.kind === 'claim') && r.ok) sentThisRun.add(`${next.kind} ${next.venue}`);
      console.log(`${r.ok ? 'done' : 'REFUSED'}  ${next.kind} ${next.venue}  ${r.tx}${r.reason ? `\n  ${r.reason}` : ''}`);
      log.push({ at: new Date().toISOString(), scenario: SC?.id ?? null, kind: next.kind, venue: next.venue, mirrors: next.mirrors, verdict: next.verdict,
        apr: next.apr, reasons: next.reasons, amount: next.amount != null ? String(next.amount) : null,
        target: next.want != null ? String(next.want) : null, signer: SIGNER_OF[next.kind], ok: r.ok, reason: r.reason, tx: r.tx });
      result = `made ${log.length} move(s)`;
      if (!r.ok) break; // a refusal means the plan and the chain disagree: stop and re-read next run
      if (!LOOP && next.kind === 'supply') break;
    }
  } catch (e) {
    // A failed or slow read signs nothing.
    result = `read failed, signed nothing: ${String(e.message || e).slice(0, 200)}`;
    console.log(`\n${result}`);
  }
  if (DRY) return;
  const file = path.join(ROOT, 'demo', `agent-${net}.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const now = new Date().toISOString();
  const out = { network: net, vault: s.vault, agent_key: s.agentKey.public, updated_at: now,
    last_run: { at: now, result, scenario: SC?.id ?? null }, mirror: MIRROR, moves: [...(prev.moves || []), ...log].slice(-50) };
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nlogged ${log.length} move(s) and the run result to demo/agent-${net}.json`);
}

await runOnce();
// --watch N: run again every N minutes, each time from a fresh read. A foreground
// process you start and stop; nothing is scheduled.
while (WATCH_MIN > 0) {
  console.log(`\nnext run in ${WATCH_MIN} min`);
  await new Promise((r) => setTimeout(r, WATCH_MIN * 60_000));
  await runOnce();
}
