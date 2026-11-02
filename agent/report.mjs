// Builds the live venue report: read every approved venue, judge it, size a target.
// readInputs() does the network reads; judgeInputs() is pure, so a scenario can
// change the inputs and run the same policy again (agent/scenarios.mjs).
import fs from 'node:fs';
import { rheaAssets, rheaVenue, lstVenue, prices, incidents } from './sources.mjs';
import { judge, targetFor, RULES } from './policy.mjs';

export const VENUES = JSON.parse(fs.readFileSync(new URL('./venues.json', import.meta.url)));
// Example on-chain max_alloc per venue for a demo vault (token units).
export const MAX_ALLOC = { 'rhea-usdc': 50, 'rhea-usdt': 50, linear: 20, rnear: 20 };

export async function readInputs(now = Date.now()) {
  const lendingContracts = [...new Set(VENUES.filter((v) => v.kind === 'LendingFt').map((v) => v.contract))];
  const [assetMaps, px, inc] = await Promise.all([
    Promise.all(lendingContracts.map((c) => rheaAssets(c))),
    prices([...VENUES.map((v) => v.price_id).filter(Boolean), 'coingecko:near']),
    incidents(),
  ]);
  const byContract = Object.fromEntries(lendingContracts.map((c, i) => [c, assetMaps[i]]));
  const live = {};
  for (const v of VENUES) {
    live[v.id] = v.kind === 'LendingFt'
      ? rheaVenue(byContract[v.contract].get(v.token), v.extra_decimals, v.decimals)
      : await lstVenue(v.contract, v.price_method);
  }
  return { now, prices: px, incidents: inc, live };
}

export function judgeInputs(inputs) {
  const { now, prices: px, incidents: inc, live } = inputs;
  const ctx = { now, prices: px, incidents: inc };
  const venues = VENUES.map((v) => {
    const j = judge(v, live[v.id], ctx);
    const max = MAX_ALLOC[v.id] ?? 0;
    // exit_ceiling: the most any vault should hold here (1% of what can leave now), in tokens.
    const exit_ceiling = v.kind === 'LendingFt' ? live[v.id].exit_liquidity * RULES.maxShareOfExitLiquidity : null;
    return { id: v.id, label: v.label, protocol: v.protocol, contract: v.contract, token: v.token, symbol: v.symbol, kind: v.kind, decimals: v.decimals,
      live: live[v.id], judgement: j, target: targetFor(v, live[v.id], j, max), max_alloc: max, exit_ceiling };
  });
  const near_incidents = inc.filter((i) => (i.chain || []).includes('Near') && now - i.ts < 400 * 86_400_000);
  return { generated_at: new Date(now).toISOString(), network: 'mainnet', rules: RULES, prices: px, venues, near_incidents };
}

export async function buildReport(now = Date.now()) {
  return judgeInputs(await readInputs(now));
}
