import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, scenario } from './scenarios.mjs';
import { judgeInputs } from './report.mjs';
import { planMoves } from './plan.mjs';

const now = Date.UTC(2026, 10, 2);
const lend = { apr_base: 0.14, reward_farm_active: false, supplied: 2e7, borrowed: 1.6e7, utilization: 0.8, exit_liquidity: 4e6, can_deposit: true, can_withdraw: true };
const lst = { apr_base: 0.05, can_deposit: true, can_withdraw: true, instant_exit: false };
const april = { name: 'Rhea Lend', date: '2026-04-16', ts: Date.UTC(2026, 3, 16), amount: 18.4e6, chain: ['Near'], technique: 't', returned: null };
const inputs = () => ({
  now,
  prices: { 'coingecko:usd-coin': 1, 'coingecko:tether': 1, 'coingecko:near': 4 },
  incidents: [april],
  live: { 'rhea-usdc': { ...lend }, 'rhea-usdt': { ...lend }, linear: { ...lst }, rnear: { ...lst } },
});
const verdicts = (i) => Object.fromEntries(judgeInputs(i).venues.map((v) => [v.id, v.judgement.verdict]));

// A vault holding 12.5 USDC in Burrow and 1 NEAR in LiNEAR, like the testnet vault.
const E6 = 10n ** 6n, E24 = 10n ** 24n;
const venues = [
  { id: 'burrow-usdc', position: String(125n * E6 / 10n), max_move: String(20n * E6), venue: { token: 'usdc', max_alloc: String(50n * E6), blocked_reason: null } },
  { id: 'linear', position: String(E24), max_move: String(5n * E24), venue: { token: 'near', max_alloc: String(20n * E24), blocked_reason: null } },
];
const idle = { usdc: 0n, near: 0n };

test('baseline: the April hack (unreturned in this fixture) caps Rhea venues', () => {
  assert.deepEqual(verdicts(inputs()), { 'rhea-usdc': 'cap', 'rhea-usdt': 'cap', linear: 'allow', rnear: 'cap' });
});

test('scenarios do not change their input', () => {
  const i = inputs(); const before = JSON.stringify(i);
  for (const s of SCENARIOS) s.apply(i);
  assert.equal(JSON.stringify(i), before);
});

test('USDC depeg blocks only the USDC venue, then the agent blocks and exits it', () => {
  const r = judgeInputs(scenario('usdc-depeg').apply(inputs()));
  assert.equal(r.venues.find((v) => v.id === 'rhea-usdc').judgement.verdict, 'block');
  assert.equal(r.venues.find((v) => v.id === 'rhea-usdt').judgement.verdict, 'cap');
  const steps = planMoves(r, venues, idle).filter((s) => s.kind !== 'hold');
  assert.deepEqual(steps.map((s) => `${s.kind} ${s.venue}`), ['block burrow-usdc', 'withdraw burrow-usdc']);
  assert.equal(steps[1].amount, 125n * E6 / 10n);
  assert.equal(steps[0].reason, 'policy: USDC off peg by 0.90%');
});

test('a fresh Rhea exploit blocks every venue that depends on Rhea Lend', () => {
  assert.deepEqual(verdicts(scenario('rhea-exploit').apply(inputs())), { 'rhea-usdc': 'block', 'rhea-usdt': 'block', linear: 'allow', rnear: 'block' });
});

test('a LiNEAR exploit unstakes from LiNEAR', () => {
  const steps = planMoves(judgeInputs(scenario('linear-exploit').apply(inputs())), venues, idle).filter((s) => s.kind !== 'hold');
  assert.deepEqual(steps.map((s) => `${s.kind} ${s.venue}`), ['block linear', 'withdraw linear']);
});

test('97% utilization blocks the USDC pool', () => {
  assert.equal(verdicts(scenario('usdc-run').apply(inputs()))['rhea-usdc'], 'block');
});

test('a year later the April cap lifts and the agent wants to supply more', () => {
  const i = scenario('year-later').apply(inputs());
  assert.equal(verdicts(i)['rhea-usdc'], 'allow');
  const steps = planMoves(judgeInputs(i), venues, { usdc: 50n * E6, near: 0n });
  assert.equal(steps[0].kind, 'supply');
  assert.equal(steps[0].venue, 'burrow-usdc');
});

test('a small position in a blocked venue still exits', () => {
  const tiny = [{ ...venues[0], position: String(E6 / 2n) }];
  const steps = planMoves(judgeInputs(scenario('usdc-depeg').apply(inputs())), tiny, idle).filter((s) => s.kind !== 'hold');
  assert.deepEqual(steps.map((s) => `${s.kind} ${s.venue} ${s.amount ?? ''}`), ['block burrow-usdc ', `withdraw burrow-usdc ${E6 / 2n}`]);
});
