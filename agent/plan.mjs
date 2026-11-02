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
 * @param report  judgeInputs() output (mainnet judgements)
 * @param venues  vault get_venues(), optionally with `claimable` (bool) on staking venues
 * @param idle    { [token]: bigint } balance the vault holds outside venues
 * @returns steps sorted: blocks and cap cuts, then exits and claims, then supplies by
 *          best base rate, then holds
 */
export function planMoves(report, venues, idle, mirror = MIRROR, tag = 'policy', vault = null) {
  const steps = [];
  // Supplies the contract would refuse right now become holds with the reason.
  const supplyStop = vault?.paused ? 'vault paused by the risk feeder or owner'
    : vault && vault.moves_today >= vault.policy.max_moves_per_day && Date.now() * 1e6 < Number(vault.day_start_ns) + 86_400e9 ? 'daily move limit reached' : null;
  const budget = { ...idle }; // supplies of the same token share one idle balance
  const ordered = [...venues].sort((a, b) => apr(report, mirror, b) - apr(report, mirror, a));
  for (const v of ordered) {
    const m = report.venues.find((x) => x.id === mirror[v.id]);
    if (!m) continue;
    const j = m.judgement;
    const max = BigInt(v.venue.max_alloc);
    const cap = BigInt(v.effective_cap ?? v.venue.max_alloc);
    const pos = BigInt(v.position);
    const unb = BigInt(v.unbonding ?? 0);
    const reasons = j.reasons.filter((r) => r.level !== 'note').map((r) => r.text);
    // Policy target: the multiplier on this vault's own cap, then the exit-liquidity
    // ceiling in this vault's token units.
    let target = share(max, j.capMult);
    if (m.exit_ceiling != null) target = min(target, BigInt(Math.floor(m.exit_ceiling * 10 ** (m.decimals ?? 0))));
    const want = min(target, cap);
    const floor = share(max, MIN_MOVE_SHARE);
    const moveCap = BigInt(v.max_move);
    const blocked = j.verdict === 'block' || !!v.venue.blocked_reason;
    const base = { venue: v.id, mirrors: m.id, label: m.label, verdict: j.verdict, apr: m.live.apr_base, reasons, token: v.venue.token, have: pos, want, cap, unbonding: unb };

    if (j.verdict === 'block' && !v.venue.blocked_reason) {
      const why = j.reasons.find((r) => r.level === 'block')?.text || 'blocked';
      steps.push({ ...base, kind: 'block', reason: `${tag}: ${why}`.slice(0, 280), prio: 0 });
    } else if (!blocked && target < cap && cap - target >= floor) {
      // Put the policy's cap on chain, so a stolen agent key is held to it too.
      steps.push({ ...base, kind: 'tighten', amount: target, prio: 0 });
    }
    if (v.claimable && unb >= floor) steps.push({ ...base, kind: 'claim', amount: unb, prio: 1 });
    const exposure = pos + unb;
    // Safety exits ignore the gas-saving minimum: any position in a blocked venue leaves.
    if (pos > want && (pos - want >= floor || (blocked && pos > 0n))) {
      steps.push({ ...base, kind: 'withdraw', amount: min(pos - want, moveCap), prio: 1 });
    } else if (want > exposure && want - exposure >= floor && !blocked && v.venue.enabled !== false) {
      const amt = min(min(want - exposure, moveCap), budget[v.venue.token] ?? 0n);
      if (supplyStop) steps.push({ ...base, kind: 'hold', note: supplyStop, prio: 3 });
      else if (amt >= floor) {
        steps.push({ ...base, kind: 'supply', amount: amt, prio: 2 });
        budget[v.venue.token] = (budget[v.venue.token] ?? 0n) - amt;
      } else steps.push({ ...base, kind: 'hold', note: 'waiting for idle funds', prio: 3 });
    } else {
      const note = target > cap && target - cap >= floor ? 'held at the on-chain risk cap; the owner can raise it' : unb > 0n && !v.claimable ? 'unstaked NEAR still unbonding' : 'at target';
      steps.push({ ...base, kind: 'hold', note, prio: 3 });
    }
  }
  return steps.sort((a, b) => a.prio - b.prio || b.apr - a.apr);
}

const apr = (report, mirror, v) => report.venues.find((x) => x.id === mirror[v.id])?.live.apr_base ?? 0;

/** Milliseconds until the vault accepts another supply (exits never wait). */
export function cooldownLeft(vault, now = Date.now()) {
  if (!vault.last_move_ns) return 0;
  return Math.max(0, Number(BigInt(vault.last_move_ns) / 1_000_000n) + vault.policy.cooldown_s * 1000 - now);
}

/** JSON-safe copy of a step (bigints to strings). */
export const stepJSON = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));
