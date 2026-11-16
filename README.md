# Chat agent with web search and dated memory

A chat agent with one tool, web search. It remembers every past conversation with its date, so you can ask "What did I ask you on 3 November? Is your answer still correct today?" See [DESIGN.md](DESIGN.md) for how it works and why.

## Run

Requires Node 22.18 or newer, which runs TypeScript without a build step.

```
npm install
cp .env.example .env        # add LLM_API_KEY and TAVILY_API_KEY
npm run dev                 # http://localhost:3000
```

Keys (two, both free):

- `LLM_API_KEY`: Groq by default (free at https://console.groq.com/keys). OpenAI or Anthropic also work: set `LLM_BASE_URL` and `LLM_MODEL` as shown in `.env.example`.
- `TAVILY_API_KEY`: https://app.tavily.com (1,000 free searches a month).

On a free Groq key the budget is 8,000 tokens a minute, shared across models, and one comparison
question costs 5-6k of it. The agent sizes its evidence to the quota Groq reports, falls back to a
smaller model, and waits out a short rate limit rather than failing, saying so each time. Two
questions in the same minute will therefore be slower or thinner, and the transcript will tell you
which. A paid key removes this.

## Try the memory

A fresh install has no history. `npm run seed` creates three real conversations dated in the past: 8 days ago, last Monday and last Tuesday. It runs the agent with the clock set back. Then ask:

- "What did I ask you 8 days ago? Is your answer still correct today?"
- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

`NOW_OVERRIDE` in `.env` moves the clock for testing.

## Test

```
npm test          # date resolution and recall, against a temporary database
npm run typecheck
```
