// Builds the "Pipeline Room · brains" n8n workflow from code. Five flows, each a straight line:
//   A check-in ended -> scribe draft      B rep sends -> commit, refresh list and profile, rebuild Today
//   C rebuild Today                       D training session ended -> proposal
//   E deploy -> new thinking model version, refresh lists, rebuild Today
//   F trainer brief -> what the Analyst or Mentor knows when a call starts
//   G new Salesforce export -> every list, Today     H new review recording -> profiles, Today
// Code steps only prepare and check (fast). Every Claude call is its own web-request step.
const fs = require('fs');
const path = require('path');

const ST = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets/state.json'), 'utf8'));
const OLD = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets/n8n_state.json'), 'utf8'));
const SB = fs.readFileSync(path.join(__dirname, 'secrets/sb_url'), 'utf8').trim();
const ANON = fs.readFileSync(path.join(__dirname, 'secrets/sb_anon_jwt'), 'utf8').trim();
const BUNDLE = fs.readFileSync(path.join(__dirname, 'steps.bundle.js'), 'utf8');
const BASE = 'https://jai-pipeline.app.n8n.cloud/webhook';

const CRED = {
  db: { httpHeaderAuth: { id: ST.sb_cred_id, name: 'Pipeline Room database' } },
  claude: { httpHeaderAuth: { id: OLD.ant_cred_id, name: 'Anthropic' } },
  voice: { httpHeaderAuth: { id: OLD.cred_id, name: 'ElevenLabs' } },
};

const nodes = []; const connections = {};
let y = 0;
const add = (n) => { nodes.push(n); return n.name; };
const link = (a, b, out = 0) => { ((connections[a] ||= { main: [] }).main[out] ||= []).push({ node: b, type: 'main', index: 0 }); };
const chain = (...names) => { for (let i = 0; i < names.length - 1; i++) link(names[i], names[i + 1]); };
let col = 0;
const pos = () => [col++ * 220, y];

const webhook = (name, p, respond = 'responseNode') => add({ id: name, name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: pos(), webhookId: `room-${p}`, parameters: { httpMethod: 'POST', path: `pipeline-room/${p}`, responseMode: respond, options: { allowedOrigins: '*' } } });
const code = (name, js, bundle = true) => add({ id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(), parameters: { jsCode: (bundle ? `${BUNDLE}\nconst X = Room;\n` : '') + js } });
const http = (name, o) => add({
  id: name, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(),
  ...(o.cred ? { credentials: CRED[o.cred] } : {}),
  ...(o.retry ? { retryOnFail: true, maxTries: 5, waitBetweenTries: 5000 } : {}),
  parameters: {
    method: o.method || 'POST', url: o.url,
    ...(o.cred ? { authentication: 'predefinedCredentialType', nodeCredentialType: 'httpHeaderAuth' } : {}),
    ...(o.headers ? { sendHeaders: true, headerParameters: { parameters: Object.entries(o.headers).map(([name, value]) => ({ name, value })) } } : {}),
    ...(o.body ? { sendBody: true, specifyBody: 'json', jsonBody: o.body } : {}),
    options: { timeout: o.timeout || 60000, ...(o.batch ? { batching: { batch: { batchSize: o.batch, batchInterval: 0 } } } : {}) },
  },
});
const rpc = (name, fn, body, extra = {}) => http(name, { url: `${SB}/rest/v1/rpc/${fn}`, cred: 'db', body, ...extra });
const claude = (name, bodyExpr = '={{ JSON.stringify($json.body) }}', extra = {}) => http(name, { url: 'https://api.anthropic.com/v1/messages', cred: 'claude', headers: { 'anthropic-version': '2023-06-01' }, body: bodyExpr, timeout: 300000, retry: true, ...extra });
const respond = (name, bodyExpr) => add({ id: name, name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: pos(), parameters: { respondWith: 'json', responseBody: bodyExpr, options: { responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] } } } });
const wait = (name, secs) => add({ id: name, name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: pos(), webhookId: `room-wait-${name.replace(/\W+/g, '-')}`, parameters: { amount: secs } });
const ifNode = (name, cond) => add({ id: name, name, type: 'n8n-nodes-base.if', typeVersion: 2, position: pos(), parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: name, leftValue: cond, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } });
const row = () => { y += 260; col = 0; };

// Who is calling: the app sends the person's login token, the database says who they are
function whoami(prefix, webhookName, leadOnly) {
  const a = http(`${prefix} · Who is calling`, { method: 'GET', url: `${SB}/auth/v1/user`, headers: { apikey: ANON, Authorization: `={{ 'Bearer ' + $('${webhookName}').first().json.body.token }}` } });
  const b = rpc(`${prefix} · Find person`, 'room_person', '={{ JSON.stringify({ p_email: $json.email }) }}');
  const c = code(`${prefix} · Allowed?`, `const p = $input.first().json;
if (!p || !p.name) throw new Error('This login is not on the team');
${leadOnly ? "if (!['vp', 'admin'].includes(p.role)) throw new Error('Only the VP can do this');" : ''}
return [{ json: { person: p.name, role: p.role, body: $('${webhookName}').first().json.body } }];`, false);
  chain(webhookName, a, b, c);
  return c;
}

// Turn an ElevenLabs conversation into "Agent: ... / Name: ..." lines; loop until the call is processed
const TRANSCRIPT_JS = (who) => `const c = $input.first().json;
const turns = (c.transcript || []).filter((t) => t.message);
const done = c.status === 'done' || c.status === 'failed';
const name = ${who};
const transcript = turns.map((t) => (t.role === 'agent' ? 'Agent: ' : name + ': ') + t.message).join('\\n');
return [{ json: { ready: done && turns.length > 0, tries: ($runIndex || 0) + 1, transcript, turns: turns.length, status: c.status } }];`;

// ---------------- A. Check-in ended -> draft ----------------
const A0 = webhook('A · Check-in ended', 'checkin-ended');
const A3 = whoami('A', A0, false);
const A4 = rpc('A · Start draft', 'room_start_draft', "={{ JSON.stringify({ p_person: $json.person, p_conv: $json.body.conversation_id }) }}");
const A5 = respond('A · Draft started', "={{ JSON.stringify({ draft_id: $json.draft_id }) }}");
const A6 = wait('A · Let the call close', 12);
const A7 = http('A · Get the call', { method: 'GET', url: "={{ 'https://api.elevenlabs.io/v1/convai/conversations/' + $('A · Allowed?').first().json.body.conversation_id }}", cred: 'voice', retry: true });
const A8 = code('A · Is it ready?', TRANSCRIPT_JS("$('A · Allowed?').first().json.person"), false);
const A9 = ifNode('A · Ready?', '={{ $json.ready || $json.tries > 12 }}');
const A10 = wait('A · Wait a little more', 8);
chain(A3, A4, A5, A6, A7, A8, A9);
link(A9, A10, 1); link(A10, A7);
const A11 = code('A · Prepare the scribe', `const ctx = $('A · Start draft').first().json;
const who = $('A · Allowed?').first().json;
const t = $input.first().json.transcript;
const list = ctx.list ? ctx.list.listen_for || [] : [];
const deals = (ctx.deals || []).map((d) => ({ ...d, close: d.close }));
return [{ json: { body: X.scribeRequest({ person: who.person, date: ctx.today, transcript: t, listenFor: list, deals, openPromises: ctx.open_promises || [] }), transcript: t, deals, open: ctx.open_promises || [] } }];`);
link(A9, A11, 0);
const A12 = claude('A · Scribe (Claude)', '={{ JSON.stringify($json.body) }}');
const A13 = code('A · Check the draft', `const prep = $('A · Prepare the scribe').first().json;
const ctx = $('A · Start draft').first().json;
let draft = null, status = 'draft', error = null;
try { const out = X.answer($input.first().json); draft = X.scribeClean(out, prep.transcript, prep.deals, prep.open); }
catch (e) { status = 'failed'; error = e.message; }
if (!prep.transcript) { status = 'failed'; error = 'The call had no words in it'; }
// Add a readable label to each kept item so the rep sees clients, not codes
const byRef = Object.fromEntries(prep.deals.map((d) => [d.ref, d]));
const openById = Object.fromEntries(prep.open.map((p) => [p.id, p.promise]));
if (draft) {
  draft.deals = draft.deals.map((d) => ({ ...d, size: byRef[d.ref] ? X.short(byRef[d.ref].value) : null }));
  draft.promises_checked = draft.promises_checked.map((p) => ({ ...p, promise: openById[p.promise_id] || '' }));
  draft.not_covered = (draft.not_covered || []).filter((r) => byRef[r]).map((r) => ({ ref: r, line: X.short(byRef[r].value) + ' ' + byRef[r].stage }));
}
return [{ json: { body: { p_id: ctx.draft_id, p_transcript: prep.transcript, p_draft: draft, p_status: status, p_error: error } } }];`);
const A14 = rpc('A · Save the draft', 'room_save_draft', '={{ JSON.stringify($json.body) }}');
chain(A11, A12, A13, A14);
row();

// ---------------- B. Rep sends -> commit, refresh their list and profile, rebuild Today ----------------
const B0 = webhook('B · Rep sends', 'checkin-send');
const B3 = whoami('B', B0, false);
const B4 = rpc('B · Commit', 'room_commit_checkin', "={{ JSON.stringify({ p_person: $json.person, p_draft: $json.body.draft_id, p_keep: $json.body.keep }) }}");
const B5 = respond('B · Sent', "={{ JSON.stringify({ ok: true }) }}");
const B6 = rpc('B · Deal context', 'room_deal_context', '={{ "{}" }}');
const B7 = code('B · Prepare their list', `const c = $input.first().json; const who = $('B · Allowed?').first().json.person;
if (!c.facts || !c.facts.reps[who]) return [{ json: { skip: true, body: { model: X.MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'ok' }] } } }];
return [{ json: { body: X.repListRequest(c.facts, c.rules, who, c.clients || {}, (c.news || {})[who] || []) } }];`);
const B8 = claude('B · List (Claude)');
const B9 = code('B · Check the list', `const who = $('B · Allowed?').first().json.person; const c = $('B · Deal context').first().json;
if ($('B · Prepare their list').first().json.skip) return [{ json: { body: null } }];
const out = X.answer($input.first().json);
out.listen_for = (out.listen_for || []).filter((x) => c.facts.live.some((d) => d.ref === x.ref)).map((x) => ({ ...x, deal: c.facts.live.find((d) => d.ref === x.ref) }));
return [{ json: { body: { p_brain: 'deal', p_kind: 'rep_list', p_person: who, p_body: out } } }];`);
const B10 = rpc('B · Save the list', 'room_save_output', '={{ JSON.stringify($json.body) }}');
const B11 = rpc('B · Coach context', 'room_coach_context', "={{ JSON.stringify({ p_person: $('B · Allowed?').first().json.person }) }}");
const B12 = code('B · Prepare the profile', `const c = $input.first().json; const who = $('B · Allowed?').first().json.person;
const pack = c.transcripts.map((t) => '=============== ' + t.date + ' · ' + (t.kind === 'checkin' ? 'CHECK-IN IN THE APP' : 'REVIEW MEETING: ' + (t.title || '')) + '\\n' + t.raw).join('\\n\\n');
return [{ json: { skip: c.transcripts.length < 2, body: X.profileRequest(who, pack, c.rules) } }];`);
const B13 = claude('B · Profile (Claude)');
const B14 = code('B · Check quotes', `const c = $('B · Coach context').first().json; const who = $('B · Allowed?').first().json.person;
if ($('B · Prepare the profile').first().json.skip) return [{ json: { body: null } }];
const p = X.profileNormalize(X.answer($input.first().json));
const byDate = {}; for (const t of c.transcripts) byDate[t.date] = (byDate[t.date] || '') + ' ' + X.norm(t.raw);
const ok = (e) => e && e.quote && byDate[e.date] && byDate[e.date].includes(X.norm(e.quote));
for (const k of ['strengths', 'patterns']) p[k] = (p[k] || []).map((o) => ({ ...o, evidence: (o.evidence || []).filter(ok) })).filter((o) => o.evidence.length);
p.reviews = [...new Set(c.transcripts.map((t) => t.date))];
p.updated_after = c.transcripts[c.transcripts.length - 1].date;
return [{ json: { body: { p_brain: 'coach', p_kind: 'profile', p_person: who, p_body: p } } }];`);
const B15 = rpc('B · Save the profile', 'room_save_output', '={{ JSON.stringify($json.body) }}');
const B16 = http('B · Rebuild Today', { url: `${BASE}/pipeline-room/rebuild-today`, headers: { 'x-room-key': ST.room_key }, body: '={{ "{}" }}' });
chain(B3, B4, B5, B6, B7, B8, B9, B10, B11, B12, B13, B14, B15, B16);
row();

// ---------------- C. Rebuild Today ----------------
const C0 = webhook('C · Rebuild Today', 'rebuild-today', 'onReceived');
const C1 = code('C · Key check', `if ($input.first().json.headers['x-room-key'] !== '${ST.room_key}') throw new Error('Not allowed'); return [{ json: {} }];`, false);
const C2 = rpc('C · Today context', 'room_today_context', '={{ "{}" }}');
const C3 = code('C · Prepare cards', `const c = $input.first().json;
const deal = c.reactions.filter((r) => r.brain === 'deal'), coach = c.reactions.filter((r) => r.brain === 'coach');
return [
  { json: { kind: 'ask', body: X.askCardsRequest(c.facts, c.deal_rules, c.lists, deal, c.clients) } },
  { json: { kind: 'coach', body: X.coachCardsRequest(c.profiles, c.coach_rules, coach) } },
];`);
const C4 = claude('C · Cards (Claude)', '={{ JSON.stringify($json.body) }}', { batch: 2 });
const C5 = code('C · Check budgets and numbers', `const c = $('C · Today context').first().json; const kinds = $('C · Prepare cards').all().map((i) => i.json.kind);
return $input.all().map((it, i) => {
  const kind = kinds[i]; let cards = [];
  try { cards = X.answer(it.json).cards || []; } catch (e) { cards = []; }
  const problems = cards.flatMap((card, j) => [...X.budgetProblems(card), ...(kind === 'ask' ? X.numberProblems(JSON.stringify(card), c.facts, c.facts.live.filter((d) => (card.refs || []).includes(d.ref))) : [])].map((p) => 'card ' + (j + 1) + ': ' + p));
  const persona = kind === 'ask' ? X.PERSONA.deal : X.PERSONA.coach;
  const schema = kind === 'ask' ? X.SCHEMAS.CARDS_SCHEMA : X.SCHEMAS.COACH_CARDS_SCHEMA;
  return { json: { kind, cards, problems, body: X.fixRequest(persona, { cards }, problems.length ? problems : ['No problems. Return the cards exactly as they are.'], schema) } };
});`);
const C6 = claude('C · Fix pass (Claude)', '={{ JSON.stringify($json.body) }}', { batch: 2 });
const C7 = code('C · Compose Today', `const c = $('C · Today context').first().json; const before = $('C · Check budgets and numbers').all().map((i) => i.json);
const all = [];
$input.all().forEach((it, i) => {
  const kind = before[i].kind; let cards = before[i].cards;
  try { const fixed = X.answer(it.json).cards; if (fixed && fixed.length) cards = fixed; } catch (e) {}
  for (const card of cards) {
    const bad = [...X.budgetProblems(card), ...(kind === 'ask' ? X.numberProblems(JSON.stringify(card), c.facts, c.facts.live.filter((d) => (card.refs || []).includes(d.ref))) : [])];
    if (bad.length) continue; // never show a card that breaks the contract
    if (kind === 'ask') all.push({ ...card, grp: 'ask', action: { kind: 'agenda', label: 'Add to agenda' } });
    else all.push({ grp: 'coach', person: card.person, headline: card.headline, number: card.number, body: card.body, move: card.move, topic: card.topic, why: (card.why || []).map((w) => ({ text: '"' + w.quote + '"', source: w.date })), action: { kind: 'done', label: 'Plan 1:1' } });
  }
});
const decide = X.decideCards(c.sf_waiting, c.asks.map((a) => ({ ...a, headline: a.headline })));
decide.forEach((d) => { if (d.action.kind === 'done') { const a = c.asks.find((x) => x.headline === d.headline && x.person === d.person); d.action.event_id = a ? a.id : null; } });
const ranked = X.rankCards([...decide, ...all], c.reactions);
const today = X.composeToday(ranked);
return [{ json: { body: { p_cards: today } } }];`);
const C8 = rpc('C · Save Today', 'room_save_today', '={{ JSON.stringify($json.body) }}');
chain(C0, C1, C2, C3, C4, C5, C6, C7, C8);
row();

// ---------------- D. Training session ended -> proposal ----------------
const D0 = webhook('D · Training ended', 'trainer-ended');
const D3 = whoami('D', D0, true);
const D4 = rpc('D · Start session', 'room_start_session', "={{ JSON.stringify({ p_brain: $json.body.brain, p_person: $json.person, p_conv: $json.body.conversation_id }) }}");
const D5 = respond('D · Session started', "={{ JSON.stringify({ session_id: $json.session_id }) }}");
const D6 = wait('D · Let the call close', 12);
const D7 = http('D · Get the call', { method: 'GET', url: "={{ 'https://api.elevenlabs.io/v1/convai/conversations/' + $('D · Allowed?').first().json.body.conversation_id }}", cred: 'voice', retry: true });
const D8 = code('D · Is it ready?', TRANSCRIPT_JS('"Mark"'), false);
const D9 = ifNode('D · Ready?', '={{ $json.ready || $json.tries > 12 }}');
const D10 = wait('D · Wait a little more', 8);
chain(D3, D4, D5, D6, D7, D8, D9);
link(D9, D10, 1); link(D10, D7);
const D11 = rpc('D · App context', 'room_today_context', '={{ "{}" }}');
link(D9, D11, 0);
const D12 = code('D · Prepare the proposal', `const c = $input.first().json; const s = $('D · Start session').first().json; const brain = $('D · Allowed?').first().json.body.brain;
const t = $('D · Is it ready?').last().json.transcript;
let context;
if (brain === 'deal') {
  const onList = new Set(c.lists.flatMap((l) => (l.listen_for || []).map((x) => x.ref)));
  context = 'WHAT THE DATA SAYS (facts)\\n' + Object.values(c.facts.facts).filter((f) => f.n >= 10).map((f) => f.id + ' | ' + f.label + ' | ' + f.won + ' won of ' + f.n + ' | ' + X.pct(f.winRate)).join('\\n') +
    '\\nOPEN DEALS DUE THIS MONTH OR NEXT (on a check-in list or not)\\n' + c.facts.live.filter((d) => d.value >= 10000).map((d) => X.dealLine(d, c.clients[d.id]) + (onList.has(d.ref) ? ' | ON A LIST' : ' | not on any list')).join('\\n') +
    '\\nEACH CHECK-IN LIST: at most 5 deals per rep. TODAY HAS: up to 2 Decide, 2 Ask and 1 Coach card.';
} else {
  context = 'PROFILES\\n' + c.profiles.map((p) => p.person + ': ' + p.in_one_line + ' | to work on: ' + (p.patterns || []).map((o) => o.observation).join(' / ')).join('\\n');
}
const rules = s.rules.map((r) => ({ text: r.text, source: r.source, author: r.author }));
return [{ json: { transcript: t, body: X.proposalRequest(brain, t, rules, context) } }];`);
const D13 = claude('D · Proposal (Claude)');
const D14 = code('D · Check the proposal', `const s = $('D · Start session').first().json; const t = $('D · Prepare the proposal').first().json.transcript;
let out = { rules: [], effects: [] }, status = 'proposed', error = null;
try { out = X.answer($input.first().json); const bad = X.proposalProblems(out, t); out.rules = (out.rules || []).filter((r, i) => !bad.some((b) => b.startsWith('rule ' + (i + 1) + ':'))); }
catch (e) { status = 'failed'; error = e.message; }
if (status === 'proposed' && !out.rules.length) { status = 'discarded'; error = 'No new rules came out of this session'; }
out.deploy_confirmed = status === 'proposed' && X.deployConfirmed(out, t);
return [{ json: { auto: out.deploy_confirmed, body: { p_id: s.session_id, p_transcript: t, p_proposal: out, p_status: status, p_error: error } } }];`);
const D15 = rpc('D · Save the proposal', 'room_save_proposal', '={{ JSON.stringify($json.body) }}');
const D16 = ifNode('D · Mark said deploy?', "={{ $('D · Check the proposal').first().json.auto }}");
const D17 = http('D · Deploy now', { url: `${BASE}/pipeline-room/deploy`, body: "={{ JSON.stringify({ token: $('D · Training ended').first().json.body.token, session_id: $('D · Start session').first().json.session_id }) }}" });
chain(D11, D12, D13, D14, D15, D16);
link(D16, D17, 0);
row();

// ---------------- E. Deploy -> new version, refresh lists, rebuild Today ----------------
const E0 = webhook('E · Deploy', 'deploy');
const E3 = whoami('E', E0, true);
const E4 = rpc('E · Deploy the rules', 'room_deploy', "={{ JSON.stringify({ p_session: $json.body.session_id, p_person: $json.person }) }}");
const E5 = respond('E · Deployed', '={{ JSON.stringify($json) }}');
const E6 = ifNode('E · Deal rules?', "={{ $('E · Deploy the rules').first().json.brain === 'deal' }}");
chain(E3, E4, E5, E6);
const E7 = rpc('E · Deal context', 'room_deal_context', '={{ "{}" }}');
link(E6, E7, 0);
const E8 = code('E · Prepare every list', `const c = $input.first().json;
return Object.keys(c.facts.reps).filter((o) => c.facts.reps[o].liveDeals > 0).map((o) => ({ json: { person: o, body: X.repListRequest(c.facts, c.rules, o, c.clients || {}, (c.news || {})[o] || []) } }));`);
const E9 = claude('E · Lists (Claude)', '={{ JSON.stringify($json.body) }}', { batch: 5 });
const E10 = code('E · Check the lists', `const c = $('E · Deal context').first().json; const who = $('E · Prepare every list').all().map((i) => i.json.person);
return $input.all().map((it, i) => { let out; try { out = X.answer(it.json); } catch (e) { return null; }
  out.listen_for = (out.listen_for || []).filter((x) => c.facts.live.some((d) => d.ref === x.ref)).map((x) => ({ ...x, deal: c.facts.live.find((d) => d.ref === x.ref) }));
  return { json: { body: { p_brain: 'deal', p_kind: 'rep_list', p_person: who[i], p_body: out } } }; }).filter(Boolean);`);
const E11 = rpc('E · Save the lists', 'room_save_output', '={{ JSON.stringify($json.body) }}');
const E12 = code('E · One go', 'return [{ json: {} }];', false);
const E13 = http('E · Rebuild Today (deal)', { url: `${BASE}/pipeline-room/rebuild-today`, headers: { 'x-room-key': ST.room_key }, body: '={{ "{}" }}' });
chain(E7, E8, E9, E10, E11, E12, E13);
const E14 = http('E · Rebuild Today (coach)', { url: `${BASE}/pipeline-room/rebuild-today`, headers: { 'x-room-key': ST.room_key }, body: '={{ "{}" }}' });
link(E6, E14, 1);

row();

// ---------------- F. Trainer brief: what the Analyst or Mentor knows when Mark starts a call ----------------
const F0 = webhook('F · Trainer brief', 'trainer-brief');
const F3 = whoami('F', F0, true);
const F4 = rpc('F · App context', 'room_today_context', '={{ "{}" }}');
const F5 = code('F · Write the brief', `const brain = $('F · Allowed?').first().json.body.brain === 'coach' ? 'coach' : 'deal';
const c = $input.first().json;
return [{ json: { brief: X.trainerBrief(brain, c), version: c.version } }];`);
const F6 = respond('F · Brief', '={{ JSON.stringify($json) }}');
chain(F3, F4, F5, F6);

row();

// ---------------- G. New Salesforce export loaded -> every list, then Today ----------------
const G0 = webhook('G · Export loaded', 'export-loaded');
const G3 = whoami('G', G0, true);
const G4 = respond('G · Started', '={{ JSON.stringify({ ok: true }) }}');
const G5 = rpc('G · Deal context', 'room_deal_context', '={{ "{}" }}');
const G6 = code('G · Prepare every list', `const c = $input.first().json;
return Object.keys(c.facts.reps).filter((o) => c.facts.reps[o].liveDeals > 0).map((o) => ({ json: { person: o, body: X.repListRequest(c.facts, c.rules, o, c.clients || {}, (c.news || {})[o] || []) } }));`);
const G7 = claude('G · Lists (Claude)', '={{ JSON.stringify($json.body) }}', { batch: 5 });
const G8 = code('G · Check the lists', `const c = $('G · Deal context').first().json; const who = $('G · Prepare every list').all().map((i) => i.json.person);
return $input.all().map((it, i) => { let out; try { out = X.answer(it.json); } catch (e) { return null; }
  out.listen_for = (out.listen_for || []).filter((x) => c.facts.live.some((d) => d.ref === x.ref)).map((x) => ({ ...x, deal: c.facts.live.find((d) => d.ref === x.ref) }));
  return { json: { body: { p_brain: 'deal', p_kind: 'rep_list', p_person: who[i], p_body: out } } }; }).filter(Boolean);`);
const G9 = rpc('G · Save the lists', 'room_save_output', '={{ JSON.stringify($json.body) }}');
const G10 = code('G · One go', 'return [{ json: {} }];', false);
const G11 = http('G · Rebuild Today', { url: `${BASE}/pipeline-room/rebuild-today`, headers: { 'x-room-key': ST.room_key }, body: '={{ "{}" }}' });
chain(G3, G4, G5, G6, G7, G8, G9, G10, G11);
row();

// ---------------- H. Review recording added -> profiles of everyone in it, then Today ----------------
const H0 = webhook('H · Recording added', 'transcript-added');
const H3 = whoami('H', H0, true);
const H4 = respond('H · Started', '={{ JSON.stringify({ ok: true }) }}');
const H5 = code('H · Each person', `return ($('H · Allowed?').first().json.body.people || []).map((p) => ({ json: { person: p } }));`, false);
const H6 = rpc('H · Coach context', 'room_coach_context', '={{ JSON.stringify({ p_person: $json.person }) }}');
const H7 = code('H · Prepare profiles', `const who = $('H · Each person').all().map((i) => i.json.person);
return $input.all().map((it, i) => { const c = it.json;
  const pack = c.transcripts.map((t) => '=============== ' + t.date + ' · ' + (t.kind === 'checkin' ? 'CHECK-IN IN THE APP' : 'REVIEW MEETING: ' + (t.title || '')) + '\\n' + t.raw).join('\\n\\n');
  return { json: { person: who[i], ctx: c, skip: c.transcripts.length < 2, body: X.profileRequest(who[i], pack, c.rules) } }; }).filter((x) => !x.json.skip);`);
const H8 = claude('H · Profiles (Claude)', '={{ JSON.stringify($json.body) }}', { batch: 3 });
const H9 = code('H · Check quotes', `const prep = $('H · Prepare profiles').all().map((i) => i.json);
return $input.all().map((it, i) => { const c = prep[i].ctx; let p; try { p = X.profileNormalize(X.answer(it.json)); } catch (e) { return null; }
  const byDate = {}; for (const t of c.transcripts) byDate[t.date] = (byDate[t.date] || '') + ' ' + X.norm(t.raw);
  const ok = (e) => e && e.quote && byDate[e.date] && byDate[e.date].includes(X.norm(e.quote));
  for (const k of ['strengths', 'patterns']) p[k] = (p[k] || []).map((o) => ({ ...o, evidence: (o.evidence || []).filter(ok) })).filter((o) => o.evidence.length);
  p.person = prep[i].person; p.reviews = [...new Set(c.transcripts.map((t) => t.date))]; p.updated_after = c.transcripts[c.transcripts.length - 1].date;
  return { json: { body: { p_brain: 'coach', p_kind: 'profile', p_person: prep[i].person, p_body: p } } }; }).filter(Boolean);`);
const H10 = rpc('H · Save profiles', 'room_save_output', '={{ JSON.stringify($json.body) }}');
const H11 = code('H · One go', 'return [{ json: {} }];', false);
const H12 = http('H · Rebuild Today', { url: `${BASE}/pipeline-room/rebuild-today`, headers: { 'x-room-key': ST.room_key }, body: '={{ "{}" }}' });
chain(H3, H4, H5, H6, H7, H8, H9, H10, H11, H12);
const HP1 = rpc('H · Recording and open promises', 'room_review_context', "={{ JSON.stringify({ p_transcript: $('H · Allowed?').first().json.body.transcript_id }) }}");
const HP2 = code('H · Prepare promises', `const c = $input.first().json; const t = c.transcript;
if (!t) return [];
return [{ json: { body: X.reviewPromisesRequest({ date: t.date, title: t.title, people: t.people, transcript: t.raw, open: c.open }) } }];`);
const HP3 = claude('H · Promises (Claude)');
const HP4 = code('H · Check promises', `const c = $('H · Recording and open promises').first().json; const t = c.transcript;
const out = X.reviewPromisesClean(X.answer($input.first().json), t.raw, t.people, c.open);
return [{ json: { body: { p_transcript: t.id, p_made: out.promises_made, p_checked: out.promises_checked } } }];`);
const HP5 = rpc('H · Save promises', 'room_save_review_promises', '={{ JSON.stringify($json.body) }}');
const HP0 = ifNode('H · New recording?', "={{ !!$('H · Allowed?').first().json.body.transcript_id }}");
link(H4, HP0); link(HP0, HP1, 0);
chain(HP1, HP2, HP3, HP4, HP5);

row();

// ---------------- I. A phone call to the Briefer: ElevenLabs asks who is calling, we hand back Mark's brief ----------------
const I0 = webhook('I · Phone call starting', 'briefer-phone');
const I1 = code('I · Key check', `if ($input.first().json.headers['x-room-key'] !== '${ST.room_key}') throw new Error('Not allowed'); return [{ json: {} }];`, false);
const I2 = rpc('I · Brief context', 'room_brief_context', '={{ "{}" }}');
const I3 = code('I · Write the brief', `return [{ json: { type: 'conversation_initiation_client_data', dynamic_variables: { first_name: 'Mark', brief: X.briefFromContext($input.first().json), headline: X.briefHeadline($input.first().json.cards) } } }];`);
const I4 = respond('I · Brief', '={{ JSON.stringify($json) }}');
chain(I0, I1, I2, I3, I4);

const wf = { name: 'Pipeline Room · brains', nodes, connections, settings: { executionOrder: 'v1' } };
fs.writeFileSync(path.join(__dirname, 'wf_brains.json'), JSON.stringify(wf, null, 1));
console.log(`built ${nodes.length} nodes`);
