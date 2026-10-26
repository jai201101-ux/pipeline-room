# Pipeline Room

Prepares a sales VP for the weekly pipeline review. Reps check in by voice before the meeting. Two separate AI brains read everything, each through a lens people can coach:

- **Deal brain**: cold and numeric. Learns where the company wins from the Salesforce export, picks the deals each check-in must cover, and drafts the VP's deal cards.
- **Coaching brain**: reads people, not deals. Every review and check-in, per person, over time. Strengths, patterns, promises kept and broken, and one coaching move, each backed by a dated quote checked word for word against the recording.

The brains never read each other. A neutral scribe turns each check-in into dated facts, Salesforce edits for the VP to approve, and promises that are checked the following week.

## What is in this repo

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The app (GitHub Pages). Reads live from Supabase as the logged-in person. |
| `brain/` | Deal brain, coaching brain, scribe, and the code checks that verify every number and quote. |
| `db/schema.sql` | The memory: tables and row security (a rep sees only their own data). |
| `voice/checkin_prompt.md` | The check-in agent's script (ElevenLabs). |

No customer data and no secret keys are stored here. The key in `config.js` is the public one; access is enforced by row security in the database.

Stack: n8n (harness), Claude (brains), ElevenLabs (voice), Supabase (memory and logins). The model layer goes through one adapter (`brain/model.js`) so it can run on an open-weight model inside a company's own infrastructure.
