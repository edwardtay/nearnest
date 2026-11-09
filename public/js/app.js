// NEARnest app: hash-routed views over /api/scan (mainnet yields judged), /api/vault
// (live vault read), /api/plan (the agent's next move), /api/agent (moves made) and
// /api/drill (recorded attack drill), /api/scenario (what-if events). No framework, no keys.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Account ids break only after a dot, never inside a word.
// Implicit accounts (64 hex characters) have no dots, so a part that long may wrap anywhere.
const acct = (s) => esc(s).split('.').map((p) => (p.length > 32 ? `<span class="hexid">${p}</span>` : `<span class="nb">${p}</span>`)).join('.<wbr>');
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const num = (x, d = 2) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const usd = (x) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LOGO = {
  // keyed by protocol name and by testnet contract
  'Rhea Lend': '/img/rhea.png',
  'Rhea LST': '/img/rhea.png',
  LiNEAR: '/img/linear.png',
  'contract.1638481328.burrow.testnet': '/img/rhea.png',
  'linear-protocol.testnet': '/img/linear.png',
  'contract.main.burrow.near': '/img/rhea.png',
  'linear-protocol.near': '/img/linear.png',
};
const VENUE = {
  'burrow-usdc': { name: 'Burrow USDC', logo: '/img/rhea.png', color: '#0ea5e9', token: 'usdc', sym: 'USDC', price: 'coingecko:usd-coin' },
  linear: { name: 'LiNEAR', logo: '/img/linear.png', color: '#8b5cf6', token: 'near', sym: 'NEAR', price: 'coingecko:near' },
};
const MIRROR_NAME = { 'rhea-usdc': 'Rhea Lend USDC', linear: 'LiNEAR' };
const VERDICT = { allow: 'Allowed', cap: 'Capped', block: 'Blocked' };
const state = { scan: null, vault: null, plan: null, agent: null, drill: null, at: 0, cooldownEnd: 0 };

function ent(name, logo, small) {
  return `<span class="ent"><span class="logo">${logo ? `<img src="${logo}" alt="" width="24" height="24">` : ''}</span><span class="nm">${esc(name)}${small ? `<small class="mono acct">${acct(small)}</small>` : ''}</span></span>`;
}
function units(raw, token) {
  if (raw == null) return 'n/a';
  const d = token === 'near' ? 24 : 6;
  return num(Number(BigInt(raw) * 1000n / 10n ** BigInt(d)) / 1000, 3);
}
const toNum = (raw, token) => Number(BigInt(raw ?? 0) * 1_000_000n / 10n ** BigInt(token === 'near' ? 24 : 6)) / 1e6;
const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const sym = (t) => (t === 'near' ? 'NEAR' : t === MAINNET_USDC || t.startsWith('usdc') ? 'USDC' : t.startsWith('usdt') ? 'USDt' : t);
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 1800);
}

// Which vault the Overview, Vault, Agent and What if views show. Mainnet by default; the
// testnet demo vault holds test tokens with no value and runs the drill and the factory.
const NETS = ['mainnet', 'testnet'];
let NETWORK = (() => { try { const q = new URLSearchParams(location.search).get('net'); return NETS.includes(q) ? q : localStorage.getItem('nearnest-net') || 'mainnet'; } catch { return 'mainnet'; } })();
if (!NETS.includes(NETWORK)) NETWORK = 'mainnet';
const EXPLORER = () => (NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io');
const withNet = (url, net = NETWORK) => `${url}${url.includes('?') ? '&' : '?'}net=${net}`;

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------- router

const VIEWS = ['overview', 'mine', 'yield', 'vault', 'agent', 'whatif', 'drill', 'about'];
function route() {
  const [hv, arg] = location.hash.slice(1).split('/');
  const v = VIEWS.includes(hv) ? hv : 'overview';
  if (v === 'whatif') openWhatIf(arg);
  if (v === 'mine') openMine();
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  document.querySelectorAll('.side a').forEach((a) => (a.dataset.v === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const h = $(`[data-view="${v}"] h2`).textContent;
  document.title = v === 'overview' ? 'NEARnest: a yield agent held to an on-chain policy · web3wagmi' : `${h} · NEARnest · web3wagmi`;
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

// ----------------------------------------------------------------- overview

function renderOverview() {
  const { plan, scan } = state;
  if (!plan || !scan) return;
  const px = scan.prices || {};
  // One row per venue: a block and an exit for the same venue share one position.
  const rows = plan.steps.filter((s, k, a) => a.findIndex((x) => x.venue === s.venue) === k).map((s) => {
    const v = VENUE[s.venue];
    const amount = toNum(s.have, s.token);
    return { ...s, v, amount, usd: amount * (px[v?.price] ?? 0) };
  }).filter((r) => r.v);
  const total = rows.reduce((a, r) => a + r.usd, 0);
  const earn = rows.reduce((a, r) => a + r.usd * r.apr, 0);
  $('#pos-usd').textContent = usd(total);
  const testNote = NETWORK === 'testnet' ? ' Testnet tokens, no real value.' : '';
  $('#pos-s').textContent = (total ? `Earning ${pct(earn / total)} blended, about ${usd(earn)} a year at today's rates.` : 'Nothing supplied yet.') + testNote;
  $('#pos-bar').innerHTML = rows.map((r) => `<i style="width:${total ? (r.usd / total) * 100 : 0}%;background:${r.v.color}"></i>`).join('');
  $('#pos-legend').innerHTML = rows.map((r) => `<li><span class="sw" style="background:${r.v.color}"></span>${ent(r.v.name, r.v.logo)}
    <span class="amt">${num(r.amount, 3)} ${r.v.sym}</span><span class="apr">${pct(r.apr)}</span></li>`).join('');
  const idle = Object.entries(plan.idle).map(([t, b]) => `${units(b, t)} ${sym(t)}`).join(' and ');
  $('#pos-idle').textContent = `Idle in the vault: ${idle}. NEAR at ${usd(px['coingecko:near'] ?? 0)}.`;

  const next = plan.steps.find((s) => s.kind !== 'hold');
  const card = $('#next');
  card.classList.remove('is-supply', 'is-exit');
  if (!next) {
    $('#next-pill').innerHTML = '<span class="pill hold">Holding</span>';
    $('#next-lead').textContent = 'Nothing to do';
    const waiting = plan.steps.filter((s) => s.note === 'waiting for idle funds').map((s) => VENUE[s.venue]?.name || s.venue);
    $('#next-why').innerHTML = `<li>Every venue is at the size the policy allows${waiting.length ? `, except ${esc(waiting.join(' and '))}, which waits for idle funds` : ''}.</li>`;
  } else {
    const v = VENUE[next.venue] || { name: next.venue, sym: '' };
    card.classList.add(next.kind === 'supply' ? 'is-supply' : 'is-exit');
    $('#next-pill').innerHTML = `<span class="pill ${next.verdict}">${VERDICT[next.verdict]}</span>`;
    const verb = { supply: 'Supply', withdraw: 'Withdraw', block: 'Block', tighten: 'Cap', claim: 'Claim' }[next.kind];
    const amt = next.amount ? `<span class="fig">${units(next.amount, next.token)} ${v.sym}</span> ` : '';
    const prep = next.kind === 'supply' ? 'to' : next.kind === 'withdraw' || next.kind === 'claim' ? 'from' : next.kind === 'tighten' ? 'on' : '';
    $('#next-lead').innerHTML = `${verb} ${amt}${prep} ${esc(v.name)}`;
    const why = [
      `${MIRROR_NAME[next.mirrors] || next.mirrors} pays ${pct(next.apr)} on mainnet.`,
      `Holds ${units(next.have, next.token)}, policy target ${units(next.want, next.token)} ${v.sym}.`,
      ...next.reasons,
    ];
    $('#next-why').innerHTML = why.map((r) => `<li>${esc(r)}</li>`).join('');
  }
  state.cooldownEnd = Date.now() + (plan.cooldown_ms || 0);
  tickCooldown();
}

function tickCooldown() {
  const left = Math.ceil((state.cooldownEnd - Date.now()) / 1000);
  const html = left > 0 ? `Vault cooldown: next supply in <b>${left}s</b>` : 'Vault ready for the next move';
  $('#next-cool').innerHTML = html;
  $('#plan-cool').innerHTML = html;
}

const ICON = { tighten: 'M4 7h16M7 12h10M10 17h4', claim: 'M12 4v11M7 10l5 5 5-5M5 20h14', supply: 'M12 19V5M6 11l6-6 6 6', withdraw: 'M12 5v14M6 13l6 6 6-6', block: 'M5.5 5.5l13 13M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18', unblock: 'M8 11V7a4 4 0 0 1 7.5-2M5 11h14v10H5z' };
function feedItem(m, v) {
  const sc = m.scenario ? (state.scenarios?.find((x) => x.id === m.scenario)?.title || m.scenario) : null;
  const t = m.kind === 'block' ? `Risk feeder blocked ${v.name}` : m.kind === 'unblock' ? `Owner reopened ${v.name}`
    : m.kind === 'tighten' ? `Risk feeder capped ${v.name} at ${units(m.amount, v.token)} ${v.sym} on chain`
    : m.kind === 'claim' ? `Claimed unstaked ${v.sym} from ${v.name}`
    : `${m.kind === 'supply' ? 'Supplied' : 'Withdrew'} ${m.amount ? `${units(m.amount, v.token)} ${v.sym} ` : ''}${m.kind === 'supply' ? 'to' : 'from'} ${v.name}`;
  const d = m.kind === 'unblock' ? 'Only the owner key can reopen a blocked venue.'
    : m.kind === 'tighten' ? `The policy's size is now binding for any holder of the agent key${m.reasons?.length ? `: ${m.reasons[0]}` : ''}`
    : `${sc ? `Simulated event: ${sc}. ` : ''}${VERDICT[m.verdict]} by the policy${m.reasons?.length ? `: ${m.kind === 'supply' ? m.reasons[0] : m.reasons[m.reasons.length - 1]}` : ''}`;
  if (!m.ok) return { at: m.at, kind: 'block', icon: ICON.block, t: `Refused: ${t}`, d: cleanReason(m.reason), tx: m.tx };
  return { at: m.at, kind: m.kind === 'supply' || m.kind === 'unblock' ? 'allow' : 'block', icon: ICON[m.kind] || ICON.supply, t, d, tx: m.tx };
}
const feedLi = (i) => `<li>
    <span class="dot ${i.kind}"><svg viewBox="0 0 24 24"><path d="${i.icon}"/></svg></span>
    <div><div class="t">${esc(i.t)}</div><div class="d">${esc(i.d)}</div></div>
    <div class="when">${ago(i.at)}${i.tx ? `<a href="${esc(i.tx)}">Transaction</a>` : i.href ? `<a href="${i.href}">Details</a>` : ''}</div></li>`;

function renderFeed() {
  const items = [];
  for (const m of state.agent?.moves || []) {
    const v = VENUE[m.venue] || { name: m.venue, sym: '' };
    items.push(feedItem(m, v));
  }
  const d = NETWORK === 'testnet' ? state.drill : null;
  if (d) {
    const stopped = d.results.filter((r) => r.expect === 'rejected' && r.pass).length;
    const attacks = d.results.filter((r) => r.expect === 'rejected').length;
    items.push({ at: d.ran_at, kind: 'block', icon: 'M8 8l8 8M16 8l-8 8', t: `Attack drill: ${stopped} of ${attacks} abuse attempts refused`,
      d: 'A script holding the real agent key tried transfers, owner calls, unknown venues and oversize moves.', href: '#drill' });
  }
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  $('#feed').innerHTML = items.slice(0, 6).map(feedLi).join('') || '<li class="loading">No activity yet.</li>';
  renderScenarioLog();
}

// ------------------------------------------------------------- yield, judged

function renderScan(rep) {
  const rows = rep.venues.map((v) => {
    const j = v.judgement;
    const share = v.max_alloc ? Math.min(1, v.target / v.max_alloc) : 0;
    const reasons = j.reasons.length ? `<ul>${j.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>` : 'No flags.';
    return `<tr>
      <th scope="row">${ent(v.label, LOGO[v.protocol], v.contract)}</th>
      <td class="n">${pct(v.live.apr_base)}</td>
      <td><div class="alloc"><span class="pill ${j.verdict}">${VERDICT[j.verdict]}</span>
        <span class="amt">${num(v.target)} of ${num(v.max_alloc)} ${esc(v.symbol)}</span>
        <span class="bar" aria-hidden="true"><i style="width:${(share * 100).toFixed(0)}%"></i></span></div></td>
      <td class="why">${reasons}</td>
    </tr>`;
  });
  $('#yield-tbl tbody').innerHTML = rows.join('');
  $('#yield-foot').textContent = `Read ${new Date(rep.generated_at).toUTCString()}. Caps shown against an example vault of 50 USDC, 50 USDt and 20 NEAR per venue.`;

  const best = [...rep.venues].sort((a, b) => b.live.apr_base - a.live.apr_base)[0];
  $('#st-best').textContent = pct(best.live.apr_base);
  $('#st-best-s').textContent = `${best.label}, ${VERDICT[best.judgement.verdict].toLowerCase()} by the policy`;
  const full = rep.venues.filter((v) => v.judgement.verdict === 'allow').length;
  const capped = rep.venues.filter((v) => v.judgement.verdict === 'cap').length;
  const blocked = rep.venues.filter((v) => v.judgement.verdict === 'block').length;
  $('#st-ok').textContent = `${full + capped} of ${rep.venues.length}`;
  $('#st-ok-s').textContent = `${full} at full size, ${capped} capped, ${blocked} blocked`;

  const r = rep.rules;
  $('#policy-rules').innerHTML = `<ul>
    <li>An exploit in the last ${r.recentIncidentDays} days blocks the venue.</li>
    <li>An exploit in the last ${r.incidentMemoryDays} days caps it at ${r.capAfterUnreturnedIncident * 100}% if funds were not returned, ${r.capAfterReturnedIncident * 100}% if they were. This applies to the protocol and to any protocol it depends on.</li>
    <li>Lending utilization at ${r.utilizationBlock * 100}% or more blocks the venue; ${r.utilizationCap * 100}% or more caps it at ${r.capAtHighUtilization * 100}%.</li>
    <li>The vault never holds more than ${r.maxShareOfExitLiquidity * 100}% of what can leave a lending pool right now.</li>
    <li>A stablecoin ${r.depegBlock * 100}% or more off its peg blocks every venue that holds it.</li>
    <li>Yield counts the base rate only. Token rewards are flagged and left out.</li>
  </ul>`;
}

// ---------------------------------------------------------------- the vault

function renderVault(v) {
  const dep = v.deployment;
  const ex = v.network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
  $('#vault-sub').innerHTML = `Live read of <a href="${ex}/address/${esc(dep.vault)}">${esc(dep.vault)}</a> on NEAR ${esc(v.network)}, owned by ${esc(dep.owner)}.`;

  const full = v.access_keys.filter((k) => k.access_key.permission === 'FullAccess').length;
  $('#st-keys').textContent = String(v.access_keys.length);
  $('#st-keys-s').textContent = full ? `${full} full-access` : 'agent key only, no full-access key';
  $('#keys').innerHTML = v.access_keys.map((k) => {
    const p = k.access_key.permission;
    if (p === 'FullAccess') return `<li><b>Full access</b><div class="mono">${esc(k.public_key)}</div></li>`;
    const fc = p.FunctionCall;
    const allowance = fc.allowance ? `${units(fc.allowance, 'near')} NEAR gas allowance` : 'no allowance cap';
    return `<li><b>Agent key</b>, function-call only, ${allowance}
      <div class="mono">${esc(k.public_key)}</div>
      <div class="perm">${fc.method_names.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div></li>`;
  }).join('');

  const pol = v.vault.policy;
  const bal = Object.entries(v.balances).map(([t, b]) => `${units(b, t)} ${sym(t)}`).join(', ');
  $('#rules').innerHTML = `
    <dt>Owner</dt><dd class="mono acct">${acct(v.vault.owner)}</dd>
    <dt>Risk feeder</dt><dd class="mono acct">${acct(v.vault.risk_feeder || 'none')}</dd>
    <dt>Cooldown</dt><dd>${pol.cooldown_s} s between moves</dd>
    <dt>Daily limit</dt><dd>${pol.max_moves_per_day} moves</dd>
    <dt>Paused</dt><dd>${v.vault.paused ? 'yes' : 'no'}</dd>
    <dt>Idle in vault</dt><dd>${esc(bal || 'n/a')}; ${units(v.native_yocto, 'near')} NEAR</dd>`;

  $('#venue-tbl tbody').innerHTML = v.venues.map((x) => {
    const st = x.venue.blocked_reason ? `<span class="pill block">Blocked</span><div class="note">${esc(x.venue.blocked_reason)}</div>`
      : x.venue.enabled ? '<span class="pill allow">Open</span>' : '<span class="pill cap">Disabled</span>';
    return `<tr><th scope="row">${ent(VENUE[x.id]?.name || x.id, LOGO[x.venue.contract], x.venue.contract)}</th><td>${st}</td>
      <td class="n">${units(x.position, x.venue.token)} ${sym(x.venue.token)}${BigInt(x.unbonding ?? 0) >= 10n ** 18n ? `<div class="note">${units(x.unbonding, x.venue.token)} unbonding</div>` : ''}</td>
      <td class="n">${units(x.effective_cap ?? x.venue.max_alloc, x.venue.token)}${x.risk_cap ? `<div class="note">risk cap (venue cap ${units(x.venue.max_alloc, x.venue.token)})</div>` : ''}</td>
      <td class="n">${units(x.max_move, x.venue.token)}</td></tr>`;
  }).join('');

  const blocked = v.venues.filter((x) => x.venue.blocked_reason).length;
  const hs = $('#health-state');
  hs.textContent = v.vault.paused ? 'Paused' : blocked ? `${blocked} venue blocked` : 'Running';
  hs.className = v.vault.paused || blocked ? 'bad' : 'ok';
  $('#health-s').textContent = `${full ? `${full} full-access key` : 'No full-access key'}. ${v.vault.moves_today} of ${pol.max_moves_per_day} moves used today.`;
}

// ---------------------------------------------------------------- the agent

const SIGNER = {
  block: 'Signed by the risk feeder: block_venue.',
  tighten: 'Signed by the risk feeder: set_risk_cap. Only the owner can raise it again.',
  claim: 'Signed by the agent key: agent_claim_unstaked.',
  withdraw: 'Signed by the agent key. Exits skip the cooldown.',
  supply: 'Signed by the agent key, after the cooldown.',
};
function planHTML(steps) {
  return steps.map((s) => {
    const v = VENUE[s.venue] || { name: s.venue, sym: '' };
    const go = s.kind !== 'hold';
    const t = go
      ? s.kind === 'tighten' ? `Lower the cap on ${v.name} to ${units(s.amount, s.token)} ${v.sym}`
        : s.kind === 'claim' ? `Claim ${units(s.amount, s.token)} unstaked ${v.sym} from ${v.name}`
        : `${{ supply: 'Supply', withdraw: 'Withdraw', block: 'Block' }[s.kind]} ${s.amount ? `${units(s.amount, s.token)} ${v.sym} ` : ''}${s.kind === 'supply' ? 'to' : s.kind === 'withdraw' ? 'from' : ''} ${v.name}`
      : `Hold ${v.name}`;
    let d = `${units(s.have, s.token)} of ${units(s.want, s.token)} ${v.sym} target. ${MIRROR_NAME[s.mirrors] || s.mirrors} at ${pct(s.apr)}${s.note ? `, ${s.note}` : ''}.`;
    if (s.kind === 'block') d = `Reason on chain: "${s.reason}".`;
    if (s.kind === 'tighten') d = `Policy size ${units(s.amount, s.token)} of ${units(s.cap, s.token)} ${v.sym} allowed on chain now. Puts the policy cap on chain, so a stolen agent key is held to it too.`;
    if (go) d += ` ${SIGNER[s.kind]}`;
    if (s.kind === 'withdraw' && s.token === 'near') d += ' Unstaked NEAR returns after 4 epochs.';
    return `<li class="${go ? 'go' : ''}"><div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></div><span class="pill ${go ? s.verdict : 'hold'}">${go ? VERDICT[s.verdict] : 'Hold'}</span></li>`;
  }).join('');
}
function renderPlan(p) { $('#plan').innerHTML = planHTML(p.steps); }

const VERB = { supply: 'Supplied to', withdraw: 'Withdrew from', block: 'Blocked', unblock: 'Owner reopened', tighten: 'Capped', claim: 'Claimed from' };
function renderMoves(a) {
  const rows = [...a.moves].reverse().map((m) => {
    const v = VENUE[m.venue] || { name: m.venue, token: 'usdc', sym: '' };
    const amt = m.amount ? `${units(m.amount, v.token)} ${v.sym}` : '';
    const pill = m.kind === 'unblock' ? '<span class="pill hold">Owner</span>' : `<span class="pill ${m.verdict}">${VERDICT[m.verdict]}</span>`;
    const sc = m.scenario ? `<div class="note">Simulated event: ${esc(state.scenarios?.find((x) => x.id === m.scenario)?.title || m.scenario)}</div>` : '';
    const why = m.reasons.length ? `<ul>${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : 'No flags.';
    const tgt = m.target ? `<div class="note">Target ${units(m.target, v.token)}, from mainnet ${esc(MIRROR_NAME[m.mirrors] || m.mirrors)} at ${pct(m.apr)}</div>` : '';
    return `<tr><th scope="row">${ent(`${VERB[m.kind] || m.kind} ${v.name}`, v.logo, new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')}</th>
      <td class="n">${amt}</td><td class="why"><div class="vd">${pill}</div>${why}${tgt}${sc}</td>
      <td>${m.ok ? `<a href="${esc(m.tx)}">Transaction</a>` : `Refused: ${esc(cleanReason(m.reason))}`}</td></tr>`;
  });
  $('#moves-tbl tbody').innerHTML = rows.join('') || '<tr><td colspan="4" class="loading">No moves yet.</td></tr>';
  const lr = a.last_run ? `Last agent run ${new Date(a.last_run.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${a.last_run.result}. ` : '';
  $('#moves-foot').textContent = NETWORK === 'mainnet'
    ? `${lr}The mainnet vault holds real funds. Every round reads mainnet risk again before the agent signs.`
    : `${lr}The testnet vault takes its judgement from the matching mainnet venue: Burrow testnet follows Rhea Lend USDC, LiNEAR testnet follows LiNEAR. Every round reads mainnet risk again before the agent signs.`;
}

// ----------------------------------------------------------------- my vault

const USDC_T = 'usdc.fakes.testnet';
const ONE_NEAR = 10n ** 24n;
const mine = { w: null, account: null, factory: null, vault: null, snap: null };

async function loadWallet() {
  if (mine.w) return mine.w;
  if (!document.querySelector('link[href="/css/wallet-modal.css"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/wallet-modal.css'; document.head.append(l);
  }
  const w = await import('/js/wallet.js');
  mine.account = await w.init('testnet');
  w.onChange((a) => { mine.account = a; renderMine(); });
  mine.w = w;
  return w;
}

async function loadFactory(force) {
  if (!mine.factory || force) mine.factory = await getJSON('/api/factory');
  document.querySelectorAll('.factory-id').forEach((el) => { el.innerHTML = acct(mine.factory.factory); });
  const vs = mine.factory.vaults;
  $('#fac-count').textContent = `${vs.length} so far`;
  $('#fac-list').innerHTML = vs.map((v) => `<li><span class="mono">${acct(v.id)}<small class="acct"> owned by ${acct(v.owner)}</small></span>
    <a href="https://testnet.nearblocks.io/address/${esc(v.id)}">Explorer</a></li>`).join('') || '<li class="loading">None yet. Be the first.</li>';
}

// Local preview of the signed-in screens (render only, nothing can be signed): localhost only.
const PREVIEW_AS = location.hostname === 'localhost' ? new URLSearchParams(location.search).get('preview_as') : null;

async function openMine() {
  loadFund();
  if (PREVIEW_AS) { mine.account = PREVIEW_AS; await loadFactory().catch(() => {}); return renderMine(); }
  try { await loadFactory(); } catch (e) { $('#fac-list').innerHTML = `<li class="loading">Could not read the factory: ${esc(e.message)}</li>`; }
  try { await loadWallet(); } catch (e) { toast('The wallet could not load'); console.error(e); }
  renderMine();
}

function whoHTML(a) {
  return `Signed in as <b class="mono">${acct(a)}</b> <button type="button" data-act="signout">Sign out</button>`;
}

async function renderMine() {
  const a = mine.account;
  $('#mine-connect').hidden = !!a;
  if (!a || !mine.factory) { $('#mine-create').hidden = true; $('#mine-vault').hidden = true; return; }
  const own = mine.factory.vaults.filter((v) => v.owner === a);
  if (!own.length) {
    $('#mine-create').hidden = false; $('#mine-vault').hidden = true;
    $('#mine-who-1').innerHTML = whoHTML(a);
    const min = BigInt(mine.factory.min_deposit);
    $('#mine-create-btn').textContent = `Create vault (attach ${num(Number(min + ONE_NEAR) / 1e24, 2)} NEAR)`;
    if (!$('#mine-name').value) $('#mine-name').value = a.split('.')[0].replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'my-vault';
    checkName();
    return;
  }
  $('#mine-create').hidden = true; $('#mine-vault').hidden = false;
  $('#mine-who-2').innerHTML = whoHTML(a);
  mine.vault = own[own.length - 1].id;
  const [snap, plan] = await Promise.all([getJSON(withNet(`/api/vault?vault=${encodeURIComponent(mine.vault)}`, 'testnet')), getJSON(withNet(`/api/plan?vault=${encodeURIComponent(mine.vault)}`, 'testnet'))]);
  mine.snap = snap;
  const keys = snap.access_keys;
  const full = keys.filter((k) => k.access_key.permission === 'FullAccess').length;
  const agentKey = keys.some((k) => k.public_key === snap.vault.agent_key);
  $('#mine-title').innerHTML = `<a href="https://testnet.nearblocks.io/address/${esc(mine.vault)}">${acct(mine.vault)}</a>`;
  const idleUsdc = BigInt(snap.balances[USDC_T] ?? 0);
  $('#mine-sub').innerHTML = `${full ? `<b>${full} full-access key.</b>` : 'No full-access key.'} ${agentKey ? 'The agent key is on the vault.' : '<b>The agent key is removed.</b>'}
    ${snap.vault.paused ? '<b>Paused.</b>' : ''} Idle in the vault: ${units(idleUsdc, 'usdc')} USDC and ${units(snap.native_yocto, 'near')} NEAR (most of the NEAR pays for the vault's code storage).`;
  $('#mine-tbl tbody').innerHTML = snap.venues.map((x) => {
    const st = x.venue.blocked_reason ? `<span class="pill block">Blocked</span><div class="note">${esc(x.venue.blocked_reason)}</div>` : '<span class="pill allow">Open</span>';
    return `<tr><th scope="row">${ent(VENUE[x.id]?.name || x.id, LOGO[x.venue.contract], x.venue.contract)}</th><td>${st}</td>
      <td class="n">${units(x.position, x.venue.token)} ${sym(x.venue.token)}</td>
      <td class="n">${units(x.effective_cap ?? x.venue.max_alloc, x.venue.token)}${x.risk_cap ? '<div class="note">risk cap</div>' : ''}</td>
      <td class="n">${units(x.max_move, x.venue.token)}</td></tr>`;
  }).join('');
  $('#mine-plan').innerHTML = planHTML(plan.steps);
  const acts = [
    { id: 'mint', t: 'Get 50 test USDC', s: 'Public faucet token, minted into the vault', ok: true },
    { id: 'near', t: 'Send 1 NEAR', s: 'For the agent to stake in LiNEAR', ok: true },
    { id: 'withdraw', t: `Withdraw ${units(idleUsdc, 'usdc')} USDC to me`, s: 'owner_withdraw: idle USDC to your account', ok: idleUsdc > 0n },
    snap.vault.paused ? { id: 'unpause', t: 'Unpause', s: 'Supply moves resume', ok: true } : { id: 'pause', t: 'Pause', s: 'Stops supply; exits still work', ok: true, warn: true },
    agentKey ? { id: 'rmkey', t: 'Remove the agent key', s: 'The agent can no longer sign for this vault', ok: true, warn: true } : { id: 'addkey', t: 'Restore the agent key', s: 'Function-call key, 0.5 NEAR gas allowance', ok: true },
    ...snap.venues.filter((x) => x.venue.blocked_reason).map((x) => ({ id: `unblock:${x.id}`, t: `Unblock ${VENUE[x.id]?.name || x.id}`, s: 'Only the owner can reopen a venue', ok: true })),
  ];
  $('#mine-acts').innerHTML = acts.map((b) => `<button type="button" data-act="${esc(b.id)}" class="${b.warn ? 'warn' : ''}" ${b.ok ? '' : 'disabled'}>${esc(b.t)}<small>${esc(b.s)}</small></button>`).join('');
}

let nameTimer;
function checkName() {
  clearTimeout(nameTimer);
  const n = $('#mine-name').value.trim().toLowerCase();
  const hint = $('#mine-name-hint');
  nameTimer = setTimeout(async () => {
    const r = await getJSON(`/api/name?n=${encodeURIComponent(n)}`).catch(() => null);
    if (!r) { hint.textContent = ''; return; }
    hint.className = `hint ${r.valid && r.free ? 'ok' : 'bad'}`;
    hint.textContent = !r.valid ? '2 to 32 of a to z, 0 to 9 and single dashes.' : r.free ? `${r.account} is free.` : `${r.account} is taken.`;
    $('#mine-create-btn').disabled = !(r.valid && r.free);
  }, 250);
}

async function act(id) {
  const w = mine.w;
  if (id === 'signout') { await w.signOut(); return; }
  if (id === 'signin') { w.signIn(); return; }
  const v = mine.vault;
  const runs = {
    create: () => w.send(mine.factory.factory, [{ method: 'create_vault', args: { name: $('#mine-name').value.trim().toLowerCase() }, deposit: String(BigInt(mine.factory.min_deposit) + ONE_NEAR), tgas: 300 }]),
    mint: () => w.send(USDC_T, [{ method: 'mint', args: { account_id: v, amount: String(50e6) }, tgas: 30 }]),
    near: () => w.send(v, [{ transfer: String(ONE_NEAR) }]),
    withdraw: () => w.send(v, [{ method: 'owner_withdraw', args: { token: USDC_T, amount: String(mine.snap.balances[USDC_T]) }, tgas: 50 }]),
    pause: () => w.send(v, [{ method: 'pause', tgas: 30 }]),
    unpause: () => w.send(v, [{ method: 'unpause', tgas: 30 }]),
    rmkey: () => w.send(v, [{ method: 'remove_agent_key', tgas: 30 }]),
    addkey: () => w.send(v, [{ method: 'add_agent_key', args: { allowance: String(ONE_NEAR / 2n) }, tgas: 30 }]),
  };
  const run = id.startsWith('unblock:') ? () => w.send(v, [{ method: 'unblock_venue', args: { venue_id: id.slice(8) }, tgas: 30 }]) : runs[id];
  if (!run) return;
  try {
    const o = await run();
    const fail = o && [o.status, ...(o.receipts_outcome || []).map((r) => r.outcome.status)].find((x) => x?.Failure);
    toast(fail ? 'The transaction was refused' : 'Sent');
  } catch (e) {
    toast(String(e.message || e).slice(0, 80));
  }
  setTimeout(async () => { await loadFactory(true).catch(() => {}); renderMine(); }, 2500);
}

document.querySelector('[data-view="mine"]').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (b) act(b.dataset.act);
});
$('#mine-signin').addEventListener('click', async () => { try { (await loadWallet()).signIn(); } catch { toast('The wallet could not load'); } });
$('#mine-create-btn').addEventListener('click', () => act('create'));
$('#mine-name').addEventListener('input', checkName);
// Browser wallets return here with ?transactionHashes=... after signing.
if (new URLSearchParams(location.search).has('transactionHashes') || new URLSearchParams(location.search).has('account_id')) {
  history.replaceState(null, '', `${location.pathname}#mine`);
  setTimeout(() => toast('Signed in your wallet'), 300);
}

// ----------------------------------------------------------- NEAR AI proposals

const AI_OUTCOME = { accepted: 'Accepted', clipped: 'Cut to bound', refused: 'Refused', hold: 'Hold' };
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
function aiAmount(raw, venue) {
  if (raw == null) return '';
  const v = VENUE[venue];
  try { return v ? `${units(raw, v.token)} ${v.sym}` : `${BigInt(raw).toLocaleString('en-US')} base units`; } catch { return esc(String(raw)); }
}
function renderAI(d) {
  const rows = d.proposals.map((p) => {
    const pr = p.proposal || {};
    const vname = VENUE[pr.venue]?.name || pr.venue || '';
    const what = pr.action === 'hold' ? 'Hold' : pr.action ? `${pr.action[0].toUpperCase()}${pr.action.slice(1)} ${aiAmount(pr.amount, pr.venue)} to ${vname}` : 'No valid move';
    const tags = [
      p.network === 'mainnet' ? '<span class="tag main">Mainnet</span>' : '<span class="tag">Testnet</span>',
      p.simulated ? '<span class="tag warn">Simulated compromised model</span>' : `<span class="tag">${esc(p.model)}</span>`,
      p.injected ? '<span class="tag warn">Hostile instruction planted in the data</span>' : '',
      p.dry ? '<span class="tag">Dry run</span>' : '',
      `<span class="tag">${new Date(p.at).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>`,
    ].join('');
    const res = p.outcome === 'clipped' ? `Policy cut it to ${aiAmount(p.step.amount, p.step.venue)}.`
      : p.outcome === 'accepted' ? 'Policy accepted it.' : p.outcome === 'hold' ? 'Nothing to sign.' : `Refused because ${esc(p.why[0])}.`;
    const tx = p.tx ? (p.ok ? ` <a href="${esc(p.tx)}">Signed and executed</a>.` : ` The vault refused it on chain: ${esc(cleanReason(p.reason))}.`) : '';
    const v = p.evidence?.verify;
    const ok = v && v.text_matches && v.signer_matches && v.attested_signer;
    const att = p.evidence?.attestation;
    const ev = p.simulated ? '<p class="ev">No model was called: this row shows what the policy check does with a hostile answer. Nothing was signed.</p>'
      : `<p class="ev">${ok ? `Signature checked: the hashes of the request and reply match the signed text, and the signer <code>${esc(short(p.evidence.signing_address))}</code> is the key named in NEAR AI's TEE attestation${att?.models?.[0]?.verified ? ` (model attested via ${esc(att.models[0].provider)})` : ''}.` : 'Signature not verified.'} <a href="/api/ai/evidence?chat_id=${encodeURIComponent(p.chat_id)}">Request, reply and signature</a></p>`;
    return `<li><div class="top"><span class="pill ${p.outcome === 'hold' ? 'holdai' : esc(p.outcome)}">${AI_OUTCOME[p.outcome] || esc(p.outcome)}</span><span class="t">${esc(what)}</span></div>
      <div class="tags">${tags}</div>
      ${pr.reason ? `<p class="q">${esc(pr.reason)}</p>` : ''}
      <p class="res">${res}${tx}</p>${ev}</li>`;
  });
  $('#ai-list').innerHTML = rows.join('') || '<li class="loading">No proposals yet. Run <code>node scripts/run-agent.mjs --ai</code>.</li>';
}

// ------------------------------------------------------- fund from any chain
// Live 1Click quotes (NEAR Intents): a token on its own chain in, NEAR USDC out to the vault.

const fund = { info: null, loading: null };
const DEFAULT_AMT = { ETH: '0.01', BTC: '0.001', SOL: '0.5', NEAR: '10', USDC: '25', USDT: '25' };
const TRON_MIN_USD = 100;

function loadFund() {
  if (!fund.loading) fund.loading = getJSON('/api/fund/tokens').then((info) => {
    fund.info = info;
    $('#fund-asset').innerHTML = info.tokens.map((t) => `<option value="${esc(t.assetId)}">${esc(t.symbol)} on ${esc(t.chain)}</option>`).join('');
    const base = info.tokens.find((t) => t.chain === 'Base' && t.symbol === 'ETH');
    if (base) $('#fund-asset').value = base.assetId;
    $('#fund-note').innerHTML = info.stand_in
      ? `NEAR Intents runs on mainnet only, and this vault is on testnet. Quotes are live mainnet prices, routed to the stand-in account <code>${acct(info.recipient)}</code> until the mainnet vault is live. They are dry: no deposit address is made and nothing can be sent. A real deposit runs with <code>scripts/fund-intents.mjs --live</code>.`
      : `Quotes route to the mainnet NEARnest vault <code>${acct(info.recipient)}</code>, owned by <code>web3wagmi.near</code>. They are dry here: no deposit address is made. A real deposit runs with <code>scripts/fund-intents.mjs --live</code>, which gives a one-time deposit address.`;
    fundUsd();
  }).catch((e) => { fund.loading = null; $('#fund-note').textContent = `Could not read the 1Click token list: ${e.message}`; });
  return fund.loading;
}

const fundToken = () => fund.info?.tokens.find((t) => t.assetId === $('#fund-asset').value);
function fundUsd() {
  const t = fundToken(); const a = Number($('#fund-amt').value);
  const h = $('#fund-usd'); h.className = 'hint';
  if (!t) { h.textContent = ''; return; }
  if (!(a > 0)) { h.textContent = 'Enter an amount above zero.'; h.className = 'hint bad'; return; }
  h.textContent = `About ${usd(a * t.price)} at ${usd(t.price)} per ${t.symbol}.${t.chain === 'Tron' && a * t.price < TRON_MIN_USD ? ` 1Click needs at least $${TRON_MIN_USD} from Tron.` : ''}`;
}

async function fundQuote() {
  const t = fundToken(); if (!t) return;
  const btn = $('#fund-go'); const out = $('#fund-out');
  btn.disabled = true; btn.textContent = 'Asking solvers…';
  try {
    const r = await fetch(`/api/fund/quote?asset=${encodeURIComponent(t.assetId)}&amount=${encodeURIComponent($('#fund-amt').value.trim())}`, { cache: 'no-store' });
    const j = await r.json();
    out.hidden = false;
    if (!r.ok) { out.innerHTML = `<p class="err">${esc(j.error || `Quote failed (${r.status})`)}</p>`; return; }
    const q = j.quote;
    const kept = Number(q.amountOutUsd) / Number(q.amountInUsd);
    out.innerHTML = `
      <div class="stat"><span class="k">You send</span><b>${num(q.amountInFormatted, 6)} ${esc(t.symbol)}</b><span class="s">on ${esc(t.chain)}, ${usd(q.amountInUsd)}</span></div>
      <div class="stat"><span class="k">Vault receives</span><b>${num(q.amountOutFormatted, 2)} USDC</b><span class="s">at least ${num(Number(q.minAmountOut) / 1e6, 2)} after 1% slippage</span></div>
      <div class="stat"><span class="k">Cost of the route</span><b>${pct(Math.max(0, 1 - kept))}</b><span class="s">${usd(Math.max(0, q.amountInUsd - q.amountOutUsd))} on this amount</span></div>
      <div class="stat"><span class="k">Time to settle</span><b>${num(q.timeEstimate, 0)} s</b><span class="s">after the deposit confirms on ${esc(t.chain)}</span></div>`;
  } catch (e) {
    out.hidden = false; out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally { btn.disabled = false; btn.textContent = 'Get a live quote'; }
}

$('#fund-asset').addEventListener('change', () => { const t = fundToken(); if (t) $('#fund-amt').value = DEFAULT_AMT[t.symbol] || '1'; fundUsd(); $('#fund-out').hidden = true; });
$('#fund-amt').addEventListener('input', fundUsd);
$('#fund-amt').addEventListener('keydown', (e) => { if (e.key === 'Enter') fundQuote(); });
$('#fund-go').addEventListener('click', fundQuote);

// ------------------------------------------------------------------ what if

const VENUE_LOGO = { 'rhea-usdc': '/img/rhea.png', 'rhea-usdt': '/img/rhea.png', rnear: '/img/rhea.png', linear: '/img/linear.png' };
const scenCache = new Map();
let scenId = 'usdc-depeg';

async function openWhatIf(arg) {
  if (!state.scenarios) {
    try { state.scenarios = await getJSON('/api/scenarios'); } catch { $('#scen-story').textContent = 'Could not load the scenarios.'; return; }
  }
  if (state.scenarios.some((x) => x.id === arg)) scenId = arg;
  $('#scen').innerHTML = state.scenarios.map((x) => `<button type="button" data-id="${esc(x.id)}" aria-pressed="${x.id === scenId}">${esc(x.title)}</button>`).join('');
  $('#scen-cmd-t').textContent = `node scripts/run-agent.mjs --scenario ${scenId}`;
  renderScenarioLog();
  const hit = scenCache.get(scenId);
  if (hit && Date.now() - hit.t < 60_000) return renderWhatIf(hit.v);
  $('#scen-story').textContent = 'Running the policy…';
  try {
    const r = await getJSON(withNet(`/api/scenario?id=${encodeURIComponent(scenId)}`));
    scenCache.set(scenId, { t: Date.now(), v: r });
    if (r.id === scenId) renderWhatIf(r);
  } catch (e) { $('#scen-story').textContent = `Could not run the scenario: ${e.message}`; }
}

function renderWhatIf(r) {
  const changed = r.venues.filter((v) => v.before.verdict !== v.after.verdict || v.before.cap !== v.after.cap);
  $('#scen-story').innerHTML = `<b>${esc(r.title)}.</b> ${esc(r.story)} ${changed.length ? `${changed.length} of ${r.venues.length} venues change.` : 'No venue changes.'}`;
  const capTxt = (j) => (j.verdict === 'cap' ? ` at ${Math.round(j.cap * 100)}%` : '');
  $('#scen-tbl tbody').innerHTML = r.venues.map((v) => {
    const was = new Set(v.before.reasons.map((x) => x.text));
    const ch = v.before.verdict !== v.after.verdict || v.before.cap !== v.after.cap;
    const reasons = v.after.reasons.length
      ? `<ul>${v.after.reasons.map((x) => `<li class="${was.has(x.text) ? '' : 'new'}">${esc(x.text)}</li>`).join('')}</ul>` : 'No flags.';
    return `<tr><th scope="row">${ent(v.label, VENUE_LOGO[v.id])}</th>
      <td><span class="pill ${v.before.verdict}">${VERDICT[v.before.verdict]}${capTxt(v.before)}</span></td>
      <td><span class="pill ${v.after.verdict}">${VERDICT[v.after.verdict]}${capTxt(v.after)}</span>${ch ? '' : '<span class="chg">No change</span>'}</td>
      <td class="why">${reasons}</td></tr>`;
  }).join('');
  $('#scen-before').innerHTML = planHTML(r.plan_before);
  $('#scen-after').innerHTML = planHTML(r.plan_after);
}

function renderScenarioLog() {
  const el = $('#scen-log');
  if (!el) return;
  const moves = state.agent?.moves || [];
  const first = moves.findIndex((m) => m.scenario === scenId);
  if (first < 0) { el.innerHTML = ''; return; }
  // The recorded response to this scenario, and the owner reopening and the agent re-entering after it.
  const run = moves.slice(first).filter((m, k, a) => m.scenario === scenId || (m.kind === 'unblock') || (k > 0 && a[k - 1].kind === 'unblock'));
  el.innerHTML = run.map((m) => feedLi(feedItem(m, VENUE[m.venue] || { name: m.venue, sym: '' }))).join('');
}

$('#scen').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  scenId = b.dataset.id;
  history.replaceState(null, '', `#whatif/${scenId}`);
  openWhatIf(scenId);
});
$('#scen-cmd').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#scen-cmd-t').textContent); toast('Command copied'); } catch { toast('Copy failed'); }
});

// ----------------------------------------------------------------- the drill

function cleanReason(r) {
  if (!r) return '';
  const m = r.match(/Smart contract panicked: ([^"}]+)/);
  if (m) return `Contract: ${m[1]}`;
  if (/MethodNameMismatch/.test(r)) return 'NEAR: method not allowed by the agent key';
  if (/RequiresFullAccess/.test(r)) return 'NEAR: a transfer needs a full-access key';
  if (/DepositWithFunctionCall/.test(r)) return 'NEAR: a function-call key cannot attach a deposit';
  if (/NotEnoughAllowance/.test(r)) return 'NEAR: over the key allowance';
  if (/AccessKeyNotFound/.test(r)) return 'NEAR: the key was deleted from the vault';
  return r.slice(0, 160);
}

const ACTOR = { agent: 'Agent key', feeder: 'Risk feeder', owner: 'Owner' };
function renderDrill(d) {
  const stopped = d.results.filter((r) => r.expect === 'rejected' && r.pass).length;
  const attacks = d.results.filter((r) => r.expect === 'rejected').length;
  $('#st-drill').textContent = `${stopped} of ${attacks}`;
  $('#st-drill-s').textContent = `run ${new Date(d.ran_at).toISOString().slice(0, 10)} on ${d.network}`;
  $('#drill-tbl tbody').innerHTML = d.results.map((r) => {
    const ok = r.outcome === 'executed';
    const pill = ok ? '<span class="pill allow">Went through</span>' : '<span class="pill block">Stopped</span>';
    let why = ok ? (r.expect === 'executed' ? 'Allowed by the policy' : 'Unexpected') : cleanReason(r.reason);
    // Contract messages carry raw USDC units (6 decimals); show the amount beside them.
    if (/USDC/.test(r.intent)) why = why.replace(/\b(\d{7,})\b/g, (n) => `${n} (${num(Number(n) / 1e6, 6)} USDC)`);
    const proof = r.tx ? `<a href="${esc(r.tx)}">Transaction</a>` : 'Refused by NEAR before it ran';
    return `<tr><th scope="row">${esc(r.intent)}</th><td>${esc(ACTOR[r.actor] || 'Agent key')}</td><td>${pill}</td><td>${esc(why)}</td><td>${proof}</td></tr>`;
  }).join('');
}

// ------------------------------------------------------------------ loading

function setLive(ok) {
  const el = $('#live');
  el.classList.toggle('on', ok); el.classList.toggle('err', !ok);
  if (ok) state.at = Date.now();
  tickLive();
}
function tickLive() {
  const el = $('#live-t');
  if ($('#live').classList.contains('err')) { el.textContent = 'Offline, retrying'; return; }
  if (!state.at) return;
  const s = Math.round((Date.now() - state.at) / 1000);
  el.textContent = `Live, updated ${s < 5 ? 'just now' : `${s}s ago`}`;
}

async function loadScan() {
  const btn = $('#rescan');
  btn.disabled = true;
  try {
    state.scan = await getJSON('/api/scan');
    renderScan(state.scan);
  } catch (e) {
    $('#yield-tbl tbody').innerHTML = `<tr><td colspan="4" class="loading">Could not read the venues: ${esc(e.message)}</td></tr>`;
  } finally {
    btn.disabled = false;
  }
}

async function refresh() {
  const btn = $('#refresh');
  btn.classList.add('spin');
  const [vault, plan, agent] = await Promise.allSettled([getJSON(withNet('/api/vault')), getJSON(withNet('/api/plan')), getJSON(withNet('/api/agent'))]);
  getJSON('/api/ai').then(renderAI).catch(() => { $('#ai-list').innerHTML = '<li class="loading">Could not read the proposals.</li>'; });
  btn.classList.remove('spin');
  if (vault.status === 'fulfilled') renderVault(state.vault = vault.value);
  else $('#vault-sub').textContent = `Could not read the vault: ${vault.reason.message}`;
  if (plan.status === 'fulfilled') { state.plan = plan.value; renderPlan(state.plan); renderOverview(); }
  if (agent.status === 'fulfilled') { state.agent = agent.value; renderMoves(state.agent); }
  renderFeed();
  setLive(vault.status === 'fulfilled' && plan.status === 'fulfilled');
}

$('#rescan').addEventListener('click', async () => { await loadScan(); renderOverview(); });
$('#refresh').addEventListener('click', refresh);
$('#copy-cmd').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('node scripts/run-agent.mjs'); toast('Command copied'); } catch { toast('Copy failed'); }
});

// The mainnet agent key, published on purpose (demo/agent-key-mainnet.json).
let dare = null;
async function renderDare() {
  const el = $('#dare');
  if (NETWORK !== 'mainnet') { el.hidden = true; return; }
  try { dare ||= await getJSON('/api/dare'); } catch { return; }
  if (!dare.private_key) return;
  el.hidden = false;
  $('#dare-key').textContent = dare.private_key;
  $('#dare-watch').href = `https://nearblocks.io/address/${dare.vault}`;
  $('#dare-cli').textContent = `near contract call-function as-transaction ${dare.vault} agent_withdraw json-args '{"venue_id":"burrow-usdc","amount":"1000000"}' prepaid-gas '150 Tgas' attached-deposit '0 NEAR' sign-as ${dare.vault} network-config mainnet sign-with-plaintext-private-key --signer-public-key ${dare.public_key} --signer-private-key <the key above> send`;
}
$('#dare-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(dare?.private_key || ''); toast('Key copied'); } catch { toast('Copy failed'); }
});

function setNetwork(n) {
  NETWORK = n;
  try { localStorage.setItem('nearnest-net', n); } catch {}
  const u = new URL(location.href); u.searchParams.set('net', n); history.replaceState(null, '', u);
  document.querySelectorAll('#net-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.net === n)));
  document.body.dataset.net = n;
  state.plan = state.vault = state.agent = null;
  scenCache?.clear?.();
  refresh();
  renderFeed();
  renderDare();
}
document.querySelectorAll('#net-switch button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.net !== NETWORK) setNetwork(b.dataset.net); }));
document.querySelectorAll('#net-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.net === NETWORK)));
document.body.dataset.net = NETWORK;

route();
if (!state.scenarios) getJSON('/api/scenarios').then((x) => { state.scenarios ??= x; renderFeed(); if (state.agent) renderMoves(state.agent); }).catch(() => {});
getJSON('/api/drill').then((d) => { state.drill = d; renderDrill(d); renderFeed(); }).catch(() => {});
loadScan().then(refresh);
renderDare();
setInterval(refresh, 30_000);
setInterval(() => { tickLive(); tickCooldown(); }, 1000);
