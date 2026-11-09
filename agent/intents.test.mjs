import test from 'node:test';
import assert from 'node:assert/strict';
import { toBaseUnits, quoteBody, USDC_ASSET, ORIGINS } from './intents.mjs';

test('toBaseUnits scales decimals exactly', () => {
  assert.equal(toBaseUnits('0.01', 18), '10000000000000000');
  assert.equal(toBaseUnits('1', 24), '1' + '0'.repeat(24));
  assert.equal(toBaseUnits('12.5', 6), '12500000');
});

test('toBaseUnits rejects bad amounts', () => {
  for (const bad of ['', '-1', '0', '0.000', '1e3', 'abc', '1.2.3']) assert.throws(() => toBaseUnits(bad, 6));
  assert.throws(() => toBaseUnits('0.0000001', 6), /decimal places/);
});

test('dry quote refunds inside Intents and pays USDC to the recipient on NEAR', () => {
  const b = quoteBody({ originAsset: ORIGINS[0][0], amount: '1', recipient: 'vault.near', now: 0 });
  assert.equal(b.dry, true);
  assert.equal(b.destinationAsset, USDC_ASSET);
  assert.equal(b.recipientType, 'DESTINATION_CHAIN');
  assert.equal(b.recipient, 'vault.near');
  assert.equal(b.refundType, 'INTENTS');
  assert.equal(b.refundTo, 'vault.near');
  assert.equal(b.deadline, new Date(30 * 60_000).toISOString());
});

test('live quote needs an origin-chain refund address', () => {
  assert.throws(() => quoteBody({ originAsset: ORIGINS[0][0], amount: '1', recipient: 'vault.near', dry: false }), /refund address/);
  const b = quoteBody({ originAsset: ORIGINS[0][0], amount: '1', recipient: 'vault.near', dry: false, refundTo: '0xabc' });
  assert.equal(b.refundType, 'ORIGIN_CHAIN');
  assert.equal(b.refundTo, '0xabc');
});

import { refundAddressOk } from './intents.mjs';
test('refund addresses are checked against the origin chain format', () => {
  assert.ok(refundAddressOk('Base', '0x437b66b5f265fdf2527f9bba3b1efc492cc362e3'));
  assert.ok(!refundAddressOk('Base', '0x437b66'));
  assert.ok(!refundAddressOk('Solana', '0x437b66b5f265fdf2527f9bba3b1efc492cc362e3'));
  assert.ok(refundAddressOk('Solana', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'));
  assert.ok(refundAddressOk('Tron', 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'));
  assert.ok(refundAddressOk('NEAR', 'web3wagmi.near'));
  assert.ok(refundAddressOk('Bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));
  assert.ok(!refundAddressOk('Dogecoin', 'anything'));
});
