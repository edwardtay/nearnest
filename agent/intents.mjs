/* Fund a vault from any chain through NEAR Intents (1Click API).
   The user deposits a token on its own chain (ETH on Base, USDT on Tron, SOL, BTC ...).
   Solvers settle the swap inside NEAR Intents and 1Click sends NEAR USDC to the vault with
   ft_transfer. The vault needs no change: it is registered for USDC at creation and keeps any
   FT it receives, and the agent sees the new balance as idle USDC on its next round.

   Intents runs on mainnet only. Until the mainnet vault exists, quotes are dry (no deposit
   address) and route to a stand-in mainnet account, and the page says so. */

export const ONECLICK = 'https://1click.chaindefuser.com';
export const USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** An existing mainnet account registered for USDC; used only for dry quotes before the mainnet vault. */
export const STAND_IN = 'intents.near';
const MAINNET_RPC = 'https://free.rpc.fastnear.com';

/** Origins offered on the page: the assets people hold most, on the chains they hold them. */
export const ORIGINS = [
  ['nep141:eth.omft.near', 'Ethereum'],
  ['nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', 'Ethereum'],
  ['nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', 'Ethereum'],
  ['nep141:base.omft.near', 'Base'],
  ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', 'Base'],
  ['nep141:arb.omft.near', 'Arbitrum'],
  ['nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', 'Arbitrum'],
  ['nep141:sol.omft.near', 'Solana'],
  ['nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', 'Solana'],
  ['nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near', 'Solana'],
  ['nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', 'Tron'],
  ['nep141:btc.omft.near', 'Bitcoin'],
  ['nep141:wrap.near', 'NEAR'],
];

/** "0.01" with 18 decimals -> "10000000000000000". Rejects anything that is not a plain positive decimal. */
export function toBaseUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('amount must be a positive number');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  const raw = BigInt(whole + frac.padEnd(decimals, '0'));
  if (raw <= 0n) throw new Error('amount must be above zero');
  return raw.toString();
}

export async function tokens(fetchImpl = fetch) {
  const r = await fetchImpl(`${ONECLICK}/v0/tokens`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`1Click tokens ${r.status}`);
  const all = await r.json();
  const by = new Map(all.map((t) => [t.assetId, t]));
  return ORIGINS.filter(([id]) => by.has(id)).map(([id, chain]) => {
    const t = by.get(id);
    return { assetId: id, chain, symbol: t.symbol === 'wNEAR' ? 'NEAR' : t.symbol, decimals: t.decimals, price: t.price };
  });
}

/** The 1Click quote body. Dry quotes refund inside Intents, so no origin-chain address is needed to preview. */
export function quoteBody({ originAsset, amount, recipient, refundTo, dry = true, slippageBps = 100, minutes = 30, now = Date.now() }) {
  if (!dry && !refundTo) throw new Error('a live quote needs a refund address on the origin chain');
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDC_ASSET,
    amount,
    refundTo: refundTo || recipient,
    refundType: refundTo ? 'ORIGIN_CHAIN' : 'INTENTS',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + minutes * 60_000).toISOString(),
  };
}

async function mainnetQuery(params) {
  const r = await fetch(MAINNET_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) return undefined;
  return j.result;
}

/** 1Click answers a bare 500 when the recipient cannot take USDC, so check it first and say why. */
export async function recipientReady(account) {
  if (!/^[a-z0-9._-]{2,64}$/.test(account)) return { ok: false, reason: `${account} is not a NEAR account id` };
  if (!(await mainnetQuery({ request_type: 'view_account', account_id: account }))) return { ok: false, reason: `${account} does not exist on NEAR mainnet` };
  const res = await mainnetQuery({ request_type: 'call_function', account_id: USDC_CONTRACT, method_name: 'storage_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64') });
  const storage = res && JSON.parse(Buffer.from(res.result).toString());
  if (!storage) return { ok: false, reason: `${account} is not registered for USDC on mainnet (needs storage_deposit on the USDC contract)` };
  return { ok: true };
}

export async function quote(opts, fetchImpl = fetch) {
  const body = quoteBody(opts);
  const r = await fetchImpl(`${ONECLICK}/v0/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `1Click quote ${r.status}`);
  return { request: body, quote: j.quote, signature: j.signature, timestamp: j.timestamp };
}

export async function status(depositAddress, fetchImpl = fetch) {
  const r = await fetchImpl(`${ONECLICK}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `1Click status ${r.status}`);
  return j;
}
