# Pipeline Room contract

The one place that says what each thing is, who writes it, and how much it may say.
Change this file first, then the code.

## The eight objects

| Object | What it is | Written by | Read by |
|---|---|---|---|
| Review | One weekly meeting: date, export used, check-in window | Admin | Everything |
| Deal | A Salesforce row, plus the client name once a rep says it | Export upload, scribe (name only) | Both brains, screens |
| Person | A rep, the VP, an admin | Admin | Everything |
| Fact | One dated thing that was said or changed, with its source | Scribe, export upload | Both brains |
| Promise | Someone will do something by a date. Open until closed | Scribe opens; scribe or VP closes | Coaching brain, screens |
| Rule | One line of a brain's lens | A person tapping Adopt | That brain only |
| Card | One thing on a screen, with one action | That brain | Screens |
| Reaction | A person's response to a card: useful, not useful, done | VP | That brain |

## The two brains

| | Deal brain | Coaching brain |
|---|---|---|
| Reads | Deals, facts about deals, its rules | Facts about people, transcripts, its rules |
| Never reads | The coaching brain's anything | The deal brain's anything |
| Coached by | VP, CEO | VP |
| Writes | Deal cards, each rep's check-in list | People cards, one profile per person |

## How a brain learns

1. **Data teaches beliefs.** New exports and transcripts update what a brain knows. Automatic. Shown as "learned from data on [date]".
2. **People set rules.** A person talks to a brain. The brain proposes one rule and shows what it would change. Nothing changes until a person taps Adopt.
3. **Reactions suggest rules.** Repeated "not useful" with the same reason makes the brain propose a rule. A person still adopts it.

A brain never changes its own rules.

## The thinking model

Mark's thinking model is the two sets of rules together: deal rules (deal brain) and coaching rules (coaching brain). Every agent's output passes through it before anyone sees it: the check-in caller's questions, the Briefer, Today's cards, the coaching cards.

## Training a brain by voice

Two trainers, one per brain. They validate, they do not argue.

| Trainer | Trains | Personality |
|---|---|---|
| The Analyst | Deal rules | Precise, calm, reflects back in numbers |
| The Mentor | Coaching rules | Warm, curious, reflects back in plain words |

During a session, for each idea:
1. Listen. Mark says it in his own words.
2. Play it back: "So you mean ... Is that right?"
3. Show the effect on screen: what would change, and how much evidence sits behind it (a quiet tag, not an argument).
4. If it conflicts with an existing rule, ask which one wins. Never decide alone.

At the end of every session:
1. The trainer summarises everything Mark said, as the rules it would become.
2. It asks: "Deploy this across the app?" The screen shows the summary and what each agent will do differently.
3. Only when Mark taps Deploy does a new version of the thinking model go live. Every agent picks it up on its next run: the deal brain rebuilds lists and cards, the check-in caller gets new briefs, the Briefer re-reads.
4. Every version is kept, so Mark can see what changed and roll back.

## Where it runs

A website that works on a phone and a laptop. Phone: one column. Laptop: cards on the left, the "since last review" summary and the trainers on the right.

## Word and screen budgets (enforced in code)

- Card headline: 8 words or fewer.
- Card body: 20 words or fewer. One number that matters. One action.
- Reasoning and evidence: behind "Why?", 60 words or fewer, every line dated and sourced.
- Today: 5 cards or fewer, in three groups: Decide, Ask, Coach.
- Deals are named "Client · $size" once known, never by code on the main screen.
- Nothing is shown unless it works. No disabled buttons.

## Card kinds

| Kind | Means | Example action |
|---|---|---|
| Decide | Only the VP can do this | Approve, Draft email |
| Ask | A question for a rep in the meeting | Add to agenda |
| Coach | One behaviour to work on with one person | Plan 1:1 |
