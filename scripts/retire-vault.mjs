#!/usr/bin/env node
// Owner pulls a vault's funds back and archives its record so setup can build a new one.
// Usage: node retire-vault.mjs <net> <nativeNearToReturn>
import { loadState, saveState, near, TGAS, NEAR } from './lib.mjs';
const [net = 'testnet', nativeBack = '1'] = process.argv.slice(2);
const s = loadState(net);
const nc = await near(net, s);
const owner = await nc.account(s.owner);
const v = async (c, m, a) => JSON.parse(Buffer.from((await nc.connection.provider.query({ request_type: 'call_function', finality: 'final', account_id: c, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') })).result).toString());
const venues = await v(s.vault, 'get_venues', {});
for (const t of [...new Set(venues.map((x) => x.venue.token).filter((t) => t !== 'near'))]) {
  const bal = await v(t, 'ft_balance_of', { account_id: s.vault });
  if (bal !== '0') {
    const o = await owner.functionCall({ contractId: s.vault, methodName: 'owner_withdraw', args: { token: t, amount: bal }, gas: 60n * TGAS });
    console.log(`returned ${bal} ${t}: ${o.transaction.hash}`);
  }
}
const o = await owner.functionCall({ contractId: s.vault, methodName: 'owner_withdraw', args: { token: 'near', amount: NEAR(Number(nativeBack)).toString() }, gas: 30n * TGAS });
console.log(`returned ${nativeBack} NEAR: ${o.transaction.hash}`);
s.retired ||= [];
s.retired.push({ vault: s.vault, agentKey: s.agentKey.public, txs: s.txs, note: 'built without --cfg near: rejections trap without messages' });
delete s.vault; delete s.agentKey; s.txs = {};
saveState(net, s);
console.log('archived; owner balance now', (await owner.getAccountBalance()).available);
