// The Coaching Brain. Separate from the Deal Brain: its own persona, lens, inputs and outputs.
//   1. writeLens:   what good looks like here, built from Mark's own coaching in the recordings
//   2. profile:     one person, read across every full meeting they appeared in
//   3. peopleCards: draft VP cards about people, cut them as Mark would, verify every quote

const fs = require('fs');
const path = require('path');
const { ask, askStructured } = require('./model');
const { quoteFound } = require('./transcripts');

const PERSONA = fs.readFileSync(path.join(__dirname, 'coach_persona.md'), 'utf8');
const S = (props, req) => ({ type: 'object', properties: props, required: req || Object.keys(props) });
const str = { type: 'string' };
const EVIDENCE = { type: 'array', items: S({ date: { type: 'string', description: 'YYYY-MM-DD of the meeting' }, quote: { type: 'string', description: 'word for word from that transcript' } }) };
const OBS = S({ observation: str, evidence: EVIDENCE });
const PROFILE_SCHEMA = S({
  person: str,
  in_one_line: { type: 'string', description: 'one plain sentence a VP reads first' },
  strengths: { type: 'array', items: OBS },
  patterns: { type: 'array', items: OBS, description: 'things to work on, each seen on at least two dates' },
  promises: { type: 'array', items: S({ made_on: str, promise: str, next_raised_on: { type: ['string', 'null'] }, status: { type: 'string', enum: ['kept', 'broken', 'not raised again', 'unclear'] }, evidence: str }) },
  likely_reaction: { type: 'string', description: 'how they will probably respond when challenged on Tuesday, based on the pattern' },
  coaching_move: { type: 'string', description: 'one concrete thing Mark can do or ask this week' },
  would_change_my_view: str,
});
const CARD = S({ person: str, title: str, body: str, evidence: EVIDENCE, move: str });
const CARDS_SCHEMA = S({ cards: { type: 'array', items: CARD } });
const CUT_SCHEMA = S({ keep: { type: 'array', items: CARD }, cut: { type: 'array', items: S({ title: str, reason: str }) } });

function coachingIndex(meetings) {
  return meetings.map((m) => [
    `### ${m.date} · ${m.team} · run by ${m.runBy.join(', ')}`,
    m.themes.length ? `Team themes: ${m.themes.join(' | ')}` : '',
    ...m.reps.map((r) => {
      const asks = (r.deals || []).map((d) => d.manager_ask).filter(Boolean);
      const coach = r.coaching_from_manager || [];
      return coach.length || asks.length ? `- ${r.rep}: coaching: ${coach.join(' | ') || 'none'}${asks.length ? ` · asks on deals: ${asks.join(' | ')}` : ''}` : '';
    }),
  ].filter(Boolean).join('\n')).join('\n\n');
}

async function writeLens(meetings, opts = {}) {
  const user = `Below is an index of every coaching point and manager ask in ${meetings.length} recorded pipeline reviews, ${meetings[0].date} to ${meetings[meetings.length - 1].date}.

${coachingIndex(meetings)}

TASK
Write version 1 of your lens as markdown, 300 to 450 words, with exactly these sections:
## What good looks like here
(5 to 7 behaviours Mark asks for again and again, each one short sentence with the dates he asked for it in brackets)
## What I listen for in a check-in
(4 to 6 plain rules a VP could edit, for example "a dated next step on every deal in the month". This is the section people will coach.)
## What the recordings cannot tell me
(real gaps, for example people who were rarely reviewed, or mislabelled speakers)
## Mark's current priorities
(say only: None set yet. Mark sets this section.)
Return only the markdown.`;
  return ask({ system: PERSONA, user, maxTokens: 5000, ...opts });
}

function personPack(name, appearances, meetings) {
  const ids = new Set(appearances.map((a) => a.meeting));
  const mine = meetings.filter((m) => ids.has(m.id));
  return mine.map((m) => {
    const ex = appearances.find((a) => a.meeting === m.id).extraction;
    return `=============== MEETING ${m.date} · ${m.team} · ${m.title} · run by ${m.runBy.join(', ')}
INDEX OF WHAT ${name.toUpperCase()} COVERED (made earlier, may be incomplete): ${JSON.stringify({ number: ex.forecast_or_number, deals: (ex.deals || []).map((d) => d.account), commitments: ex.commitments, coaching: ex.coaching_from_manager })}
FULL TRANSCRIPT
${m.raw}`;
  }).join('\n\n');
}

async function profile(name, appearances, meetings, lens, opts = {}) {
  const user = `YOUR LENS
${lens}

${name} appears in ${appearances.length} reviews: ${appearances.map((a) => a.date).join(', ')}. Read every one in full. Other people are discussed too; focus on ${name}.

${personPack(name, appearances, meetings)}

TASK
Write ${name}'s profile and submit it through the submit tool.
- 1 or 2 strengths and 1 to 3 patterns, each with 1 to 3 pieces of dated evidence. A pattern must show up on at least two dates.
- Every quote is copied exactly from that date's transcript, 6 to 30 words long.
- Promises: list what ${name} promised (or Mark asked them to do) and whether a later meeting shows it kept, broken or never raised again. Only promises you can see.
- likely_reaction and coaching_move must follow from the evidence.`;
  return askStructured({ system: PERSONA, user, schema: PROFILE_SCHEMA, maxTokens: 8000, ...opts });
}

// Every quote must be found word for word in that date's meeting for that person
function checkQuotes(items, appearances, meetings) {
  const bad = [];
  for (const it of items) {
    if (!it || !it.quote) continue;
    const ms = meetings.filter((m) => m.date === it.date && (!appearances || appearances.some((a) => a.meeting === m.id)));
    if (!ms.length) { bad.push(`no meeting on ${it.date} for this person: "${it.quote}"`); continue; }
    if (!ms.some((m) => quoteFound(m, it.quote))) bad.push(`not found word for word on ${it.date}: "${it.quote}"`);
  }
  return bad;
}
const profileQuotes = (p) => [...(p.strengths || []), ...(p.patterns || [])].flatMap((o) => o.evidence || []);

async function fixProfile(name, p, problems, appearances, meetings, opts = {}) {
  const user = `Your profile of ${name} has quotes that could not be found word for word in the transcripts:
${problems.join('\n')}

For each one, replace it with an exact quote from the same meeting that supports the same point, or drop that piece of evidence. If an observation is left with no evidence, drop the observation. Change nothing else. Submit the full corrected profile.

YOUR PROFILE
${JSON.stringify(p, null, 1)}

${personPack(name, appearances, meetings)}`;
  return askStructured({ system: PERSONA, user, schema: PROFILE_SCHEMA, maxTokens: 8000, ...opts });
}

// Tool answers are not strictly enforced, so a profile can come back with a field missing
const REQUIRED = PROFILE_SCHEMA.required;
const missing = (p) => REQUIRED.filter((k) => p[k] === undefined || p[k] === null || p[k] === '');
async function completeProfile(name, p, appearances, meetings, opts = {}) {
  const gaps = missing(p);
  if (!gaps.length) return p;
  const user = `Your profile of ${name} is missing: ${gaps.join(', ')}. Fill those fields from the evidence, keep everything else exactly as it is, and submit the full profile.

YOUR PROFILE
${JSON.stringify(p, null, 1)}

${personPack(name, appearances, meetings)}`;
  return askStructured({ system: PERSONA, user, schema: PROFILE_SCHEMA, maxTokens: 8000, ...opts });
}

async function peopleCards(profiles, lens, opts = {}) {
  const user = `YOUR LENS
${lens}

PROFILES
${JSON.stringify(profiles.map((p) => ({ person: p.person, in_one_line: p.in_one_line, strengths: p.strengths, patterns: p.patterns, promises: p.promises, likely_reaction: p.likely_reaction, coaching_move: p.coaching_move })), null, 1)}

TASK
Draft up to 8 cards for Mark's screen before the review, about people, not deals. Each card is one person and the single thing most worth coaching or recognising this week. Title under 10 words. Body two sentences at most. Evidence: 1 to 3 dated quotes copied from the profile. Move: one sentence. Submit {"cards": [...]}.`;
  return (await askStructured({ system: PERSONA, user, schema: CARDS_SCHEMA, maxTokens: 6000, ...opts })).cards;
}

const VP_CUT = `You are Mark Goldberger, VP of Sales. You have ten minutes before the weekly pipeline review and you read on your phone.
These are draft coaching cards about your team. Keep the ones that would change how you run this week's review or a one-to-one. Keep at most 4. Cut anything vague, anything you already know, or anything without strong dated evidence. Prefer a balance: not only problems.
Submit {"keep": [kept cards exactly as given], "cut": [{"title": "...", "reason": "one line"}]}.`;

async function cutCards(drafts, opts = {}) {
  return askStructured({ system: VP_CUT, user: JSON.stringify(drafts, null, 1), schema: CUT_SCHEMA, maxTokens: 6000, ...opts });
}

module.exports = { completeProfile, missing, writeLens, profile, fixProfile, checkQuotes, profileQuotes, peopleCards, cutCards, coachingIndex };
