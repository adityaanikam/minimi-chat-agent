# Design

## How it works

```
message ─► recall (SQLite, no model call) ─► model ─► web_search × N in parallel ─► model ─► streamed answer
                │                                                                          │
                └── dates + topic words find earlier exchanges          answer + evidence saved with timestamps
```

1. **Recall happens before the model runs.**
   - `chrono-node` turns "on 3 November", "last Tuesday" or "on Monday" into day windows in the user's timezone.
   - Words in the message pick the matching exchanges inside those windows. For "you said earlier…" with no date, SQLite full-text search covers both questions and answers.
   - The result goes into the system prompt as a dated MEMORY block, including days that had no conversation, so the model says "nothing on 5 Nov" instead of making something up.
2. **One tool, `web_search`** (Tavily), called once per turn but as many times as needed *within* that one step, concurrently. "Did any of my 5 CRM tools change pricing?" becomes 5 searches at once, not 5 round trips. An optional `since` date limits results to pages published after a date.
   - **One search step, then answer.** Every extra round re-sends all evidence gathered so far, so the same five searches cost about 5k tokens in one step and about 15k spread over four. A second step exists only for when the first found nothing usable. Depth comes from breadth in one step, not from drilling in series.
   - **The step has an evidence budget** (`budgetFor`): one search reads 6 results at 600 characters, a five-way comparison reads 3 at 380. The turn stays inside a free tier's 8k tokens a minute either way.
   - **Dates are stripped from queries** (`cleanQuery`). Models paste "now" into the query, and a literal `2026-11-16` is the worst possible keyword: asked for the latest Node LTS with the date glued on, the engine returned a horoscope for that week, three times running, and the model then answered from it. Dates belong in `since`, and the code enforces that rather than asking politely.
3. **Every answer is stored with its evidence:** URLs, titles, publish dates, the snippet the answer was based on, and when it was fetched. "Has pricing changed since Tuesday?" is then a comparison of Tuesday's evidence with today's search, not a guess about what was said.
4. **Streaming everywhere.** Server-Sent Events carry tokens, "searched: …" chips and sources. The UI shows time to first words.
5. **Three guards on the way out**, because the failure modes that matter are silent ones:
   - **Dangling citations.** A `[7]` when six results came back means the answer left its evidence. Both bracket styles are checked, since gpt-oss sometimes emits its training-time `【7†L1-L4】` form. The user is told which claim is unverified rather than shown a convincing footnote.
   - **A blank answer never ships.** If a turn gathers evidence and then produces no text, because the token budget went on tool calls and reasoning, one final call with no tools has to answer from what was found.
   - **A downgrade is never silent.** If the primary model is rate-limited for longer than five seconds, the turn falls back to a smaller one and says so in the transcript.

## Why this way

- **Memory is architecture, not a second tool.** The brief allows one tool. Recall by date is also deterministic, so a model call to decide "should I look in memory?" would only add latency and a way to fail. Resolving dates in code means it can be unit tested (`npm test`). The tests cover "last Tuesday" on a Wednesday, a day with no conversation, and the CRM shortlist from Monday.
- **Ambiguity is settled by data.** On Wednesday 11 Nov, "last Tuesday" could mean 10 Nov or 3 Nov. Both days are checked and the one whose conversation matches the topic wins.
- **No agent framework.** The loop is about 60 lines (`agent.ts`) over any OpenAI-compatible endpoint (`llm.ts`). Groq, OpenAI and Anthropic's compatibility endpoint work by changing `LLM_BASE_URL`. I can explain every request it sends.
- **Nothing to compile.** Node ≥ 22.18 runs TypeScript directly and `node:sqlite` is built in. `npm install` fetches one runtime package (`chrono-node`), so there is no native build to break on a reviewer's machine.
- **The prompt asks for behaviour, not personality:** search anything that can change, answer first, cite with dates, say what could not be verified, and never invent a past conversation.

## Considered and rejected

- **A `recall_memory` tool:** an extra round trip on exactly the questions where the user is waiting for "what did I say".
- **Embedding the memory:** questions about the past are anchored by dates and product names, where SQLite full-text search is exact and instant. It is worth revisiting once the history is long.
- **LangChain / AI SDK:** less code to write, but more code I could not fully explain. The tool-call streaming they handle is 30 lines here.
- **Fetching full pages after search:** better recall on pricing pages, but +2–5 s per answer. Tavily's excerpts were enough for most questions. See "another week".
- **Summarising old threads into a profile:** it loses the exact wording and dates that "what did I ask on 3 Nov" needs.

## With another week

- **Page fetch for changes.** When a re-check finds no dated news, fetch the pricing page itself and diff it against the stored snippet. That is how "pricing changed" gets proven rather than inferred.
- **An evaluation set** of 50 memory and freshness questions with a time-travel clock (`NOW_OVERRIDE`). Track accuracy, citations and first-token latency per change.
- **Multiple users:** a user id on every row (today it is one local user, by design).
- **Answer cache keyed by normalised question and day,** so repeated questions after an incident cost nothing.
- **A second search provider,** so a Tavily outage is a degradation rather than a stop. The model fallback is in; the search fallback is not.
- **A planning call before the search step.** Today the model decides its searches while holding the whole conversation in context. A cheap first call that only lists the searches needed would make the fan-out reliable on small models, instead of nudging a model that has already searched for one thing.

## What I know is weak

- **The free tier is the binding constraint, not the design.** Groq allows 8k tokens a minute, and one comparison question costs 5-6k. Two questions in a minute will downgrade the model. On a paid key, `MAX_ROUNDS` and the evidence budget could both go up, and the honest version of this agent is one that reads its own limits from the provider's headers rather than having them written into constants.
- **Small models batch badly.** `gpt-oss-20b` searches one item at a time whatever the prompt says. The round-budget nudge helps and the planning call above would fix it properly.
- **The seeded history is real answers under a backdated clock,** so "evidence then" is today's web stamped with an earlier date. Good enough to demonstrate recall, not a true record of what the web said that day.
