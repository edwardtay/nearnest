#!/usr/bin/env node
// Owner reopens a venue after a block (a real one, or one made by run-agent --scenario).
// Only the owner can unblock; the risk feeder and the agent key cannot.
// Usage: node owner-unblock.mjs <venue_id> [testnet]
import fs from 'node:fs';
import path from 'node:path';
import { transactions } from 'near-api-js';
import { loadState, near, TGAS, txUrl, ROOT } from './lib.mjs';

const [venue, net = 'testnet'] = process.argv.slice(2);
if (!venue) { console.error('usage: node owner-unblock.mjs <venue_id> [testnet]'); process.exit(1); }
const s = loadState(net);
const nc = await near(net, { signers: { [s.owner]: s.signers[s.owner] } });
const owner = await nc.account(s.owner);
const o = await owner.signAndSendTransaction({ receiverId: s.vault, actions: [transactions.functionCall('unblock_venue', { venue_id: venue }, 30n * TGAS, 0n)], returnError: true });
const fail = [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)].find((x) => x?.Failure);
const tx = txUrl(net, o);
console.log(`${fail ? 'REFUSED' : 'done'}  unblock_venue ${venue}  ${tx}${fail ? `\n  ${JSON.stringify(fail.Failure).slice(0, 300)}` : ''}`);
if (!fail) {
  const file = path.join(ROOT, 'demo', `agent-${net}.json`);
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  a.moves.push({ at: new Date().toISOString(), scenario: null, kind: 'unblock', venue, mirrors: null, verdict: 'allow', apr: null,
    reasons: ['owner reopened the venue'], amount: null, target: null, ok: true, reason: null, tx, signer: 'owner' });
  a.updated_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(a, null, 2));
}
