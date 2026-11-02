import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, targetFor } from './policy.mjs';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 2);
const lending = { id: 'x', kind: 'LendingFt', protocol: 'P', symbol: 'USDC', price_id: 'usdc' };
const healthy = { can_deposit: true, can_withdraw: true, utilization: 0.5, exit_liquidity: 1e7, reward_farm_active: false };
const ctx = (over = {}) => ({ now, prices: { usdc: 1 }, incidents: [], ...over });
const inc = (daysAgo, returned = null) => ({ name: 'P', ts: now - daysAgo * DAY, date: 'd', amount: 1e7, technique: 't', returned });

test('healthy venue is allowed at full cap', () => {
  const j = judge(lending, healthy, ctx());
  assert.equal(j.verdict, 'allow');
  assert.equal(targetFor(lending, healthy, j, 50), 50);
});

test('incident inside 90 days blocks', () => {
  assert.equal(judge(lending, healthy, ctx({ incidents: [inc(30)] })).verdict, 'block');
});

test('older unreturned incident caps at 25%', () => {
  const j = judge(lending, healthy, ctx({ incidents: [inc(200)] }));
  assert.equal(j.verdict, 'cap');
  assert.equal(j.capMult, 0.25);
});

test('older returned incident caps at 50%', () => {
  assert.equal(judge(lending, healthy, ctx({ incidents: [inc(200, 5e6)] })).capMult, 0.5);
});

test('incident older than a year is ignored', () => {
  assert.equal(judge(lending, healthy, ctx({ incidents: [inc(400)] })).verdict, 'allow');
});

test('utilization 96% blocks, 88% caps', () => {
  assert.equal(judge(lending, { ...healthy, utilization: 0.96 }, ctx()).verdict, 'block');
  assert.equal(judge(lending, { ...healthy, utilization: 0.88 }, ctx()).capMult, 0.5);
});

test('depeg of 0.6% blocks', () => {
  assert.equal(judge(lending, healthy, ctx({ prices: { usdc: 0.994 } })).verdict, 'block');
});

test('paused deposits block', () => {
  assert.equal(judge(lending, { ...healthy, can_deposit: false }, ctx()).verdict, 'block');
});

test('target never exceeds 1% of exit liquidity', () => {
  const thin = { ...healthy, exit_liquidity: 1000 };
  assert.equal(targetFor(lending, thin, judge(lending, thin, ctx()), 50), 10);
});

test('related protocol incident caps a dependent venue', () => {
  const lst = { id: 'r', kind: 'LiquidStake', protocol: 'R', related_protocols: ['P'], symbol: 'NEAR' };
  const j = judge(lst, { can_deposit: true, can_withdraw: true, instant_exit: false }, ctx({ incidents: [inc(200)] }));
  assert.equal(j.verdict, 'cap');
});
