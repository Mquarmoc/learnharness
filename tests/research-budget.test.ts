import assert from "node:assert/strict";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";

test("research reserves its twelfth request for a brief instead of ending on a tool call", async () => {
 const faux = createFauxCore({});
 let requests = 0;
 const respond: FauxResponseFactory = (context) => {
  requests++;
  const last = context.messages.at(-1);
  const finishing = last?.role === "system" && !!last.toolsRemoved?.length;
  if (finishing) {
   const available = new Set<string>();
   for (const m of context.messages) if (m.role === "system") {
    for (const tool of m.toolsAdded ?? []) available.add(tool.name);
    for (const tool of m.toolsRemoved ?? []) available.delete(tool.name);
   }
   assert.equal(available.size, 0, "all research tools must be removed");
  }
  if (finishing) {
   assert.match(JSON.stringify(context), /final.*brief|brief.*final/i);
   return fauxAssistantMessage(fauxText("## Summary\nA bounded research brief.\n## Gaps\nSearch unavailable."));
  }
  return fauxAssistantMessage(fauxToolCall("web_search", { query: "offline fixture" }));
 };
 faux.setResponses(Array.from({ length: 13 }, () => respond));
 const brief = await runResearcherAgent("Offline fixture", {
  engine: { model: faux.getModel(), streamFn: faux.streamSimple },
 });
 assert.equal(requests, 12);
 assert.match(brief, /bounded research brief/);
});

test("a brief completed early does not use the remaining request budget", async () => {
 const faux = createFauxCore({});
 let requests = 0;
 faux.setResponses([(() => { requests++; return fauxAssistantMessage(fauxText("Early brief.")); }) as FauxResponseStep]);
 assert.equal(await runResearcherAgent("Offline fixture", {
  engine: { model: faux.getModel(), streamFn: faux.streamSimple },
 }), "Early brief.");
 assert.equal(requests, 1);
});
