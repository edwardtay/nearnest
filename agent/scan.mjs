#!/usr/bin/env node
// NEARnest scan: read every approved venue live, judge it, print the plan.
//   node scan.mjs            table
//   node scan.mjs --json     machine-readable report (same shape the site serves at /api/scan)
import { buildReport } from './report.mjs';

const report = await buildReport();
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`NEARnest scan ${report.generated_at}\n`);
  for (const r of report.venues) {
    const apr = (r.live.apr_base * 100).toFixed(2);
    console.log(`${r.label.padEnd(20)} ${apr.padStart(6)}%  ${r.judgement.verdict.toUpperCase().padEnd(5)}  target ${r.target.toFixed(2)} of ${r.max_alloc} ${r.symbol}`);
    for (const x of r.judgement.reasons) console.log(`    ${x.level}: ${x.text}`);
  }
}
