// One turn of the agent: context in, streamed answer out.
//
//   recall (no model call) -> model -> [web_search x N in parallel] -> model -> ... -> answer
//
// Memory is assembled *before* the model runs, from dates and words in the message, so the
// one tool the model has is web search and a "what did I ask on 3 November" question costs
// no extra round trip.
import { streamChat, tokensLeftThisMinute, type ChatMessage } from "./llm.ts";
import { recall, threadMessages, type Source } from "./memory.ts";
import { budgetFor, webSearch } from "./search.ts";
import { localDateLabel } from "./time.ts";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "search"; query: string; since?: string }
  | { type: "sources"; sources: (Source & { n: number })[] }
  | { type: "memory"; exchanges: number }
  | { type: "warning"; message: string }
  | { type: "error"; message: string };

// One search step, then answer, with a second step kept for the case where the first found nothing
// usable. Every extra round re-sends all the evidence gathered so far, so a four-round serial
// search costs about 15k tokens for one question, where the same searches run in one step cost 5k.
// Depth comes from searching several things at once, not from searching several times in a row.
const MAX_ROUNDS = 3;
const MAX_PARALLEL = 6;    // one search per item when comparing ("5 CRM tools" -> 5 searches)

/**
 * Models like to paste "now" into the query, and a literal ISO date is the worst possible keyword:
 * the engine matches it and returns whatever happens to mention that date. Asking for the latest
 * Node LTS with "2026-11-16" glued on returned a horoscope for that week, three times running.
 * The tool description says not to; this makes it impossible rather than discouraged.
 */
export function cleanQuery(query: string): string {
  return query
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")   // 2026-11-16
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, " ") // 16/11/2026
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Citation markers in the answer that point at a result that was never returned.
 * gpt-oss models sometimes emit their training-time format (`【3†L1-L4】`) instead of `[3]`,
 * so both spellings are read here, or a fabricated citation would slip past in the other one.
 */
export function danglingCitations(text: string, sourceCount: number): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,3})\]|【(\d{1,3})(?:†[^】]*)?】/g)) {
    const n = Number(m[1] ?? m[2]);
    if (n < 1 || n > sourceCount) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

const TOOLS = [{
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web. Returns numbered results with title, URL, publish date when known, and an " +
      "excerpt. Call it several times in one turn (in parallel) to cover several products or angles.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords a person would type, e.g. 'Neon Postgres pricing'. " +
          "Never put today's date or a YYYY-MM-DD date in the query: search engines match it literally and " +
          "return pages that merely mention that date. To restrict by date, use 'since' instead." },
        since: { type: "string", description: "Optional YYYY-MM-DD: only pages published on or after this date. " +
                                                "Use it for 'has anything changed since <date>'." },
        news: { type: "boolean", description: "true for news, announcements and launches." },
      },
      required: ["query"],
    },
  },
}];

function systemPrompt(now: Date, tz: number, memory: string) {
  const today = localDateLabel(now, tz);
  const time = new Date(now.getTime() + tz * 60_000).toISOString().slice(11, 16);
  return `You are a research assistant that talks with one user across many conversations. You have one tool, web_search.

Now: ${today} ${time} (user's local time, UTC${tz >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0")}:${String(Math.abs(tz) % 60).padStart(2, "0")}).

When to search:
- Search for anything that can change: prices, plans, releases, versions, news, people's roles, "is X still true". Your training data is old; do not answer these from memory.
- Do not search for chit-chat, maths, writing help, or questions about what the user said before (that is in MEMORY below).
- You get one search step. Everything you need must be requested in it: one search per product, per angle, per claim to re-check, all in the same step so they run in parallel. Searching one thing, reading it, then searching the next wastes the step and leaves you answering with a fraction of the evidence.
- "Has anything changed since <date>": search with since=<that date> and also check the current pricing or product page, because pricing pages often have no publish date.

How to answer:
- Lead with the answer in one or two sentences, then the detail. Short paragraphs or a compact list; no filler, no "Great question".
- Cite every fact from a search as [n], using the result numbers. Give concrete dates ("as of ${today.slice(0, 10)}", "announced 4 Nov").
- Write citations as plain ASCII square brackets: [1], [2]. Never use 【 】 or add line ranges.
- Only ever cite a number that appears in the results you were given. Never write a citation for a result you did not receive.
- If the results do not settle it, say what you could not confirm. Never fill a gap with a guess.
- If the results came back about something else entirely, say the search did not find it and offer to try different wording. An off-topic result is not evidence, and answering from your own memory of versions, prices or dates is the one thing you must not do.
- If the question is ambiguous, pick the most likely reading, say which one you picked, and answer it.

${memory ? `MEMORY (earlier conversations with this user, found by date and topic; this is your only record of them):
${memory}

Using MEMORY:
- Answer "what did I ask / what did you say" from MEMORY exactly, with its date.
- "Is that still correct" / "has anything changed since": re-check each claim with fresh searches and compare with the "Evidence then" lines. Say per item: unchanged, changed (what, when, source), or could not verify.
- If MEMORY says there was no conversation on a day, say so plainly and do not invent one.` :
`MEMORY: nothing relevant was found in earlier conversations. If the user refers to something they told you before, say you have no record of it and ask them to remind you; never invent a past conversation.`}`;
}

export async function runTurn(opts: {
  threadId: string; message: string; now: Date; tz: number;
  emit: (e: AgentEvent) => void; signal?: AbortSignal;
}): Promise<{ text: string; sources: Source[] }> {
  const { threadId, message, now, tz, emit, signal } = opts;
  const mem = recall(message, threadId, now, tz);
  if (mem.exchanges) emit({ type: "memory", exchanges: mem.exchanges });

  // The current thread, minus the message we just stored (it is appended below).
  const history = threadMessages(threadId, 21).slice(0, -1).map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(now, tz, mem.block) },
    ...history,
    { role: "user", content: message },
  ];

  const sources: (Source & { n: number })[] = [];
  let text = "";
  let downgraded = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const turn = await streamChat(messages, last ? [] : TOOLS, (t) => { text += t; emit({ type: "text", text: t }); }, signal, (m) => emit({ type: "warning", message: m }));
    const primary = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";
    if (turn.model && turn.model !== primary && !downgraded) {
      downgraded = true;
      emit({ type: "warning", message: `${primary} is rate-limited, so this answer came from ${turn.model}.` });
    }
    if (!turn.toolCalls.length) break;

    messages.push({ role: "assistant", content: turn.text || null,
      tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
    const calls = turn.toolCalls.slice(0, MAX_PARALLEL);
    const budget = budgetFor(calls.length, tokensLeftThisMinute());
    const results = await Promise.all(calls.map(async (c) => {
      let args: { query: string; since?: string; news?: boolean };
      try { args = JSON.parse(c.arguments || "{}"); } catch { return { c, out: "Error: arguments were not valid JSON." }; }
      if (!args.query) return { c, out: "Error: query is required." };
      args = { ...args, query: cleanQuery(args.query) };
      if (!args.query) return { c, out: "Error: the query was only a date. Put dates in 'since', not in the query." };
      emit({ type: "search", query: args.query, since: args.since });
      try {
        const rs = await webSearch(args, budget);
        const numbered = rs.map((r) => {
          const known = sources.find((s) => s.url === r.url);
          if (known) return known;
          const s = { ...r, n: sources.length + 1 };
          sources.push(s);
          return s;
        });
        return { c, out: numbered.length ? numbered.map((s) =>
          `[${s.n}] ${s.title}\n${s.url}${s.published ? `\npublished: ${s.published}` : ""}\n${s.snippet}`).join("\n\n")
          : "No results." };
      } catch (e) {
        return { c, out: `Search failed: ${(e as Error).message}. Answer from other results, or say what you could not check.` };
      }
    }));
    for (const c of turn.toolCalls.slice(MAX_PARALLEL)) results.push({ c, out: "Skipped: too many searches in one step." });
    for (const { c, out } of results) messages.push({ role: "tool", tool_call_id: c.id, content: out });

    // Smaller models search one item at a time even when told to batch, and a five-item comparison
    // then runs out of rounds with nothing to show. Telling the model what it has left is more
    // reliable than telling it what to do: it batches the rest when it knows this is the last chance.
    // Smaller models search one item at a time even when told to batch, and a five-item comparison
    // then answers on one item's evidence. Telling the model what it has left is more reliable than
    // telling it what to do: it batches the rest when it knows this is the last chance.
    if (round === 0 && calls.length === 1)
      messages.push({ role: "user", content:
        "That was your one search step, but you searched for a single thing. If the question covers " +
        "others, search for all of them now in one step. Otherwise answer from what you have." });

    if (sources.length) emit({ type: "sources", sources });
    if (text) { emit({ type: "text", text: "\n\n" }); text += "\n\n"; }
  }
  // A turn that gathered evidence and then said nothing is the worst outcome: the user waited and
  // got a blank reply. It happens when the model spends its whole token budget on tool calls and
  // reasoning. One last call, no tools, with the evidence already in the messages, has to produce
  // the answer. Asking again costs a second; sending back silence costs the conversation.
  if (!text.trim() && sources.length) {
    messages.push({ role: "user", content:
      "Answer now from the results above. Do not search again. If they do not settle it, say what is " +
      "still unconfirmed." });
    const final = await streamChat(messages, [], (t) => { text += t; emit({ type: "text", text: t }); }, signal, (m) => emit({ type: "warning", message: m }));
    if (!final.text.trim())
      emit({ type: "warning", message: "I found sources but could not compose an answer. The sources are listed below." });
  }

  // A citation pointing at a result that does not exist is the clearest signal that the answer
  // drifted off the evidence. Surfacing it is honest; silently rendering it as a footnote is not.
  const dangling = danglingCitations(text, sources.length);
  if (dangling.length)
    emit({ type: "warning", message: `This answer cited ${dangling.map((n) => `[${n}]`).join(", ")}, ` +
      `which ${dangling.length > 1 ? "are" : "is"} not among the ${sources.length} result${sources.length === 1 ? "" : "s"} found. Treat ${dangling.length > 1 ? "those claims" : "that claim"} as unverified.` });

  return { text: text.trim(), sources };
}
