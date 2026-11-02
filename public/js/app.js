// NEARnest app: hash-routed views over /api/scan (mainnet yields judged), /api/vault
// (live vault read), /api/plan (the agent's next move), /api/agent (moves made) and
// /api/drill (recorded attack drill). No framework, no keys.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Account ids break only after a dot, never inside a word.
const acct = (s) => esc(s).replace(/\./g, '.<wbr>');
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
const sym = (t) => (t === 'near' ? 'NEAR' : t.startsWith('usdc') ? 'USDC' : t.startsWith('usdt') ? 'USDt' : t);
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

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------- router

const VIEWS = ['overview', 'yield', 'vault', 'agent', 'drill', 'about'];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
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
  const rows = plan.steps.map((s) => {
    const v = VENUE[s.venue];
    const amount = toNum(s.have, s.token);
    return { ...s, v, amount, usd: amount * (px[v?.price] ?? 0) };
  }).filter((r) => r.v);
  const total = rows.reduce((a, r) => a + r.usd, 0);
  const earn = rows.reduce((a, r) => a + r.usd * r.apr, 0);
  $('#pos-usd').textContent = usd(total);
  $('#pos-s').textContent = total ? `Earning ${pct(earn / total)} blended, about ${usd(earn)} a year at today's rates` : 'Nothing supplied yet';
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
    const verb = { supply: 'Supply', withdraw: 'Withdraw', block: 'Block' }[next.kind];
    const amt = next.amount ? `<span class="fig">${units(next.amount, next.token)} ${v.sym}</span> ` : '';
    const prep = next.kind === 'supply' ? 'to' : next.kind === 'withdraw' ? 'from' : '';
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

function renderFeed() {
  const items = [];
  for (const m of state.agent?.moves || []) {
    const v = VENUE[m.venue] || { name: m.venue, sym: '' };
    const verb = { supply: 'Supplied', withdraw: 'Withdrew', block: 'Blocked' }[m.kind] || m.kind;
    items.push({ at: m.at, kind: m.kind === 'supply' ? 'allow' : 'block', icon: m.kind === 'supply' ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6',
      t: `${verb} ${m.amount ? `${units(m.amount, v.token)} ${v.sym} ` : ''}${m.kind === 'supply' ? 'to' : 'from'} ${v.name}`,
      d: `${VERDICT[m.verdict]} by the policy${m.reasons?.length ? `: ${m.reasons[0]}` : ''}`, tx: m.tx });
  }
  const d = state.drill;
  if (d) {
    const stopped = d.results.filter((r) => r.expect === 'rejected' && r.pass).length;
    const attacks = d.results.filter((r) => r.expect === 'rejected').length;
    items.push({ at: d.ran_at, kind: 'block', icon: 'M8 8l8 8M16 8l-8 8', t: `Attack drill: ${stopped} of ${attacks} theft attempts stopped`,
      d: 'A script holding the real agent key tried transfers, owner calls, unknown venues and oversize moves.', href: '#drill' });
  }
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  $('#feed').innerHTML = items.slice(0, 6).map((i) => `<li>
    <span class="dot ${i.kind}"><svg viewBox="0 0 24 24"><path d="${i.icon}"/></svg></span>
    <div><div class="t">${esc(i.t)}</div><div class="d">${esc(i.d)}</div></div>
    <div class="when">${ago(i.at)}${i.tx ? `<a href="${esc(i.tx)}">Transaction</a>` : i.href ? `<a href="${i.href}">Details</a>` : ''}</div></li>`).join('')
    || '<li class="loading">No activity yet.</li>';
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
      <td class="n">${units(x.position, x.venue.token)} ${sym(x.venue.token)}</td>
      <td class="n">${units(x.venue.max_alloc, x.venue.token)}</td>
      <td class="n">${units(x.max_move, x.venue.token)}</td></tr>`;
  }).join('');

  const blocked = v.venues.filter((x) => x.venue.blocked_reason).length;
  const hs = $('#health-state');
  hs.textContent = v.vault.paused ? 'Paused' : blocked ? `${blocked} venue blocked` : 'Running';
  hs.className = v.vault.paused || blocked ? 'bad' : 'ok';
  $('#health-s').textContent = `${full ? `${full} full-access key` : 'No full-access key'}. ${v.vault.moves_today} of ${pol.max_moves_per_day} moves used today.`;
}

// ---------------------------------------------------------------- the agent

function renderPlan(p) {
  $('#plan').innerHTML = p.steps.map((s) => {
    const v = VENUE[s.venue] || { name: s.venue, sym: '' };
    const go = s.kind !== 'hold';
    const t = go
      ? `${{ supply: 'Supply', withdraw: 'Withdraw', block: 'Block' }[s.kind]} ${s.amount ? `${units(s.amount, s.token)} ${v.sym} ` : ''}${s.kind === 'supply' ? 'to' : s.kind === 'withdraw' ? 'from' : ''} ${v.name}`
      : `Hold ${v.name}`;
    const d = `${units(s.have, s.token)} of ${units(s.want, s.token)} ${v.sym} target. ${MIRROR_NAME[s.mirrors] || s.mirrors} at ${pct(s.apr)}${s.note ? `, ${s.note}` : ''}.`;
    return `<li class="${go ? 'go' : ''}"><div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></div><span class="pill ${go ? s.verdict : 'hold'}">${go ? VERDICT[s.verdict] : 'Hold'}</span></li>`;
  }).join('');
}

const VERB = { supply: 'Supplied to', withdraw: 'Withdrew from', block: 'Blocked' };
function renderMoves(a) {
  const rows = [...a.moves].reverse().map((m) => {
    const v = VENUE[m.venue] || { name: m.venue, token: 'usdc', sym: '' };
    const amt = m.amount ? `${units(m.amount, v.token)} ${v.sym}` : '';
    const pill = `<span class="pill ${m.verdict}">${VERDICT[m.verdict]}</span>`;
    const why = m.reasons.length ? `<ul>${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : 'No flags.';
    const tgt = m.target ? `<div class="note">Target ${units(m.target, v.token)}, from mainnet ${esc(MIRROR_NAME[m.mirrors] || m.mirrors)} at ${pct(m.apr)}</div>` : '';
    return `<tr><th scope="row">${ent(`${VERB[m.kind] || m.kind} ${v.name}`, v.logo, new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')}</th>
      <td class="n">${amt}</td><td class="why"><div class="vd">${pill}</div>${why}${tgt}</td>
      <td>${m.ok ? `<a href="${esc(m.tx)}">Transaction</a>` : `Refused: ${esc(cleanReason(m.reason))}`}</td></tr>`;
  });
  $('#moves-tbl tbody').innerHTML = rows.join('') || '<tr><td colspan="4" class="loading">No moves yet.</td></tr>';
  $('#moves-foot').textContent = 'The testnet vault takes its judgement from the matching mainnet venue: Burrow testnet follows Rhea Lend USDC, LiNEAR testnet follows LiNEAR.';
}

// ----------------------------------------------------------------- the drill

function cleanReason(r) {
  if (!r) return '';
  const m = r.match(/Smart contract panicked: ([^"}]+)/);
  if (m) return `Contract: ${m[1]}`;
  if (/MethodNameMismatch/.test(r)) return 'NEAR: method not allowed by the agent key';
  if (/RequiresFullAccess/.test(r)) return 'NEAR: a transfer needs a full-access key';
  if (/DepositWithFunctionCall/.test(r)) return 'NEAR: a function-call key cannot attach a deposit';
  if (/NotEnoughAllowance/.test(r)) return 'NEAR: over the key allowance';
  return r.slice(0, 160);
}

function renderDrill(d) {
  const stopped = d.results.filter((r) => r.expect === 'rejected' && r.pass).length;
  const attacks = d.results.filter((r) => r.expect === 'rejected').length;
  $('#st-drill').textContent = `${stopped} of ${attacks}`;
  $('#st-drill-s').textContent = `run ${new Date(d.ran_at).toISOString().slice(0, 10)} on ${d.network}`;
  $('#drill-tbl tbody').innerHTML = d.results.map((r) => {
    const ok = r.outcome === 'executed';
    const pill = ok ? '<span class="pill allow">Went through</span>' : '<span class="pill block">Stopped</span>';
    const why = ok ? (r.expect === 'executed' ? 'Allowed by the policy' : 'Unexpected') : cleanReason(r.reason);
    const proof = r.tx ? `<a href="${esc(r.tx)}">Transaction</a>` : 'Refused by NEAR before it ran';
    return `<tr><th scope="row">${esc(r.intent)}</th><td>${pill}</td><td>${esc(why)}</td><td>${proof}</td></tr>`;
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
  const [vault, plan, agent] = await Promise.allSettled([getJSON('/api/vault'), getJSON('/api/plan'), getJSON('/api/agent')]);
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

route();
getJSON('/api/drill').then((d) => { state.drill = d; renderDrill(d); renderFeed(); }).catch(() => {});
loadScan().then(refresh);
setInterval(refresh, 30_000);
setInterval(() => { tickLive(); tickCooldown(); }, 1000);
