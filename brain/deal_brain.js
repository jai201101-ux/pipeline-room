// The Deal Brain. Three jobs, each a separate model pass:
//   1. writeLens: turn the facts into the lens, the document people coach
//   2. repList:   for one rep, choose the deals the check-in must hear about (tentative)
//   3. teamCards: draft the VP's deal cards, then cut them as the VP would, then verify every number
// It never sees the Coaching Brain's output.

const fs = require('fs');
const path = require('path');
const { ask, askStructured, json } = require('./model');

// Ask for JSON; if the reply does not parse, show the model its error once and ask again
async function askJson(args) {
  const first = await ask(args);
  try { return json(first); } catch (e) {
    const again = await ask({ ...args, user: `${args.user}\n\nYour previous reply was not valid JSON (${e.message}). Return the same content as valid JSON only. Use single quotes inside text, never unescaped double quotes.` });
    return json(again);
  }
}

const PERSONA = fs.readFileSync(path.join(__dirname, 'deal_persona.md'), 'utf8');
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const usd = (x) => (x === null || x === undefined ? 'no amount' : `$${Math.round(x).toLocaleString('en-US')}`);

function factLines(F) {
  return Object.values(F.facts)
    .filter((f) => f.n > 0)
    .map((f) => `${f.id} | ${f.label} | deals ${f.n} | won ${f.won} | win rate ${pct(f.winRate)} | won value ${usd(f.wonValue)}`)
    .join('\n');
}

function dealLine(d) {
  return [
    `deal ${d.ref}`, usd(d.value), d.stage, `close ${d.close} (${d.horizon})`,
    `Salesforce ${pct(d.salesforceProb)}`, `history ${pct(d.historyWinRate)} from ${d.historyN} deals [${d.historyFact}]`,
    `fit ${d.fit}`, `expected ${usd(d.expectedValue)}`,
    d.daysInStage !== null ? `${d.daysInStage} days in stage (median ${d.medianDaysInStage})${d.stuck ? ' STUCK' : ''}` : 'days in stage unknown',
    `${d.segment} ${d.region}`, d.source ? `source ${d.source}` : 'source unknown', d.type ? `type ${d.type}` : 'type unknown',
    d.products.length ? `products ${d.products.join('+')}` : 'products not recorded',
  ].join(' | ');
}

function context(F) {
  return [
    `Data as of ${F.asOf}. History window: deals closed ${F.window.from} to ${F.window.to}, clean-up days excluded. This month runs ${F.thisMonth.from} to ${F.thisMonth.to}.`,
    '', 'DATA QUALITY (respect these limits in everything you write)', ...(F.dataQuality || []).map((x) => `- ${x}`),
    '', 'FACTS', factLines(F),
    '', 'TOP RECORDED LOSS REASONS (real losses in window)', F.lostReasons.map((r) => `${r.reason}: ${r.n}`).join('\n'),
    '', 'TOP RECORDED WIN REASONS', F.wonReasons.map((r) => `${r.reason.slice(0, 140)}: ${r.n}`).join('\n'),
    '', 'MEDIAN DAYS IN CURRENT STAGE FOR OPEN DEALS, BY STAGE NUMBER', JSON.stringify(F.stageMedianDays),
  ].join('\n');
}

async function writeLens(F, opts = {}) {
  const user = `${context(F)}

TASK
Write version 1 of your lens as a markdown document of 300 to 450 words. A busy VP must be able to read it in two minutes. Use exactly these sections:
## Where we win
## Where we lose or waste effort
## Deal size
## Motion, source and products
## What the data cannot tell me
## How I choose deals for a check-in
## Company focus

Rules
- Each bullet is one short sentence with at most two numbers and its fact ids in brackets. No chains of arithmetic.
- "Where we win" and "Where we lose" pick the 3 or 4 findings that matter most for revenue, not every cut.
- "What the data cannot tell me" must name the real gaps you can see (for example thin history above $100k, or how many losses have no reason).
- "How I choose deals for a check-in" is your selection method in 4 to 6 plain rules that a VP could edit, such as which deals you always ask about. Base it on the facts. This section is what people will coach.
- "Company focus" says only: None set yet. People set this section.
Return only the markdown.`;
  return ask({ system: PERSONA, user, maxTokens: 6000, ...opts });
}

const S = (props, req) => ({ type: 'object', properties: props, required: req || Object.keys(props) });
const str = { type: 'string' };
const LIST_SCHEMA = S({ rep: str, month: str, listen_for: { type: 'array', items: S({ ref: str, tag: { type: 'string', enum: ['priority', 'at-risk', 'off-strategy', 'thin-history', 'stuck'] }, why: str, ask: str }) }, not_asking: str, unsure: str });
const CARD = S({ kind: { type: 'string', enum: ['at-risk', 'off-strategy', 'pattern'] }, title: str, body: str, refs: { type: 'array', items: str }, facts: { type: 'array', items: str } });
const CARDS_SCHEMA = S({ cards: { type: 'array', items: CARD } });
const CUT_SCHEMA = S({ keep: { type: 'array', items: CARD }, cut: { type: 'array', items: S({ title: str, reason: str }) } });

async function repList(F, lens, owner, opts = {}) {
  const r = F.reps[owner];
  const deals = F.live.filter((d) => d.owner === owner).sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0));
  const user = `YOUR LENS (current version, follow it)
${lens}

${context(F)}

REP
${owner} | ${r.segment} ${r.region} | monthly target ${usd(r.monthlyTarget)} | won this month so far ${usd(r.wonThisMonth)} from ${r.wonThisMonthDeals} deals | closed in window ${r.closedInWindow}, win rate ${pct(r.winRateInWindow)} against team ${pct(r.teamWinRate)} | by size: ${Object.entries(r.winRateByBand).map(([b, v]) => `${b} ${pct(v.winRate)} of ${v.n}`).join(', ') || 'too few to split'}

THEIR OPEN DEALS DUE THIS MONTH, OVERDUE, OR NEXT MONTH (${deals.length})
${deals.map(dealLine).join('\n') || 'none'}

TASK
Using your lens rules, choose the deals the check-in agent must hear about from ${owner} this week. Choose 3 to 5, fewer if fewer matter. Submit it through the submit tool, in this shape:
{
 "rep": "${owner}",
 "month": "one sentence on their month in numbers only: won so far against target, and what is due",
 "listen_for": [
  {"ref": "deal ref", "tag": "priority | at-risk | off-strategy | thin-history | stuck", "why": "one or two sentences with fact ids", "ask": "the single question, using single quotes if you quote anything, the agent should ask about this deal, spoken, under 25 words, describing the deal by size, stage and close date because the client name is unknown"}
 ],
 "not_asking": "one sentence on what you left out and why",
 "unsure": "one sentence on what would change your choice"
}`;
  const out = await askStructured({ system: PERSONA, user, schema: LIST_SCHEMA, ...opts });
  out.listen_for = (out.listen_for || []).map((x) => ({ ...x, deal: F.live.find((d) => d.ref === x.ref) || null }));
  return out;
}

async function teamCards(F, lens, lists, opts = {}) {
  const user = `YOUR LENS
${lens}

${context(F)}

EACH REP'S LIST FROM YOUR OWN EARLIER PASS
${lists.map((l) => `${l.rep}: ${l.month}\n${l.listen_for.map((x) => `  - ${x.tag} | deal ${x.ref} | ${x.deal ? dealLine(x.deal) : ''} | ${x.why}`).join('\n')}`).join('\n')}

TASK
Draft the deal cards for the VP's screen before the review. Up to 8 drafts. Each card is one thing the VP should know or act on about deals (never about people). Kinds: "at-risk" (a specific deal), "off-strategy" (where effort is going against the lens), "pattern" (something across several deals or reps). Submit {"cards": [...]} through the submit tool, each card shaped like:
[{"kind": "...", "title": "under 12 words, with the key number", "body": "two sentences at most, with fact ids and deal refs", "refs": ["deal refs"], "facts": ["fact ids"]}]`;
  return (await askStructured({ system: PERSONA, user, schema: CARDS_SCHEMA, ...opts })).cards;
}

const VP_CUT = `You are Mark, VP of Sales. You have ten minutes before your weekly pipeline review and you read on your phone.
You are given draft deal cards from an analyst. Keep only the cards that change what you decide or how you spend the hour. Keep at most 4. A card that repeats another, states the obvious, or that you cannot act on this week is cut.
Submit through the submit tool: {"keep": [the kept cards exactly as given], "cut": [{"title": "...", "reason": "one line"}]}`;

async function cutCards(drafts, opts = {}) {
  return askStructured({ system: VP_CUT, user: JSON.stringify(drafts, null, 1), schema: CUT_SCHEMA, ...opts });
}

// Verify: every fact id must exist, every deal ref must exist, every $ and % must trace to the evidence
function allowedNumbers(F) {
  const money = new Set(), rates = new Set();
  const addM = (v) => { if (v) money.add(Math.round(v)); };
  for (const f of Object.values(F.facts)) { addM(f.wonValue); if (f.winRate !== null) rates.add(Math.round(f.winRate * 100)); }
  for (const d of F.live) { addM(d.value); addM(d.expectedValue); if (d.salesforceProb !== null) rates.add(Math.round(d.salesforceProb * 100)); if (d.historyWinRate !== null) rates.add(Math.round(d.historyWinRate * 100)); if (d.gapVsHistory !== null) rates.add(Math.abs(Math.round(d.gapVsHistory * 100))); }
  for (const r of Object.values(F.reps)) { addM(r.wonThisMonth); addM(r.liveValue); addM(r.monthlyTarget); addM(r.monthlyTarget - r.wonThisMonth); if (r.winRateInWindow !== null) rates.add(Math.round(r.winRateInWindow * 100)); for (const v of Object.values(r.winRateByBand)) rates.add(Math.round(v.winRate * 100)); }
  for (const b of [10000, 25000, 50000, 100000]) money.add(b);
  return { money: [...money], rates };
}

function parseMoney(s) {
  const m = s.match(/\$\s?([\d,]+(?:\.\d+)?)(?:\s?([kKmM])(?![a-zA-Z]))?/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (/k/i.test(m[2] || '')) v *= 1e3; if (/m/i.test(m[2] || '')) v *= 1e6;
  return v;
}

function verify(text, F, allowed = allowedNumbers(F)) {
  const problems = [];
  for (const id of text.match(/F:[A-Za-z0-9:+\-_.|]+/g) || []) {
    const clean = id.replace(/[.,;)\]]+$/, '');
    if (!F.facts[clean]) problems.push(`unknown fact id ${clean}`);
  }
  for (const m of text.matchAll(/deal ([0-9A-Za-z]{6})\b/g)) if (/[0-9A-Z]/.test(m[1]) && !F.live.some((d) => d.ref === m[1])) problems.push(`unknown deal ref ${m[1]}`);
  for (const s of text.match(/\$\s?[\d,]+(?:\.\d+)?(?:\s?[kKmM](?![a-zA-Z]))?/g) || []) {
    const v = parseMoney(s);
    if (v === null) continue;
    const ok = allowed.money.some((a) => Math.abs(a - v) <= Math.max(0.02 * a, 600));
    if (!ok) problems.push(`money not in evidence: ${s.trim()}`);
  }
  for (const m of text.matchAll(/(\d{1,3})%/g)) {
    const v = +m[1];
    if (![v - 1, v, v + 1].some((x) => allowed.rates.has(x))) problems.push(`rate not in evidence: ${m[0]}`);
  }
  return [...new Set(problems)];
}

async function fixText(text, problems, F, opts = {}, schema = null) {
  const user = `This text failed a check against the evidence. Problems:
${problems.join('\n')}

Rewrite it so every number traces to the facts below. If a number was arithmetic you did (a sum or difference), show the parts instead. If you cannot support it, remove it. Keep the same format (if it is JSON, return the same JSON shape only).

TEXT
${text}

${context(F)}`;
  if (schema) return askStructured({ system: PERSONA, user, schema, ...opts });
  return ask({ system: PERSONA, user, maxTokens: 6000, ...opts });
}

module.exports = { LIST_SCHEMA, CARDS_SCHEMA, writeLens, repList, teamCards, cutCards, verify, fixText, dealLine, allowedNumbers };
