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
  const steps = planMoves(judgeInputs(scenario('linear-exploit').apply(inputs())), venues, idle).filter((s) => s.venue === 'linear' && s.kind !== 'hold');
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

// v3: on-chain risk caps, claims, shared idle budget, exit ceiling in real units.
const capped = (cap) => [{ ...venues[0], effective_cap: String(cap) }, venues[1]];

test('the policy cap is pushed on chain as a risk cap', () => {
  const steps = planMoves(judgeInputs(inputs()), venues, idle);
  const t = steps.find((s) => s.kind === 'tighten');
  assert.equal(t.venue, 'burrow-usdc');
  assert.equal(t.amount, 125n * E6 / 10n); // 25% of 50 USDC
  assert.equal(steps[0].kind, 'tighten');
});

test('no cap cut once the on-chain cap matches the policy', () => {
  const steps = planMoves(judgeInputs(inputs()), capped(125n * E6 / 10n), idle);
  assert.equal(steps.some((s) => s.kind === 'tighten'), false);
});

test('when the policy loosens, the agent waits for the owner to raise the cap', () => {
  const i = scenario('year-later').apply(inputs());
  const steps = planMoves(judgeInputs(i), capped(125n * E6 / 10n), { usdc: 50n * E6, near: 0n });
  const b = steps.find((s) => s.venue === 'burrow-usdc');
  assert.equal(b.kind, 'hold');
  assert.match(b.note, /owner can raise it/);
});

test('unstaked NEAR is claimed once LiNEAR says it can be withdrawn', () => {
  const v = [venues[0], { ...venues[1], position: '0', unbonding: String(E24), claimable: true }];
  const steps = planMoves(judgeInputs(inputs()), v, idle);
  assert.ok(steps.some((s) => s.kind === 'claim' && s.venue === 'linear' && s.amount === E24));
  const waiting = planMoves(judgeInputs(inputs()), [venues[0], { ...venues[1], position: '0', unbonding: String(E24), max_move: '0' }], idle);
  assert.equal(waiting.some((s) => s.kind === 'claim'), false);
});

test('the exit-liquidity ceiling is in this vault\'s token units', () => {
  const i = inputs();
  i.live['rhea-usdc'].exit_liquidity = 1000; // 1% = 10 USDC
  const big = [{ ...venues[0], position: '0', venue: { ...venues[0].venue, max_alloc: String(5000n * E6) }, max_move: String(5000n * E6) }];
  const s = planMoves(judgeInputs(i), big, { usdc: 5000n * E6 }).find((x) => x.kind === 'tighten');
  assert.equal(s.amount, 10n * E6); // the on-chain cap goes to 10 USDC, never 25% of 5,000
});

test('two supplies of one token share the idle balance', () => {
  const two = [
    { id: 'burrow-usdc', position: '0', max_move: String(50n * E6), effective_cap: String(125n * E6 / 10n), venue: { token: 'usdc', max_alloc: String(50n * E6), blocked_reason: null } },
    { id: 'linear', position: '0', max_move: String(5n * E24), venue: { token: 'near', max_alloc: String(20n * E24), blocked_reason: null } },
  ];
  const steps = planMoves(judgeInputs(inputs()), two, { usdc: 5n * E6, near: 0n });
  const sup = steps.filter((s) => s.kind === 'supply');
  assert.equal(sup.reduce((a, s) => a + s.amount, 0n) <= 5n * E6, true);
});

test('a paused vault or a used-up day turns supplies into holds', () => {
  const i = scenario('year-later').apply(inputs());
  const paused = { paused: true, moves_today: 0, day_start_ns: '0', policy: { max_moves_per_day: 10 } };
  const s1 = planMoves(judgeInputs(i), venues, { usdc: 50n * E6, near: 0n }, undefined, 'policy', paused);
  assert.equal(s1.some((s) => s.kind === 'supply'), false);
  assert.ok(s1.some((s) => s.note === 'vault paused by the risk feeder or owner'));
  const full = { paused: false, moves_today: 10, day_start_ns: String(BigInt(Date.now()) * 1_000_000n), policy: { max_moves_per_day: 10 } };
  const s2 = planMoves(judgeInputs(i), venues, { usdc: 50n * E6, near: 0n }, undefined, 'policy', full);
  assert.ok(s2.some((s) => s.note === 'daily move limit reached'));
});
