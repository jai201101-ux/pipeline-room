# Pipeline Room

Cuts the VP's time in the weekly pipeline review. Reps check in by voice before the meeting. Two separate brains read everything. The VP gets five things, filtered by rules he sets by voice.

## Who does what

| Who | In the app |
|---|---|
| **Rep** | Taps **Check in** and talks for three minutes. Reviews "Here's what I heard", unticks anything wrong, taps **Send to Mark**. Sees their next check-in list update. |
| **VP** | Opens **Today**: at most 5 cards (Decide, Ask in the meeting, Coach). **Why?** shows the evidence. Taps the action, or Useful / Not useful. **Brief me** reads it aloud in 90 seconds. |
| **VP, training** | **Talk to the Analyst** (deal brain) or **the Mentor** (coaching brain). Each plays every rule back and confirms. At the end it asks "Shall I deploy this?" Yes deploys a new version of the thinking model across the app. |
| **Admin** | Loads the Salesforce export and review recordings, and adds logins. |

## The voice agents

| Agent | Talks to | Does |
|---|---|---|
| Check-in | Rep | Listens first, asks only about listed deals the rep skipped, checks last week's promises. |
| Briefer | VP | Reads Today in 90 seconds, answers "why". |
| Analyst | VP | Turns what matters into deal rules. Validates, never argues. |
| Mentor | VP | Turns what good looks like into coaching rules. Validates, never argues. |

## What is in this repo

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css`, `config.js` | The website (GitHub Pages). Works on a phone and a laptop. |
| `brain/steps.js` | Every brain request and every check: word budgets, numbers traced to facts, quotes found word for word. |
| `server/build_brains.js` | Builds the n8n workflow: check-in ended, rep sends, rebuild Today, training ended, deploy, trainer brief. |
| `db/` | Tables, row security, and the database functions the server and app call. |
| `voice/` | The four agents' scripts. |
| `CONTRACT.md` | The ontology: eight objects, who writes each, word and screen budgets. |

No customer data and no secret keys are here. The key in `config.js` is the public one; row security decides what each login sees, and the server checks each person's login token.

Stack: n8n (server), Claude (brains), ElevenLabs (voice), Supabase (memory and logins).
