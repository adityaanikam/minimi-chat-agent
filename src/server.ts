// HTTP server: static UI + a streaming chat endpoint (Server-Sent Events). No framework;
// three routes do not need one.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runTurn, type AgentEvent } from "./agent.ts";
import { addMessage, addSources, ensureThread, listThreads, threadMessages } from "./memory.ts";
import { now } from "./time.ts";

const PORT = Number(process.env.PORT ?? 3000);

for (const k of ["LLM_API_KEY", "TAVILY_API_KEY"]) {
  if (!process.env[k]) console.warn(`warning: ${k} is not set (copy .env.example to .env)`);
}

async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  const { message, threadId: given, tzOffset } = await body(req);
  if (!message || typeof message !== "string") return json(res, 400, { error: "message is required" });
  const threadId = given || randomUUID();
  const tz = Number.isFinite(tzOffset) ? tzOffset : 0;     // minutes east of UTC, from the browser
  const at = now();

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e: AgentEvent | { type: string; [k: string]: unknown }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  send({ type: "thread", threadId });

  ensureThread(threadId, message, at.getTime());
  addMessage(threadId, "user", message, at.getTime());

  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  const t0 = Date.now();
  let firstText = 0;
  try {
    const out = await runTurn({
      threadId, message, now: at, tz, signal: abort.signal,
      emit: (e) => { if (e.type === "text" && !firstText) firstText = Date.now() - t0; send(e); },
    });
    const answer = out.text || "I could not produce an answer this time.";
    const id = addMessage(threadId, "assistant", answer, now().getTime());
    addSources(id, out.sources, now().getTime());
    send({ type: "done", firstTextMs: firstText, totalMs: Date.now() - t0 });
  } catch (e) {
    if (abort.signal.aborted) return;
    const msg = (e as Error).message;
    // Store the failure as the answer, so a later "what did you say" is truthful.
    addMessage(threadId, "assistant", `(No answer: ${msg})`, now().getTime());
    send({ type: "error", message: msg });
  }
  res.end();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    if (req.method === "GET" && url.pathname === "/api/threads") return json(res, 200, listThreads());
    if (req.method === "GET" && url.pathname.startsWith("/api/threads/"))
      return json(res, 200, threadMessages(decodeURIComponent(url.pathname.split("/")[3]), 200));
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(new URL("../public/index.html", import.meta.url)));
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, () => console.log(`chat agent on http://localhost:${PORT}`));
