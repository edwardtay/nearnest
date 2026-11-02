// NEARnest page: renders /api/scan (mainnet yields judged), /api/vault (live vault
// read) and /api/drill (recorded attack drill). No framework, no keys.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Account ids break only after a dot, never inside a word.
const acct = (s) => esc(s).replace(/\./g, '.<wbr>');
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const num = (x, d = 2) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });

const LOGO = {
  'Rhea Lend': '/img/rhea.png',
  'Rhea LST': '/img/rhea.png',
  LiNEAR: '/img/linear.png',
  'contract.1638481328.burrow.testnet': '/img/rhea.png',
  'linear-protocol.testnet': '/img/linear.png',
};
const VERDICT = { allow: 'Allowed', cap: 'Capped', block: 'Blocked' };

function ent(name, logo, small) {
  return `<span class="ent"><span class="logo">${logo ? `<img src="${logo}" alt="" width="24" height="24">` : ''}</span><span class="nm">${esc(name)}${small ? `<small class="mono acct">${acct(small)}</small>` : ''}</span></span>`;
}

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------- yield, judged

function renderScan(rep) {
  const rows = rep.venues.map((v) => {
    const j = v.judgement;
    const share = v.max_alloc ? Math.min(1, v.target / v.max_alloc) : 0;
    const reasons = j.reasons.length
      ? `<ul>${j.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>`
      : 'No flags.';
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

async function loadScan() {
  const btn = $('#rescan');
  btn.disabled = true;
  try {
    renderScan(await getJSON('/api/scan'));
  } catch (e) {
    $('#yield-tbl tbody').innerHTML = `<tr><td colspan="4" class="loading">Could not read the venues: ${esc(e.message)}</td></tr>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- the vault

function units(raw, token) {
  if (raw == null) return 'n/a';
  const d = token === 'near' ? 24 : 6;
  return num(Number(BigInt(raw) * 1000n / 10n ** BigInt(d)) / 1000, 3);
}
const sym = (t) => (t === 'near' ? 'NEAR' : t.startsWith('usdc') ? 'USDC' : t.startsWith('usdt') ? 'USDt' : t);

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
    return `<tr><th scope="row">${ent(x.id, LOGO[x.venue.contract], x.venue.contract)}</th><td>${st}</td>
      <td class="n">${units(x.position, x.venue.token)} ${sym(x.venue.token)}</td>
      <td class="n">${units(x.venue.max_alloc, x.venue.token)}</td>
      <td class="n">${units(x.max_move, x.venue.token)}</td></tr>`;
  }).join('');
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

// ---------------------------------------------------------- section nav spy

function spy() {
  const links = [...document.querySelectorAll('.toc a')];
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.setAttribute('aria-current', a.hash === `#${e.target.id}`));
      links.find((a) => a.hash === `#${e.target.id}`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, { rootMargin: '-30% 0px -65% 0px' });
  document.querySelectorAll('section[id]').forEach((s) => io.observe(s));
}

$('#rescan').addEventListener('click', loadScan);
spy();
loadScan();
getJSON('/api/vault').then(renderVault).catch((e) => { $('#vault-sub').textContent = `Could not read the vault: ${e.message}`; });
getJSON('/api/drill').then(renderDrill).catch(() => {});
