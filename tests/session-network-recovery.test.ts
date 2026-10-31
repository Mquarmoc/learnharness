import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { findPendingToolCall } from "../src/core/index.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const quiz = { id: "saved-question", role: "assistant", content: [{ type: "toolCall", id: "quiz-next", name: "quiz", arguments: { question: "Fixture?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correctAnswer: "a" } }], stopReason: "toolUse", timestamp: 1, api: "openai-responses", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as LhMessage;

test("a saved idle question recovers a disconnected view without opening another stream", async () => {
 let streams = 0, settled = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  onReattachSettled: () => { settled++; },
  fetch: async input => {
   if (String(input).endsWith("/stream")) { streams++; throw new TypeError("network error"); }
   return Response.json({ messages: [quiz], turnInFlight: false });
  },
 });
 await model.resumeStream(false);
 assert.equal(streams, 1);
 assert.equal(model.getState().status, "ready");
 assert.equal(model.getState().error, null);
 assert.equal(findPendingToolCall(model.getState().messages)?.toolCallId, "quiz-next");
 assert.equal(settled, 1);
});

test("a browser NetworkError can recover through the saved lesson", async () => {
 let streams = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async input => {
   if (String(input).endsWith("/stream")) {
    streams++; throw new DOMException("network error", "NetworkError");
   }
   return Response.json({ messages: [quiz], turnInFlight: false });
  },
 });
 await model.resumeStream(false);
 assert.equal(streams, 1);
 assert.equal(model.getState().error, null);
 assert.equal(model.getState().status, "ready");
});

test("a later successful idle snapshot clears an exhausted connection error", async () => {
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async () => { throw new TypeError("network error"); },
 });
 await model.resumeStream(false);
 assert.ok(model.getState().error);
 model.setMessages([quiz]);
 assert.equal(model.getState().error, null);
 assert.equal(model.getState().status, "ready");
});

test("a failed send allows an explicit learner retry rather than silently discarding it", async () => {
 let posts = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [],
  fetch: async (_input, init) => {
   if (init?.method === "POST") {
    if (++posts === 1) throw new TypeError("network error");
    return Response.json({ ok: true });
   }
   return Response.json({ messages: [quiz], turnInFlight: false });
  },
 });
 await model.send({ type: "text", text: "First attempt" });
 assert.equal(posts, 1, "a failed POST must never replay automatically");
 await model.send({ type: "text", text: "Explicit retry" });
 assert.equal(posts, 2);
 assert.equal(model.getState().error, null);
});

test("snapshot recovery preserves access refusal and saved provider failures", async () => {
 const refused = new SessionModel({ chatId: "chat_fixture", initialMessages: [],
  fetch: async () => new Response("Phone access refused.", { status: 401 }),
 });
 await refused.resumeStream(true);
 refused.setMessages([quiz]);
 assert.match(refused.getState().error!.message, /Phone access refused/);
 const failed = { ...quiz, content: [], stopReason: "error", errorMessage: "ChatGPT usage limit reached." } as LhMessage;
 const disconnected = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async () => { throw new TypeError("network error"); },
 });
 await disconnected.resumeStream(false);
 disconnected.setMessages([failed]);
 assert.equal(disconnected.getState().error!.message, "ChatGPT usage limit reached.");
 assert.equal(disconnected.getState().status, "ready");
});
