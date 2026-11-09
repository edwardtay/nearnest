#!/usr/bin/env node
/* Fund a NEARnest vault from any chain through NEAR Intents (1Click).

     node scripts/fund-intents.mjs base:ETH 0.01                      dry quote to the stand-in account
     node scripts/fund-intents.mjs tron:USDT 120 --to <vault>.near    dry quote to a mainnet vault
     node scripts/fund-intents.mjs base:USDC 2 --to <vault>.near --live --refund 0xYourBaseAddress

   --live asks 1Click for a real deposit address, prints it, and follows the swap until it settles.
   You send the funds yourself from your wallet on the origin chain; nothing here holds a key.
   Each live run is appended to demo/intents-mainnet.json. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as intents from '../agent/intents.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const LOG = path.join(DIR, '..', 'demo', 'intents-mainnet.json');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const [pick, amount] = args.filter((a, i) => !a.startsWith('--') && !['--to', '--refund'].includes(args[i - 1]));
const live = args.includes('--live');
const to = flag('--to') || intents.STAND_IN;
const refund = flag('--refund');

if (!pick || !amount) {
  console.error('usage: fund-intents.mjs <chain:SYMBOL> <amount> [--to <mainnet vault>] [--live --refund <origin address>]');
  process.exit(2);
}
if (live && to === intents.STAND_IN) { console.error('--live needs --to <your mainnet vault>'); process.exit(2); }
if (live && !refund) { console.error('--live needs --refund <your address on the origin chain>'); process.exit(2); }

const list = await intents.tokens();
const [chain, symbol] = pick.toLowerCase().split(':');
const t = list.find((x) => x.chain.toLowerCase() === chain && x.symbol.toLowerCase() === symbol);
if (!t) { console.error(`unknown origin ${pick}. Options: ${list.map((x) => `${x.chain}:${x.symbol}`).join(', ')}`); process.exit(2); }

const ready = await intents.recipientReady(to);
if (!ready.ok) { console.error(ready.reason); process.exit(1); }

const { request, quote } = await intents.quote({ originAsset: t.assetId, amount: intents.toBaseUnits(amount, t.decimals), recipient: to, dry: !live, refundTo: refund });
console.log(`${live ? 'LIVE' : 'dry'} quote: ${quote.amountInFormatted} ${t.symbol} on ${t.chain} ($${Number(quote.amountInUsd).toFixed(2)})`);
console.log(`  ${to} receives about ${quote.amountOutFormatted} USDC on NEAR, at least ${Number(quote.minAmountOut) / 1e6}`);
console.log(`  about ${quote.timeEstimate} s after the deposit confirms`);
if (!live) process.exit(0);

console.log(`\nSend exactly ${quote.amountInFormatted} ${t.symbol} on ${t.chain} to:\n  ${quote.depositAddress}${quote.depositMemo ? `\n  memo ${quote.depositMemo}` : ''}`);
console.log(`Deadline ${quote.deadline || request.deadline}. Following status (Ctrl+C to stop; the swap continues without this script).`);

let last = '';
let st;
for (;;) {
  st = await intents.status(quote.depositAddress).catch((e) => ({ status: `error: ${e.message}` }));
  if (st.status !== last) { console.log(`${new Date().toISOString()}  ${st.status}`); last = st.status; }
  if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(st.status)) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
const d = st.swapDetails || {};
const log = JSON.parse(await readFile(LOG, 'utf8').catch(() => '{"runs":[]}'));
log.runs.push({
  at: new Date().toISOString(), recipient: to, origin: `${t.chain}:${t.symbol}`, amount_in: quote.amountInFormatted,
  amount_out: d.amountOutFormatted ?? quote.amountOutFormatted, status: st.status, deposit_address: quote.depositAddress,
  deposited: d.depositedAmountFormatted, refunded: d.refundedAmountFormatted,
  // 1Click often leaves explorerUrl empty: keep the hashes.
  origin_tx: d.originChainTxHashes?.[0]?.explorerUrl || d.originChainTxHashes?.[0]?.hash,
  near_tx: d.destinationChainTxHashes?.[0]?.explorerUrl || d.destinationChainTxHashes?.[0]?.hash,
  refund_tx: d.destinationChainTxHashes?.[1]?.explorerUrl || d.destinationChainTxHashes?.[1]?.hash,
  intent_hashes: d.intentHashes,
});
await writeFile(LOG, JSON.stringify(log, null, 2) + '\n');
console.log(`logged to demo/intents-mainnet.json${d.destinationChainTxHashes?.[0] ? `\nNEAR delivery: ${d.destinationChainTxHashes[0].explorerUrl || d.destinationChainTxHashes[0].hash}` : ''}${Number(d.refundedAmount) > 0 ? `\nrefunded ${d.refundedAmountFormatted} to ${refund}` : ''}`);
