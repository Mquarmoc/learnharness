import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionModel } from "../components/session-core.ts";

const wire = (events: unknown[]) => events.map(e => "data: " + (e === "[DONE]" ? e : JSON.stringify(e)) + "\n\n").join("");
const message = { role: "assistant", content: [{ type: "text", text: "Recovered lesson." }], stopReason: "stop", timestamp: 1, provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };

for (const failure of ["network", "eof"] as const) test(`reattach recovers ${failure} with GET replay and no duplicated answer or lesson`, async () => {
 let streams = 0, posts = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async (input, init) => {
   const url = String(input);
   if (init?.method === "POST") { posts++; return Response.json({ ok: true }); }
   if (!url.endsWith("/stream")) return Response.json({ messages: [] });
   streams++;
   if (streams === 1) {
    if (failure === "network") throw new TypeError("network error");
    return new Response(wire([{ type: "message_start", message }]));
   }
   return new Response(wire([{ type: "message_start", message }, { type: "message_end", message }, "[DONE]"]));
  },
 });
 await model.send({ type: "text", text: "One learner input." });
 assert.equal(posts, 1);
 assert.equal(streams, 2);
 assert.equal(model.getState().error, null);
 assert.equal(model.getState().status, "ready");
 assert.equal(model.getState().nativeMessages.filter(m => m.role === "assistant").length, 1);
});

test("authentication refusal is surfaced without repeated requests", async () => {
 let requests = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async () => { requests++; return new Response("Phone pairing expired.", { status: 401 }); },
 });
 await model.resumeStream(false);
 assert.equal(requests, 1);
 assert.match(model.getState().error!.message, /pairing expired/);
});

test("persistent network failure is bounded", async () => {
 let requests = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async () => { requests++; throw new TypeError("network error"); },
 });
 await model.resumeStream(false);
 assert.equal(requests, 4);
 assert.match(model.getState().error!.message, /network error/);
});

test("a stream body failing after a partial response replays without duplicating it", async () => {
 let streams = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 0,
  fetch: async input => {
   if (!String(input).endsWith("/stream")) return Response.json({ messages: [] });
   streams++;
   if (streams === 1) {
    let reads = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
     if (reads++ === 0) controller.enqueue(new TextEncoder().encode(wire([{ type: "message_start", message }])));
     else controller.error(new TypeError("network error"));
    } }));
   }
   return new Response(wire([{ type: "message_start", message }, { type: "message_end", message }, "[DONE]"]));
  },
 });
 await model.resumeStream(false);
 assert.equal(streams, 2);
 assert.equal(model.getState().error, null);
 assert.equal(model.getState().nativeMessages.filter(m => m.role === "assistant").length, 1);
});

test("stop during reconnect backoff prevents any further fetch", async () => {
 let requests = 0;
 let failed!: () => void;
 const firstFailure = new Promise<void>(resolve => { failed = resolve; });
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [], pollMs: 50,
  fetch: async () => { requests++; failed(); throw new TypeError("network error"); },
 });
 const pending = model.resumeStream(false);
 await firstFailure;
 await new Promise(resolve => setTimeout(resolve, 0));
 model.stop();
 await pending;
 assert.equal(requests, 1);
 assert.equal(model.getState().status, "ready");
 assert.equal(model.getState().error, null);
});

test("provider failure is preserved and never triggers a new provider request or replay", async () => {
 let streams = 0;
 const failed = { ...message, content: [], stopReason: "error", errorMessage: "ChatGPT request failed." };
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [],
  fetch: async () => {
   streams++;
   return new Response(wire([{ type: "message_start", message: failed }, { type: "message_end", message: failed }, "[DONE]"]));
  },
 });
 await model.resumeStream(false);
 assert.equal(streams, 1);
 assert.match(model.getState().error!.message, /ChatGPT request failed/);
});

for (const status of [401, 403]) test(`record refetch refusal ${status} stops before attaching or clearing the lesson`, async () => {
 let streams = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [],
  fetch: async input => {
   if (String(input).endsWith("/stream")) streams++;
   return new Response("Phone access refused.", { status });
  },
 });
 await model.resumeStream(true);
 assert.equal(streams, 0);
 assert.match(model.getState().error!.message, /Phone access refused/);
});

test("a quiz answer stays saved exactly once across a dropped stream and replay", async () => {
 const { newAnswerResult } = await import("../src/core/native-messages.ts");
 const quiz = { ...message, id: "quiz-fixture", stopReason: "toolUse",
  content: [{ type: "toolCall", id: "call-fixture", name: "quiz", arguments: { question: "Fixture?", choices: ["a", "b"] } }] };
 const answer = { correct: true } as never;
 const record = [quiz, { ...newAnswerResult("call-fixture", "quiz", answer), id: "saved-answer" }];
 let posts = 0, streams = 0;
 const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [quiz as never], pollMs: 0,
  fetch: async (input, init) => {
   if (init?.method === "POST") { posts++; assert.equal(JSON.parse(init.body as string).input.type, "answer"); return Response.json({ ok: true }); }
   if (!String(input).endsWith("/stream")) return Response.json({ messages: record });
   if (++streams === 1) throw new TypeError("network error");
   return new Response(wire([{ type: "message_start", message }, { type: "message_end", message }, "[DONE]"]));
  },
 });
 await model.send({ type: "answer", toolCallId: "call-fixture", answer });
 assert.equal(posts, 1);
 const saved = model.getState().nativeMessages;
 assert.equal(saved.filter(m => m.role === "toolResult").length, 1);
 assert.equal(saved.filter(m => m.role === "assistant" && m.stopReason === "stop").length, 1);
 assert.equal(model.getState().error, null);
});
