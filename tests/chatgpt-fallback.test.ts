import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { refreshSubscriptionModels } from "../src/agent/subscription-bridge.ts";
import { NATIVE_SUBSCRIPTIONS } from "../src/core/contracts/subscriptions.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send"), originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const saved = Object.fromEntries(["LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_FALLBACK_MODEL"].map((key) => [key, process.env[key]]));
const model = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
const grok = piModels().getModels("xai")[0]!;
const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: true }], error: null };
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const context = () => normalizeContext({ messages: [{ role: "user", content: "Offline fixture", timestamp: 0 }] });
let grokConnected = true;
function reply(message: any): unknown {
	if (message.channel === "lh:chatgpt") return message.op === "lease" ? { accessToken: "scratch-oauth-only", accountId: "scratch-account", epoch: 1, authorityRevision: 1, revision: 1 } : { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: [{ id: model.id, name: "Scratch account model" }] };
	if (message.op === "lease") return { scope: message.scope, auth: { apiKey: "fixture-grok-oauth" } };
	return {
		statuses: NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, available: true, connected: grokConnected, pending: false, allowBackgroundUse: true, connectionId: `fixture-${p.providerId}`, epoch: 1, authorityRevision: 1, revision: grokConnected ? 1 : 2 })),
		models: Object.fromEntries(NATIVE_SUBSCRIPTIONS.map((p) => [p.providerId, piModels().getModels(p.providerId)])),
	};
}
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => ipc({ channel: message.channel, id: message.id, op: message.op, ok: true, value: reply(message) }));
		callback?.(); return true;
	} });
	await refreshChatGPTModels([model]); await refreshSubscriptionModels();
});
after(() => {
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
/** ChatGPT answers 429 (plan limit); Grok answers 401 so its own error identifies which route ran. */
async function run() {
	const origins: string[] = [];
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	const result = await engine.streamFn(engine.model, context(), {
		fetch: async (input, init) => {
			const origin = new URL(new Request(input, init).url).origin; origins.push(origin);
			return new Response('{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}', { status: origin === "https://api.openai.com" ? 429 : 401, headers: { "content-type": "application/json" } });
		},
	}).result();
	return { origins, result };
}

test("without LH_FALLBACK_MODEL a ChatGPT plan limit stays a ChatGPT error", async () => {
	delete process.env.LH_FALLBACK_MODEL;
	const { origins, result } = await run();
	assert.deepEqual(origins, ["https://api.openai.com"]);
	assert.equal(result.provider, "chatgpt"); assert.match(result.errorMessage ?? "", /usage limit reached/);
});

test("with LH_FALLBACK_MODEL a ChatGPT plan limit reruns the call on the Grok subscription", async () => {
	process.env.LH_FALLBACK_MODEL = `xai-subscription:${grok.id}`;
	const { origins, result } = await run();
	assert.deepEqual(origins, ["https://api.openai.com", "https://api.x.ai"]);
	assert.equal(result.provider, "xai-subscription"); assert.equal(result.model, grok.id);
});

test("an unavailable fallback connection keeps the original ChatGPT error", async () => {
	process.env.LH_FALLBACK_MODEL = `xai-subscription:${grok.id}`; grokConnected = false;
	const { origins, result } = await run();
	assert.deepEqual(origins, ["https://api.openai.com"]);
	assert.equal(result.provider, "chatgpt"); assert.match(result.errorMessage ?? "", /usage limit reached/);
});
