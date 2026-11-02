// Off-chain risk policy. It decides what the agent may attempt and why. The vault
// contract enforces the hard limits on chain whatever this code decides; this layer
// adds judgement the chain cannot see (incidents, exit liquidity, depegs).
//
// Verdicts: allow (full cap), cap (reduced cap, with reasons), block (no new supply).

const DAY = 86_400_000;

export const RULES = {
  recentIncidentDays: 90, // block
  incidentMemoryDays: 365, // cap
  capAfterUnreturnedIncident: 0.25,
  capAfterReturnedIncident: 0.5,
  utilizationBlock: 0.95,
  utilizationCap: 0.85,
  capAtHighUtilization: 0.5,
  maxShareOfExitLiquidity: 0.01, // never be more than 1% of what can be withdrawn
  depegBlock: 0.005,
};

export function judge(venue, live, ctx) {
  const reasons = [];
  let verdict = 'allow';
  let capMult = 1;
  const block = (r) => { verdict = 'block'; reasons.push({ level: 'block', text: r }); };
  const cap = (m, r) => {
    if (verdict !== 'block') verdict = 'cap';
    capMult = Math.min(capMult, m);
    reasons.push({ level: 'cap', text: r });
  };
  const note = (r) => reasons.push({ level: 'note', text: r });

  if (!live.can_deposit) block('venue has deposits switched off');
  if (!live.can_withdraw) block('venue has withdrawals switched off');

  // Incidents: the venue's own protocol and any protocol it depends on.
  const names = [venue.protocol, ...(venue.related_protocols || [])];
  for (const inc of ctx.incidents.filter((i) => names.includes(i.name))) {
    const age = (ctx.now - inc.ts) / DAY;
    const usd = `$${(inc.amount / 1e6).toFixed(1)}M`;
    const what = `${inc.name} lost ${usd} on ${inc.date} (${inc.technique || inc.classification})`;
    if (age <= RULES.recentIncidentDays) block(`${what}, ${Math.round(age)} days ago`);
    else if (age <= RULES.incidentMemoryDays) {
      const returned = inc.returned && inc.returned > 0;
      cap(
        returned ? RULES.capAfterReturnedIncident : RULES.capAfterUnreturnedIncident,
        `${what}, ${Math.round(age)} days ago; funds ${returned ? 'partly returned' : 'not returned'}`,
      );
    }
  }

  if (venue.kind === 'LendingFt') {
    const u = live.utilization;
    if (u >= RULES.utilizationBlock) block(`utilization ${(u * 100).toFixed(1)}%: exits may stall`);
    else if (u >= RULES.utilizationCap)
      cap(RULES.capAtHighUtilization, `utilization ${(u * 100).toFixed(1)}%: only ${fmt(live.exit_liquidity)} ${venue.symbol} can leave now`);
    if (live.reward_farm_active) note('reward farm active: yield counted at base rate only');
  }
  if (venue.kind === 'LiquidStake' && !live.instant_exit) note('exit takes 4 epochs (about 2 to 3 days)');

  if (venue.price_id && ctx.prices[venue.price_id] != null) {
    const dev = Math.abs(ctx.prices[venue.price_id] - 1);
    if (dev >= RULES.depegBlock) block(`${venue.symbol} off peg by ${(dev * 100).toFixed(2)}%`);
  }

  return { verdict, capMult: verdict === 'block' ? 0 : capMult, reasons };
}

/**
 * Size a target for one venue in token units: the vault's on-chain max_alloc times
 * the policy multiplier, never above the exit-liquidity share.
 */
export function targetFor(venue, live, j, maxAlloc) {
  if (j.verdict === 'block') return 0;
  let t = maxAlloc * j.capMult;
  if (venue.kind === 'LendingFt') t = Math.min(t, live.exit_liquidity * RULES.maxShareOfExitLiquidity);
  return t;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
