#!/usr/bin/env node
// NEARnest scan: read every approved venue live, judge it, print the plan.
//   node scan.mjs            table
//   node scan.mjs --json     machine-readable report (feeds the dashboard)
import fs from 'node:fs';
import { rheaAssets, rheaVenue, lstVenue, prices, incidents } from './sources.mjs';
import { judge, targetFor, RULES } from './policy.mjs';

const venues = JSON.parse(fs.readFileSync(new URL('./venues.json', import.meta.url)));
const asJson = process.argv.includes('--json');
// Example on-chain max_alloc per venue for the demo vault (token units).
const MAX_ALLOC = { 'rhea-usdc': 50, 'rhea-usdt': 50, linear: 20, rnear: 20 };

const now = Date.now();
const lendingContracts = [...new Set(venues.filter((v) => v.kind === 'LendingFt').map((v) => v.contract))];
const [assetMaps, px, inc] = await Promise.all([
  Promise.all(lendingContracts.map((c) => rheaAssets(c))),
  prices(venues.map((v) => v.price_id).filter(Boolean)),
  incidents(),
]);
const byContract = Object.fromEntries(lendingContracts.map((c, i) => [c, assetMaps[i]]));
const ctx = { now, prices: px, incidents: inc };

const rows = [];
for (const v of venues) {
  const live = v.kind === 'LendingFt'
    ? rheaVenue(byContract[v.contract].get(v.token), v.extra_decimals, v.decimals)
    : await lstVenue(v.contract, v.price_method);
  const j = judge(v, live, ctx);
  rows.push({ id: v.id, label: v.label, symbol: v.symbol, kind: v.kind, live, judgement: j, target: targetFor(v, live, j, MAX_ALLOC[v.id] ?? 0), max_alloc: MAX_ALLOC[v.id] ?? 0 });
}

const report = { generated_at: new Date(now).toISOString(), rules: RULES, venues: rows };
if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`NEARnest scan ${report.generated_at}\n`);
  for (const r of rows) {
    const apr = (r.live.apr_base * 100).toFixed(2);
    console.log(`${r.label.padEnd(20)} ${apr.padStart(6)}%  ${r.judgement.verdict.toUpperCase().padEnd(5)}  target ${r.target.toFixed(2)} of ${r.max_alloc} ${r.symbol}`);
    for (const x of r.judgement.reasons) console.log(`    ${x.level}: ${x.text}`);
  }
}
