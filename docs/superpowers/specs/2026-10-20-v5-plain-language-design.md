# Weigh v5: the 90-second read

Date: 2026-10-20. Status: plan, approved by Kyle to start ("switch from engineering to marketing"). Builder: Scout. Repo: weigh (hub pages under `src/hub/pages/`, styles in `web/`).

## Why

Every page on weigh.bartlettlabs.io is correct and nobody outside engineering can read it. The run page opens with "pass-all", "Wilson 95% intervals", "noise floor" and "saturated" before it says who won. A recruiter gives the page 90 seconds. A hiring manager gives it five minutes. A prospect gives it one scroll on a phone. v5 makes the first screen of every page a sentence a non-engineer can repeat, and keeps every number one click down for the engineer.

What stays: the editorial look (warm off-white, the big display headline, monospace numbers). The design database's suggestion (corporate blue, serif body) was a poor match and is rejected. v5 changes words, order and disclosure, not the brand.

## Who reads it, and what each needs in 90 seconds

| Reader | Question in their head | What the first screen must give them |
|---|---|---|
| Recruiter or HR screener | Does this person really do evals? | One plain sentence with a result, a date, "live", Kyle's name |
| Hiring manager or senior engineer | Is this rigorous or a toy? | Paired comparison, a noise floor, graders checked against human labels. One click down, never gone |
| Prospect (owner of a service business) | Would you catch my AI being wrong before my customers do? | The story in their words: "we changed the prompt, graded 27 real emails, 4 wrong decisions became 0" |
| Kyle | What do I queue, label or fix next? | The Dashboard artifact and the labels page. Operator tools stay technical |

## The rule: three layers on every page

1. **The sentence.** Who won, by how much, ship or not. Plain words. Above the fold, phone and desktop.
2. **The numbers, each with a meaning.** Every figure carries a one-line "so what" next to it. No bare percentages.
3. **The method.** Intervals, cache, reproduce commands, JSON. In a "For engineers" drawer, closed by default, open by URL hash so it can be linked.

A term appears in plain words first. The technical name sits beside it in a small mono tag for the engineer, with a tooltip. Never the other way round.

## Glossary: the words that replace the words on screen

| On screen today | On screen in v5 | Mono tag |
|---|---|---|
| baseline / candidate | current prompt / new prompt | v3 / v4 |
| pass-all rate | cases that passed every check | pass-all |
| noise floor | "The current prompt, run twice, moved 3.7 points. Anything smaller is not a real change." | noise |
| Wilson 95% interval | likely range | CI |
| saturated | every case passes, so this check can no longer tell prompts apart | saturated |
| judge | an AI grader we checked against human answers | judge |
| TPR / TNR | catches 100% of real failures / wrongly flags 35% of good answers | TPR, TNR |
| gate passed / failed | Ship it / Don't ship | gate |
| regression | a case that got worse | regression |
| prompt tokens | words sent to the model (what it costs) | prompt tokens |
| variant | version | variant |
| trace | the full record of one run | trace |
| unanswered | the grader gave no verdict, so it is left out | unanswered |
| INCOMPLETE / REFERRED / IN APPETITE | follow up with the broker / send to an underwriter / quote it | (same, from the product) |

## Page by page

### Landing (`/`)

Headline: **Watch an AI get graded.**
Lede: "Weigh runs a new prompt against the old one on real cases, grades every answer, and shows the result as it happens. Built by Kyle Bartlett."

Sections, in order:
1. **Latest verdict card.** The newest finished run as a story: "v4 beat v3. 27 of 27 decisions right, up from 23. Costs 3% more per case. Shipped." Link: watch the run.
2. **How it works, three steps.** Queue a run from the browser. Watch cases grade themselves live from an always-on machine. Read the verdict and open any case to see what the model said. Three small line icons, no stock art.
3. **Why it matters, one paragraph for prospects.** An AI that reads emails and makes decisions will be wrong sometimes. The question is whether you find out first. This is how.
4. **Trust strip.** Last run date, number of cases, "graders checked against 54 human labels", link to the public code.
5. **Two buttons.** Watch a run (primary). Talk to Kyle (secondary, mailto).

### Project page (`/p/<id>`)

Plain description, then a **version timeline** as a story: v1 plain prompt, v2 canonical construction classes (what moved), v3 caught an invented value in production, v4 fixed the four bare-masonry follow-ups. One number per step. Runs list below it with the sentence from each run's verdict card instead of raw status.

### Run page (`/r/<suite>/<run>`)

1. **Verdict card** replaces the headline and the two gate boxes: one sentence, Ship it / Don't ship, three numbers with meanings (decisions right, cases passing everything, cost per case), and the noise sentence in small text.
2. **What changed, in words.** "4 cases fixed. 0 cases broke." Each fixed or broken case is a link.
3. **Live state while running** (already streams): a progress sentence, "Grading case 41 of 135, about 6 minutes left", and case rows appearing as they land. Count-up on the verdict numbers when the run finishes; respect reduced motion.
4. **What we grade** (was Checks): plain name per check ("The decision matches the expert's", "Construction type is the standard class"), then pass counts current vs new, then the one-line meaning. Mono id in a tag.
5. **Every case** (was Per-case ledger): rows with plain status words ("Passed everything", "Wrong decision", "Grader flagged a source"), the decision in product words, and a token delta. The dot matrix becomes a tooltip detail.
6. **Cost chart** keeps the paired dots and gains a one-line takeaway above it.
7. **Where runs fail** and **Method** move into the For engineers drawer with the reproduce commands.

### Case page (`/r/<suite>/<run>/c/<case>`)

"What the broker wrote" (input, as today). Then **what each version answered**, side by side, as a field table: field, expected, current, new, with the differing cells highlighted and a plain check result per field ("Joisted Masonry, matches the expert"). Raw JSON, tokens and latency in the drawer.

### Labels page

Kyle's tool. Stays technical. Only change: a one-line hotkey hint that reads as a sentence and a visible progress bar.

## Shareability (the marketing half)

- **OG image per run.** The verdict card rendered as a PNG at `/r/<suite>/<run>/og.png`, so a LinkedIn or email link shows the result, not a blank card. Rendered by the hub from the same summary code (Satori or a small headless capture; builder's call).
- **Copy summary** button on the run page: three plain lines on the clipboard for a post or a recruiter reply.
- **`/latest`** redirects to the newest finished run so the portfolio link never goes stale.
- **First-visit tour.** Four tooltips, 60 seconds, dismissible, remembered in localStorage: verdict, what changed, a case, the engineers drawer.
- **Portfolio link.** The portfolio card for Weigh points at `/latest` and reuses the OG image.

## Measurement

Add the staats tracker to the hub with four events: `verdict_viewed`, `case_opened`, `engineers_opened`, `copy_summary`. The question v5 answers in two weeks: do visitors open a case (they understood the verdict and wanted proof) or bounce from the run page.

The human test before shipping each step: one non-engineer reads the first screen and says who won and why. If they cannot, the step is not done.

## Sequence and size

| Step | What | Size |
|---|---|---|
| 1 | Glossary applied to the run page, verdict card, "what changed", plain check names, engineers drawer | half a day |
| 2 | Landing rewrite: headline, latest verdict, how it works, trust strip, buttons | half a day |
| 3 | Case page field table with highlighted differences; JSON to the drawer | half a day |
| 4 | OG image, copy summary, `/latest`, first-visit tour | half a day |
| 5 | Project timeline, analytics events, phone pass at 390px | one day |

Step 1 is the whole payoff for a recruiter; ship it first and alone.

## Non-goals

- No restyle. Same palette, type and layout grid.
- No sign-in, no comments, no sharing beyond links and images.
- No charts added. One chart stays; everything else is words and tables.
- No dumbing down of the engineers drawer: every current number survives there.

## Left to the builder

Tooltip and drawer implementation (plain `<details>` is fine), the OG renderer, exact copy per check (draft from each check's description, then run the writing guardrails), and whether the version timeline is hand-written in the suite description or derived from prompt header comments.
