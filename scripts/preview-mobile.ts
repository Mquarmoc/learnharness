/**
 * Isolated, zero-network-model demonstration. Uses the existing faux engine and
 * the real session store/turn handler. Never point this script at a learner profile.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const root = path.resolve(import.meta.dirname, "..");
for (const port of [8792, 8793, 8794]) {
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
}

const data = path.join(root, ".fresh-data", "mobile-preview");
fs.mkdirSync(data, { recursive: true });
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(data, "empty-auth.json");
Object.assign(process.env, { NODE_ENV: "test" });
process.env.OPENROUTER_API_KEY = "preview-placeholder-never-dispatched";
const secret = randomBytes(32).toString("hex");
const publicOrigin = process.env.LH_MOBILE_ORIGIN;
if (!publicOrigin) throw new Error("Set LH_MOBILE_ORIGIN to the private HTTPS origin.");
const { createMobileCompanion } = createRequire(import.meta.url)("../electron/mobile-companion.cjs");
const { chatStore } = await import("../src/store/chats.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn, settledTurnResponse } = await import("../src/server/turn-runs.ts");
const { piTurnResponse } = await import("../src/server/pi/ui-stream.ts");
const { eventsResponse } = await import("../src/server/events-stream.ts");
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const model = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
settingsStore.writeSettings({ version: 1, models: { strong: { model }, cheap: { model }, vision: { model } }, graph: { rendering: false } });
const samples = [
	{ title: "Russian — first everyday words (sample)", text: "**Привет** (privet) is an informal hello. **Спасибо** (spasibo) means thank you. This is a scripted preview, so it cannot assess your Russian level.", question: "Which word means thank you?", options: ["Привет", "Спасибо", "Пока"], correct: "Спасибо" },
	{ title: "Luxembourgish — from zero (sample)", text: "**Moien** veut dire bonjour. **Merci** veut dire merci. **Äddi** veut dire au revoir. Cette leçon est un exemple préparé pour tester le téléphone.", question: "Comment dit-on bonjour en luxembourgeois ?", options: ["Äddi", "Moien", "Merci"], correct: "Moien" },
	{ title: "Aviation — four forces (sample)", text: "The four basic forces are **lift**, **weight**, **thrust**, and **drag**. In steady, level flight, the vertical and horizontal forces balance. This is a simple sample lesson, not operational flight guidance.", question: "Which force opposes motion through the air?", options: ["Thrust", "Drag", "Lift"], correct: "Drag" },
];
const question = (sample: typeof samples[number]) => ({ question: sample.question, options: sample.options.map((label) => ({ label })), correctAnswer: sample.correct, explanation: "Sample answer: " + sample.correct + ". This feedback is scripted.", type: "check", nodeId: "basics" });
if (chatStore.listChats().length === 0) for (const sample of samples) {
	const chat = chatStore.createChat(sample.title);
	chatStore.saveSettings(chat.id, { model });
	chatStore.saveTree(chat.id, { version: 1, nodes: [{ id: "basics", title: "First foundations" }], edges: [] });
	const assistant = { ...fauxAssistantMessage([fauxText(sample.text), fauxToolCall("quiz", question(sample), { id: randomBytes(8).toString("hex") })], { stopReason: "toolUse" }), id: "sample_" + randomBytes(8).toString("hex") };
	chatStore.saveMessages(chat.id, [newUserMessage("Start with the basics."), assistant]);
}
const serverLog = fs.openSync(path.join(data, "next.log"), "a");
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "8793"], {
	cwd: root, windowsHide: true, stdio: ["ignore", serverLog, serverLog],
	env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret },
});
process.on("exit", () => child.kill());
const reply = async (response: Response, res: http.ServerResponse) => {
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.flushHeaders();
	if (!response.body) { res.end(); return; }
	const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
	stream.pipe(res);
};
const adapter = http.createServer(async (req, res) => {
	if (req.headers["x-learnharness-desktop"] !== secret) { res.writeHead(403); res.end(); return; }
	try {
		const url = new URL(req.url!, "http://127.0.0.1:8794");
		if (url.pathname === "/api/chat" && req.method === "POST") {
			let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 100_000) throw new Error("Input too long"); }
			JSON.parse(body);
			const faux = createFauxCore({});
			faux.setResponses([fauxAssistantMessage([fauxText("Your answer or message was saved on the preview PC. This response is scripted; no AI request was sent.")])]);
			const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
			return await reply(await handleChatRequest(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
				(opts) => createTeacherAgent(undefined, { engine, messages: opts.messages })), res);
		}
		const match = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/stream$/);
		if (match) {
			const turn = runningTurn(match[1]!);
			return await reply(turn ? piTurnResponse(turn) : settledTurnResponse(), res);
		}
		if (url.pathname === "/api/events") return await reply(eventsResponse(), res);
		const relay = http.request(new URL(req.url!, "http://127.0.0.1:8793"), { method: req.method, headers: { ...req.headers, host: "127.0.0.1:8793" } }, (response) => {
			res.writeHead(response.statusCode!, response.headers); response.pipe(res);
		});
		relay.on("error", () => { res.writeHead(502); res.end("Preview is starting. Reload shortly."); });
		res.on("close", () => relay.destroy());
		req.pipe(relay);
	} catch { if (!res.headersSent) res.writeHead(400); res.end("Could not process preview input."); }
});
await new Promise<void>((resolve) => adapter.listen(8794, "127.0.0.1", resolve));
const gateway = await createMobileCompanion({ target: "http://127.0.0.1:8794", secret, publicOrigin, preview: true });
await gateway.listen(8792);
const pairingFile = path.join(data, "pairing.json");
function issue() { fs.writeFileSync(pairingFile, JSON.stringify(gateway.issuePairing()), { mode: 0o600 }); }
issue();
// Local-only test control: touch this file to issue a fresh preview code.
const controlFile = path.join(data, "request-pairing");
fs.writeFileSync(controlFile, "");
const control = fs.watch(controlFile, () => issue());
// Local IPC is the desktop control seam; this is never an HTTP endpoint.
process.on("message", (message) => { if (message === "pair") issue(); });
const shutdown = () => { control.close(); gateway.close().catch(() => {}); adapter.closeAllConnections(); adapter.close(); child.kill(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
child.on("exit", () => { shutdown(); process.exitCode = 1; });
console.log("Isolated mobile preview ready. Pairing stays in .fresh-data/mobile-preview/pairing.json.");
