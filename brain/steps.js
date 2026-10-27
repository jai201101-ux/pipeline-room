// Pipeline Room v2 core. Pure functions only: each job is "build a request" then "check the answer".
// No network, no files. The same code runs locally (tests) and inside n8n (bundled into code steps),
// where each Claude call is its own web-request step.

const PERSONA = require('./personas');

// ---------- shared ----------
const MODEL = 'claude-opus-5-5';
const S = (props, req) => ({ type: 'object', properties: props, required: req || Object.keys(props) });
const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const usd = (x) => (x === null || x === undefined ? 'no amount' : `$${Math.round(x).toLocaleString('en-US')}`);
const short = (x) => (x === null || x === undefined ? '' : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x).toLocaleString('en-US')}`);
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$%' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// The Anthropic request body: the model answers by calling a "submit" tool, so the answer is JSON
function request({ system, user, schema, maxTokens = 6000, model = MODEL }) {
  // Opus thinks before it answers, and thinking counts against the allowance, so leave plenty of room
  return {
    model, max_tokens: Math.max(maxTokens, 16000),
    system: `${system}\n\nAnswer only by calling the submit tool once. Do not write the answer as text.`,
    messages: [{ role: 'user', content: user }],
    tools: [{ name: 'submit', description: 'Submit your final answer. This is the only way to answer.', input_schema: schema }],
    tool_choice: { type: 'auto' },
  };
}
function answer(resp) {
  if (resp.stop_reason === 'max_tokens') throw new Error('The model ran out of room before finishing its answer');
  const t = (resp.content || []).find((c) => c.type === 'tool_use');
  if (!t) throw new Error('The model did not submit an answer');
  return t.input;
}
const rulesText = (rules) => (rules.length ? rules.map((r, i) => `${i + 1}. ${r.text} (${r.source === 'data' ? 'from the data' : `set by ${r.author}`})`).join('\n') : 'No rules yet.');

// ---------- budgets (the contract, enforced) ----------
const BUDGET = { headline: 8, body: 20, why: 60, move: 20 };
function budgetProblems(card) {
  const p = [];
  if (words(card.headline) > BUDGET.headline) p.push(`headline over ${BUDGET.headline} words: "${card.headline}"`);
  if (words(card.body) > BUDGET.body) p.push(`body over ${BUDGET.body} words: "${card.body}"`);
  const why = (card.why || []).map((w) => w.text).join(' ');
  if (words(why) > BUDGET.why) p.push(`why over ${BUDGET.why} words`);
  if (card.move && words(card.move) > BUDGET.move) p.push(`move over ${BUDGET.move} words: "${card.move}"`);
  if (/\b20\d\d-\d\d-\d\d\b/.test(`${card.headline} ${card.body} ${card.move || ''}`)) p.push('write dates as "21 Apr", not 2026-04-21');
  if (/\b[0-9][0-9A-Za-z]{5}\b/.test(`${card.headline} ${card.body}`) && /[A-Z]/.test(`${card.headline} ${card.body}`.match(/\b[0-9][0-9A-Za-z]{5}\b/)[0])) p.push('a deal code is on the card face; name the client or describe the deal instead');
  return p;
}

// ---------- deal facts ----------
function factLines(F) {
  return Object.values(F.facts).filter((f) => f.n > 0).map((f) => `${f.id} | ${f.label} | deals ${f.n} | won ${f.won} | win rate ${pct(f.winRate)} | won value ${usd(f.wonValue)}`).join('\n');
}
function dealLine(d, client) {
  return [
    `deal ${d.ref}${client ? ` (client: ${client})` : ''}`, usd(d.value), d.stage, `close ${d.close} (${d.horizon})`, `owner ${d.owner}`,
    `Salesforce ${pct(d.salesforceProb)}`, `history ${pct(d.historyWinRate)} from ${d.historyN} deals [${d.historyFact}]`,
    d.daysInStage !== null ? `${d.daysInStage} days in stage (median ${d.medianDaysInStage})${d.stuck ? ' STUCK' : ''}` : 'days in stage unknown',
    `${d.segment} ${d.region}`,
  ].join(' | ');
}
function dealContext(F) {
  return [
    `Data as of ${F.asOf}. History: AE deals closed ${F.window.from} to ${F.window.to}, clean-up days excluded. This month: ${F.thisMonth.from} to ${F.thisMonth.to}.`,
    'DATA LIMITS', ...(F.dataQuality || []).map((x) => `- ${x}`),
    'FACTS', factLines(F),
    'MEDIAN DAYS IN CURRENT STAGE, BY STAGE NUMBER', JSON.stringify(F.stageMedianDays),
  ].join('\n');
}
function allowedNumbers(F, extra = []) {
  const money = new Set(extra), rates = new Set();
  const m = (v) => { if (v) money.add(Math.round(v)); };
  for (const f of Object.values(F.facts)) { m(f.wonValue); if (f.winRate !== null) rates.add(Math.round(f.winRate * 100)); }
  for (const d of F.live) { m(d.value); m(d.expectedValue); for (const r of [d.salesforceProb, d.historyWinRate]) if (r !== null) rates.add(Math.round(r * 100)); }
  for (const r of Object.values(F.reps)) { m(r.wonThisMonth); m(r.liveValue); m(r.monthlyTarget); m(r.monthlyTarget - r.wonThisMonth); if (r.winRateInWindow !== null) rates.add(Math.round(r.winRateInWindow * 100)); }
  [10000, 25000, 50000, 100000].forEach((x) => money.add(x));
  return { money: [...money], rates };
}
function moneyIn(s) {
  const out = [];
  for (const m of String(s).matchAll(/\$\s?([\d,]+(?:\.\d+)?)(?:\s?([kKmM])(?![a-zA-Z]))?/g)) {
    let v = parseFloat(m[1].replace(/,/g, '')); if (/k/i.test(m[2] || '')) v *= 1e3; if (/m/i.test(m[2] || '')) v *= 1e6; out.push([m[0], v]);
  }
  return out;
}
// Every $ and % must trace to the evidence (sums of up to 8 listed deal values are allowed)
function numberProblems(text, F, dealsInPlay = []) {
  const A = allowedNumbers(F), p = [];
  const vals = dealsInPlay.map((d) => d.value || 0);
  const sums = new Set(); for (let mask = 1; mask < 1 << Math.min(vals.length, 8); mask++) { let t = 0; for (let i = 0; i < Math.min(vals.length, 8); i++) if (mask & (1 << i)) t += vals[i]; sums.add(Math.round(t)); }
  for (const [raw, v] of moneyIn(text)) {
    const near = (a) => Math.abs(a - v) <= Math.max(0.03 * a, 600);
    if (!A.money.some(near) && ![...sums].some(near)) p.push(`money not in evidence: ${raw}`);
  }
  for (const m of String(text).matchAll(/(\d{1,3})%/g)) { const v = +m[1]; if (![v - 1, v, v + 1].some((x) => A.rates.has(x))) p.push(`rate not in evidence: ${m[0]}`); }
  return [...new Set(p)];
}

// ---------- 1. Scribe: one check-in becomes a draft the rep confirms ----------
const SCRIBE_PERSONA = `You are the Scribe of Pipeline Room. You record what was said in a sales check-in, exactly and without opinion.
- You never judge the person or the deal. You never guess. If something was not said, leave it out.
- Every item you record carries a short quote copied word for word from the transcript.
- The agent's own words are never the rep's answer. A number, promise or fact counts only if the rep said it.
- Plain English, short sentences, no em dashes, no semicolons.`;
const SCRIBE_SCHEMA = S({
  deals: { type: 'array', items: S({ ref: nstr, client: nstr, line: { type: 'string', description: 'what is happening, 10 words or fewer, for example "legal redlines back 23 Jun"' }, next_step_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' }, signer: nstr, quote: str }, ['line', 'quote']) },
  sf_edits: { type: 'array', items: S({ ref: nstr, client: nstr, field: { type: 'string', enum: ['close', 'status', 'amount', 'stage'] }, to: str, line: { type: 'string', description: '8 words or fewer, for example "Ripple close date to 10 Jul"' }, quote: str }) },
  promises_made: { type: 'array', items: S({ by: str, promise: { type: 'string', description: '12 words or fewer' }, ref: nstr, due: { type: ['string', 'null'], description: 'YYYY-MM-DD only if a date was said, else null' }, quote: str }, ['by', 'promise', 'quote']) },
  promises_checked: { type: 'array', items: S({ promise_id: str, status: { type: 'string', enum: ['kept', 'broken', 'unclear'] }, quote: str }) },
  for_mark: { type: 'array', items: S({ headline: { type: 'string', description: '8 words or fewer, phrased as a decision for Mark, for example "Email Ripple\'s CFO this week?"' }, ref: nstr, quote: str }) },
  not_covered: { type: 'array', items: str, description: 'refs from the list that never came up' },
});
function scribeRequest({ person, date, transcript, listenFor = [], deals = [], openPromises = [] }) {
  const user = `CHECK-IN with ${person} on ${date}.
THE LIST THE AGENT HAD (refs): ${listenFor.map((x) => x.ref).join(', ') || 'none'}
${person.toUpperCase()}'S OPEN DEALS (match what was said to these by size, stage and close date)
${deals.map((d) => `deal ${d.ref} | ${usd(d.value)} | ${d.stage} | close ${d.close}`).join('\n') || 'none'}
OPEN PROMISES (id | made on | promise)
${openPromises.map((p) => `${p.id} | ${p.made_on} | ${p.promise}`).join('\n') || 'none'}
TRANSCRIPT
${transcript}
TASK: record what was said. deals: every deal discussed, with the client name if the rep said it. sf_edits: only where the rep said Salesforce is wrong or out of date. for_mark: only things the rep asked Mark to do. promises_checked: only open promises that came up.`;
  return request({ system: SCRIBE_PERSONA, user, schema: SCRIBE_SCHEMA, maxTokens: 5000, model: 'claude-sonnet-5-5' });
}
function scribeProblems(out, transcript, deals, openPromises) {
  const T = norm(transcript), agent = transcript.split('\n').filter((l) => /^\s*(agent|ai)\s*:/i.test(l)).map(norm), p = [];
  const q = (where, quote) => { if (!quote || norm(quote).split(' ').length < 3) return; if (!T.includes(norm(quote))) p.push(`${where}: quote not in transcript`); else if (agent.some((l) => l.includes(norm(quote)))) p.push(`${where}: quote is the agent's words`); };
  const refOk = (r) => !r || deals.some((d) => d.ref === r);
  (out.deals || []).forEach((d, i) => { q(`deal ${i + 1}`, d.quote); if (!refOk(d.ref)) p.push(`deal ${i + 1}: unknown ref ${d.ref}`); });
  (out.sf_edits || []).forEach((e, i) => { q(`edit ${i + 1}`, e.quote); if (!refOk(e.ref)) p.push(`edit ${i + 1}: unknown ref ${e.ref}`); });
  (out.promises_made || []).forEach((x, i) => q(`promise ${i + 1}`, x.quote));
  (out.promises_checked || []).forEach((x, i) => { q(`check ${i + 1}`, x.quote); if (!openPromises.some((o) => o.id === x.promise_id)) p.push(`check ${i + 1}: unknown promise`); });
  (out.for_mark || []).forEach((x, i) => { q(`for Mark ${i + 1}`, x.quote); if (words(x.headline) > BUDGET.headline) p.push(`for Mark ${i + 1}: headline too long`); });
  return p;
}
// Drop anything that failed a check, so the rep only ever sees verified lines
function scribeClean(out, transcript, deals, openPromises) {
  const keep = (arr, label) => (arr || []).filter((x, i) => !scribeProblems({ [label]: [x] }, transcript, deals, openPromises).length);
  return { deals: keep(out.deals, 'deals'), sf_edits: keep(out.sf_edits, 'sf_edits'), promises_made: keep(out.promises_made, 'promises_made'), promises_checked: keep(out.promises_checked, 'promises_checked'), for_mark: keep(out.for_mark, 'for_mark'), not_covered: out.not_covered || [] };
}

// ---------- 2. Deal brain: each rep's list ----------
const LIST_SCHEMA = S({ rep: str, month: { type: 'string', description: 'one sentence, numbers only' }, listen_for: { type: 'array', items: S({ ref: str, tag: { type: 'string', enum: ['priority', 'at-risk', 'off-strategy', 'thin-history', 'stuck'] }, why: { type: 'string', description: '25 words or fewer, with fact ids' }, ask: { type: 'string', description: 'the one question the check-in asks, 12 words or fewer, plain words, no codes or rule numbers' } }) }, not_asking: str });
function repListRequest(F, rules, owner, clients = {}, news = []) {
  const r = F.reps[owner];
  const deals = F.live.filter((d) => d.owner === owner).sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0));
  const user = `YOUR RULES (follow them in order)
${rulesText(rules)}
${dealContext(F)}
REP: ${owner} | ${r.segment} ${r.region} | target ${usd(r.monthlyTarget)} | won this month ${usd(r.wonThisMonth)} | win rate ${pct(r.winRateInWindow)} vs team ${pct(r.teamWinRate)}
WHAT THE REP SAID SINCE THE EXPORT (dated)
${news.map((n) => `${n.at} | ${n.text}`).join('\n') || 'nothing yet'}
OPEN DEALS DUE THIS MONTH, OVERDUE OR NEXT MONTH
${deals.map((d) => dealLine(d, clients[d.id])).join('\n') || 'none'}
TASK: using your rules, choose the 3 to 5 deals the check-in must hear about. Skip deals the rep already gave a dated next step for since the export, unless your rules say otherwise.`;
  return request({ system: PERSONA.deal, user, schema: LIST_SCHEMA, maxTokens: 3000 });
}

// ---------- 3. Deal brain: Ask cards for Today ----------
const CARD_SCHEMA = S({
  headline: { type: 'string', description: `${BUDGET.headline} words or fewer, phrased as what to do` },
  number: { type: 'string', description: 'the one number that matters, for example "$186k"' },
  body: { type: 'string', description: `${BUDGET.body} words or fewer` },
  why: { type: 'array', items: S({ text: { type: 'string', description: 'one short line' }, source: { type: 'string', description: 'for example "Salesforce 18 Jun" or "Review 12 May"' } }), description: `up to 4 lines, ${BUDGET.why} words in total` },
  rows: { type: 'array', items: S({ who: str, what: str, number: str }, ['who', 'what']), description: 'optional table behind Why?, one row per deal or person' },
  refs: { type: 'array', items: str },
  topic: { type: 'string', description: 'two or three words naming the kind of card, for example "stuck contracts"' },
}, ['headline', 'number', 'body', 'why', 'refs', 'topic']);
const CARDS_SCHEMA = S({ cards: { type: 'array', items: CARD_SCHEMA } });
function reactionsText(reactions) {
  if (!reactions.length) return 'No reactions yet.';
  return reactions.map((x) => `${x.kind.replace('_', ' ')} | ${x.topic || ''} | "${x.headline || ''}"${x.reason ? ` | reason: ${x.reason}` : ''}`).join('\n');
}
function askCardsRequest(F, rules, lists, reactions = [], clients = {}) {
  const user = `YOUR RULES
${rulesText(rules)}
MARK'S REACTIONS TO EARLIER CARDS (do more of what he found useful or acted on, less of what he did not)
${reactionsText(reactions)}
${dealContext(F)}
EACH REP'S LIST FROM YOUR EARLIER PASS
${lists.map((l) => `${l.rep}: ${l.month}\n${(l.listen_for || []).map((x) => { const d = F.live.find((y) => y.ref === x.ref); return `  - ${x.tag} | ${d ? dealLine(d, clients[d.id]) : x.ref} | ${x.why}`; }).join('\n')}`).join('\n')}
TASK: write up to 3 cards for "Ask in the meeting": questions Mark should put to reps about deals. Each card is something he can raise in the meeting this week. Card face: headline (${BUDGET.headline} words max), one number, body (${BUDGET.body} words max). No deal codes, fact ids or rule numbers on the card face, and write numbers short ($840k). Reasons and sources go in "why". Put the deals in "rows".`;
  return request({ system: PERSONA.deal, user, schema: CARDS_SCHEMA, maxTokens: 4000 });
}

// ---------- 4. Coaching brain: profile and Coach cards ----------
const EVIDENCE = { type: 'array', items: S({ date: { type: 'string', description: 'YYYY-MM-DD' }, quote: { type: 'string', description: 'word for word' } }) };
const OBS = S({ observation: str, evidence: EVIDENCE });
const PROFILE_SCHEMA = S({ person: str, in_one_line: str, strengths: { type: 'array', items: OBS }, patterns: { type: 'array', items: OBS }, likely_reaction: str, coaching_move: str,
  for_rep: S({
    strengths: { type: 'array', items: { type: 'string', description: 'to the rep, starting "You", warm and specific, 18 words or fewer' } },
    to_try: { type: 'array', items: { type: 'string', description: 'to the rep, a gentle suggestion starting "Try" or "It could help to", 18 words or fewer, no blame' } },
  }) });
function profileRequest(name, pack, rules) {
  const user = `YOUR RULES (what good looks like here)
${rulesText(rules)}
Everything on file for ${name}, oldest first: reviews and check-ins. Read all of it.
${pack}
TASK: write ${name}'s profile. 1 or 2 strengths and 1 to 3 patterns, each with 1 to 3 dated quotes copied exactly (6 to 30 words). A pattern must appear on two dates or more. likely_reaction and coaching_move follow from the evidence. Then for_rep: what the rep sees about themselves, written to them as "you". 1 or 2 strengths, then at most 2 things to try, drawn from the patterns but phrased softly as next steps. No quotes, no dates, no names, no mention of Mark's views.`;
  return request({ system: PERSONA.coach, user, schema: PROFILE_SCHEMA, maxTokens: 6000 });
}
const COACH_CARDS_SCHEMA = S({ cards: { type: 'array', items: S({ person: str, headline: { type: 'string', description: `${BUDGET.headline} words or fewer, "Name: the behaviour"` }, number: { type: 'string', description: 'a count from the evidence, for example "2 extensions"' }, body: { type: 'string', description: `${BUDGET.body} words or fewer` }, why: { type: 'array', items: S({ date: str, quote: str }) }, move: { type: 'string', description: `one sentence, ${BUDGET.move} words or fewer` }, topic: str }) } });
function coachCardsRequest(profiles, rules, reactions = []) {
  const user = `YOUR RULES
${rulesText(rules)}
MARK'S REACTIONS TO EARLIER COACHING CARDS
${reactionsText(reactions)}
PROFILES
${JSON.stringify(profiles.map((p) => ({ person: p.person, in_one_line: p.in_one_line, patterns: p.patterns, strengths: p.strengths, coaching_move: p.coaching_move })), null, 1)}
TASK: up to 2 Coach cards for Today: the single most useful thing to coach this week, per person. Use your rules to choose. "why" holds 1 to 3 dated quotes copied from the profiles.`;
  return request({ system: PERSONA.coach, user, schema: COACH_CARDS_SCHEMA, maxTokens: 4000 });
}

// ---------- 5. Trainers: a session becomes a proposal Mark deploys ----------
const PROPOSAL_SCHEMA = S({
  rules: { type: 'array', items: S({ text: { type: 'string', description: 'the rule, 12 words or fewer' }, said: { type: 'string', description: 'Mark\'s own words that led to it, copied from the transcript' }, evidence: { type: 'string', description: 'one quiet line on how much data sits behind it, or empty' }, replaces: { type: ['integer', 'null'], description: 'number of an existing rule this replaces, or null' } }, ['text', 'said', 'evidence', 'replaces']) },
  effects: { type: 'array', items: S({ where: { type: 'string', enum: ['Check-ins', 'Today', 'Briefer', 'Profiles'] }, change: { type: 'string', description: '15 words or fewer, concrete' } }) },
  deploy_said: { type: 'boolean', description: 'true only if, at the end, the agent asked whether to deploy and Mark clearly said yes' },
  deploy_quote: { type: 'string', description: 'Mark\'s yes, copied word for word, or empty' },
});
function proposalRequest(brain, transcript, rules, context) {
  const who = brain === 'deal' ? 'the Analyst, who trains the deal brain' : 'the Mentor, who trains the coaching brain';
  const user = `You are ${who}. Mark has just finished a training session. Turn what he said into rules.
CURRENT RULES (numbered)
${rulesText(rules)}
${context}
SESSION TRANSCRIPT
${transcript}
TASK: list each rule Mark agreed to in the session (a rule counts only once he confirmed the agent's play-back), in his meaning, 12 words or fewer. Quote his own words in "said". If a rule replaces an existing one, give its number. Then list what would change across the app if deployed, concretely, using only facts above. Each rep's check-in list holds at most 5 deals, so say "up to 5 of Tom's 13", never more. Name people and amounts, never deal codes. If Mark agreed to nothing, return empty lists. Finally say whether Mark said yes when asked to deploy, with his words.`;
  return request({ system: brain === 'deal' ? PERSONA.deal : PERSONA.coach, user, schema: PROPOSAL_SCHEMA, maxTokens: 3000 });
}
function proposalProblems(out, transcript) {
  const T = norm(transcript), p = [];
  (out.rules || []).forEach((r, i) => { if (r.said && norm(r.said).split(' ').length >= 3 && !T.includes(norm(r.said))) p.push(`rule ${i + 1}: Mark's words not found in the session`); if (words(r.text) > 12) p.push(`rule ${i + 1}: too long`); });
  return p;
}
// Deploy straight away only when Mark's spoken yes is really in the transcript
function deployConfirmed(out, transcript) {
  return Boolean(out && out.deploy_said && out.deploy_quote && norm(out.deploy_quote).length > 1 && norm(transcript).includes(norm(out.deploy_quote)) && (out.rules || []).length);
}

// ---------- trainer brief: what the Analyst or Mentor knows when the call starts ----------
function trainerBrief(brain, c) {
  const rules = brain === 'deal' ? c.deal_rules : c.coach_rules;
  const head = `RULES THE ${brain === 'deal' ? 'DEAL' : 'COACHING'} BRAIN FOLLOWS NOW (thinking model v${c.version})\n${rulesText(rules)}`;
  if (brain === 'coach') {
    return `${head}\nPEOPLE (what the coaching brain sees, one line each)\n${(c.profiles || []).map((p) => `${p.person}: ${p.in_one_line}`).join('\n')}`;
  }
  const F = c.facts;
  const facts = Object.values(F.facts).filter((f) => f.n >= 15 && f.winRate !== null && f.winRate !== undefined).sort((a, b) => b.n - a.n).slice(0, 30)
    .map((f) => `${f.label}: won ${pct(f.winRate)} of ${f.n}${f.wonValue ? `, ${short(f.wonValue)} won` : ''}`);
  const onList = new Set((c.lists || []).flatMap((l) => (l.listen_for || []).map((x) => x.ref)));
  const open = F.live.filter((d) => d.value >= 10000 && (d.horizon === 'this-month' || d.horizon === 'next-month'));
  const groups = {};
  const put = (k, d) => { const g = (groups[k] ||= { n: 0, v: 0, off: 0, owners: {} }); g.n++; g.v += d.value; if (!onList.has(d.ref)) { g.off++; const o = d.owner.split(' ')[0]; g.owners[o] = (g.owners[o] || 0) + 1; } };
  for (const d of open) {
    const when = d.horizon === 'this-month' ? 'due this month' : 'due next month';
    const size = { '10-25k': '$10k to $25k', '25-50k': '$25k to $50k', '50-100k': '$50k to $100k', '100k+': 'over $100k' }[d.band] || d.band;
    put(`${d.segment} ${size}, ${when}`, d);
    if (d.value >= 50000) put(`${d.segment} ALL OVER $50k, ${when}`, d);
  }
  const lines = Object.entries(groups).sort((a, b) => b[1].v - a[1].v)
    .map(([k, g]) => `${k}: ${g.n} open, ${short(g.v)}. Not on any list yet: ${g.off}${g.off ? ` (${Object.entries(g.owners).map(([o, n]) => `${o} ${n}`).join(', ')})` : ''}`);
  return `${head}\nWHAT WON, ${F.window.from} TO ${F.window.to}\n${facts.join('\n')}\nOPEN DEALS OF $10K OR MORE BY GROUP (segments: SMB, MM = mid-market, ENT = enterprise). A new \"always ask\" rule puts the \"not on any list yet\" deals in play. Each rep's check-in asks about 5 deals at most, so a rep with more gets only the top 5.\n${lines.join('\n')}\nTODAY SHOWS MARK AT MOST 5 CARDS: 2 to decide, 2 to ask in the meeting, 1 to coach.`;
}

// ---------- fix pass: one retry when a card breaks a budget or a number does not trace ----------
function fixRequest(persona, json, problems, schema, context = '') {
  const user = `These cards break the rules below. Fix only what is listed, keep everything else the same, and submit the full set.
PROBLEMS
${problems.join('\n')}
RULES: headline ${BUDGET.headline} words or fewer, body ${BUDGET.body} words or fewer, move ${BUDGET.move} words or fewer, dates written like "21 Apr", no deal codes or rule numbers on the card face, every $ and % from the facts.
CARDS
${JSON.stringify(json, null, 1)}
${context}`;
  return request({ system: persona, user, schema, maxTokens: 4000 });
}

// ---------- 6. Decide cards: no model, straight from what reps sent ----------
function decideCards(sfEdits, asks) {
  const cards = [];
  const byOwner = {};
  for (const e of sfEdits) (byOwner[e.owner] ||= []).push(e);
  for (const [owner, list] of Object.entries(byOwner)) {
    const first = owner.split(' ')[0];
    cards.push({ grp: 'decide', headline: `Approve ${list.length} Salesforce fix${list.length > 1 ? 'es' : ''}`, number: first, body: list.map((e) => e.reason).join('. ').slice(0, 160), action: { kind: 'approve_edits', ids: list.map((e) => e.id), label: list.length > 1 ? 'Approve all' : 'Approve' }, why: list.map((e) => ({ text: e.reason, source: `Check-in ${e.created_at ? e.created_at.slice(5, 10) : ''}` })), topic: 'salesforce fixes', person: owner });
  }
  const seen = new Set();
  for (const a of asks.filter((x) => { const k = `${x.person}|${norm(x.headline)}`; if (seen.has(k)) return false; seen.add(k); return true; })) cards.push({ grp: 'decide', headline: a.headline, number: a.number || a.person.split(' ')[0], body: `${a.person.split(' ')[0]} asked in the check-in.`, action: { kind: 'done', label: 'Mark as done', event_ids: asks.filter((x) => x.person === a.person && norm(x.headline) === norm(a.headline)).map((x) => x.id) }, why: [{ text: `"${a.quote}"`, source: `Check-in ${a.date}` }], topic: 'rep asks', person: a.person });
  return cards;
}

// Today: at most 5, Decide first, then Ask, then Coach, each group in rank order
function composeToday(cards) {
  const by = (g) => cards.filter((c) => c.grp === g).sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const pick = [...by('decide').slice(0, 2), ...by('ask').slice(0, 2), ...by('coach').slice(0, 1)];
  const rest = [...by('decide').slice(2), ...by('ask').slice(2), ...by('coach').slice(1)];
  while (pick.length < 5 && rest.length) pick.push(rest.shift());
  return pick;
}
// Rank from Mark's reactions: useful or done on a topic lifts it, not useful drops it
function rankCards(cards, reactions) {
  const score = {};
  for (const r of reactions) score[r.topic] = (score[r.topic] || 0) + (r.kind === 'not_useful' ? -1 : 1);
  return cards.map((c, i) => ({ ...c, rank: (score[c.topic] || 0) * 10 - i }));
}

// ---------- 7. Promises in a review recording ----------
const REVIEW_PROMISES_SCHEMA = S({
  promises_made: { type: 'array', items: S({ by: { type: 'string', description: 'full name, one of the people listed' }, promise: { type: 'string', description: '12 words or fewer' }, due: { type: ['string', 'null'], description: 'YYYY-MM-DD only if a date was said, else null' }, quote: str }, ['by', 'promise', 'quote']) },
  promises_checked: { type: 'array', items: S({ promise_id: str, status: { type: 'string', enum: ['kept', 'broken', 'unclear'] }, quote: str }) },
});
function reviewPromisesRequest({ date, title, people, transcript, open = [] }) {
  const user = `REVIEW MEETING on ${date}: ${title || ''}
PEOPLE IN IT (reps): ${people.join(', ')}. Mark Goldberger usually runs the meeting. Speaker labels are often wrong, so work out who speaks from context.
OPEN PROMISES FROM EARLIER (id | by | made on | promise)
${open.map((p) => `${p.id} | ${p.by} | ${p.made_on} | ${p.promise}`).join('\n') || 'none'}
TRANSCRIPT
${transcript}
TASK: promises_made: each concrete thing one of the reps listed said they would do, with a quote. Only the reps listed, never Mark. promises_checked: only open promises that clearly came up, kept or broken, with a quote.`;
  return request({ system: SCRIBE_PERSONA, user, schema: REVIEW_PROMISES_SCHEMA, maxTokens: 6000, model: 'claude-sonnet-5-5' });
}
function reviewPromisesClean(out, transcript, people, open) {
  const T = norm(transcript);
  const found = (q) => q && norm(q).split(' ').length >= 3 && T.includes(norm(q));
  return {
    promises_made: (out.promises_made || []).filter((x) => people.includes(x.by) && found(x.quote) && words(x.promise) <= 14),
    promises_checked: (out.promises_checked || []).filter((x) => open.some((o) => o.id === x.promise_id) && found(x.quote)),
  };
}

// The model sometimes returns a nested list as a JSON string: turn it back into a list
const asList = (x) => { if (Array.isArray(x)) return x; if (typeof x === 'string') { try { const v = JSON.parse(x); return Array.isArray(v) ? v : [v]; } catch (e) { return x.trim() ? [x] : []; } } return x ? [x] : []; };
function profileNormalize(p) {
  p.strengths = asList(p.strengths); p.patterns = asList(p.patterns);
  let r = p.for_rep; if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } }
  p.for_rep = r ? { strengths: asList(r.strengths).filter((t) => typeof t === 'string'), to_try: asList(r.to_try).filter((t) => typeof t === 'string') } : null;
  return p;
}

// ---------- 8. The Briefer's script for a phone call (the app builds the same from the screen) ----------
function briefFromContext(c) {
  const clean = (t) => String(t || '').replace(/\s*\[F:[^\]]+\]/g, '').replace(/\s*\((?:deals? )?[0-9][0-9A-Za-z]{5}\)/g, '').trim();
  const by = (g) => (c.cards || []).filter((x) => x.grp === g);
  const item = (x, i) => `${i + 1}. ${x.headline}. ${x.number ? `Number: ${x.number}. ` : ''}${clean(x.body)}${x.move ? ` Move: ${x.move}` : ''}${x.person && x.grp !== 'ask' ? ` (${x.person})` : ''}\n   Why: ${[...(((x.why || {}).rows) || []).map((r) => `${r.who} ${clean(r.what)} ${r.number || ''}`), ...(((x.why || {}).lines) || []).map((l) => clean(l.text))].join('; ').slice(0, 600)}`;
  const rv = c.review || {};
  const who = c.checked_in || [];
  const list = (g) => (by(g).length ? by(g).map(item) : ['none']);
  return [
    `THE WEEK: pipeline review on ${rv.date || 'the next review'}. ${who.length ? `${who.join(', ')} checked in.` : 'No check-ins yet.'} ${c.fixes} Salesforce fixes waiting. ${c.broken} promises broken since the last review. ${Math.max(0, (c.reps || 0) - who.length)} reps still to check in.`,
    'TO DECIDE', ...list('decide'), 'TO ASK IN THE MEETING', ...list('ask'), 'TO COACH', ...list('coach'),
  ].join('\n');
}

module.exports = {
  briefFromContext,
  profileNormalize,
  reviewPromisesRequest, reviewPromisesClean,
  MODEL, BUDGET, request, answer, words, norm, short, usd, pct, rulesText, budgetProblems, numberProblems, dealLine,
  scribeRequest, scribeProblems, scribeClean, repListRequest, askCardsRequest, profileRequest, coachCardsRequest,
  proposalRequest, proposalProblems, deployConfirmed, trainerBrief, fixRequest, PERSONA, decideCards, composeToday, rankCards,
  SCHEMAS: { SCRIBE_SCHEMA, LIST_SCHEMA, CARDS_SCHEMA, PROFILE_SCHEMA, COACH_CARDS_SCHEMA, PROPOSAL_SCHEMA },
};
