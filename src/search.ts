// The agent's one tool. Tavily returns page text and (for news) publish dates in one call,
// so the model can answer from the results without a second "fetch the page" step.
import type { Source } from "./memory.ts";

export type SearchArgs = { query: string; since?: string; news?: boolean };

/**
 * How much evidence one search may return. Comparison questions fan out ("5 CRM tools" -> 5
 * searches), and six 700-character excerpts each would put ~6k tokens of page text into a single
 * turn, over the 8k tokens-a-minute a free Groq key allows. So the turn gets a fixed evidence
 * budget and the searches share it: one search reads deeply, six read shallowly.
 */
export type Budget = { maxResults: number; snippetChars: number };

const TURN_RESULT_BUDGET = 14;

export function budgetFor(parallelSearches: number, tokensLeft: number | null = null): Budget {
  let results = TURN_RESULT_BUDGET;
  let chars = parallelSearches > 2 ? 380 : 600;
  let floor = 3;

  // The provider says how many tokens are left this minute. Evidence is most of a turn's prompt,
  // so when the budget is nearly gone the choice is a thinner answer now or a rate-limit wait.
  // A thinner answer with honest citations is the better trade; the turn says what it could not read.
  if (tokensLeft !== null && tokensLeft < 6000) {
    const tight = tokensLeft < 3000;
    results = tight ? 4 : 8;
    chars = tight ? 260 : 340;
    if (tight) floor = 2;
  }

  const maxResults = Math.max(floor, Math.min(6, Math.floor(results / Math.max(1, parallelSearches))));
  return { maxResults, snippetChars: chars };
}

const cache = new Map<string, { at: number; results: Source[] }>();
const TTL_MS = 10 * 60_000; // a re-asked question within 10 minutes reuses results

export async function webSearch(args: SearchArgs, budget: Budget = { maxResults: 6, snippetChars: 600 }): Promise<Source[]> {
  const key = JSON.stringify([args, budget]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.results;

  const body: Record<string, unknown> = {
    query: args.query,
    max_results: budget.maxResults,
    search_depth: "basic",       // ~1 s; "advanced" doubles latency for a small recall gain
    topic: args.news ? "news" : "general",
    include_answer: false,       // we want evidence, not another model's summary
  };
  if (args.since && /^\d{4}-\d{2}-\d{2}$/.test(args.since)) body.start_date = args.since;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { results?: { title: string; url: string; content: string; published_date?: string }[] };
  const results: Source[] = (json.results ?? []).map((r) => ({
    url: r.url, title: r.title, published: r.published_date ?? null,
    snippet: (r.content ?? "").replace(/\s+/g, " ").slice(0, budget.snippetChars), query: args.query,
  }));
  cache.set(key, { at: Date.now(), results });
  return results;
}
