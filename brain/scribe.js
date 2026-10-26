// The Scribe. Neutral, no opinions: turns one check-in (or one rep's part of a review) into
// dated facts. What changed on each deal, the Salesforce edits implied by what the rep said,
// promises made, and whether earlier promises were kept. Neither brain marks its own homework:
// both read what the Scribe wrote.

const { askStructured } = require('./model');
const { norm } = require('./transcripts');

const PERSONA = `You are the Scribe of Pipeline Room. You record what was said in a sales check-in, exactly and without opinion.
- You never judge the person or the deal. You never guess. If something was not said, leave it out.
- Every item you record carries a short quote copied word for word from the transcript.
- Speaker labels may be wrong. Work out who is speaking from context.
- The agent's own words are never the rep's answer. A number, promise or fact counts only if the rep or the VP said it. If the rep gave no number, leave the number empty.
- Plain English, short sentences, no em dashes, no semicolons.`;

const S = (props, req) => ({ type: 'object', properties: props, required: req || Object.keys(props) });
const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const SCHEMA = S({
  deals: { type: 'array', items: S({ ref: nstr, described_as: str, client_name: nstr, what_changed: nstr, next_step: nstr, next_step_date: { type: ['string', 'null'], description: 'YYYY-MM-DD if a date was given' }, signer: nstr, quote: str }, ['described_as', 'quote']) },
  number: S({ month_call: nstr, committed: nstr, quote: nstr }, []),
  sf_edits: { type: 'array', items: S({ ref: str, field: { type: 'string', enum: ['stage', 'close', 'amount', 'status', 'next_step'] }, to: str, reason: str, quote: str }) },
  promises_made: { type: 'array', items: S({ by: { type: 'string', description: 'person name' }, promise: str, ref: nstr, due: nstr, quote: str }, ['by', 'promise', 'quote']) },
  promises_checked: { type: 'array', items: S({ promise_id: str, status: { type: 'string', enum: ['kept', 'broken', 'unclear'] }, quote: str }) },
  help_needed: { type: 'array', items: S({ ask: str, quote: str }) },
  not_covered: { type: 'array', items: str, description: 'refs from the list that were never discussed' },
});

function dealRow(d) {
  return `deal ${d.ref} | $${Math.round(d.value || 0).toLocaleString('en-US')} | ${d.stage} | close ${d.close} | Salesforce ${Math.round((d.salesforceProb ?? d.prob ?? 0) * 100)}%`;
}

async function scribe({ person, date, transcript, listenFor = [], deals = [], openPromises = [] }, opts = {}) {
  const user = `CHECK-IN with ${person} on ${date}.

THE DEALS THE AGENT WAS ASKED TO COVER (refs)
${listenFor.map((x) => `- ${x.ref}`).join('\n') || 'none'}

${person.toUpperCase()}'S OPEN DEALS IN SALESFORCE (use these refs to match what was said; the rep usually names the client, Salesforce does not)
${deals.map(dealRow).join('\n') || 'none'}

OPEN PROMISES TO CHECK (id | made on | by | promise)
${openPromises.map((p) => `${p.id} | ${p.made_on} | ${p.by_person} | ${p.promise}`).join('\n') || 'none'}

TRANSCRIPT
${transcript}

TASK
Record what was said and submit it.
- deals: every deal discussed. Match it to a ref by size, stage and close date when you can, otherwise ref null.
- sf_edits: only where what the rep said differs from Salesforce (for example a new close date, a deal they say is signed, a different amount). "to" is the new value as the rep said it.
- promises_made: anything the rep or the VP said they would do, with a date if one was given.
- promises_checked: for each open promise above that came up, whether it was kept, broken or unclear. Skip promises that did not come up.`;
  return askStructured({ system: PERSONA, user, schema: SCHEMA, maxTokens: 6000, ...opts });
}

// Code checks: quotes must be in the transcript, refs must exist, promise ids must exist
function checkScribe(out, transcript, deals, openPromises) {
  const T = norm(transcript);
  const problems = [];
  const agentLines = transcript.split('\n').filter((l) => /^\s*(agent|ai|assistant)\s*:/i.test(l)).map(norm);
  const q = (where, quote) => {
    if (!quote || norm(quote).split(' ').length < 3) return;
    if (!T.includes(norm(quote))) problems.push(`${where}: quote not in transcript: "${quote}"`);
    else if (agentLines.some((l) => l.includes(norm(quote)))) problems.push(`${where}: quote is the agent's words, not the rep's: "${quote}"`);
  };
  for (const d of out.deals || []) { q(`deal ${d.ref || d.described_as}`, d.quote); if (d.ref && !deals.some((x) => x.ref === d.ref)) problems.push(`unknown ref ${d.ref}`); }
  for (const e of out.sf_edits || []) { q(`edit ${e.ref}`, e.quote); if (!deals.some((x) => x.ref === e.ref)) problems.push(`edit on unknown ref ${e.ref}`); }
  for (const p of out.promises_made || []) q('promise', p.quote);
  for (const p of out.promises_checked || []) { q('promise check', p.quote); if (!openPromises.some((x) => x.id === p.promise_id)) problems.push(`unknown promise id ${p.promise_id}`); }
  if (out.number && out.number.quote) q('number', out.number.quote);
  return problems;
}

module.exports = { scribe, checkScribe, SCHEMA };
