import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-")), "t.db");
const { pastWindows } = await import("../src/time.ts");
const { addMessage, addSources, ensureThread, recall } = await import("../src/memory.ts");

const IST = 330;
const NOW = new Date("2026-11-11T15:00:00+05:30"); // a Wednesday
const at = (iso: string) => new Date(iso).getTime();

function chat(thread: string, iso: string, q: string, a: string, sources: string[] = []) {
  ensureThread(thread, q, at(iso));
  addMessage(thread, "user", q, at(iso));
  const id = addMessage(thread, "assistant", a, at(iso) + 5000);
  addSources(id, sources.map((s) => ({ url: `https://${s}.example/pricing`, title: s, snippet: `${s} costs $25`, query: s })), at(iso) + 5000);
}

chat("t1", "2026-11-03T10:00:00+05:30", "Which Postgres hosting is cheapest for a side project?",
     "Neon and Supabase both have free tiers.", ["neon", "supabase"]);
chat("t2", "2026-11-09T11:00:00+05:30", "Shortlist CRM tools for a 20-person sales team",
     "HubSpot, Pipedrive, Close, Attio, Salesforce Starter.", ["hubspot", "pipedrive"]);
chat("t3", "2026-11-10T09:00:00+05:30", "What is the capital of Australia?", "Canberra.");

test("a calendar date becomes that local day", () => {
  const [w] = pastWindows("What did I ask you on 3 November?", NOW, IST);
  assert.equal(w.label, "2026-11-03 (Tue)");
  assert.equal(w.start.toISOString(), "2026-11-02T18:30:00.000Z");
});

test("a bare weekday gives this week's and last week's candidate", () => {
  const ws = pastWindows("Last Tuesday I asked you about Postgres hosting", NOW, IST);
  assert.deepEqual(ws.map((w) => w.label), ["2026-11-10 (Tue)", "2026-11-03 (Tue)"]);
});

test("'last Tuesday' resolves to the Tuesday that has the Postgres conversation", () => {
  const r = recall("Last Tuesday I asked you about Postgres hosting. Has any pricing changed?", "now", NOW, IST);
  assert.match(r.block, /2026-11-03 \(Tue\).*Postgres/);
  assert.doesNotMatch(r.block, /Australia/);
  assert.match(r.block, /Evidence then .*neon/);
});

test("'on Monday we shortlisted' finds Monday's CRM list", () => {
  const r = recall("On Monday we shortlisted 5 CRM tools. Has any of them changed pricing?", "now", NOW, IST);
  assert.match(r.block, /2026-11-09 \(Mon\).*CRM/);
  assert.match(r.block, /Pipedrive/);
});

test("a day with no conversation is reported, not invented", () => {
  const r = recall("What did I ask you on 5 November?", "now", NOW, IST);
  assert.match(r.block, /2026-11-05 \(Thu\): no conversations/);
});

test("'you said earlier' with no date searches by topic across threads", () => {
  const r = recall("You said earlier something about Supabase, is that still correct?", "now", NOW, IST);
  assert.match(r.block, /Supabase/);
});

test("an ordinary question pulls in no memory", () => {
  assert.equal(recall("What's the weather in Pune?", "now", NOW, IST).block, "");
});
