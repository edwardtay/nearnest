// Turns a mainnet report plus the vault's on-chain state into an ordered list of moves.
// Pure: no network, no keys. Used by scripts/run-agent.mjs (which signs) and by the
// server's /api/plan (which only shows what the agent would do next).

// The testnet vault takes its judgement from the matching mainnet venue.
export const MIRROR = { 'burrow-usdc': 'rhea-usdc', linear: 'linear' };
// Moves smaller than this share of the venue cap are not worth the gas.
export const MIN_MOVE_SHARE = 0.02;
// The vault contract keeps this much NEAR for gas and storage (NATIVE_RESERVE).
export const NATIVE_RESERVE = 5n * 10n ** 23n;
const STORAGE_PRICE = 10n ** 19n; // yocto per byte

const min = (a, b) => (a < b ? a : b);
const share = (x, s) => (x * BigInt(Math.round(s * 1e6))) / 1_000_000n;

/** NEAR the vault can stake right now, from a view_account result. */
export function spendableNative(acct) {
  const free = BigInt(acct.amount) - BigInt(acct.storage_usage) * STORAGE_PRICE - NATIVE_RESERVE;
  return free > 0n ? free : 0n;
}

/**
 * @param report  buildReport() output (mainnet judgements)
 * @param venues  vault get_venues()
 * @param idle    { [token]: bigint } balance the vault holds outside venues
 * @returns steps sorted: blocks, then exits, then supplies by best base rate, then holds
 */
export function planMoves(report, venues, idle, mirror = MIRROR) {
  const steps = [];
  for (const v of venues) {
    const m = report.venues.find((x) => x.id === mirror[v.id]);
    if (!m) continue;
    const j = m.judgement;
    const max = BigInt(v.venue.max_alloc);
    const pos = BigInt(v.position);
    const reasons = j.reasons.filter((r) => r.level !== 'note').map((r) => r.text);
    const want = share(max, m.max_alloc ? Math.min(1, m.target / m.max_alloc) : 0);
    const floor = share(max, MIN_MOVE_SHARE);
    const cap = BigInt(v.max_move);
    const base = { venue: v.id, mirrors: m.id, label: m.label, verdict: j.verdict, apr: m.live.apr_base, reasons, token: v.venue.token, have: pos, want };

    if (j.verdict === 'block' && !v.venue.blocked_reason) {
      steps.push({ ...base, kind: 'block', reason: `policy: ${reasons[0] || 'blocked'}`.slice(0, 280), prio: 0 });
    }
    if (pos > want && pos - want >= floor) {
      steps.push({ ...base, kind: 'withdraw', amount: min(pos - want, cap), prio: 1 });
    } else if (want > pos && want - pos >= floor && j.verdict !== 'block' && !v.venue.blocked_reason) {
      const amt = min(min(want - pos, cap), idle[v.venue.token] ?? 0n);
      if (amt >= floor) steps.push({ ...base, kind: 'supply', amount: amt, prio: 2 });
      else steps.push({ ...base, kind: 'hold', note: 'waiting for idle funds', prio: 3 });
    } else {
      steps.push({ ...base, kind: 'hold', note: 'at target', prio: 3 });
    }
  }
  return steps.sort((a, b) => a.prio - b.prio || b.apr - a.apr);
}

/** Milliseconds until the vault accepts another supply (exits never wait). */
export function cooldownLeft(vault, now = Date.now()) {
  if (!vault.last_move_ns) return 0;
  return Math.max(0, Number(BigInt(vault.last_move_ns) / 1_000_000n) + vault.policy.cooldown_s * 1000 - now);
}

/** JSON-safe copy of a step (bigints to strings). */
export const stepJSON = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));
