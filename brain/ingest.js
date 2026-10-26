// Turns Salesforce export rows (one row per product line) into one record per deal.
// Plain JS with no libraries, so the same file runs in an n8n Code node and locally.
// Rules match the corrected May review: count each Opportunity ID once, value = sum of
// "Total Price (converted)", won and lost dates only from the 7W and 7L stage dates,
// and bulk clean-up days (50+ lost in a day, 75%+ reason Unknown) flagged.

const DAY = 86400000;

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(Math.round((Math.floor(v) - 25569) * DAY));
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(Date.UTC(y, +m[2] - 1, +m[1])); }
  const d = new Date(s);
  return isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function productFamily(name) {
  const s = String(name || '').toLowerCase();
  if (s.startsWith('notetaker')) return 'Notetaker';
  if (s.startsWith('sourcing')) return 'Sourcing';
  if (s.startsWith('reports')) return 'Reports';
  if (s.startsWith('application review') || s.startsWith('app review')) return 'Application Review';
  if (s.startsWith('job post')) return 'Job Posts';
  return s ? 'Other' : null;
}

function ingest(rows) {
  const byId = new Map();
  for (const r of rows) {
    const id = r['Opportunity ID'];
    if (!id) continue;
    let d = byId.get(id);
    if (!d) {
      d = {
        id,
        ref: String(id).slice(-6),
        owner: r['Opportunity Owner'] || 'Unknown',
        role: r['Owner Role'] || '',
        type: r['Type'] || null,
        stage: String(r['Stage'] || '').replace(/^Closed Lost$/, '7L - Closed Lost'),
        prob: num(r['Probability (%)']),
        created: toDate(r['Created Date']),
        close: toDate(r['Close Date']),
        won: toDate(r['Stage 7W Entered Date']),
        lost: toDate(r['Stage 7L Entered Date']),
        stageDates: [1, 2, 3, 4, 5, 6].map((i) => toDate(r[`Stage ${i} Entered Date`])),
        source: r['Attribution'] || null,
        lostReason: r['Closed Lost Reason'] || null,
        lostDetail: r['Closed Lost Reason Detail'] || null,
        wonReason: r['Closed Won Reason'] || r['Closed Won Reasons'] || null,
        value: 0,
        products: new Set(),
        families: new Set(),
      };
      byId.set(id, d);
    }
    d.value += num(r['Total Price (converted)']) || 0;
    if (r['Product Name']) { d.products.add(r['Product Name']); d.families.add(productFamily(r['Product Name'])); }
  }

  const deals = [...byId.values()];
  for (const d of deals) {
    if (!d.value) d.value = null;
    if (d.prob !== null && d.prob > 1) d.prob = d.prob / 100;
    d.status = d.stage.startsWith('7W') ? 'won' : d.stage.startsWith('7L') ? 'lost' : 'open';
    d.segment = (d.role.match(/(SMB|MM|ENT)/) || [])[1] || 'Other';
    d.region = (d.role.match(/^(EMEA|AMER)/) || [])[1] || 'Other';
    d.isAE = /\bAE\b/.test(d.role);
    d.stageNum = parseInt(d.stage, 10) || null;
    d.stageName = d.stage.replace(/^\d+[A-Z]?\s*-\s*/, '').trim();
    const sd = d.stageDates.filter(Boolean);
    d.enteredStage = sd.length ? new Date(Math.max(...sd)) : null;
    d.products = [...d.products];
    d.families = [...d.families].filter(Boolean);
  }

  // Bulk clean-up days
  const byDay = {};
  for (const d of deals) if (d.status === 'lost' && d.lost) {
    const k = +d.lost; (byDay[k] ||= { n: 0, u: 0 }); byDay[k].n++; if (d.lostReason === 'Unknown') byDay[k].u++;
  }
  const bulkDays = Object.entries(byDay).filter(([, v]) => v.n >= 50 && v.u / v.n >= 0.75).map(([k]) => +k);
  const bulkSet = new Set(bulkDays);
  for (const d of deals) d.bulk = d.status === 'lost' && !!d.lost && bulkSet.has(+d.lost);

  // "Today" is the latest date in the export
  const all = deals.flatMap((d) => [d.won, d.lost, d.enteredStage]).filter(Boolean);
  const today = new Date(Math.max(...all));
  return { deals, today, bulkDays: bulkDays.map((k) => new Date(k)) };
}

module.exports = { ingest, toDate, num, DAY };
