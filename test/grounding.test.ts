// The two guards that keep an answer tied to its evidence.
import { test } from "node:test";
import assert from "node:assert/strict";

const { cleanQuery, danglingCitations } = await import("../src/agent.ts");

test("a date pasted into the query is removed", () => {
  // The real failure: asking for the latest Node LTS with today's date glued on returned a
  // horoscope for that week, because the engine matched the date string literally.
  assert.equal(cleanQuery("latest LTS version of Node.js 2026-11-16"), "latest LTS version of Node.js");
  assert.equal(cleanQuery("Neon pricing 16/11/2026"), "Neon pricing");
  assert.equal(cleanQuery("2026-11-16"), "");
});

test("version numbers and years survive", () => {
  // Only full dates go; a year or a version is often the point of the search.
  assert.equal(cleanQuery("Node.js 24 end of life"), "Node.js 24 end of life");
  assert.equal(cleanQuery("HubSpot pricing 2026"), "HubSpot pricing 2026");
  assert.equal(cleanQuery("Postgres 18.6 release notes"), "Postgres 18.6 release notes");
});

test("a citation beyond the result count is reported", () => {
  assert.deepEqual(danglingCitations("Node 26 is current [8] and [10].", 6), [8, 10]);
  assert.deepEqual(danglingCitations("Node 24 is current [1][2].", 6), []);
  assert.deepEqual(danglingCitations("No citations here.", 6), []);
});

test("the model's own bracket style is checked too", () => {
  // gpt-oss sometimes emits its training-time format instead of [n].
  assert.deepEqual(danglingCitations("Latest is 26.13.1 【3†L1-L4】【9†L1-L2】", 6), [9]);
  assert.deepEqual(danglingCitations("Latest is 26.13.1 【3】", 6), []);
});

test("nothing found means every citation is dangling", () => {
  assert.deepEqual(danglingCitations("It costs $25 [1].", 0), [1]);
});

const { budgetFor } = await import("../src/search.ts");

test("the evidence budget shrinks as searches fan out", () => {
  // One search reads deeply; a five-way comparison reads shallowly, so the whole turn still
  // fits inside a free tier's 8k tokens a minute.
  assert.deepEqual(budgetFor(1), { maxResults: 6, snippetChars: 600 });
  // with the quota nearly spent, the same fan-out reads less rather than waiting
  assert.deepEqual(budgetFor(1, 2500), { maxResults: 4, snippetChars: 260 });
  assert.deepEqual(budgetFor(5, 2500), { maxResults: 2, snippetChars: 260 });
  assert.deepEqual(budgetFor(2), { maxResults: 6, snippetChars: 600 });
  assert.deepEqual(budgetFor(5), { maxResults: 3, snippetChars: 380 });
  assert.deepEqual(budgetFor(6), { maxResults: 3, snippetChars: 380 });
});

test("the per-search floor holds however wide the fan-out", () => {
  assert.equal(budgetFor(99).maxResults, 3);
});
