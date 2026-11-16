// Long-term memory: every message, and the evidence behind every answer, in SQLite.
// node:sqlite is built into Node, so `npm install` compiles nothing.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { localDateLabel, pastWindows, type Window } from "./time.ts";

export type Source = { url: string; title: string; published?: string | null; snippet: string; query: string };
export type Msg = { id: number; thread_id: string; role: "user" | "assistant"; content: string; created_at: number };

mkdirSync("data", { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH ?? "data/memory.db");
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created_at INTEGER);
  CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
  CREATE TABLE IF NOT EXISTS sources (
    message_id INTEGER, url TEXT, title TEXT, published TEXT, snippet TEXT, query TEXT, retrieved_at INTEGER);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;
`);

export function ensureThread(id: string, title: string, at: number) {
  db.prepare("INSERT OR IGNORE INTO threads VALUES (?, ?, ?)").run(id, title.slice(0, 80), at);
}

export function addMessage(threadId: string, role: Msg["role"], content: string, at: number): number {
  const r = db.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(threadId, role, content, at);
  return Number(r.lastInsertRowid);
}

export function addSources(messageId: number, sources: Source[], at: number) {
  const st = db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const s of sources) st.run(messageId, s.url, s.title, s.published ?? null, s.snippet.slice(0, 600), s.query, at);
}

export function threadMessages(threadId: string, limit = 20): Msg[] {
  const rows = db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
    .all(threadId, limit) as unknown as Msg[];
  return rows.reverse();
}

export function listThreads() {
  return db.prepare(`SELECT t.id, t.title, MAX(m.created_at) AS last_at FROM threads t
                     JOIN messages m ON m.thread_id = t.id GROUP BY t.id ORDER BY last_at DESC LIMIT 50`).all();
}

// ---- recall ----------------------------------------------------------------------------

const STOP = new Set(("a an the of to in on for and or is are was were be been by with as at from that this these " +
  "those it its into than then which what how why when where who does do did can could would should will i me my " +
  "we our you your us ask asked asking said tell told answer answered still correct today since any has have had " +
  "changed change there last monday tuesday wednesday thursday friday saturday sunday january february march april " +
  "may june july august september october november december yesterday week day ago earlier before about them").split(" "));

const MEMORY_CUE = /\b(i|we) (asked|discussed|talked|shortlisted|said|mentioned|looked|compared|chose|picked)\b|\byou (said|told|recommended|answered|suggested)\b|\blast time\b|\bearlier\b|\bpreviously\b|\bsince (then|we|i|you|last)\b|\bstill (correct|true|right|valid)\b/i;

function topicTerms(message: string): string[] {
  return [...new Set((message.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{1,}/g) ?? [])
    .map((w) => w.replace(/[.]+$/, ""))
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

function ftsQuery(terms: string[]) {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

type Exchange = { question: Msg; answer?: Msg; sources: (Source & { retrieved_at: number })[]; topicHit: boolean };

function exchangeFor(q: Msg, terms: string[]): Exchange {
  const answer = db.prepare(`SELECT * FROM messages WHERE thread_id = ? AND id > ? AND role = 'assistant'
                             ORDER BY id LIMIT 1`).get(q.thread_id, q.id) as unknown as Msg | undefined;
  const sources = answer
    ? (db.prepare("SELECT url, title, published, snippet, query, retrieved_at FROM sources WHERE message_id = ?")
        .all(answer.id) as unknown as Exchange["sources"])
    : [];
  const text = (q.content + " " + (answer?.content ?? "")).toLowerCase();
  return { question: q, answer, sources, topicHit: terms.some((t) => text.includes(t)) };
}

export type Recall = { block: string; exchanges: number };

/**
 * What the user is referring to from earlier conversations, found without a model call:
 * date expressions pick day windows, topic words pick messages inside them (or anywhere,
 * when the message only says "earlier" / "you said"). Empty windows are reported too,
 * so the model can say "I have no conversation from 3 November" instead of inventing one.
 */
export function recall(message: string, currentThread: string, ref: Date, tz: number): Recall {
  const windows = pastWindows(message, ref, tz);
  const terms = topicTerms(message);
  const lines: string[] = [];
  let found: Exchange[] = [];

  const byWindow = new Map<Window, Exchange[]>();
  for (const w of windows) {
    const qs = db.prepare(`SELECT * FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?
                           ORDER BY created_at`).all(w.start.getTime(), w.end.getTime()) as unknown as Msg[];
    byWindow.set(w, qs.filter((q) => q.created_at < ref.getTime() - 1000).map((q) => exchangeFor(q, terms)));
  }
  // Ambiguous weekdays produce two windows with the same text: keep the one that matches the topic.
  const groups = new Map<string, Window[]>();
  for (const w of windows) groups.set(w.text, [...(groups.get(w.text) ?? []), w]);
  for (const [text, ws] of groups) {
    const hits = ws.filter((w) => byWindow.get(w)!.some((e) => e.topicHit));
    const nonEmpty = ws.filter((w) => byWindow.get(w)!.length);
    const keep = hits.length ? hits : nonEmpty.length ? nonEmpty : ws;
    for (const w of ws) {
      if (!keep.includes(w)) continue;
      const ex = byWindow.get(w)!;
      if (!ex.length) lines.push(`- "${text}" = ${w.label}: no conversations with the user on that day.`);
      // On a busy day, topic matches first.
      found.push(...ex.sort((a, b) => Number(b.topicHit) - Number(a.topicHit)).slice(0, 6));
    }
  }

  if (!windows.length && (MEMORY_CUE.test(message)) && terms.length) {
    // Match questions and answers ("you said X" is usually in the answer), then step back to the question.
    const rows = db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
                             WHERE messages_fts MATCH ? AND m.thread_id != ?
                             ORDER BY rank LIMIT 8`).all(ftsQuery(terms), currentThread) as unknown as Msg[];
    const seen = new Set<number>();
    for (const m of rows) {
      const q = m.role === "user" ? m : (db.prepare(`SELECT * FROM messages WHERE thread_id = ? AND id < ?
                AND role = 'user' ORDER BY id DESC LIMIT 1`).get(m.thread_id, m.id) as unknown as Msg | undefined);
      if (q && !seen.has(q.id) && seen.size < 4) { seen.add(q.id); found.push(exchangeFor(q, terms)); }
    }
  }

  for (const e of found) {
    lines.push(`- ${localDateLabel(new Date(e.question.created_at), tz)} ${hhmm(e.question.created_at, tz)}, ` +
      `the user asked: "${clip(e.question.content, 400)}"`);
    if (e.answer) lines.push(`  You answered: "${clip(e.answer.content, 1200)}"`);
    for (const s of e.sources.slice(0, 6)) {
      lines.push(`  Evidence then (fetched ${localDateLabel(new Date(s.retrieved_at), tz)}): ${s.title} <${s.url}>` +
        `${s.published ? ` published ${s.published}` : ""}: "${clip(s.snippet, 260)}"`);
    }
  }
  if (!lines.length) return { block: "", exchanges: 0 };
  return { block: lines.join("\n"), exchanges: found.length };
}

function clip(s: string, n: number) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function hhmm(ms: number, tz: number) {
  return new Date(ms + tz * 60_000).toISOString().slice(11, 16);
}
