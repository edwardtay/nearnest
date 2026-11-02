// What-if scenarios. Each one changes the live mainnet inputs the way a real event
// would, then the same policy and planner run on the changed inputs. Nothing here
// touches the network; the server and run-agent.mjs feed in live reads.
const DAY = 86_400_000;
const today = (now) => new Date(now).toISOString().slice(0, 10);
const clone = (x) => structuredClone(x);
const hack = (name, now, amount, technique) => ({ name, date: today(now), ts: now, amount, chain: ['Near'], technique, classification: 'Protocol Logic', returned: null, simulated: true });

export const SCENARIOS = [
  {
    id: 'usdc-depeg',
    title: 'USDC slips to $0.991',
    story: 'Circle reserves are in question and USDC trades 0.9% under its peg.',
    apply(i) { const o = clone(i); o.prices['coingecko:usd-coin'] = 0.991; return o; },
  },
  {
    id: 'rhea-exploit',
    title: 'Rhea Lend is exploited today',
    story: 'An oracle bug drains $12M from Rhea Lend. Funds are not returned.',
    apply(i) { const o = clone(i); o.incidents.push(hack('Rhea Lend', o.now, 12e6, 'Price oracle manipulation')); return o; },
  },
  {
    id: 'linear-exploit',
    title: 'LiNEAR is exploited today',
    story: 'A staking pool bug lets an attacker mint LiNEAR worth $8M.',
    apply(i) { const o = clone(i); o.incidents.push(hack('LiNEAR', o.now, 8e6, 'Infinite mint')); return o; },
  },
  {
    id: 'usdc-run',
    title: 'Borrowers drain the USDC pool',
    story: 'Rhea Lend USDC reaches 97% utilization, so lenders may not be able to leave.',
    apply(i) {
      const o = clone(i); const v = o.live['rhea-usdc'];
      v.borrowed = v.supplied * 0.97; v.utilization = 0.97; v.exit_liquidity = v.supplied - v.borrowed; return o;
    },
  },
  {
    id: 'year-later',
    title: 'One year after the April hack',
    story: 'It is 18 April 2027. The Rhea Lend incident of 16 April 2026 is older than 365 days.',
    apply(i) { const o = clone(i); o.now = Date.UTC(2027, 3, 18); return o; },
  },
];

export const scenario = (id) => SCENARIOS.find((s) => s.id === id);
export const scenarioMeta = (s) => ({ id: s.id, title: s.title, story: s.story });
export { DAY };
