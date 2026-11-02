// Live inputs for each venue: yield, exit liquidity, venue switches, prices, incidents.
import { view, block } from './near.mjs';

const DAY = 86_400_000;

export async function rheaAssets(contract) {
  const assets = await view(contract, 'get_assets_paged_detailed', { from_index: 0, limit: 60 });
  return new Map(assets.map((a) => [a.token_id, a]));
}

/** Rhea Lend supply side for one token. Balances are 18-decimal internal units. */
export function rheaVenue(asset, extraDecimals, decimals) {
  const scale = 10 ** (decimals + extraDecimals);
  const supplied = Number(BigInt(asset.supplied.balance)) / scale;
  const borrowed = Number(BigInt(asset.borrowed.balance)) / scale;
  const farms = asset.farms || [];
  const rewardActive = farms.some((f) => f.rewards && Object.keys(f.rewards).length > 0);
  return {
    apr_base: Number(asset.supply_apr),
    apr_reward: 0, // farms are read below; any active reward is flagged, not added
    reward_farm_active: rewardActive,
    supplied,
    borrowed,
    utilization: supplied > 0 ? borrowed / supplied : 0,
    exit_liquidity: Math.max(0, supplied - borrowed),
    can_deposit: asset.config.can_deposit,
    can_withdraw: asset.config.can_withdraw,
  };
}

/** Realized LST yield from the share price now vs about 30 days ago (archival read). */
export async function lstVenue(contract, priceMethod) {
  const now = await block();
  const back = Math.round((30 * DAY) / 1000 / 0.6);
  const then = await block(now.height - back);
  const [pNow, pThen] = await Promise.all([
    view(contract, priceMethod),
    view(contract, priceMethod, {}, then.height),
  ]);
  const ratio = Number(BigInt(pNow) * 1_000_000_000n / BigInt(pThen)) / 1e9;
  const years = (now.ts - then.ts) / (365 * DAY);
  return {
    apr_base: Math.pow(ratio, 1 / years) - 1,
    apr_reward: 0,
    reward_farm_active: false,
    window_days: (now.ts - then.ts) / DAY,
    share_price: Number(BigInt(pNow) / 1_000_000_000_000_000n) / 1e9,
    can_deposit: true,
    can_withdraw: true,
    instant_exit: false, // 4-epoch unstake; no on-chain instant pool (see docs/venues.md)
  };
}

export async function prices(ids) {
  if (!ids.length) return {};
  const r = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}`);
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.coins || {}).map(([k, v]) => [k, v.price]));
}

/** Incidents from DefiLlama's public hacks feed, matched by protocol name. */
export async function incidents() {
  const r = await fetch('https://api.llama.fi/hacks');
  const all = await r.json();
  return all.map((h) => ({
    name: h.name,
    date: new Date(h.date * 1000).toISOString().slice(0, 10),
    ts: h.date * 1000,
    amount: h.amount,
    chain: h.chain,
    technique: h.technique,
    classification: h.classification,
    returned: h.returnedFunds,
  }));
}
