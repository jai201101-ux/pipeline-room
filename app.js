// Pipeline Room v2. Plain JS, no build step. Reads live from Supabase as the signed-in person
// (row security decides what each person sees) and calls the server for anything a brain does.
//   VP:    Today (5 cards, Why?, reactions) · Deals · People · Thinking (Analyst, Mentor, Deploy) · Brief me
//   Rep:   My week · Check in · review "what I heard" · Send to Mark
(() => {
  const R = window.ROOM;
  const sb = window.supabase.createClient(R.url, R.anonKey);
  const $app = document.getElementById('app');
  const $tabs = document.getElementById('tabs');
  const $tabsInner = document.getElementById('tabsInner');
  const S = { me: null, dealsByRef: {} };
  let live = null; // the running voice call, if any
  let timer = null; // the running poll, if any

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (v) => (v === null || v === undefined ? '' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v).toLocaleString('en-US')}`);
  const day = (d) => (d ? new Date(String(d).length === 10 ? `${d}T00:00:00Z` : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
  const weekday = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const isLead = () => S.me && (S.me.role === 'vp' || S.me.role === 'admin');
  const first = (n) => String(n || '').split(' ')[0];
  const slug = (n) => encodeURIComponent(n);
  const plain = (t) => String(t || '').replace(/^\s*Rules? [\d, and]+\.\s*/i, '').replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => day(m)).replace(/\s*\[F:[^\]]+\]/g, '').replace(/\s*\((?:deals? )?[0-9][0-9A-Za-z]{5}\)/g, '').replace(/\s+([.,])/g, '$1').trim();
  const asDate = (s) => esc(String(s ?? '').replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => day(m)));
  const money = (s) => (/^\$[\d,]+$/.test(String(s || '').trim()) ? usd(Number(String(s).replace(/[$,]/g, ''))) : String(s || ''));
  // "(deal 0IzVn7) EB Go/No Go" -> chip + text
  const chips = (t) => esc(String(t || '').replace(/\s*\[F:[^\]]+\]/g, '')).replace(/\(?(?:deals? )?\b([0-9][0-9A-Za-z]{5})\b\)?/g, (m, ref) => (/[A-Z]/.test(ref) && /[a-z]/.test(ref) ? `<button class="ref" data-ref="${ref}" aria-label="Show deal ${ref}">${ref}</button>` : m));
  async function q(promise) { const { data, error } = await promise; if (error) throw error; return data; }
  async function token() { const { data } = await sb.auth.getSession(); return data.session ? data.session.access_token : ''; }
  async function server(path, body) {
    const r = await fetch(`${R.server}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await token(), ...body }) });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `server said ${r.status}`);
    try { return JSON.parse(t); } catch (e) { return {}; }
  }
  const poll = (fn, ms = 4000) => { stopPoll(); const tick = async () => { let again = false; try { again = await fn(); } catch (e) { again = true; } if (again) timer = setTimeout(tick, ms); }; tick(); };
  function stopPoll() { if (timer) clearTimeout(timer); timer = null; }
  const mic = (c = 'var(--ink)') => `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="${c}"></rect><path d="M4 10a6 6 0 0 0 12 0M10 16v2" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"></path></svg>`;

  // Tap a deal chip: show the deal from Salesforce
  document.addEventListener('click', async (e) => {
    const r = e.target.closest('.ref');
    if (!r) return;
    e.preventDefault();
    const host = r.closest('.card, li, .row, p, .whyrow') || r.parentElement;
    let pop = host.querySelector(':scope > .popover');
    if (pop && pop.dataset.key === r.dataset.ref) { pop.remove(); return; }
    if (pop) pop.remove();
    pop = document.createElement('div'); pop.className = 'popover'; pop.dataset.key = r.dataset.ref;
    let d = S.dealsByRef[r.dataset.ref];
    if (!d) { const rows = await q(sb.from('deals').select('*').eq('ref', r.dataset.ref).limit(1)); d = rows[0]; if (d) S.dealsByRef[r.dataset.ref] = d; }
    pop.innerHTML = d ? `<b>${esc(d.client || 'Deal')} · ${usd(d.value)} · ${esc(d.owner)}</b><span>${esc(d.stage)} · close ${day(d.close)} · in stage since ${day(d.entered_stage)}</span><span class="small">${esc(d.segment)} ${esc(d.region)} · Salesforce ${d.prob === null || d.prob === undefined ? '' : `${Math.round(d.prob * 100)}%`} · ref ${esc(r.dataset.ref)}</span>` : '<span>This deal is not visible to you.</span>';
    host.appendChild(pop);
  });

  // ---------- layout ----------
  function tabs(active) {
    const items = isLead()
      ? [['today', 'Today'], ['deals', 'Deals'], ['people', 'People'], ['thinking', 'Thinking'], ...(S.me.role === 'admin' ? [['inputs', 'Inputs']] : [])]
      : [['me', 'My week'], ['person', 'About me']];
    $tabsInner.style.setProperty('--n', items.length);
    $tabsInner.innerHTML = `<span class="navbrand">PIPELINE ROOM</span>${items.map(([k, l]) => `<a href="#${k}" class="${k === active ? 'on' : ''}">${l}</a>`).join('')}<span class="navme">${esc(S.me.name)} · <button class="linkish signout">Sign out</button></span>`;
    $tabs.hidden = false;
  }
  const header = (kicker, title, sub = '', cls = '') => `<header class="top ${cls}"><div class="brandrow"><span class="brand">${kicker}</span><span class="phoneonly">${esc(first(S.me.name))} · <button class="linkish signout">Sign out</button></span></div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</header>`;
  const empty = (t) => `<p class="empty">${t}</p>`;

  // ---------- shared data ----------
  async function thinking() {
    const [v, rules] = await Promise.all([
      q(sb.from('thinking_versions').select('*').order('version', { ascending: false }).limit(1)),
      q(sb.from('rules').select('*').eq('status', 'active').order('id')),
    ]);
    return { v: v[0] || { version: 1 }, rules, deal: rules.filter((r) => r.brain === 'deal'), coach: rules.filter((r) => r.brain === 'coach') };
  }
  const review = async () => (await q(sb.from('reviews').select('*').order('date', { ascending: false }).limit(1)))[0];
  async function since(rv) {
    const from = rv ? rv.window_from : '2000-01-01';
    const [cis, fixes, broken, reps] = await Promise.all([
      q(sb.from('transcripts').select('people,date').eq('kind', 'checkin').gte('date', from)),
      q(sb.from('sf_edits').select('id').eq('status', 'waiting')),
      q(sb.from('promises').select('promise,by_person').eq('status', 'broken').gte('checked_on', from)),
      q(sb.from('people').select('name').eq('role', 'rep')),
    ]);
    const who = [...new Set(cis.flatMap((c) => c.people || []))];
    return { who, fixes: fixes.length, broken, toGo: Math.max(0, reps.length - who.length) };
  }
  const latestList = async (person) => (await q(sb.from('brain_outputs').select('body,created_at').eq('brain', 'deal').eq('kind', 'rep_list').eq('person', person).order('created_at', { ascending: false }).limit(1)))[0];

  // ---------- VP: Today ----------
  const GROUPS = [['decide', 'Decide'], ['ask', 'Ask in the meeting'], ['coach', 'Coach']];
  function cardSource(c, rv) {
    if (c.grp === 'decide') return `Check-in · ${esc(first(c.person))}`;
    if (c.grp === 'coach') return `Reviews to ${day(c.as_of)}`;
    return `Salesforce ${day(rv && rv.window_to)}`;
  }
  function actionState(c, reacts) {
    const done = reacts.find((x) => x.card_id === c.id && x.kind === 'done');
    if (!done) return null;
    return { agenda: 'On the agenda', approve_edits: 'Approved', done: c.grp === 'coach' ? '1:1 planned' : 'Done' }[c.action && c.action.kind] || 'Done';
  }
  function cardHtml(c, reacts, rv) {
    const st = actionState(c, reacts);
    const voted = reacts.find((x) => x.card_id === c.id && x.kind !== 'done');
    return `<article class="card c-${c.grp}" data-card="${c.id}">
      <div class="cardtop"><div class="cardmain"><div class="headline">${esc(c.headline || c.title)}</div><div class="text">${esc(plain(c.body))}</div>${c.move ? `<div class="move">${esc(c.move)}</div>` : ''}</div>${c.number ? `<div class="num">${esc(money(c.number))}</div>` : ''}</div>
      <div class="cardfoot">${c.action ? (st ? `<span class="donepill">✓ ${st}</span>` : `<button class="btn ${c.grp === 'coach' ? 'coach' : 'ink'} act" data-card="${c.id}">${esc(c.action.label)}</button>`) : ''}<span class="small src">${cardSource(c, rv)} · <button class="linkish why" data-card="${c.id}" aria-expanded="false">Why?</button></span></div>
      <div class="whybox" id="why-${c.id}" hidden>${whyHtml(c, voted)}</div>
    </article>`;
  }
  function whyHtml(c, voted) {
    const w = c.why || {};
    const rows = (w.rows || []).filter(Boolean);
    const lines = (w.lines || []).filter(Boolean);
    return `${rows.length ? `<div class="whyrows">${rows.map((r) => `<div class="whyrow"><span>${esc(first(r.who) === r.who ? r.who : r.who)}</span><span class="what">${chips(r.what)}</span><b>${esc(money(r.number))}</b></div>`).join('')}</div>` : ''}
      ${lines.length ? `<ul class="whylines">${lines.map((l) => `<li>${esc(plain(l.text))}${l.source ? ` <span class="small">${asDate(l.source)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      <div class="useful"><span class="small">Was this useful?</span>${voted ? `<span class="donepill">${voted.kind === 'useful' ? 'Useful' : 'Not useful'} · noted</span>` : `<button class="btn ghost sm vote" data-card="${c.id}" data-kind="useful">Useful</button><button class="btn ghost sm vote" data-card="${c.id}" data-kind="not_useful">Not useful</button>`}</div>
      <div class="small">The brains learn from this. Rules change only when you deploy.</div>`;
  }

  async function screenToday() {
    const rv = await review();
    const [cards, reacts, th, sn] = await Promise.all([
      q(sb.from('cards').select('*').eq('status', 'live').not('grp', 'is', null)),
      q(sb.from('reactions').select('*')),
      thinking(),
      since(rv),
    ]);
    S.cards = cards;
    const by = (g) => cards.filter((c) => c.grp === g).sort((a, b) => (b.rank || 0) - (a.rank || 0));
    const sinceLines = [
      sn.who.length ? `${sn.who.map(first).join(', ')} checked in` : 'No check-ins yet',
      `${sn.fixes} Salesforce fix${sn.fixes === 1 ? '' : 'es'} waiting`,
      sn.broken.length ? `${sn.broken.length} promise${sn.broken.length > 1 ? 's' : ''} broken${sn.broken[0] ? `: ${esc(first(sn.broken[0].by_person))}, ${esc(sn.broken[0].promise).slice(0, 48)}` : ''}` : 'No promises broken',
      `${sn.toGo} reps still to check in`,
    ];
    const pt = th.deal.filter((r) => r.source === 'person').length + th.coach.filter((r) => r.source === 'person').length;
    $app.innerHTML = header(rv ? `REVIEW · ${weekday(rv.date).toUpperCase()}` : 'REVIEW', `${cards.length} thing${cards.length === 1 ? '' : 's'} for today`, `<span class="phoneonly">Since last review: ${esc(sn.who.length)} check-in${sn.who.length === 1 ? '' : 's'} · ${sn.fixes} fixes · ${sn.broken.length} broken</span>`) + `
      <div class="cols">
        <div class="maincol">
          <section class="section phoneonly"><button class="brief" data-brief type="button"><span class="mic">${mic()}</span><span><b>Brief me</b><span>The Briefer · 90 seconds</span></span></button></section>
          ${GROUPS.map(([g, label]) => (by(g).length ? `<section class="section"><h2 class="grp g-${g}">${label}</h2>${by(g).map((c) => cardHtml(c, reacts, rv)).join('')}</section>` : '')).join('') || `<section class="section">${empty('Nothing yet. Cards appear after the brains read the latest Salesforce export and check-ins.')}</section>`}
        </div>
        <aside class="rail">
          <section class="section laptoponly"><button class="brief" data-brief type="button"><span class="mic">${mic()}</span><span><b>Brief me</b><span>The Briefer · 90 seconds</span></span></button></section>
          <section class="section"><h2 class="grp">Since last review</h2><div class="card"><ul class="plainlist">${sinceLines.map((l) => `<li>${l}</li>`).join('')}</ul></div></section>
          <section class="section"><h2 class="grp">Filtered by your thinking</h2><div class="card"><div class="text"><b>Thinking model v${th.v.version}</b>${th.v.created_at ? ` · ${day(th.v.created_at)}` : ''}</div><div class="small">Deal rules: ${th.deal.length} · Coaching rules: ${th.coach.length} · ${pt} set by you</div><div class="quick"><a class="btn dealfill sm" href="#train/deal">Talk to the Analyst</a><a class="btn coach sm" href="#train/coach">Talk to the Mentor</a></div></div></section>
        </aside>
      </div>`;
    $app.querySelectorAll('[data-brief]').forEach((b) => (b.onclick = () => { location.hash = '#brief'; }));
    // Live: when a rep sends a check-in or the brains rebuild Today, the screen refreshes itself
    const sig = async () => { const [c, t] = await Promise.all([q(sb.from('cards').select('id').eq('status', 'live')), q(sb.from('transcripts').select('id').eq('kind', 'checkin'))]); return `${c.map((x) => x.id).sort().join()}|${t.length}`; };
    const first0 = await sig();
    const onToday = () => !location.hash || location.hash === '#today';
    setTimeout(() => onToday() && poll(async () => { if (!onToday()) return false; if ((await sig()) !== first0) { const y = window.scrollY; await screenToday(); window.scrollTo(0, y); return false; } return true; }, 15000), 15000);
    $app.querySelectorAll('.why').forEach((b) => (b.onclick = () => { const box = document.getElementById(`why-${b.dataset.card}`); box.hidden = !box.hidden; b.setAttribute('aria-expanded', String(!box.hidden)); }));
    $app.querySelectorAll('.vote').forEach((b) => (b.onclick = async () => { b.disabled = true; await q(sb.from('reactions').insert({ card_id: b.dataset.card, person: S.me.name, kind: b.dataset.kind })); b.parentElement.innerHTML = `<span class="small">Was this useful?</span><span class="donepill">${b.dataset.kind === 'useful' ? 'Useful' : 'Not useful'} · noted</span>`; }));
    $app.querySelectorAll('.act').forEach((b) => (b.onclick = async () => {
      const c = cards.find((x) => x.id === b.dataset.card); const a = c.action || {};
      b.disabled = true;
      try {
        if (a.kind === 'approve_edits' && a.ids) await q(sb.from('sf_edits').update({ status: 'approved', decided_by: S.me.name, decided_at: new Date().toISOString() }).in('id', a.ids));
        for (const ev of [...new Set([...(a.event_ids || []), ...(a.event_id ? [a.event_id] : [])])]) await q(sb.rpc('room_mark_done', { p_event: ev }));
        await q(sb.from('reactions').insert({ card_id: c.id, person: S.me.name, kind: 'done', reason: a.kind }));
        b.outerHTML = `<span class="donepill">✓ ${actionState(c, [{ card_id: c.id, kind: 'done' }])}</span>`;
      } catch (e) { b.disabled = false; b.textContent = 'Try again'; }
    }));
  }

  // ---------- VP: Brief me ----------
  async function briefText() {
    const rv = await review();
    const [cards, sn] = await Promise.all([q(sb.from('cards').select('*').eq('status', 'live').not('grp', 'is', null)), since(rv)]);
    const by = (g) => cards.filter((c) => c.grp === g).sort((a, b) => (b.rank || 0) - (a.rank || 0));
    const item = (c, i) => `${i + 1}. ${c.headline}. ${c.number ? `Number: ${c.number}. ` : ''}${plain(c.body)}${c.move ? ` Move: ${c.move}` : ''}${c.person && c.grp !== 'ask' ? ` (${c.person})` : ''}\n   Why: ${[...((c.why && c.why.rows) || []).map((r) => `${r.who} ${plain(r.what)} ${r.number || ''}`), ...((c.why && c.why.lines) || []).map((l) => plain(l.text))].join('; ').slice(0, 600)}`;
    return {
      cards, rv,
      headline: (() => { const w = ['no', 'one', 'two', 'three', 'four', 'five']; const n = (g) => cards.filter((c) => c.grp === g).length; const parts = [[n('decide'), 'to decide'], [n('ask'), 'to ask in the meeting'], [n('coach'), 'to coach']].filter(([k]) => k).map(([k, t]) => `${w[k] || k} ${t}`); return cards.length ? `You have ${w[cards.length] || cards.length} thing${cards.length > 1 ? 's' : ''} for the review: ${parts.join(', ')}.` : 'Nothing needs you for the review yet.'; })(),
      text: [
        `THE WEEK: pipeline review on ${rv ? weekday(rv.date) : 'the next review'}. ${sn.who.length ? `${sn.who.join(', ')} checked in.` : 'No check-ins yet.'} ${sn.fixes} Salesforce fixes waiting. ${sn.broken.length} promises broken since the last review. ${sn.toGo} reps still to check in.`,
        'TO DECIDE', ...(by('decide').map(item).length ? by('decide').map(item) : ['none']),
        'TO ASK IN THE MEETING', ...(by('ask').map(item).length ? by('ask').map(item) : ['none']),
        'TO COACH', ...(by('coach').map(item).length ? by('coach').map(item) : ['none']),
      ].join('\n'),
    };
  }
  async function screenBrief() {
    const b = await briefText();
    voiceScreen({
      kicker: 'THE BRIEFER', title: 'Brief me', sub: 'About 90 seconds. Interrupt any time.', back: '#today', cls: 'ink', agent: R.agents.briefer,
      vars: { first_name: first(S.me.name), brief: b.text, headline: b.headline },
      below: `<h2 class="grp">On today's screen</h2><div class="card"><ul class="plainlist">${b.cards.map((c) => `<li><b>${esc(c.headline)}</b>${c.number ? ` · ${esc(c.number)}` : ''}</li>`).join('')}</ul></div>`,
      done: 'Done. Everything is still on Today.',
    });
  }

  // ---------- VP: Deals (what each check-in will ask) ----------
  async function screenDeals() {
    const [lists, th] = await Promise.all([q(sb.from('brain_outputs').select('person,body,created_at').eq('brain', 'deal').eq('kind', 'rep_list').order('created_at', { ascending: false })), thinking()]);
    const latest = {}; for (const l of lists) if (!latest[l.person]) latest[l.person] = l;
    const reps = Object.values(latest).sort((a, b) => a.person.localeCompare(b.person));
    $app.innerHTML = header('DEAL BRAIN', 'What each check-in will ask', `Filtered by thinking model v${th.v.version} · ${th.deal.length} deal rules`, 'deal') + `
      <section class="section">${reps.map((l) => { const xs = l.body.listen_for || []; return `<details class="card"><summary><span class="title">${esc(l.person)}</span><span class="small">${xs.length} deal${xs.length === 1 ? '' : 's'} · ${day(l.created_at)}</span></summary>
        ${xs.map((x) => `<div class="row col"><span>${x.deal ? `<b>${usd(x.deal.value)}</b> · ${esc(x.deal.stage)} · close ${day(x.deal.close)}` : ''} <button class="ref" data-ref="${esc(x.ref)}">${esc(x.ref)}</button></span><span class="meta">${esc(plain(x.why))}</span></div>`).join('') || empty('Nothing to ask.')}</details>`; }).join('') || empty('No lists yet.')}
      <a class="btn dealfill" href="#train/deal">Change what it asks: talk to the Analyst</a></section>`;
  }

  // ---------- VP: People ----------
  async function screenPeople() {
    const [profs, th] = await Promise.all([q(sb.from('brain_outputs').select('person,body,created_at').eq('brain', 'coach').eq('kind', 'profile').order('created_at', { ascending: false })), thinking()]);
    const latest = {}; for (const p of profs) if (!latest[p.person]) latest[p.person] = p.body;
    $app.innerHTML = header('COACHING BRAIN', 'People', `Filtered by thinking model v${th.v.version} · ${th.coach.length} coaching rules`, 'coach') + `
      <section class="section"><div class="card"><div class="list">${Object.values(latest).sort((a, b) => a.person.localeCompare(b.person)).map((p) => `<a class="row" href="#person/${slug(p.person)}"><span><span class="title">${esc(p.person)}</span><br><span class="meta">${esc(String(p.in_one_line || '').split('. ')[0])}</span></span><span aria-hidden="true">›</span></a>`).join('')}</div></div>
      <a class="btn coach" href="#train/coach">Change what it watches for: talk to the Mentor</a></section>`;
  }

  async function screenPerson(name) {
    if (!name || name === 'me' || (!isLead() && name !== S.me.name)) name = S.me.name;
    const [prof, l, promises] = await Promise.all([
      q(sb.from('brain_outputs').select('body').eq('brain', 'coach').eq('kind', 'profile').eq('person', name).order('created_at', { ascending: false }).limit(1)),
      latestList(name),
      q(sb.from('promises').select('*').eq('by_person', name).order('made_on', { ascending: false }).limit(5)),
    ]);
    const p = prof[0] && prof[0].body; const self = S.me.name === name;
    if (!isLead()) {
      const r = (p && p.for_rep) || null; const open = promises.filter((x) => x.status === 'open' || x.status === 'unclear');
      $app.innerHTML = header('ABOUT YOU', `${esc(first(name))}, how it's going`, 'A short read from your check-ins and reviews.') + `
        <section class="section"><h2 class="grp g-coach">What you do well</h2><div class="card">${r && r.strengths.length ? `<ul class="plainlist">${r.strengths.slice(0, 2).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : empty(p ? 'Your notes are being refreshed. Check back soon.' : 'After a couple of reviews, this fills in.')}</div></section>
        ${r && r.to_try.length ? `<section class="section"><h2 class="grp g-coach">Things to try</h2><div class="card"><ul class="plainlist">${r.to_try.slice(0, 2).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div></section>` : ''}
        ${l ? `<section class="section"><h2 class="grp g-ask">Next check-in asks about</h2><div class="card">${listRows(l.body)}</div></section>` : ''}
        ${open.length ? `<section class="section"><h2 class="grp">Your open promises</h2><div class="card"><div class="list">${open.map((x) => `<div class="row"><span>${esc(x.promise)}</span><span class="meta">${day(x.made_on)}</span></div>`).join('')}</div></div></section>` : ''}`;
      return;
    }
    const obs = (o) => `<li>${esc(o.observation)}${o.evidence && o.evidence[0] ? `<div class="quote"><b>${day(o.evidence[0].date)}</b> “${esc(o.evidence[0].quote)}”</div>` : ''}</li>`;
    $app.innerHTML = header(self ? 'ABOUT YOU' : 'PERSON', esc(name), '') + `
      ${p ? `<section class="section"><h2 class="grp g-coach">Coaching</h2><div class="card"><div class="text">${esc(p.in_one_line)}</div>
        <h3>Strengths</h3><ul class="plainlist">${(p.strengths || []).slice(0, 2).map(obs).join('')}</ul>
        <h3>To work on</h3><ul class="plainlist">${(p.patterns || []).slice(0, 2).map(obs).join('')}</ul>
        ${p.coaching_move ? `<div class="move">${esc(p.coaching_move)}</div>` : ''}</div>
        <div class="small">Dated quotes, never a score. Every quote is checked word for word.</div></section>` : `<section class="section">${empty(`${esc(first(name))} has fewer than two reviews on file, so there is no coaching profile yet.`)}</section>`}
      ${l ? `<section class="section"><h2 class="grp g-ask">Next check-in asks about</h2><div class="card">${listRows(l.body)}</div></section>` : ''}
      <section class="section"><h2 class="grp">Promises</h2><div class="card"><div class="list">${promises.map((x) => `<div class="row"><span><span>${esc(x.promise)}</span><br><span class="meta">${day(x.made_on)}</span></span><span class="pill ${x.status === 'kept' ? 'kept' : x.status === 'broken' ? 'broken' : 'notraised'}">${esc(x.status)}</span></div>`).join('') || empty('None on file.')}</div></div></section>`;
  }
  const listRows = (b) => (b.listen_for || []).map((x) => `<div class="row col"><span>${x.deal ? `<b>${usd(x.deal.value)}</b> · ${esc(x.deal.stage)} · close ${day(x.deal.close)}` : esc(x.ref)}</span><span class="meta">${esc(plain(x.ask || x.why))}</span></div>`).join('') || empty('Nothing on the list. The agent will just listen.');

  // ---------- VP: Thinking ----------
  async function screenThinking() {
    const [th, sessions, versions] = await Promise.all([
      thinking(),
      q(sb.from('training_sessions').select('*').in('status', ['proposed', 'working']).order('created_at', { ascending: false }).limit(5)),
      q(sb.from('thinking_versions').select('*').order('version', { ascending: false }).limit(5)),
    ]);
    const ruleList = (rs) => `<ol class="rules">${rs.map((r) => `<li><span>${esc(r.text)}</span><span class="src2 ${r.source}">${r.source === 'person' ? esc(first(r.author)) : r.source === 'reaction' ? 'reactions' : 'data'}</span></li>`).join('')}</ol>`;
    $app.innerHTML = header('THINKING MODEL', `v${th.v.version}`, 'Every agent filters its results through these rules. They change only when you deploy.') + `
      ${sessions.length ? `<section class="section"><h2 class="grp">Waiting for you</h2>${sessions.map((s) => `<a class="card rowlink" href="#session/${s.id}"><b>${s.brain === 'deal' ? 'Analyst' : 'Mentor'} session · ${day(s.created_at)}</b><span class="small">${s.status === 'working' ? 'Turning the call into rules…' : `${((s.proposal && s.proposal.rules) || []).length} rules ready to deploy`}</span></a>`).join('')}</section>` : ''}
      <div class="cols two">
        <section class="section"><div class="sechead"><h2 class="grp g-ask">Deal brain</h2><span class="small">Mark and the CEO</span></div><div class="card">${ruleList(th.deal)}</div><a class="btn dealfill" href="#train/deal">${mic('#fff')} Talk to the Analyst</a></section>
        <section class="section"><div class="sechead"><h2 class="grp g-coach">Coaching brain</h2><span class="small">Mark</span></div><div class="card">${ruleList(th.coach)}</div><a class="btn coach" href="#train/coach">${mic('#fff')} Talk to the Mentor</a></section>
      </div>
      <section class="section"><h2 class="grp">History</h2><div class="card"><div class="list">${versions.map((v) => `<div class="row"><span><b>v${v.version}</b> · ${esc(v.summary || '')}</span><span class="meta">${esc(first(v.deployed_by))} · ${day(v.created_at)}</span></div>`).join('')}</div></div><div class="small">Every version is kept.</div></section>`;
  }

  // ---------- VP: talk to the Analyst or the Mentor ----------
  async function screenTrain(brain) {
    brain = brain === 'coach' ? 'coach' : 'deal';
    const who = brain === 'deal' ? 'The Analyst' : 'The Mentor';
    $app.innerHTML = header(who.toUpperCase(), 'Getting ready…', '', brain === 'deal' ? 'deal' : 'coach');
    const b = await server('trainer-brief', { brain });
    const th = await thinking();
    voiceScreen({
      kicker: who.toUpperCase(), title: brain === 'deal' ? 'Train the deal brain' : 'Train the coaching brain', back: '#thinking', cls: brain === 'deal' ? 'deal' : 'coach',
      sub: 'Say what matters. It plays each rule back and checks with you. At the end it asks to deploy.',
      agent: brain === 'deal' ? R.agents.analyst : R.agents.mentor,
      vars: { first_name: first(S.me.name), brief: b.brief },
      below: `<h2 class="grp">Rules now · v${th.v.version}</h2><div class="card"><ol class="rules">${(brain === 'deal' ? th.deal : th.coach).map((r) => `<li><span>${esc(r.text)}</span></li>`).join('')}</ol></div>`,
      done: 'Turning the call into rules…',
      onEnd: async (conv) => { const r = await server('trainer-ended', { conversation_id: conv, brain }); location.hash = `#session/${r.session_id}`; },
    });
  }

  // After a training call: what Mark told it, what changes, Deploy
  async function screenSession(id) {
    const draw = (s, th) => {
      const p = s.proposal || {}; const rules = p.rules || []; const fx = p.effects || [];
      const who = s.brain === 'deal' ? 'The Analyst' : 'The Mentor';
      const head = header(`${who.toUpperCase()} · SESSION DONE`, s.status === 'deployed' ? 'Deployed' : s.status === 'working' ? 'Writing it up…' : "Here's what you told me", '', s.brain === 'deal' ? 'deal' : 'coach');
      if (s.status === 'working') return `${head}<section class="section"><div class="card"><div class="spinner" aria-hidden="true"></div><div class="text">Turning the call into rules. About a minute.</div></div></section>`;
      if (s.status === 'failed' || s.status === 'discarded') return `${head}<section class="section"><div class="card"><div class="text">${s.status === 'discarded' ? 'No new rules came out of this call. Nothing changes.' : `Something went wrong: ${esc(s.error || '')}`}</div></div><a class="btn ink" href="#train/${s.brain}">Talk again</a></section>`;
      const auto = p.deploy_confirmed && s.status === 'proposed';
      return `${head}
        <section class="section"><h2 class="grp">${rules.length} rule${rules.length === 1 ? '' : 's'} for the ${s.brain === 'deal' ? 'deal' : 'coaching'} brain</h2>
          ${rules.map((r, i) => `<div class="card"><div class="headline">${i + 1}. ${esc(r.text)}</div><div class="quote">You said: “${esc(r.said)}”</div>${r.evidence ? `<div class="small">${esc(plain(r.evidence))}</div>` : ''}${r.replaces ? `<div class="small">Replaces rule ${r.replaces}</div>` : ''}</div>`).join('')}</section>
        ${fx.length ? `<section class="section"><h2 class="grp">What changes${s.status === 'deployed' ? '' : ' if you deploy'}</h2><div class="card"><div class="list">${fx.slice(0, 4).map((f) => `<div class="row"><span class="meta wide">${esc(f.where)}</span><span>${esc(plain(f.change))}</span></div>`).join('')}</div></div></section>` : ''}
        <section class="section">
          ${s.status === 'deployed' ? `<div class="card ok"><b>Thinking model v${th.v.version} is live.</b><span class="small">Check-in lists, Today and the Briefer refresh in about two minutes.</span></div><a class="btn ink" href="#today">Back to Today</a>`
            : auto ? '<div class="card"><div class="spinner" aria-hidden="true"></div><b>You said yes on the call. Deploying…</b></div>'
            : `<div class="small">Thinking model v${th.v.version} → v${th.v.version + 1}. Every version is kept.</div><b>Deploy this across the app?</b><div class="quick"><a class="btn ghost" href="#thinking">Not yet</a><button class="btn ink" id="deploy">Deploy</button></div>`}
        </section>`;
    };
    poll(async () => {
      if (!location.hash.startsWith('#session/')) return false;
      const [s] = await q(sb.from('training_sessions').select('*').eq('id', id));
      if (!s) { $app.innerHTML = header('SESSION', 'Not found'); return false; }
      const th = await thinking();
      $app.innerHTML = draw(s, th);
      const d = document.getElementById('deploy');
      if (d) d.onclick = async () => { d.disabled = true; d.textContent = 'Deploying…'; try { await server('deploy', { session_id: id }); screenSession(id); } catch (e) { d.disabled = false; d.textContent = 'Try again'; } };
      return s.status === 'working' || (s.status === 'proposed' && s.proposal && s.proposal.deploy_confirmed);
    });
  }

  // ---------- Rep: my week ----------
  async function screenMe() {
    const [l, drafts] = await Promise.all([latestList(S.me.name), q(sb.from('checkin_drafts').select('id,status,created_at,sent_at').eq('person', S.me.name).order('created_at', { ascending: false }).limit(1))]);
    const d = drafts[0];
    const status = !d ? '' : d.status === 'draft' ? `<a class="card rowlink warn" href="#draft/${d.id}"><b>Your last check-in is waiting for you</b><span class="small">Review what I heard, then send it to Mark.</span></a>`
      : d.status === 'sent' ? `<div class="small">Last check-in sent ${day(d.sent_at)}.</div>` : d.status === 'working' ? `<a class="small" href="#draft/${d.id}">Writing up your last check-in…</a>` : '';
    $app.innerHTML = header('MY WEEK', `${esc(first(S.me.name))}, your week`, l ? esc(plain(l.body.month)) : '') + `
      <section class="section"><button class="brief" type="button" id="go"><span class="mic">${mic()}</span><span><b>Check in</b><span>About three minutes. It listens first.</span></span></button>${status}</section>
      <section class="section"><h2 class="grp g-ask">It will ask about</h2><div class="card">${l ? listRows(l.body) : empty('No list yet.')}</div><div class="small">Chosen by the deal brain, filtered by Mark's thinking model.</div></section>`;
    document.getElementById('go').onclick = () => { location.hash = '#checkin'; };
  }

  async function briefFor(name) {
    const [l, proms] = await Promise.all([latestList(name), q(sb.from('promises').select('*').eq('by_person', name).order('made_on', { ascending: false }))]);
    const b = l && l.body; const last = proms.length ? proms[0].made_on : null;
    const open = proms.filter((p) => p.made_on === last && p.status !== 'kept' && p.status !== 'broken');
    const deals = b ? b.listen_for || [] : [];
    return {
      deals,
      text: [
        b ? `THEIR MONTH: ${plain(b.month)}` : '',
        'YOUR LIST (ask about each one they do not cover, in this order):',
        ...deals.map((x, i) => `${i + 1}. ${x.deal ? `The ${usd(x.deal.value)} deal at ${x.deal.stage}, close date ${day(x.deal.close)}` : 'A deal'}. Why it matters: ${plain(x.why)}`),
        `OPEN PROMISES (from the review on ${last ? day(last) : 'n/a'}):`,
        ...(open.length ? open.map((p) => `- ${p.promise}`) : ['- none']),
      ].filter(Boolean).join('\n'),
    };
  }
  async function screenCheckin(name) {
    if (!name || !isLead()) name = S.me.name;
    const b = await briefFor(name);
    voiceScreen({
      kicker: 'CHECK-IN', title: esc(name), sub: 'About three minutes. Talk about your week. It asks only what you skip.', back: isLead() ? `#person/${slug(name)}` : '#me', cls: 'ink', agent: R.agents.checkin,
      vars: { rep_name: name, first_name: first(name), brief: b.text },
      below: `<h2 class="grp g-ask">It will ask about</h2><div class="card">${b.deals.map((x) => `<div class="row"><span>${x.deal ? `<b>${usd(x.deal.value)}</b> · ${esc(x.deal.stage)} · close ${day(x.deal.close)}` : ''}</span></div>`).join('') || empty('Nothing. It will just listen.')}</div>`,
      done: 'Writing up what I heard…',
      onEnd: async (conv) => { const r = await server('checkin-ended', { conversation_id: conv }); location.hash = `#draft/${r.draft_id}`; },
    });
  }

  // After the check-in: what I heard -> untick -> send
  const SECTIONS = [
    ['deals', 'Deals', (x) => `${esc(x.client || 'Deal')}${x.size ? ` · ${esc(x.size)}` : ''} · ${esc(x.line)}`],
    ['sf_edits', 'Salesforce changes · Mark approves', (x) => esc(x.line || `${x.field} → ${x.to}`)],
    ['promises_checked', 'Promises', (x) => `${x.status === 'kept' ? 'Kept' : x.status === 'broken' ? 'Not done' : 'Unclear'} · ${esc(x.promise || '')}`],
    ['promises_made', 'New promises', (x) => `New · ${esc(x.promise)}${x.due ? ` by ${day(x.due)}` : ''}`],
    ['for_mark', 'For Mark', (x) => esc(x.headline)],
  ];
  async function screenDraft(id) {
    const draw = async (d) => {
      const g = d.draft || {};
      if (d.status === 'working') return `${header('CHECK-IN DONE', 'Writing up what I heard…')}<section class="section"><div class="card"><div class="spinner" aria-hidden="true"></div><div class="text">About 30 seconds. Nothing reaches Mark until you send it.</div></div></section>`;
      if (d.status === 'failed') return `${header('CHECK-IN', 'That did not work')}<section class="section"><div class="card"><div class="text">${esc(d.error || 'The call could not be written up.')}</div></div><a class="btn ink" href="#checkin">Talk again</a></section>`;
      if (d.status === 'sent') {
        const l = await latestList(d.person);
        const fresh = l && d.sent_at && l.created_at > d.sent_at;
        return `${header('SENT', 'Sent to Mark', `${day(d.sent_at)} · his Today is updating`)}
          <section class="section"><h2 class="grp">What changed</h2><div class="card"><ul class="plainlist">
            ${(g.sf_edits || []).length ? `<li>${g.sf_edits.length} Salesforce change${g.sf_edits.length > 1 ? 's' : ''} waiting for Mark</li>` : ''}
            ${(g.for_mark || []).length ? `<li>${g.for_mark.length} ask${g.for_mark.length > 1 ? 's' : ''} on Mark's Today</li>` : ''}
            ${(g.promises_checked || []).length + (g.promises_made || []).length ? `<li>${(g.promises_checked || []).length + (g.promises_made || []).length} promises updated</li>` : ''}
            <li>${fresh ? 'Your next check-in list is updated' : 'Updating your next check-in list…'}</li></ul></div></section>
          ${fresh ? `<section class="section"><h2 class="grp g-ask">Next check-in asks about</h2><div class="card">${listRows(l.body)}</div></section>` : ''}
          <section class="section"><a class="btn ghost" href="#me">Back to my week</a></section>`;
      }
      const nc = (g.not_covered || []).map((x) => (typeof x === 'string' ? x : [x.size, x.line].filter(Boolean).join(' ')));
      return `${header('CHECK-IN DONE', "Here's what I heard", 'Untick anything wrong. Nothing reaches Mark until you send.')}
        ${SECTIONS.map(([k, label, fmt]) => ((g[k] || []).length ? `<section class="section"><h2 class="grp">${label}</h2><div class="card">${g[k].map((x, i) => `<label class="tick"><input type="checkbox" data-k="${k}" data-i="${i}" checked><span>${fmt(x)}</span></label>`).join('')}</div></section>` : '')).join('')}
        ${nc.length ? `<section class="section"><div class="small">Not covered, Mark will see this: ${nc.map(esc).join(', ')}.</div></section>` : ''}
        <section class="section"><div class="quick"><a class="btn ghost" href="#checkin">Talk again</a><button class="btn ink" id="send">Send to Mark</button></div></section>`;
    };
    poll(async () => {
      if (!location.hash.startsWith('#draft/')) return false;
      const [d] = await q(sb.from('checkin_drafts').select('*').eq('id', id));
      if (!d) { $app.innerHTML = header('CHECK-IN', 'Not found'); return false; }
      $app.innerHTML = await draw(d);
      const send = document.getElementById('send');
      if (send) send.onclick = async () => {
        send.disabled = true; send.textContent = 'Sending…';
        const keep = { not_covered: (d.draft || {}).not_covered || [] };
        for (const [k] of SECTIONS) keep[k] = ((d.draft || {})[k] || []).filter((x, i) => { const c = $app.querySelector(`input[data-k="${k}"][data-i="${i}"]`); return c && c.checked; });
        try { await server('checkin-send', { draft_id: id, keep }); screenDraft(id); } catch (e) { send.disabled = false; send.textContent = 'Try again'; }
      };
      if (d.status === 'sent') { const l = await latestList(d.person); return !(l && l.created_at > d.sent_at); }
      return d.status === 'working';
    }, 5000);
  }

  // ---------- one voice screen for all four agents ----------
  function voiceScreen(o) {
    $app.innerHTML = `${header(o.kicker, o.title, o.sub, o.cls)}
      <section class="section center"><a class="small backlink" href="${o.back}">← Back</a>
        <button id="orb" class="orb ${o.cls}" type="button" aria-label="Start">${mic('#fff').replace('width="20" height="20"', 'width="44" height="44"')}</button>
        <div id="vStatus" class="sub" aria-live="polite">Tap to start. Your browser will ask for the microphone.</div>
        <button class="btn ghost" id="vEnd" hidden>Finish</button></section>
      <section class="section"><div class="card" id="vLog" hidden><div class="list" id="vLines"></div></div></section>
      <section class="section">${o.below || ''}</section>`;
    const $s = document.getElementById('vStatus'), $orb = document.getElementById('orb'), $end = document.getElementById('vEnd'), $log = document.getElementById('vLog'), $lines = document.getElementById('vLines');
    let heard = 0;
    const say = (who, text) => { $log.hidden = false; const d = document.createElement('div'); d.className = 'row col'; d.innerHTML = `<b class="small">${esc(who)}</b><span>${esc(text)}</span>`; $lines.appendChild(d); };
    $orb.onclick = async () => {
      if (live) return;
      if (!window.ElevenLabsConversation) { $s.textContent = 'Voice could not load. Refresh and try again.'; return; }
      $orb.disabled = true; $s.textContent = 'Connecting…';
      let conv = null;
      try {
        live = await window.ElevenLabsConversation.startSession({
          agentId: o.agent, connectionType: 'websocket', dynamicVariables: o.vars,
          onConnect: (x) => { conv = (x && x.conversationId) || conv; $orb.classList.add('on'); $end.hidden = false; $s.textContent = 'Listening'; },
          onModeChange: (m) => { $s.textContent = m.mode === 'speaking' ? 'Speaking' : 'Listening'; $orb.classList.toggle('speaking', m.mode === 'speaking'); },
          onMessage: (m) => { const ai = m.source === 'ai' || m.role === 'agent'; if (!ai) heard++; say(ai ? o.kicker.replace(/^THE /, '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : first(S.me.name), m.message); },
          onError: (msg) => { $s.textContent = `Something went wrong: ${msg}`; },
          onDisconnect: async () => {
            const id = conv || (live && live.getId && live.getId());
            live = null; $orb.classList.remove('on', 'speaking'); $orb.disabled = false; $end.hidden = true;
            if (!o.onEnd) { $s.textContent = o.done; return; }
            if (!heard || !id) { $s.textContent = 'Nothing was said, so nothing was saved. Tap to try again.'; return; }
            $s.textContent = o.done;
            try { await o.onEnd(id); } catch (e) { $s.textContent = `Could not save the call: ${e.message || e}`; }
          },
        });
        conv = conv || (live.getId && live.getId());
      } catch (e) {
        live = null; $orb.disabled = false;
        $s.textContent = /permission|denied|NotAllowed/i.test(String(e && (e.name || e.message))) ? 'The microphone is blocked. Allow it in your browser settings, then tap again.' : `Could not start: ${e.message || e}`;
      }
    };
    $end.onclick = async () => { if (live) await live.endSession(); };
  }

  // ---------- admin: inputs ----------
  async function screenInputs() {
    const [exp, trs, ppl] = await Promise.all([
      q(sb.from('exports').select('*').order('uploaded_at', { ascending: false }).limit(1)),
      q(sb.from('transcripts').select('kind,date').order('date', { ascending: false })),
      q(sb.from('people').select('name,role,email').order('name')),
    ]);
    const e = exp[0]; const reviews = trs.filter((t) => t.kind === 'review');
    const reps = ppl.filter((p) => p.role === 'rep').map((p) => p.name);
    $app.innerHTML = header('ADMIN', 'Inputs', 'What the brains read. Anything new here refreshes check-in lists, profiles and Today.') + `
      <section class="section"><div class="card"><div class="list">
        <div class="row"><span>Salesforce export</span><span class="meta">${e ? `data to ${day(e.as_of)} · ${e.deals.toLocaleString('en-US')} deals · ${day(e.uploaded_at)}` : 'none'}</span></div>
        <div class="row"><span>Review recordings</span><span class="meta">${reviews.length}${reviews[0] ? ` · latest ${day(reviews[0].date)}` : ''}</span></div>
        <div class="row"><span>Check-ins</span><span class="meta">${trs.length - reviews.length} sent</span></div>
        <div class="row"><span>People who can sign in</span><span class="meta">${ppl.filter((p) => p.email).length} of ${ppl.length}</span></div>
      </div></div></section>

      <section class="section"><h2 class="grp g-ask">New Salesforce export</h2><div class="card">
        <div class="text">The same export as before: one row per product line, .xlsx or .csv.</div>
        <label class="btn ghost filebtn">Choose file<input type="file" id="sfFile" accept=".xlsx,.xls,.csv" hidden></label>
        <div id="sfOut" class="text" aria-live="polite"></div>
      </div></section>

      <section class="section"><h2 class="grp g-coach">New review recording</h2><div class="card">
        <div class="text">A transcript as text (.txt, .vtt, .md), or paste it below.</div>
        <label class="btn ghost filebtn">Choose file<input type="file" id="trFile" accept=".txt,.vtt,.md,.srt,text/plain" hidden></label>
        <label>Transcript<textarea id="trText" rows="5" placeholder="Paste the transcript here"></textarea></label>
        <div class="two-inputs"><label>Meeting date<input type="date" id="trDate"></label><label>Title<input id="trTitle" placeholder="MM US pipeline review"></label></div>
        <div class="small">Who was in it? Names found in the text are ticked.</div>
        <div class="people" id="trPeople">${reps.map((n) => `<label class="tick"><input type="checkbox" value="${esc(n)}"><span>${esc(n)}</span></label>`).join('')}</div>
        <button class="btn ink" id="trAdd">Add recording</button>
        <div id="trOut" class="text" aria-live="polite"></div>
      </div></section>`;

    // ---- Salesforce export: read and check in the browser, then load in chunks ----
    const $sf = document.getElementById('sfOut');
    document.getElementById('sfFile').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      $sf.textContent = `Reading ${f.name}…`;
      try {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
        await loadScript('vendor/room-data.js');
        const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        const need = ['Opportunity ID', 'Opportunity Owner', 'Owner Role', 'Stage', 'Close Date', 'Total Price (converted)'];
        const missing = need.filter((k) => !(rows[0] && k in rows[0]));
        if (missing.length) { $sf.innerHTML = `<span class="error">This file is missing columns: ${missing.map(esc).join(', ')}.</span>`; return; }
        const { deals, today } = window.RoomData.ingest(rows);
        const F = window.RoomData.buildFacts(deals, today);
        const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
        const t = new Date(`${F.asOf}T00:00:00Z`); do { t.setUTCDate(t.getUTCDate() + 1); } while (t.getUTCDay() !== 2);
        const repNames = Object.keys(F.reps); const newReps = repNames.filter((n) => !ppl.some((p) => p.name === n));
        $sf.innerHTML = `<ul class="plainlist"><li>${rows.length.toLocaleString('en-US')} rows, ${deals.length.toLocaleString('en-US')} deals</li><li>Data to ${day(F.asOf)}${e ? ` (last export: ${day(e.as_of)})` : ''}</li><li>${repNames.length} AEs, ${F.live.length} open deals${newReps.length ? `, ${newReps.length} new: ${newReps.map(esc).join(', ')}` : ''}</li></ul>
          <label>Next review<input type="date" id="sfReview" value="${iso(t)}"></label>
          <button class="btn ink" id="sfLoad">Load it</button>`;
        document.getElementById('sfLoad').onclick = async (b) => {
          const btn = b.currentTarget; btn.disabled = true;
          const say = (m) => { btn.textContent = m; };
          try {
            say('Starting…');
            const exportId = await q(sb.rpc('room_export_start', { p_as_of: F.asOf, p_rows: rows.length, p_deals: deals.length }));
            const D = deals.map((d) => ({ id: d.id, ref: d.ref, owner: d.owner, segment: d.segment, region: d.region, value: d.value, band: window.RoomData.band(d.value), stage: d.stageName, stage_num: d.stageNum, prob: d.prob, close: iso(d.close), status: d.status, entered_stage: iso(d.enteredStage), source: d.source, type: d.type, products: d.families }));
            for (let i = 0; i < D.length; i += 2000) { say(`Loading deals ${Math.min(i + 2000, D.length).toLocaleString('en-US')} of ${D.length.toLocaleString('en-US')}…`); await q(sb.rpc('room_export_deals', { p_export: exportId, p_deals: D.slice(i, i + 2000) })); }
            say('Saving the facts…');
            const fin = await q(sb.rpc('room_export_finish', { p_export: exportId, p_facts: F, p_review: document.getElementById('sfReview').value }));
            await server('export-loaded', {});
            $sf.innerHTML = `<div class="card ok"><b>Loaded. Data to ${day(fin.as_of)}, review on ${day(fin.review)}.</b><span class="small">The deal brain is rewriting every check-in list. Today refreshes in about two minutes.</span></div>`;
          } catch (err) { btn.disabled = false; btn.textContent = 'Try again'; $sf.insertAdjacentHTML('beforeend', `<div class="error">${esc(err.message || err)}</div>`); }
        };
      } catch (err) { $sf.innerHTML = `<span class="error">Could not read this file: ${esc(err.message || err)}</span>`; }
    };

    // ---- Review recording ----
    const $txt = document.getElementById('trText'), $out = document.getElementById('trOut');
    const tickNames = () => { const t = $txt.value.toLowerCase(); document.querySelectorAll('#trPeople input').forEach((c) => { if (t && t.includes(c.value.toLowerCase())) c.checked = true; }); };
    $txt.oninput = tickNames;
    document.getElementById('trFile').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      $txt.value = await f.text(); tickNames();
      const m = f.name.match(/(\d{4}-\d{2}-\d{2})/); if (m) document.getElementById('trDate').value = m[1];
      document.getElementById('trTitle').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    };
    document.getElementById('trAdd').onclick = async (b) => {
      const btn = b.currentTarget; const raw = $txt.value.trim(); const date = document.getElementById('trDate').value;
      const people = [...document.querySelectorAll('#trPeople input:checked')].map((c) => c.value);
      if (!raw || !date || !people.length) { $out.innerHTML = '<span class="error">Add the transcript, the date, and at least one person.</span>'; return; }
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const tid = await q(sb.rpc('room_add_transcript', { p_date: date, p_title: document.getElementById('trTitle').value || 'Pipeline review', p_people: people, p_raw: raw }));
        await server('transcript-added', { people, transcript_id: tid });
        $out.innerHTML = `<div class="card ok"><b>Added.</b><span class="small">The coaching brain is re-reading ${people.length} profile${people.length > 1 ? 's' : ''} and logging promises. Today refreshes in about two minutes.</span></div>`;
        btn.textContent = 'Added';
      } catch (err) { btn.disabled = false; btn.textContent = 'Try again'; $out.innerHTML = `<span class="error">${esc(err.message || err)}</span>`; }
    };
  }
  const loadScript = (src) => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error(`could not load ${src}`)); document.head.appendChild(el); });

  // ---------- sign in ----------
  function screenLogin(msg) {
    $tabs.hidden = true;
    $app.innerHTML = `<div class="login">
      <div class="brand">PIPELINE ROOM</div>
      <h1>Walk into the pipeline review knowing where you're needed</h1>
      <p class="sub">Reps check in by voice. Two brains read it. Mark gets five things, filtered by rules he sets by voice.</p>
      <form id="loginForm">
        <label for="email">Email<input id="email" type="email" autocomplete="username" required></label>
        <label for="password">Password<input id="password" type="password" autocomplete="current-password" required></label>
        <button class="btn ink wide" type="submit">Sign in</button>
        <div class="error" id="loginError" ${msg ? '' : 'hidden'}>${esc(msg || '')}</div>
      </form>
      <div class="quick"><button class="btn ghost sm" data-email="mark@example.com">Mark · VP</button><label class="sr" for="repPick">Pick a rep</label><select id="repPick" class="btn ghost sm"><option value="">Pick a rep…</option>${["alexandra","andrew","david","devin","djavan","dominic","federico","gabby","james","jimena","laura","luke","mayi","nick","paddy","peter","rich","tom"].map((n) => `<option value="${n}@example.com">${n[0].toUpperCase() + n.slice(1)} · rep</option>`).join("")}</select></div>
    </div>`;
    $app.querySelectorAll('[data-email]').forEach((b) => (b.onclick = () => { document.getElementById('email').value = b.dataset.email; document.getElementById('password').focus(); }));
    document.getElementById('repPick').onchange = (e) => { if (e.target.value) { document.getElementById('email').value = e.target.value; document.getElementById('password').focus(); } };
    document.getElementById('loginForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: document.getElementById('email').value.trim(), password: document.getElementById('password').value });
      if (error) { const el = document.getElementById('loginError'); el.hidden = false; el.textContent = 'That email and password did not match.'; return; }
      boot();
    };
  }

  // ---------- routing ----------
  async function route() {
    if (!S.me) return;
    stopPoll();
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || (isLead() ? 'today' : 'me');
    const [k, ...rest] = h.split('/'); const arg = rest.join('/');
    const tab = { brief: 'today', train: 'thinking', session: 'thinking', checkin: isLead() ? 'people' : 'me', draft: 'me', person: isLead() ? 'people' : 'person' }[k] || k;
    tabs(tab);
    document.body.dataset.screen = k;
    try {
      if (!isLead()) {
        if (k === 'person') await screenPerson(S.me.name);
        else if (k === 'checkin') await screenCheckin();
        else if (k === 'draft') await screenDraft(arg);
        else await screenMe();
      } else if (k === 'deals') await screenDeals();
      else if (k === 'people') await screenPeople();
      else if (k === 'person') await screenPerson(arg);
      else if (k === 'thinking') await screenThinking();
      else if (k === 'train') await screenTrain(arg);
      else if (k === 'session') await screenSession(arg);
      else if (k === 'brief') await screenBrief();
      else if (k === 'checkin') await screenCheckin(arg);
      else if (k === 'draft') await screenDraft(arg);
      else if (k === 'inputs') await screenInputs();
      else await screenToday();
    } catch (e) {
      $app.innerHTML = `<section class="section"><p class="error">Could not load this screen: ${esc(e.message || e)}. Refresh, or sign out and back in.</p></section>`;
    }
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', async (e) => { if (e.target.closest('.signout')) { await sb.auth.signOut(); S.me = null; screenLogin(); } });

  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return screenLogin();
    const me = await q(sb.from('people').select('*').ilike('email', data.session.user.email).limit(1));
    if (!me[0]) { await sb.auth.signOut(); return screenLogin('This login is not on the team yet. Ask the admin to add you.'); }
    S.me = me[0];
    route();
  }
  window.addEventListener('hashchange', async () => { if (live) { try { await live.endSession(); } catch (e) {} live = null; } route(); });
  boot();
})();
