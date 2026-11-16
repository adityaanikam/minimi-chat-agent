// Gives a fresh install some history to remember, so the date questions can be tried at once.
// It does not invent past answers: it runs the real agent (real searches, real model) with the
// clock set back, and stores each exchange under that past date. "Evidence then" is therefore
// today's web, stamped with the earlier date; say so if you demo a "what changed" answer.
import { randomUUID } from "node:crypto";
import { runTurn } from "../src/agent.ts";
import { addMessage, addSources, ensureThread } from "../src/memory.ts";
import { now as realNow } from "../src/time.ts";

const tz = -new Date().getTimezoneOffset();
const DAY = 86_400_000;

function daysAgo(n: number, hour: number) {
  const d = new Date(realNow().getTime() - n * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function lastWeekday(dow: number, hour: number) {   // most recent past <dow> (0 = Sunday), not today
  const t = realNow();
  const back = ((t.getDay() - dow + 7) % 7) || 7;
  return daysAgo(back, hour);
}

const plan: { at: Date; message: string }[] = [
  { at: daysAgo(8, 11), message: "What's the current LTS version of Node.js and when does it reach end of life?" },
  { at: lastWeekday(1, 10), message: "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing." },
  { at: lastWeekday(2, 16), message: "Compare Postgres hosting for a small SaaS: Neon, Supabase, and AWS RDS. Main pricing tiers?" },
];

for (const p of plan) {
  const threadId = randomUUID();
  ensureThread(threadId, p.message, p.at.getTime());
  addMessage(threadId, "user", p.message, p.at.getTime());
  process.stdout.write(`${p.at.toString().slice(0, 21)}  ${p.message}\n`);
  const out = await runTurn({ threadId, message: p.message, now: p.at, tz, emit: () => {} });
  const id = addMessage(threadId, "assistant", out.text, p.at.getTime() + 20_000);
  addSources(id, out.sources, p.at.getTime() + 20_000);
  process.stdout.write(`  -> ${out.text.slice(0, 160).replace(/\s+/g, " ")}...\n\n`);
}
console.log("Seeded. Try: \"What did I ask you on " + plan[0].at.toDateString().slice(4, 10) + "? Is your answer still correct today?\"");
