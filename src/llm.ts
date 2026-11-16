// A streaming client for any OpenAI-compatible /chat/completions endpoint (Groq, OpenAI,
// Anthropic's compatibility endpoint). About 100 lines instead of a framework: tool-call
// deltas are reassembled here, and nothing happens that cannot be read in this file.

export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type Turn = { text: string; toolCalls: ToolCall[]; model?: string; finishReason?: string; usage?: { prompt_tokens: number; completion_tokens: number } };

/**
 * Groq reports the remaining tokens-a-minute on every response, and on a free key that budget
 * (8k, shared across models) is smaller than one comparison question. Remembering it lets the
 * next turn size its evidence to what is actually left instead of to a constant.
 */
let remainingTokens: number | null = null;
export const tokensLeftThisMinute = () => remainingTokens;

/** Groq sends "7.927s" / "1m2s" as well as plain seconds. */
function parseSeconds(v: string | null): number {
  if (!v) return 0;
  if (/^[\d.]+$/.test(v)) return Number(v);
  const m = v.match(/(?:(\d+)m)?([\d.]+)s/);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : 0;
}

export async function streamChat(
  messages: ChatMessage[],
  tools: unknown[],
  onText: (t: string) => void,
  signal?: AbortSignal,
  onNotice?: (m: string) => void,
): Promise<Turn> {
  const primary = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";
  // The strongest model on a free tier is also the one with the smallest tokens-per-minute budget
  // (8k TPM for gpt-oss-120b on Groq, enough for roughly one or two answers a minute). Waiting out
  // a 20-second rate limit mid-conversation is worse than answering now on a smaller model, so a
  // long 429 falls back instead of stalling. Set LLM_FALLBACK_MODEL="" to turn this off.
  const fallback = process.env.LLM_FALLBACK_MODEL ?? "openai/gpt-oss-20b";
  let model = primary;

  const buildBody = (m: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      model: m, messages, tools, tool_choice: "auto", stream: true, temperature: 0.3, max_tokens: 2000,
      stream_options: { include_usage: true },
    };
    // gpt-oss thinks before answering; "low" keeps first-token latency near a second.
    if (m.includes("gpt-oss")) b.reasoning_effort = process.env.LLM_REASONING_EFFORT ?? "low";
    return b;
  };
  let body = buildBody(model);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1"}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify(body),
      signal,
    });
    const left = res.headers.get("x-ratelimit-remaining-tokens");
    if (left !== null) remainingTokens = Number(left);

    if (res.status === 429 && attempt < 3) {
      const wait = parseSeconds(res.headers.get("retry-after"));
      // A short wait is cheaper than a weaker answer, so sit it out on the same model.
      if (wait > 0 && wait <= 5) { await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
      // A long wait is not: drop to a different model and answer now.
      if (fallback && model !== fallback) { model = fallback; body = buildBody(model); continue; }
      // Both are limited, which on a free key means one shared budget is empty. Waiting beats
      // failing: the user would rather have the answer late than read an error about quotas.
      if (wait > 0 && wait <= 30) {
        onNotice?.(`Rate-limited by the model provider; waiting ${Math.ceil(wait)}s for the quota to refill.`);
        await new Promise((r) => setTimeout(r, wait * 1000 + 500));
        continue;
      }
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(res.status === 429 ? `The model provider is rate-limiting me right now (${detail})`
                                         : `Model call failed: HTTP ${res.status} ${detail}`);
    }
    const turn = await readStream(res.body, onText);
    turn.model = model;
    return turn;
  }
}

async function readStream(body: ReadableStream<Uint8Array>, onText: (t: string) => void): Promise<Turn> {
  const out: Turn = { text: "", toolCalls: [] };
  const calls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.usage) out.usage = j.usage;
      if (j.choices?.[0]?.finish_reason) out.finishReason = j.choices[0].finish_reason;
      const delta = j.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { out.text += delta.content; onText(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.arguments += tc.function.arguments;
      }
    }
  }
  out.toolCalls = calls.filter(Boolean);
  return out;
}
