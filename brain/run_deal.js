// Local runner for the Deal Brain: export rows -> facts -> lens -> rep lists -> VP deal cards.
// node brain/run_deal.js data/rows.json out/
const fs = require('fs');
const path = require('path');
const { ingest } = require('./ingest');
const { buildFacts } = require('./facts');
const B = require('./deal_brain');
const { json, ledger } = require('./model');

const [rowsPath = 'data/rows.json', outDir = 'out'] = process.argv.slice(2);
const save = (f, x) => fs.writeFileSync(path.join(outDir, f), typeof x === 'string' ? x : JSON.stringify(x, null, 1));

async function checked(label, produce, F, isJson, schema = null) {
  let text = await produce();
  for (let i = 0; i < 2; i++) {
    const body = isJson ? JSON.stringify(text) : text;
    const problems = B.verify(body, F);
    if (!problems.length) return { value: text, problems: [] };
    console.log(`  ${label}: ${problems.length} problem(s), fixing: ${problems.slice(0, 4).join('; ')}`);
    const fixed = await B.fixText(body, problems, F, {}, schema);
    if (schema) text = schema === B.CARDS_SCHEMA ? fixed.cards : fixed;
    else { try { text = isJson ? json(fixed) : fixed; } catch (e) { console.log(`  ${label}: fix was not valid JSON, keeping previous`); break; } }
  }
  return { value: text, problems: B.verify(isJson ? JSON.stringify(text) : text, F) };
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

(async () => {
  const t0 = Date.now();
  const { deals, today } = ingest(JSON.parse(fs.readFileSync(rowsPath, 'utf8')));
  const F = buildFacts(deals, today);
  save('facts.json', F);
  console.log(`facts: ${Object.keys(F.facts).length}, live deals: ${F.live.length}, reps: ${Object.keys(F.reps).length}`);

  console.log('1. lens');
  const lens = await checked('lens', () => B.writeLens(F), F, false);
  save('lens_v1.md', lens.value);

  console.log('2. rep lists');
  const owners = Object.keys(F.reps).filter((o) => F.reps[o].liveDeals > 0).sort();
  const lists = await pool(owners, 5, async (o) => {
    let r;
    try { r = await checked(o, () => B.repList(F, lens.value, o), F, true, B.LIST_SCHEMA); } catch (e) { console.log(`  ${o}: FAILED ${e.message}`); return { rep: o, month: '', listen_for: [], not_asking: '', unsure: '', error: e.message }; }
    r.value.listen_for = (r.value.listen_for || []).map((x) => ({ ...x, deal: F.live.find((d) => d.ref === x.ref) || null }));
    console.log(`  ${o}: ${r.value.listen_for.length} deals${r.problems.length ? ` (unresolved: ${r.problems.join('; ')})` : ''}`);
    return { ...r.value, unresolved: r.problems };
  });
  save('rep_lists.json', lists);

  console.log('3. VP deal cards: draft, cut, verify');
  const drafts = await B.teamCards(F, lens.value, lists);
  save('cards_draft.json', drafts);
  const cut = await B.cutCards(drafts);
  const kept = await checked('cards', async () => cut.keep, F, true, B.CARDS_SCHEMA);
  save('cards.json', { keep: kept.value, cut: cut.cut, unresolved: kept.problems });

  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s · ${ledger.calls} calls · ${ledger.in.toLocaleString()} tokens in · ${ledger.out.toLocaleString()} out`);
})().catch((e) => { console.error(e); process.exit(1); });
