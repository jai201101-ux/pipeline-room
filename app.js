// Pipeline Room app. Plain JS, no build step. Reads live from Supabase as the logged-in person;
// row security in the database decides what each person can see.
(() => {
  const sb = window.supabase.createClient(window.ROOM.url, window.ROOM.anonKey);
  const $app = document.getElementById('app');
  const $tabs = document.getElementById('tabs');
  const $tabsInner = document.getElementById('tabsInner');
  const S = { me: null, facts: null, dealsByRef: {} };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (v) => (v === null || v === undefined ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v).toLocaleString('en-US')}`);
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
  const day = (d) => (d ? new Date(d + (String(d).length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
  const isLead = () => S.me && (S.me.role === 'vp' || S.me.role === 'admin');
  const first = (n) => String(n || '').split(' ')[0];
  const slug = (n) => encodeURIComponent(n);

  // Turn "deal 0IzVjb" / "(deal 0IzVjb)" into a tappable chip and "[F:...]" into a citation chip
  function rich(text) {
    let h = esc(text);
    // Deal refs are the last 6 characters of a Salesforce id: a digit, then letters and digits including a capital
    h = h.replace(/\(?(?:deals? )?\b([0-9][0-9A-Za-z]{5})\b\)?/g, (m, ref) => (/[A-Z]/.test(ref) && /[a-z]|[A-Z].*[0-9]|[0-9].*[A-Z]/.test(ref) ? m.replace(ref, `<button class="ref" data-ref="${ref}" aria-label="Show deal ${ref}">${ref}</button>`).replace(/^\(?deals? /, (x) => x.replace(/deals? /, '')) : m));
    h = h.replace(/\[((?:F:[^\]\s]+)(?:\]\[F:[^\]\s]+)*)\]/g, (m, inner) => inner.split('][').map((id) => `<button class="cite" data-fact="${esc(id)}" aria-label="Show evidence ${esc(id)}">${esc(id.replace(/^F:/, ''))}</button>`).join(' '));
    return h;
  }
  function lensHtml(md) {
    const out = []; let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(md || '').split('\n')) {
      const line = raw.trim();
      if (!line) { close(); continue; }
      let m;
      if ((m = line.match(/^#{1,3}\s+(.*)/))) { close(); out.push(`<h4>${esc(m[1])}</h4>`); }
      else if ((m = line.match(/^[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${rich(m[1])}</li>`); }
      else if ((m = line.match(/^\d+\.\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${rich(m[1])}</li>`); }
      else { close(); out.push(`<p>${rich(line)}</p>`); }
    }
    close();
    return out.join('');
  }
  async function q(promise) { const { data, error } = await promise; if (error) throw error; return data; }

  // ---------- tap handlers for deal and evidence chips ----------
  document.addEventListener('click', async (e) => {
    const r = e.target.closest('.ref'); const c = e.target.closest('.cite');
    if (!r && !c) return;
    e.preventDefault();
    const host = (r || c).closest('.card, .lens, li, p, .bubble') || (r || c).parentElement;
    let pop = host.querySelector(':scope > .popover');
    if (pop && pop.dataset.key === (r ? r.dataset.ref : c.dataset.fact)) { pop.remove(); return; }
    if (pop) pop.remove();
    pop = document.createElement('div'); pop.className = 'popover'; pop.dataset.key = r ? r.dataset.ref : c.dataset.fact;
    if (r) {
      const ref = r.dataset.ref;
      let d = S.dealsByRef[ref];
      if (!d) { const rows = await q(sb.from('deals').select('*').eq('ref', ref).limit(1)); d = rows[0]; if (d) S.dealsByRef[ref] = d; }
      pop.innerHTML = d ? `<b>Deal ${esc(ref)} · ${esc(d.owner)}</b><span>${usd(d.value)} · ${esc(d.stage)} · Salesforce ${pct(d.prob)}</span><span>Close ${day(d.close)} · in stage since ${day(d.entered_stage)}</span><span class="small">${esc(d.segment)} ${esc(d.region)} · ${esc(d.source || 'source unknown')} · Salesforce export</span>` : `<span>Deal ${esc(ref)} is not visible to you.</span>`;
    } else {
      const f = S.facts && S.facts.facts && S.facts.facts[c.dataset.fact];
      pop.innerHTML = f ? `<b>${esc(f.label)}</b><span>${f.winRate === null ? `${f.n} won deals` : `${f.won} won of ${f.n} closed · win rate ${pct(f.winRate)}`}${f.wonValue ? ` · ${usd(f.wonValue)} won` : ''}</span><span class="small">Salesforce, AE deals closed ${day(S.facts.window.from)} to ${day(S.facts.window.to)} · ${esc(f.id)}</span>` : `<span>${esc(c.dataset.fact)}</span>`;
    }
    host.appendChild(pop);
  });

  // ---------- layout ----------
  function tabs(active) {
    const items = isLead()
      ? [['today', 'Today'], ['deal', 'Deal brain'], ['coach', 'Coaching'], ['inputs', 'Inputs']]
      : [['me', 'My week'], ['deal', 'Deal brain'], ['coach', 'My coaching']];
    $tabsInner.style.gridTemplateColumns = `repeat(${items.length}, minmax(0, 1fr))`;
    $tabsInner.innerHTML = items.map(([k, l]) => `<a href="#${k}" class="${k === active ? 'on' : ''}">${l}</a>`).join('');
    $tabs.hidden = false;
  }
  const header = (title, sub, cls = '', back = '') => `<header class="top ${cls}"><div class="brandrow"><span class="brand">PIPELINE ROOM</span><span>${back || `${esc(S.me.name)} · <button class="linkish" id="signout" style="background:none;border:0;color:inherit;padding:0;text-decoration:underline">Sign out</button>`}</span></div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</header>`;

  // ---------- data ----------
  const latestLens = async (brain) => (await q(sb.from('lenses').select('*').eq('brain', brain).order('version', { ascending: false }).limit(1)))[0];
  const outputs = (brain, kind, person) => { let x = sb.from('brain_outputs').select('*').eq('brain', brain).eq('kind', kind).order('created_at', { ascending: false }); if (person) x = x.eq('person', person); return q(x); };
  async function loadFacts() { if (S.facts || !isLead()) return; const r = await outputs('deal', 'facts'); S.facts = r[0] ? r[0].body : null; }

  // ---------- screens ----------
  async function screenToday() {
    await loadFacts();
    const [cards, edits, promises, exp, checkins] = await Promise.all([
      q(sb.from('cards').select('*').eq('status', 'live').order('created_at')),
      q(sb.from('sf_edits').select('*').eq('status', 'waiting').order('created_at')),
      q(sb.from('promises').select('*').order('made_on', { ascending: false })),
      q(sb.from('exports').select('*').order('uploaded_at', { ascending: false }).limit(1)),
      q(sb.from('transcripts').select('id,date,people').eq('kind', 'checkin').order('date', { ascending: false })),
    ]);
    const F = S.facts; const reps = F ? Object.values(F.reps) : [];
    const won = reps.reduce((t, r) => t + r.wonThisMonth, 0), target = reps.reduce((t, r) => t + r.monthlyTarget, 0);
    const asOf = exp[0] ? exp[0].as_of : null;
    const thisWeek = checkins.filter((c) => asOf && c.date >= asOf);
    const dealCards = cards.filter((c) => c.brain === 'deal'), coachCards = cards.filter((c) => c.brain === 'coach');
    const count = (s) => promises.filter((p) => p.status === s).length;
    const open = promises.filter((p) => p.status === 'broken' || p.status === 'not raised again').slice(0, 5);
    $app.innerHTML = header('Review prep', `${F ? `${day(F.thisMonth.from)} to ${day(F.thisMonth.to)}: AEs have won ${usd(won)} of ${usd(target)} in targets` : ''}${asOf ? ` · Salesforce as of ${day(asOf)}` : ''}`) + `
      <div class="section" style="padding-top:16px">
        ${target ? `<div class="bar" role="img" aria-label="${Math.round((100 * won) / target)} percent of target"><i style="width:${Math.min(100, (100 * won) / target)}%"></i></div>` : ''}
        <button class="brief" id="brief" type="button"><span class="mic" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" style="color:var(--ink)"></rect><path d="M4 10a6 6 0 0 0 12 0M10 16v2" stroke="var(--ink)" stroke-width="1.8" fill="none" stroke-linecap="round"></path></svg></span><span><b>Brief me</b><span>Three minutes by voice, from both brains</span></span></button>
        <div class="small" id="briefnote" hidden>The voice briefing switches on with the check-in agent.</div>
        <div class="small">${thisWeek.length ? `Check-ins this week: ${thisWeek.map((c) => esc(first(c.people[0]))).join(', ')}.` : 'No check-ins yet this week. Reps check in from the app before the review.'}</div>
      </div>
      <div class="section"><div class="sechead"><h2>Deals</h2><a href="#deal">Deal brain →</a></div>
        ${dealCards.map((c) => `<article class="card"><span class="tag ${c.kind === 'at-risk' ? 'risk' : ''}">${esc(c.kind.replace('-', ' '))}</span><div class="title">${rich(c.title)}</div><div class="text">${rich(c.body)}</div><div class="small">Deal brain · Salesforce ${day(c.as_of)}</div></article>`).join('') || '<p class="empty">No deal cards yet.</p>'}
      </div>
      <div class="section"><div class="sechead"><h2>People</h2><a class="coachlink" href="#coach">Coaching brain →</a></div>
        ${coachCards.map((c) => `<article class="card"><a class="who" href="#person/${slug(c.person)}">${esc(c.person)}</a><div class="title">${esc(c.title)}</div><div class="text">${esc(c.body)}</div>${(c.evidence || []).map((e) => `<div class="quote"><b>${day(e.date)}</b> “${esc(e.quote)}”</div>`).join('')}${c.move ? `<div class="move">${esc(c.move)}</div>` : ''}<div class="small">Coaching brain · reviews to ${day(c.as_of)}</div></article>`).join('') || '<p class="empty">No coaching cards yet.</p>'}
      </div>
      <div class="section"><h2>Salesforce fixes</h2>
        ${edits.length ? edits.map((x) => `<article class="card"><div class="title">${esc(x.owner)} · <button class="ref" data-ref="${esc(x.deal_id || '').slice(-6)}">${esc((x.deal_id || '').slice(-6))}</button> ${esc(x.field)} → ${esc(x.to_value)}</div><div class="text">${esc(x.reason || '')}</div><div class="quick"><button class="btn ink" data-edit="${x.id}" data-to="approved">Approve</button><button class="btn ghost" data-edit="${x.id}" data-to="rejected">Reject</button></div></article>`).join('') : '<p class="empty">Nothing waiting. Changes reps describe in check-ins appear here for you to approve.</p>'}
      </div>
      <div class="section"><h2>Promises</h2>
        <div class="stat"><div><b>${count('kept')}</b><span>kept</span></div><div><b>${count('broken')}</b><span>broken</span></div><div><b>${count('not raised again')}</b><span>never raised again</span></div></div>
        <div class="card"><div class="list">${open.map((p) => `<a class="row" href="#person/${slug(p.by_person)}"><span><span>${esc(p.promise)}</span><br><span class="meta">${esc(p.by_person)} · ${day(p.made_on)}</span></span><span class="pill ${p.status === 'broken' ? 'broken' : 'notraised'}">${esc(p.status)}</span></a>`).join('')}</div></div>
        <div class="small">From the 18 recorded reviews. Each promise is checked against the next review and check-in.</div>
      </div>`;
    document.getElementById('brief').onclick = () => { document.getElementById('briefnote').hidden = false; };
    $app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      await q(sb.from('sf_edits').update({ status: b.dataset.to, decided_by: S.me.name, decided_at: new Date().toISOString() }).eq('id', b.dataset.edit));
      route();
    }));
  }

  async function screenDeal() {
    await loadFacts();
    const lens = await latestLens('deal');
    const lists = await outputs('deal', 'rep_list');
    const latest = {}; for (const l of lists) if (!latest[l.person]) latest[l.person] = l.body;
    const mine = !isLead() ? latest[S.me.name] : null;
    $app.innerHTML = header('Deal brain', 'Cold and numeric. Reads every deal through the lens below. Coached by Mark and the CEO.', 'deal') + `
      <div class="section"><div class="sechead"><h2>The lens</h2><span class="small">v${lens ? lens.version : '–'} · ${lens ? `${esc(lens.changed_by)} · ${day(lens.created_at.slice(0, 10))}` : ''}</span></div>
        ${lens ? `<div class="small">${esc(lens.change_note || '')}</div><div class="lens">${lensHtml(lens.body)}</div>` : '<p class="empty">No lens yet.</p>'}
        ${isLead() && S.facts ? `<div class="small">Tap any blue tag to see the numbers behind it. Data limits the brain respects: ${S.facts.dataQuality.map(esc).join(' ')}</div>` : ''}
      </div>
      ${isLead() ? `<div class="section"><h2>Coach the lens</h2><div class="composer"><label for="dealq" style="position:absolute;left:-9999px">Ask or coach the deal brain</label><input id="dealq" placeholder="For example: we want more mid-market deals over $50k" disabled><button class="btn dealfill" disabled>Send</button></div><div class="small">Talking to the brain and editing its lens switches on in the next build.</div></div>` : ''}
      <div class="section"><h2>${isLead() ? 'What each check-in will ask' : 'What your check-in will ask'}</h2>
        ${(isLead() ? Object.values(latest).sort((a, b) => a.rep.localeCompare(b.rep)) : mine ? [mine] : []).map((l) => `<details class="card" ${isLead() ? '' : 'open'}><summary class="title" style="cursor:pointer">${esc(l.rep)} <span class="small">· ${(l.listen_for || []).length} deals</span></summary><div class="text">${rich(l.month)}</div>${(l.listen_for || []).map((x) => `<div class="card" style="padding:12px"><span class="tag ${x.tag === 'at-risk' ? 'risk' : ''}">${esc(x.tag)}</span><div class="text">${x.deal ? `<b>${usd(x.deal.value)} · ${esc(x.deal.stage)} · close ${day(x.deal.close)}</b> ` : ''}<button class="ref" data-ref="${esc(x.ref)}">${esc(x.ref)}</button></div><div class="text">${rich(x.why)}</div><div class="move" style="background:var(--deal-soft);color:var(--deal-ink)">Ask: ${esc(x.ask)}</div></div>`).join('')}<div class="small">Left out: ${rich(l.not_asking)}</div></details>`).join('') || '<p class="empty">No list yet.</p>'}
      </div>`;
  }

  async function screenCoach() {
    if (!isLead()) { location.hash = `#person/${slug(S.me.name)}`; return; }
    const lens = await latestLens('coach');
    const profs = await outputs('coach', 'profile');
    const thin = await outputs('coach', 'profile_thin');
    $app.innerHTML = header('Coaching brain', 'Reads people, not deals. Every review and check-in, per person, over time. Coached by Mark.', 'coach') + `
      <div class="section"><div class="sechead"><h2>What good looks like here</h2><span class="small">v${lens ? lens.version : '–'} · ${lens ? esc(lens.changed_by) : ''}</span></div>
        ${lens ? `<div class="small">${esc(lens.change_note || '')}</div><div class="lens">${lensHtml(lens.body)}</div>` : ''}
      </div>
      <div class="section"><h2>Coach the lens</h2><div class="composer"><label for="coachq" style="position:absolute;left:-9999px">Ask or coach the coaching brain</label><input id="coachq" placeholder="For example: every deal over $50k names who signs" disabled><button class="btn coach" disabled>Send</button></div><div class="small">Talking to the brain and editing its lens switches on in the next build.</div></div>
      <div class="section"><h2>People</h2><div class="card"><div class="list">
        ${profs.map((p) => p.body).sort((a, b) => a.person.localeCompare(b.person)).map((p) => `<a class="row" href="#person/${slug(p.person)}"><span><span>${esc(p.person)}</span><br><span class="meta">${esc(p.in_one_line || '').slice(0, 110)}…</span></span><span class="small">${(p.reviews || []).length} reviews</span></a>`).join('')}
        ${thin.map((p) => `<div class="row"><span><span>${esc(p.person)}</span><br><span class="meta">One review on file. Too little to see a pattern.</span></span></div>`).join('')}
      </div></div></div>`;
  }

  async function screenPerson(name) {
    if (!isLead() && name !== S.me.name) {
      $app.innerHTML = header(esc(name), '') + `<div class="section"><p class="empty">You can see only your own page. Each rep sees what the brains say about them, and Mark sees everyone.</p><a class="btn ghost" href="#person/${slug(S.me.name)}">Go to your page</a></div>`;
      return;
    }
    const [prof, list, promises] = await Promise.all([outputs('coach', 'profile', name), outputs('deal', 'rep_list', name), q(sb.from('promises').select('*').eq('by_person', name).order('made_on', { ascending: false }))]);
    const p = prof[0] && prof[0].body, l = list[0] && list[0].body;
    const self = S.me.name === name;
    const back = isLead() ? '<a href="#coach">← Coaching</a>' : '';
    $app.innerHTML = header(esc(name), self ? 'What both brains see about you. Mark sees the same.' : 'What both brains see. They never read each other.', '', back || undefined) + `
      ${l ? `<div class="section"><div class="sechead"><h2>Deals</h2><span class="small" style="color:var(--deal)">Deal brain</span></div><div class="card"><div class="text">${rich(l.month)}</div>${(l.listen_for || []).map((x) => `<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px"><span><span class="tag ${x.tag === 'at-risk' ? 'risk' : ''}">${esc(x.tag)}</span> <button class="ref" data-ref="${esc(x.ref)}">${esc(x.ref)}</button> ${x.deal ? `${usd(x.deal.value)} · ${esc(x.deal.stage)} · close ${day(x.deal.close)}` : ''}</span><span class="meta">${rich(x.why)}</span></div>`).join('')}</div></div>` : ''}
      ${p ? `<div class="section"><div class="sechead"><h2>Coaching</h2><span class="small" style="color:var(--coach)">Coaching brain · ${(p.reviews || []).length} reviews</span></div>
        <div class="card"><div class="text">${esc(p.in_one_line)}</div></div>
        <h3>Strengths</h3>${(p.strengths || []).map((o) => `<article class="card"><div class="text">${esc(o.observation)}</div>${(o.evidence || []).map((e) => `<div class="quote"><b>${day(e.date)}</b> “${esc(e.quote)}”</div>`).join('')}</article>`).join('')}
        <h3>To work on</h3>${(p.patterns || []).map((o) => `<article class="card"><div class="text">${esc(o.observation)}</div>${(o.evidence || []).map((e) => `<div class="quote"><b>${day(e.date)}</b> “${esc(e.quote)}”</div>`).join('')}</article>`).join('')}
        <article class="card"><span class="tag coach">Likely reaction on Tuesday</span><div class="text">${esc(p.likely_reaction)}</div><span class="tag coach">One coaching move</span><div class="move">${esc(p.coaching_move)}</div></article>
        <div class="small">Observations with dated quotes, never a score. Every quote is checked word for word against the recording.</div></div>` : `<div class="section"><p class="empty">${esc(first(name))} has fewer than two reviews on file, so the coaching brain has no profile yet.</p></div>`}
      ${isLead() && l ? `<div class="section"><a class="btn ink" href="#checkin/${slug(name)}">Try ${esc(first(name))}'s check-in</a><div class="small">Plays the agent exactly as ${esc(first(name))} would hear it. Answer as ${esc(first(name))}.</div></div>` : ''}
      <div class="section"><h2>Promises</h2><div class="card"><div class="list">${promises.map((x) => `<div class="row"><span><span>${esc(x.promise)}</span><br><span class="meta">${day(x.made_on)}${x.evidence ? ` · ${esc(x.evidence).slice(0, 140)}` : ''}</span></span><span class="pill ${x.status === 'kept' ? 'kept' : x.status === 'broken' ? 'broken' : 'notraised'}">${esc(x.status)}</span></div>`).join('') || '<p class="empty">No promises on file.</p>'}</div></div></div>`;
  }

  async function screenMe() {
    const l = (await outputs('deal', 'rep_list', S.me.name))[0];
    $app.innerHTML = header(`${esc(first(S.me.name))}, your week`, l ? rich(l.body.month) : '') + `
      <div class="section"><button class="brief" type="button" id="checkin"><span class="mic" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><rect x="7" y="2" width="6" height="10" rx="3" fill="var(--ink)"></rect><path d="M4 10a6 6 0 0 0 12 0M10 16v2" stroke="var(--ink)" stroke-width="1.8" fill="none" stroke-linecap="round"></path></svg></span><span><b>Check in</b><span>Three minutes. The agent listens first, then asks.</span></span></button></div>
      <div class="section"><h2>The agent will ask about</h2>${l ? (l.body.listen_for || []).map((x) => `<article class="card"><span class="tag ${x.tag === 'at-risk' ? 'risk' : ''}">${esc(x.tag)}</span><div class="title">${x.deal ? `${usd(x.deal.value)} · ${esc(x.deal.stage)} · close ${day(x.deal.close)}` : ''} <button class="ref" data-ref="${esc(x.ref)}">${esc(x.ref)}</button></div><div class="move" style="background:var(--deal-soft);color:var(--deal-ink)">${esc(x.ask)}</div></article>`).join('') : '<p class="empty">No list yet.</p>'}</div>
      <div class="section"><a class="btn ghost" href="#person/${slug(S.me.name)}">See what both brains say about you →</a></div>`;
    document.getElementById('checkin').onclick = () => { location.hash = '#checkin'; };
  }

  async function screenInputs() {
    const [exp, trs, ppl] = await Promise.all([
      q(sb.from('exports').select('*').order('uploaded_at', { ascending: false }).limit(1)),
      q(sb.from('transcripts').select('id,kind,date').order('date', { ascending: false })),
      q(sb.from('people').select('name,role,email')),
    ]);
    const e = exp[0]; const reviews = trs.filter((t) => t.kind === 'review'); const checkins = trs.filter((t) => t.kind === 'checkin');
    $app.innerHTML = header('Inputs', 'Anything new here makes both brains re-read everything and rebuild every screen.') + `
      <div class="section">
        <article class="card"><h3>Salesforce export</h3><div class="text">${e ? `Data to ${day(e.as_of)} · ${e.deals.toLocaleString('en-US')} deals · uploaded by ${esc(e.uploaded_by)}` : 'None yet'}</div><button class="btn" disabled>Upload a new export</button></article>
        <article class="card"><h3>Review meetings</h3><div class="text">${reviews.length} on file${reviews.length ? ` · ${day(reviews[reviews.length - 1].date)} to ${day(reviews[0].date)}` : ''}</div><div class="quick"><button class="btn" disabled>Upload a transcript</button><button class="btn ink" disabled>Connect Metaview notes</button></div></article>
        <article class="card"><h3>Check-ins</h3><div class="text">${checkins.length} so far</div></article>
        <article class="card"><h3>Who coaches which brain</h3><div class="text"><b style="color:var(--deal)">Deal brain</b> · Mark, the CEO</div><div class="text"><b style="color:var(--coach)">Coaching brain</b> · Mark</div><div class="small">${ppl.filter((p) => p.email).length} people can log in · ${ppl.filter((p) => p.role === 'rep').length} reps on the team</div></article>
        <div class="small">Uploads switch on in the next build.</div>
      </div>`;
  }


  // ---------- voice check-in ----------
  let live = null; // the running voice session, if any
  async function briefFor(name) {
    const [list, proms] = await Promise.all([outputs('deal', 'rep_list', name), q(sb.from('promises').select('*').eq('by_person', name).order('made_on', { ascending: false }))]);
    const l = list[0] && list[0].body;
    const lastReview = proms.length ? proms[0].made_on : null;
    const open = proms.filter((p) => p.made_on === lastReview && p.status !== 'kept' && p.status !== 'broken');
    const deals = l ? (l.listen_for || []) : [];
    const text = [
      l ? `THEIR MONTH: ${l.month}` : '',
      'YOUR LIST (ask about each one they do not cover, in this order):',
      ...deals.map((x, i) => `${i + 1}. ${x.deal ? `The ${usd(x.deal.value)} deal at ${x.deal.stage}, close date ${day(x.deal.close)}` : `Deal ${x.ref}`}. Why it matters: ${String(x.why || '').replace(/\[F:[^\]]+\]/g, '').replace(/\(deal [^)]+\)/g, '').trim()}`),
      'OPEN PROMISES (from the review on ' + (lastReview ? day(lastReview) : 'n/a') + '):',
      ...(open.length ? open.map((p) => `- ${p.promise}`) : ['- none']),
    ].filter(Boolean).join('\n');
    return { text, deals, open };
  }

  async function screenCheckin(name) {
    if (!name) name = S.me.name;
    if (!isLead() && name !== S.me.name) name = S.me.name;
    const b = await briefFor(name);
    const back = isLead() ? `<a href="#person/${slug(name)}">← ${esc(name)}</a>` : '<a href="#me">← My week</a>';
    $app.innerHTML = `<header class="top" style="background:var(--ink);color:var(--surface);border:0"><div class="brandrow" style="color:rgba(255,255,255,.75)"><span class="brand">CHECK-IN</span><span>${back}</span></div><h1>${esc(name)}</h1><div class="sub" style="color:rgba(255,255,255,.8)">About three minutes. The agent listens first, then asks.</div></header>
      <div class="section" style="align-items:center;text-align:center;padding-top:28px">
        <button id="orb" class="orb" type="button" aria-label="Start check-in"><svg width="44" height="44" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="#fff"></rect><path d="M4 10a6 6 0 0 0 12 0M10 16v2" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"></path></svg></button>
        <div id="ciStatus" class="sub" aria-live="polite">Tap to start. Your browser will ask to use the microphone.</div>
        <div class="quick" style="justify-content:center"><button class="btn ghost" id="ciEnd" hidden>Finish</button></div>
      </div>
      <div class="section"><div class="card" id="ciLog" hidden><div class="list" id="ciLines"></div></div></div>
      <div class="section"><h2>The agent will ask about</h2>
        ${b.deals.map((x) => `<article class="card"><span class="tag ${x.tag === 'at-risk' ? 'risk' : ''}">${esc(x.tag)}</span><div class="title">${x.deal ? `${usd(x.deal.value)} · ${esc(x.deal.stage)} · close ${day(x.deal.close)}` : ''} <button class="ref" data-ref="${esc(x.ref)}">${esc(x.ref)}</button></div></article>`).join('') || '<p class="empty">Nothing on the list. The agent will just listen.</p>'}
        ${b.open.length ? `<h3>Promises from the last review</h3><div class="card"><div class="list">${b.open.map((p) => `<div class="row"><span>${esc(p.promise)}</span></div>`).join('')}</div></div>` : ''}
      </div>`;
    const $status = document.getElementById('ciStatus'), $orb = document.getElementById('orb'), $end = document.getElementById('ciEnd'), $log = document.getElementById('ciLog'), $lines = document.getElementById('ciLines');
    const say = (who, text) => { $log.hidden = false; const d = document.createElement('div'); d.className = 'row'; d.style.display = 'block'; d.innerHTML = `<b style="font-size:12px;color:var(--muted)">${esc(who)}</b><br>${esc(text)}`; $lines.appendChild(d); d.scrollIntoView({ block: 'nearest' }); };
    $orb.onclick = async () => {
      if (live) return;
      if (!window.ElevenLabsConversation) { $status.textContent = 'Voice could not load. Refresh the page and try again.'; return; }
      $orb.disabled = true; $status.textContent = 'Connecting…';
      try {
        live = await window.ElevenLabsConversation.startSession({
          agentId: window.ROOM.checkinAgentId,
          connectionType: 'websocket',
          dynamicVariables: { rep_name: name, first_name: first(name), brief: b.text },
          onConnect: () => { $orb.classList.add('on'); $end.hidden = false; $status.textContent = 'Listening. Talk about your week.'; },
          onModeChange: (m) => { $status.textContent = m.mode === 'speaking' ? 'Agent speaking' : 'Listening'; $orb.classList.toggle('speaking', m.mode === 'speaking'); },
          onMessage: (m) => say(m.source === 'ai' || m.role === 'agent' ? 'Agent' : first(name), m.message),
          onError: (msg) => { $status.textContent = `Something went wrong: ${msg}`; },
          onDisconnect: () => {
            live = null; $orb.classList.remove('on', 'speaking'); $orb.disabled = false; $end.hidden = true;
            $status.textContent = 'Done. Your notes go to the scribe now and appear on your page and Mark\'s screen in a few minutes.';
          },
        });
      } catch (e) {
        live = null; $orb.disabled = false;
        $status.textContent = /permission|denied|NotAllowed/i.test(String(e && (e.name || e.message))) ? 'The microphone is blocked. Allow it in your browser settings, then tap again.' : `Could not start: ${e.message || e}`;
      }
    };
    $end.onclick = async () => { if (live) await live.endSession(); };
  }

  // ---------- login ----------
  function screenLogin(msg) {
    $tabs.hidden = true;
    $app.innerHTML = `<div class="login">
      <div class="brand" style="color:var(--muted)">PIPELINE ROOM</div>
      <h1>Walk into the pipeline review already knowing where you are needed</h1>
      <p class="sub">Reps check in with an AI before the meeting. Two brains, one for deals and one for people, turn that into what the VP reads on the way in.</p>
      <form id="loginForm">
        <label for="email">Email<input id="email" type="email" autocomplete="username" required></label>
        <label for="password">Password<input id="password" type="password" autocomplete="current-password" required></label>
        <button class="btn ink" type="submit" style="align-self:stretch">Sign in</button>
        <div class="error" id="loginError" ${msg ? '' : 'hidden'}>${esc(msg || '')}</div>
      </form>
      <div class="small">Trying the demo? Use the logins in the note you were sent. Mark sees the whole team. Andrew and Laura see only their own week.</div>
      <div class="quick"><button class="btn ghost" data-email="mark@example.com">Mark (VP)</button><button class="btn ghost" data-email="andrew@example.com">Andrew (rep)</button><button class="btn ghost" data-email="laura@example.com">Laura (rep)</button></div>
    </div>`;
    $app.querySelectorAll('[data-email]').forEach((b) => (b.onclick = () => { document.getElementById('email').value = b.dataset.email; document.getElementById('password').focus(); }));
    document.getElementById('loginForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: document.getElementById('email').value.trim(), password: document.getElementById('password').value });
      if (error) { const el = document.getElementById('loginError'); el.hidden = false; el.textContent = 'That email and password did not match. Check the note and try again.'; return; }
      boot();
    };
  }

  // ---------- routing ----------
  async function route() {
    if (!S.me) return;
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || (isLead() ? 'today' : 'me');
    const [k, ...rest] = h.split('/');
    tabs(k === 'person' ? (isLead() ? 'coach' : 'coach') : k);
    try {
      if (k === 'today' && isLead()) await screenToday();
      else if (k === 'deal') await screenDeal();
      else if (k === 'coach') await screenCoach();
      else if (k === 'person') await screenPerson(rest.join('/'));
      else if (k === 'checkin') await screenCheckin(rest.join('/'));
      else if (k === 'inputs' && isLead()) await screenInputs();
      else if (isLead()) await screenToday(); else await screenMe();
    } catch (e) {
      $app.innerHTML = `<div class="section"><p class="error">Could not load this screen: ${esc(e.message || e)}. Pull to refresh, or sign out and back in.</p></div>`;
    }
    const so = document.getElementById('signout');
    if (so) so.onclick = async () => { await sb.auth.signOut(); S.me = null; S.facts = null; screenLogin(); };
    window.scrollTo(0, 0);
  }

  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return screenLogin();
    const email = data.session.user.email;
    const me = await q(sb.from('people').select('*').ilike('email', email).limit(1));
    if (!me[0]) { await sb.auth.signOut(); return screenLogin('This login is not on the team yet. Ask the admin to add you.'); }
    S.me = me[0];
    route();
  }

  window.addEventListener('hashchange', async () => { if (live) { try { await live.endSession(); } catch (e) {} live = null; } route(); });
  boot();
})();
