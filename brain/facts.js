// Builds the evidence the deal brain reasons over. Every number the brain may use is a
// "fact" with an id, so every line it writes can be traced and checked.
// No judgement here: only counts, rates and values. The judgement is the brain's job.

const { DAY } = require('./ingest');

const BANDS = [
  { key: 'u10k', label: 'Under $10k', lo: 0, hi: 10000 },
  { key: '10-25k', label: '$10k to $25k', lo: 10000, hi: 25000 },
  { key: '25-50k', label: '$25k to $50k', lo: 25000, hi: 50000 },
  { key: '50-100k', label: '$50k to $100k', lo: 50000, hi: 100000 },
  { key: '100k+', label: 'Over $100k', lo: 100000, hi: Infinity },
];
const band = (v) => (v === null ? null : BANDS.find((b) => v >= b.lo && v < b.hi).key);
const bandLabel = (k) => (BANDS.find((b) => b.key === k) || {}).label || k;
const SEG = { SMB: 'SMB', MM: 'mid-market', ENT: 'enterprise' };
const mStart = (y, m) => new Date(Date.UTC(y, m, 1));
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
const r2 = (x) => Math.round(x * 100) / 100;
const slug = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function buildFacts(deals, today) {
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  const winStart = mStart(y, m - 5), winEnd = new Date(mStart(y, m) - DAY);
  const monthStart = mStart(y, m), monthEnd = new Date(mStart(y, m + 1) - DAY);
  const nextEnd = new Date(mStart(y, m + 2) - DAY);

  const ae = deals.filter((d) => d.isAE);
  for (const d of ae) d.band = band(d.value);
  const closed = ae.filter((d) => {
    if (d.status === 'won') return d.won >= winStart && d.won <= winEnd;
    if (d.status === 'lost') return !d.bulk && d.lost >= winStart && d.lost <= winEnd;
    return false;
  });

  const facts = {};
  const add = (id, label, group) => {
    const n = group.length, won = group.filter((d) => d.status === 'won');
    facts[id] = { id, label, n, won: won.length, winRate: n ? r2(won.length / n) : null, wonValue: Math.round(won.reduce((t, d) => t + (d.value || 0), 0)) };
    return facts[id];
  };
  const groupBy = (arr, keyFn) => { const g = {}; for (const d of arr) { const k = keyFn(d); if (k === null || k === undefined) continue; (g[k] ||= []).push(d); } return g; };

  const overall = add('F:all', `All AE deals closed ${iso(winStart)} to ${iso(winEnd)}`, closed);
  for (const [k, g] of Object.entries(groupBy(closed, (d) => `${d.segment}|${d.region}`))) { const [s, r] = k.split('|'); add(`F:team:${s}-${r}`, `${SEG[s] || s} ${r}`, g); }
  for (const [k, g] of Object.entries(groupBy(closed, (d) => d.band))) add(`F:band:${k}`, bandLabel(k), g);
  for (const [k, g] of Object.entries(groupBy(closed, (d) => (d.band ? `${d.segment}|${d.band}` : null)))) { const [s, b] = k.split('|'); add(`F:segband:${s}-${b}`, `${SEG[s] || s}, ${bandLabel(b)}`, g); }
  for (const [k, g] of Object.entries(groupBy(closed, (d) => (d.band ? `${d.segment}|${d.region}|${d.band}` : null)))) { const [s, r, b] = k.split('|'); add(`F:cell:${s}-${r}-${b}`, `${SEG[s] || s} ${r}, ${bandLabel(b)}`, g); }
  for (const [k, g] of Object.entries(groupBy(closed, (d) => d.type))) add(`F:type:${slug(k)}`, `Deal type: ${k}`, g);
  for (const [k, g] of Object.entries(groupBy(closed, (d) => d.source))) add(`F:source:${slug(k)}`, `Source: ${k}`, g);
  // Products are only recorded on some deals, and far more often on won deals than lost ones,
  // so a product "win rate" would be fake. Products only describe what won deals contain.
  const wonWithProducts = closed.filter((d) => d.status === 'won' && d.families.length);
  for (const fam of ['Notetaker', 'Sourcing', 'Reports', 'Application Review', 'Job Posts']) {
    const g = wonWithProducts.filter((d) => d.families.includes(fam));
    facts[`F:product-mix:${slug(fam)}`] = { id: `F:product-mix:${slug(fam)}`, label: `Won deals that include ${fam} (of ${wonWithProducts.length} won deals with products recorded)`, n: g.length, won: g.length, winRate: null, wonValue: Math.round(g.reduce((t, d) => t + (d.value || 0), 0)) };
  }
  const cover = (st) => { const g = ae.filter((d) => d.status === st && !d.bulk); return g.length ? Math.round((100 * g.filter((d) => d.families.length).length) / g.length) : 0; };
  const lostInWindow = closed.filter((d) => d.status === 'lost');
  const unknownLoss = lostInWindow.filter((d) => !d.lostReason || d.lostReason === 'Unknown').length;
  const wonAll = ae.filter((d) => d.status === 'won' && d.created && d.won).length;
  const createdAfterWon = ae.filter((d) => d.status === 'won' && d.created && d.won && d.created > d.won).length;
  const dataQuality = [
    `Products are recorded on ${cover('won')}% of won AE deals, ${cover('lost')}% of lost and ${cover('open')}% of open. Product win rates cannot be measured. Use products only to describe what won deals contain.`,
    `${unknownLoss} of ${lostInWindow.length} real losses in the window have no loss reason or "Unknown".`,
    `Most recorded win reasons say no pre-close activity was found, so win reasons say little about why deals are won.`,
    `${createdAfterWon} of ${wonAll} won AE deals have a created date after their won date, so deal age from creation cannot be used. Stage entry dates are present on every open deal.`,
  ];
  // Monthly win rate per team, to spot movement
  const months = [];
  for (let i = 5; i >= 1; i--) months.push(mStart(y, m - i));
  for (const ms of months) {
    const me = new Date(mStart(ms.getUTCFullYear(), ms.getUTCMonth() + 1) - DAY);
    const inM = closed.filter((d) => { const e = d.won || d.lost; return e >= ms && e <= me; });
    const label = ms.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
    add(`F:month:${iso(ms).slice(0, 7)}`, `All AE deals closed in ${label}`, inM);
    for (const [k, g] of Object.entries(groupBy(inM, (d) => `${d.segment}|${d.region}`))) { const [s, r] = k.split('|'); add(`F:month:${iso(ms).slice(0, 7)}:${s}-${r}`, `${SEG[s] || s} ${r}, ${label}`, g); }
  }
  // Why deals are lost (real losses only) and won
  const reasons = (arr, field) => Object.entries(groupBy(arr.filter((d) => d[field]), (d) => d[field])).map(([k, g]) => ({ reason: k, n: g.length })).sort((a, b) => b.n - a.n).slice(0, 8);
  const lostReasons = reasons(closed.filter((d) => d.status === 'lost'), 'lostReason');
  const wonReasons = reasons(closed.filter((d) => d.status === 'won'), 'wonReason');

  // Score cell for an open deal: most specific group with enough history
  const cellFor = (d) => {
    const tries = [[`F:cell:${d.segment}-${d.region}-${d.band}`, 20], [`F:segband:${d.segment}-${d.band}`, 20], [`F:team:${d.segment}-${d.region}`, 20], ['F:all', 0]];
    for (const [id, min] of tries) if (facts[id] && facts[id].n >= min) return facts[id];
    return overall;
  };

  // Stage medians for open AE deals, to spot stuck deals
  const open = ae.filter((d) => d.status === 'open');
  for (const d of open) d.daysInStage = d.enteredStage ? Math.max(0, Math.round((today - d.enteredStage) / DAY)) : null;
  const medians = {};
  for (const [k, g] of Object.entries(groupBy(open.filter((d) => d.daysInStage !== null), (d) => d.stageNum))) {
    const v = g.map((d) => d.daysInStage).sort((a, b) => a - b);
    medians[k] = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  }

  // Open deals the brain can look at: due this month (or overdue) and next month
  const live = open.filter((d) => d.close && d.close <= nextEnd).map((d) => {
    const cell = cellFor(d);
    const wr = cell.winRate;
    const gap = d.prob !== null && wr !== null ? r2(d.prob - wr) : null;
    let fit = 'neutral';
    const thin = !d.band || (d.band === '100k+' && (facts['F:band:100k+'] || { n: 0 }).n < 15) || cell.n < 15;
    if (thin) fit = 'thin-history';
    else if (wr >= overall.winRate + 0.05) fit = 'strong-fit';
    else if (wr <= overall.winRate - 0.05) fit = 'weak-fit';
    return {
      id: d.id, ref: d.ref, owner: d.owner, segment: d.segment, region: d.region, value: d.value, band: d.band,
      stage: d.stageName, stageNum: d.stageNum, salesforceProb: d.prob, close: iso(d.close),
      horizon: d.close < monthStart ? 'overdue' : d.close <= monthEnd ? 'this-month' : 'next-month',
      daysInStage: d.daysInStage, medianDaysInStage: medians[d.stageNum] ?? null,
      stuck: d.daysInStage !== null && medians[d.stageNum] ? d.daysInStage > 1.5 * medians[d.stageNum] : false,
      source: d.source, type: d.type, products: d.families,
      historyFact: cell.id, historyWinRate: wr, historyN: cell.n, gapVsHistory: gap, fit,
      expectedValue: d.value !== null && wr !== null ? Math.round(d.value * wr) : null,
    };
  });

  // Per rep: track record and this month so far
  const target = (seg) => (seg === 'ENT' ? 125000 : 100000);
  const reps = {};
  for (const [owner, g] of Object.entries(groupBy(ae, (d) => d.owner))) {
    const c = closed.filter((d) => d.owner === owner);
    const seg = g[0].segment, reg = g[0].region;
    const wonMonth = g.filter((d) => d.status === 'won' && d.won >= monthStart && d.won <= today);
    const byBand = {};
    for (const [b, gb] of Object.entries(groupBy(c, (d) => d.band))) if (gb.length >= 8) byBand[b] = { n: gb.length, winRate: r2(gb.filter((d) => d.status === 'won').length / gb.length) };
    const myLive = live.filter((d) => d.owner === owner);
    reps[owner] = {
      owner, segment: seg, region: reg, monthlyTarget: target(seg),
      closedInWindow: c.length, winRateInWindow: c.length ? r2(c.filter((d) => d.status === 'won').length / c.length) : null,
      teamWinRate: (facts[`F:team:${seg}-${reg}`] || {}).winRate ?? null,
      winRateByBand: byBand,
      wonThisMonth: Math.round(wonMonth.reduce((t, d) => t + (d.value || 0), 0)), wonThisMonthDeals: wonMonth.length,
      liveDeals: myLive.length, liveValue: Math.round(myLive.reduce((t, d) => t + (d.value || 0), 0)),
    };
  }

  return {
    asOf: iso(today), window: { from: iso(winStart), to: iso(winEnd) },
    thisMonth: { from: iso(monthStart), to: iso(monthEnd) }, nextMonthEnd: iso(nextEnd),
    facts, dataQuality, lostReasons, wonReasons, stageMedianDays: medians, live, reps,
  };
}

module.exports = { buildFacts, BANDS, band, bandLabel };
