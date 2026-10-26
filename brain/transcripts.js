// Loads review meetings into a per-person store. Each meeting keeps its full raw text (speaker
// labels in these recordings are often wrong, so the brain reads whole meetings) plus the
// structured extraction made earlier, which acts as an index of who was reviewed.

const fs = require('fs');
const path = require('path');

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$%' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function loadMeetings(txtDir, jsonDir) {
  const meetings = [];
  for (const f of fs.readdirSync(jsonDir).filter((x) => x.endsWith('.json')).sort()) {
    const ex = JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8'));
    const txtPath = path.join(txtDir, f.replace(/\.json$/, '.txt'));
    if (!fs.existsSync(txtPath)) continue;
    const raw = fs.readFileSync(txtPath, 'utf8');
    meetings.push({ id: f.replace(/_1\.json$|\.json$/, ''), date: ex.date, team: ex.team, title: ex.meeting, runBy: ex.run_by, themes: ex.team_themes || [], reps: ex.reps || [], raw, rawNorm: norm(raw) });
  }
  return meetings;
}

// Canonical person name: drop the notes the extractor added in brackets
const canon = (name) => String(name).replace(/\s*\(.*\)\s*$/, '').trim();
const isRealName = (n) => !/^(Unnamed|Peter \(surname|Speaker)/i.test(n) && /^[A-Z][a-z]+ [A-Z]/.test(n);

function people(meetings) {
  const byPerson = {};
  for (const m of meetings) for (const r of m.reps) {
    const name = canon(r.rep);
    if (!isRealName(name)) continue;
    (byPerson[name] ||= []).push({ meeting: m.id, date: m.date, team: m.team, extraction: r });
  }
  return byPerson;
}

// Does a quote really appear in that meeting? Normalised match, tolerant of punctuation.
function quoteFound(meeting, quote) {
  const q = norm(quote);
  if (q.split(' ').length < 4) return false;
  if (meeting.rawNorm.includes(q)) return true;
  // allow a short gap the transcriber inserted: match the first and last six words
  const w = q.split(' ');
  if (w.length >= 12) return meeting.rawNorm.includes(w.slice(0, 6).join(' ')) && meeting.rawNorm.includes(w.slice(-6).join(' '));
  return false;
}

module.exports = { loadMeetings, people, quoteFound, norm, canon };
