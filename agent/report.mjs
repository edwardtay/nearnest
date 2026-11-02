// Builds the live venue report: read every approved venue, judge it, size a target.
import fs from 'node:fs';
import { rheaAssets, rheaVenue, lstVenue, prices, incidents } from './sources.mjs';
import { judge, targetFor, RULES } from './policy.mjs';

const VENUES = JSON.parse(fs.readFileSync(new URL('./venues.json', import.meta.url)));
// Example on-chain max_alloc per venue for a demo vault (token units).
export const MAX_ALLOC = { 'rhea-usdc': 50, 'rhea-usdt': 50, linear: 20, rnear: 20 };

export async function buildReport(now = Date.now()) {
  const lendingContracts = [...new Set(VENUES.filter((v) => v.kind === 'LendingFt').map((v) => v.contract))];
  const [assetMaps, px, inc] = await Promise.all([
    Promise.all(lendingContracts.map((c) => rheaAssets(c))),
    prices([...VENUES.map((v) => v.price_id).filter(Boolean), 'coingecko:near']),
    incidents(),
  ]);
  const byContract = Object.fromEntries(lendingContracts.map((c, i) => [c, assetMaps[i]]));
  const ctx = { now, prices: px, incidents: inc };
  const venues = [];
  for (const v of VENUES) {
    const live = v.kind === 'LendingFt'
      ? rheaVenue(byContract[v.contract].get(v.token), v.extra_decimals, v.decimals)
      : await lstVenue(v.contract, v.price_method);
    const j = judge(v, live, ctx);
    const max = MAX_ALLOC[v.id] ?? 0;
    venues.push({ id: v.id, label: v.label, protocol: v.protocol, contract: v.contract, token: v.token, symbol: v.symbol, kind: v.kind, live, judgement: j, target: targetFor(v, live, j, max), max_alloc: max });
  }
  const near_incidents = inc.filter((i) => (i.chain || []).includes('Near') && now - i.ts < 400 * 86_400_000);
  return { generated_at: new Date(now).toISOString(), network: 'mainnet', rules: RULES, prices: px, venues, near_incidents };
}
