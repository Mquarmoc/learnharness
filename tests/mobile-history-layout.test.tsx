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

// Since 0.6.1 the Chat component assigns onto a ref object during render, which React's
// development server renderer seals, so the layout is asserted on the source structure.
test("phone history and the question dock share one scroller, desktop keeps its overlay dock and spacer", async () => {
 const { readFileSync } = await import("node:fs");
 const source = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
 const content = source.slice(source.indexOf("<ConversationContent"), source.indexOf("</ConversationContent>"));
 assert.match(content, /\{mobile \? dock : <div aria-hidden data-testid="dock-spacer"/, "on the phone the dock scrolls with history, on desktop a spacer reserves its height");
 const after = source.slice(source.indexOf("</ConversationContent>"), source.indexOf("</Conversation>"));
 assert.match(after, /\{!mobile && dock\}/, "the overlay dock outside the scroller is desktop only");
 assert.equal(source.match(/<DockOverlay\b/g)?.length, 1, "one dock element serves both layouts");
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
