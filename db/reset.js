// Resets the demo to a clean starting point: thinking model v1, no check-ins, no reactions,
// promises as they stood after the 18 recorded reviews. Then the server rewrites lists, profiles and Today.
const fs = require('fs');
const { rest, insertBatched } = require('./sb');
const S = '../mv/secrets/';
const U = fs.readFileSync(S + 'sb_url', 'utf8').trim(), K = fs.readFileSync(S + 'sb_service_jwt', 'utf8').trim();
const sql = (q) => fetch(`${U}/rest/v1/rpc/admin_sql`, { method: 'POST', headers: { apikey: K, Authorization: `Bearer ${K}`, 'content-type': 'application/json' }, body: JSON.stringify({ q }) }).then(async (r) => { if (!r.ok) throw new Error(await r.text()); });
(async () => {
  await sql(`
    delete from reactions where true; delete from training_sessions where true; delete from jobs where true;
    delete from rules where coalesce(from_version, 1) > 1;
    update rules set status = 'active', to_version = null where status = 'retired';
    delete from thinking_versions where version > 1;
    delete from checkin_drafts where true; delete from sf_edits where true;
    delete from events where source_kind = 'checkin';
    delete from promises where true;
    delete from transcripts where kind = 'checkin';
    update transcripts set extraction = extraction - 'promises_made' - 'promises_checked' where kind = 'review' and extraction ? 'promises_made';
    update deals set client = null where client is not null;
    update cards set status = 'dismissed' where status = 'live';`);
  // Promises as the coaching brain found them in the 18 reviews
  const reviews = await rest.select('transcripts', 'kind=eq.review&select=id,date,people');
  const P = JSON.parse(fs.readFileSync('out/profiles.json', 'utf8'));
  const madeIn = (person, date) => (reviews.find((t) => t.date === date && (t.people || []).includes(person)) || {}).id || null;
  const rows = P.profiles.flatMap((p) => (p.promises || []).map((x) => ({ made_on: x.made_on, made_in: madeIn(p.person, x.made_on), by_person: p.person, promise: x.promise, status: x.status, checked_on: x.next_raised_on || null, evidence: x.evidence })));
  await insertBatched('promises', rows);
  const count = async (t, q = '') => (await rest.select(t, `select=id${q}`)).length;
  console.log({ rules: await count('rules', '&status=eq.active'), versions: await count('thinking_versions'), promises: await count('promises'), checkins: await count('transcripts', '&kind=eq.checkin'), events: await count('events') });
})().catch((e) => { console.error(e); process.exit(1); });
