import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";

const origin = process.argv[2]!;
const cookieFile = process.argv[3]!;
assert(origin?.startsWith("https://"));
assert(cookieFile?.includes("mobile-preview"), "Only synthetic preview cookies may be used.");
const cookie = fs.readFileSync(cookieFile, "utf8").trim();
const request = (pathname: string, options: RequestInit = {}) => fetch(origin + pathname, { ...options, headers: { cookie, origin, ...options.headers }, signal: AbortSignal.timeout(15_000) });
const status = await (await request("/mobile/status")).json();
assert(status.preview, "Refuse to submit anything to a real learner profile.");
const { chats } = await (await request("/api/chats")).json();
const selected = chats.find((chat: { title: string }) => chat.title.includes("Russian"));
const record = await (await request("/api/chats/" + selected.id)).json();
const call = record.messages.flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : [])
	.find((part: { type: string; name: string }) => part.type === "toolCall" && part.name === "quiz");
const options = normalizeOptions(call.arguments.options);
const question: QuestionData = { id: call.id, kind: "quiz", question: call.arguments.question, mode: "single-select",
	options, correctIndices: resolveCorrect(call.arguments.correctAnswer, options).indices, explanation: call.arguments.explanation, createdAt: new Date().toISOString() };
const answer = buildAnswer(question, { values: [options[1]!.value], thinking: "Synthetic mobile continuity check." });
const submitted = await request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: selected.id, input: { type: "answer", toolCallId: call.id, answer } }) });
assert.equal(submitted.status, 200, await submitted.text());
const stream = await request("/api/chats/" + selected.id + "/stream");
assert.equal(stream.status, 200);
await stream.text();
const saved = await (await request("/api/chats/" + selected.id)).json();
assert(saved.messages.some((message: { role: string; toolCallId: string; details?: { thinking?: string } }) => message.role === "toolResult" && message.toolCallId === call.id && message.details?.thinking === "Synthetic mobile continuity check."));
assert(saved.messages.some((message: { content: unknown }) => JSON.stringify(message.content).includes("no AI request was sent")));
const reloaded = await request("/chat/" + selected.id);
assert.equal(reloaded.status, 200);
assert((await reloaded.text()).includes("no AI request was sent"));
console.log(JSON.stringify({ test: "HTTPS phone answer → real store → scripted reaction → reload", result: "passed", modelRequests: 0, physicalPhone: "unverified" }));
