import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Chat } from "../components/chat.tsx";

import { ServerEventsProvider } from "../components/server-events.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { SidebarProvider, AppShell } from "../components/sidebar.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";

const messages = [
 { id: "history", role: "user", content: "Earlier lesson history.", timestamp: 1 },
 { id: "question", role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 2, stopReason: "toolUse",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  content: [{ type: "toolCall", id: "question-1", name: "quiz", arguments: { question: "A long prediction question. ".repeat(30), type: "predict", nodeId: "fixture", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "Fixture." } }],
 },
] as LhMessage[];
function render(mobile: boolean) {
 const chat = <Chat chatId="chat_layout_fixture" title="Fixture" initialMessages={messages} initialConfigured />;
 return parseHTML(renderToStaticMarkup(<AppRouterContext.Provider value={{ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {}, hmrRefresh() {} } as never}><ServerEventsProvider><SidebarProvider><AppShell mobile={mobile}>{chat}</AppShell></SidebarProvider></ServerEventsProvider></AppRouterContext.Provider>)).document;
}

test("phone history and a long question belong to the same scrolling content", () => {
 const document = render(true);
 const history = document.querySelector('[role="log"] [data-session-find-root]')!;
 const question = document.querySelector('[data-testid="question-dock"]')!;
 assert.ok(history && question, "rendered history and question must exist");
 assert.equal(history.parentElement!.contains(question), true, "the question must scroll away with history instead of covering it");
 assert.equal(document.querySelectorAll('[data-testid="question-dock"]').length, 1);
});

test("desktop retains its separate dock and reserved transcript space", () => {
 const document = render(false);
 const history = document.querySelector('[role="log"] [data-session-find-root]')!;
 const question = document.querySelector('[data-testid="question-dock"]')!;
 assert.ok(history && question);
 assert.equal(history.parentElement!.contains(question), false);
 assert.ok(document.querySelector('[data-testid="dock-spacer"]'));
});

test("phone question and practice forms have no independent scrolling pane", async () => {
 const { readFileSync } = await import("node:fs");
 const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
 for (const selector of ['.lh-mobile [data-testid="question-dock"]', '.lh-mobile [data-testid="practice-dock"]']) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
   .filter(match => match[1]!.split(",").map(part => part.trim()).includes(selector));
  const declarations = rules.at(-1)?.[2] ?? "";
  assert.match(declarations, /max-height:\s*none/);
  assert.match(declarations, /overflow:\s*visible/);
 }
});
