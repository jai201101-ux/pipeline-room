// Local runner for the Coaching Brain: recordings -> lens -> one profile per person -> VP people cards.
// node brain/run_coach.js <txtDir> <jsonDir> out/
const fs = require('fs');
const path = require('path');
const T = require('./transcripts');
const C = require('./coach_brain');
const { ledger } = require('./model');

const [txtDir = '../mv/calls/txt', jsonDir = '../mv/calls/json', outDir = 'out'] = process.argv.slice(2);
const save = (f, x) => fs.writeFileSync(path.join(outDir, f), typeof x === 'string' ? x : JSON.stringify(x, null, 1));

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

(async () => {
  const t0 = Date.now();
  const meetings = T.loadMeetings(txtDir, jsonDir);
  const people = T.people(meetings);
  console.log(`meetings ${meetings.length}, people ${Object.keys(people).length}`);

  console.log('1. coaching lens');
  const lens = await C.writeLens(meetings);
  save('coach_lens_v1.md', lens);

  console.log('2. profiles');
  const names = Object.keys(people).filter((n) => people[n].length >= 2).sort();
  const profiles = await pool(names, 4, async (name) => {
    const apps = people[name];
    try {
      let p = await C.profile(name, apps, meetings, lens);
      if (C.missing(p).length) { console.log(`  ${name}: missing ${C.missing(p).join(', ')}, completing`); p = await C.completeProfile(name, p, apps, meetings); }
      let bad = C.checkQuotes(C.profileQuotes(p), apps, meetings);
      for (let i = 0; i < 2 && bad.length; i++) {
        console.log(`  ${name}: ${bad.length} quote(s) not found, fixing`);
        p = await C.fixProfile(name, p, bad, apps, meetings);
        bad = C.checkQuotes(C.profileQuotes(p), apps, meetings);
      }
      // Anything still unverified is removed, never shown
      if (bad.length) for (const o of [...(p.strengths || []), ...(p.patterns || [])]) o.evidence = (o.evidence || []).filter((e) => !C.checkQuotes([e], apps, meetings).length);
      p.strengths = (p.strengths || []).filter((o) => o.evidence.length); p.patterns = (p.patterns || []).filter((o) => o.evidence.length);
      p.reviews = apps.map((a) => a.date);
      console.log(`  ${name}: ${p.strengths.length} strengths, ${p.patterns.length} patterns, ${(p.promises || []).length} promises${bad.length ? `, ${bad.length} quotes dropped` : ''}`);
      return p;
    } catch (e) { console.log(`  ${name}: FAILED ${e.message}`); return { person: name, error: e.message }; }
  });
  const thin = Object.keys(people).filter((n) => people[n].length < 2).map((n) => ({ person: n, reviews: people[n].map((a) => a.date), note: 'Only one review on file. Too little to see a pattern.' }));
  save('profiles.json', { profiles, thin });

  console.log('3. VP people cards: draft, cut, verify');
  const ok = profiles.filter((p) => !p.error);
  const drafts = await C.peopleCards(ok, lens);
  save('people_cards_draft.json', drafts);
  const cut = await C.cutCards(drafts);
  for (const c of cut.keep) c.evidence = (c.evidence || []).filter((e) => { const b = C.checkQuotes([e], people[c.person], meetings); if (b.length) console.log('  dropped card quote:', b[0]); return !b.length; });
  save('people_cards.json', cut);

  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s · ${ledger.calls} calls · ${ledger.in.toLocaleString()} tokens in · ${ledger.out.toLocaleString()} out`);
})().catch((e) => { console.error(e); process.exit(1); });
