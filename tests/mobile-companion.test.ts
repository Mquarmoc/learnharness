import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { createMobileCompanion, learningRoute } = createRequire(import.meta.url)("../electron/mobile-companion.cjs");
const publicOrigin = "https://phone.tail.test";
const secret = "a".repeat(64);

async function fixture(options: Record<string, unknown> = {}) {
	const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
	const backend = http.createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		seen.push({ method: req.method, url: req.url, headers: req.headers, body });
		if (req.url === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); return; }
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ saved: body || "existing session", header: req.headers["x-learnharness-desktop"] === secret }));
	});
	await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
	const target = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
	let clock = 1000;
	const companion = await createMobileCompanion({ target, secret, publicOrigin, now: () => clock, ...options });
	const port = await companion.listen();
	const request = (pathname: string, method = "GET", cookie = "", body = "", headers: Record<string, string> = {}) =>
		new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
			const req = http.request({ hostname: "127.0.0.1", agent: false, port, path: pathname, method, headers: {
				host: new URL(publicOrigin).host, ...(method !== "GET" ? { origin: publicOrigin } : {}), authorization: cookie, ...headers,
			} }, (res) => {
				let data = ""; res.on("data", (chunk) => data += chunk);
				res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
			});
			req.on("error", reject); req.end(body);
		});
	const pair = async () => {
		const { code } = companion.issuePairing();
		const res = await request("/pair", "POST", "", new URLSearchParams({ code }).toString());
		assert.equal(res.status, 200);
		assert.equal(res.headers["set-cookie"], undefined);
		return { code, cookie: "Bearer " + JSON.parse(res.body).token };
	};
	return { companion, request, pair, seen, port, advance: (ms: number) => clock += ms,
		close: async () => { await companion.close(); backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); } };
}

test("mobile pairing is required for APIs and SSR pages; admin APIs stay desktop-only", async () => {
	const f = await fixture();
	try {
		assert.equal((await f.request("/api/chats")).status, 401);
		assert.match((await f.request("/chat/sample")).body, /mobile-gate/);
		assert.equal(f.seen.length, 0);
		const { cookie } = await f.pair();
		for (const [path, method] of [["/api/keys", "GET"], ["/api/settings/models", "PUT"], ["/api/graph/import", "POST"], ["/api/chats/sample", "DELETE"], ["/api/jobs", "POST"], ["/settings", "GET"], ["/api/unknown", "GET"]]) {
			assert.equal((await f.request(path!, method!, cookie)).status, 403, path);
		}
		assert.equal(f.seen.length, 0);
		assert.equal((await f.request("/api/chats", "GET", cookie)).status, 200);
		assert.equal(f.seen[0]!.headers["x-learnharness-desktop"], secret);
		assert.equal(f.seen[0]!.headers.cookie, "lh-mobile=1");
	} finally { await f.close(); }
});

test("one-use codes, expiry, rate limiting, logout, and desktop revocation fail closed", async () => {
	const f = await fixture();
	try {
		const first = await f.pair();
		assert.equal((await f.request("/pair", "POST", "", "code=" + first.code)).status, 400);
		const expired = f.companion.issuePairing();
		f.advance(600_001);
		assert.equal((await f.request("/pair", "POST", "", "code=" + expired.code)).status, 400);
		assert.equal((await f.request("/mobile/logout", "POST", first.cookie)).status, 303);
		assert.equal((await f.request("/api/chats", "GET", first.cookie)).status, 401);
		const second = await f.pair();
		f.companion.revoke();
		assert.equal((await f.request("/api/events", "GET", second.cookie)).status, 401);
		const third = await f.pair();
		f.advance(12 * 60 * 60 * 1000 + 1);
		assert.equal((await f.request("/api/chats", "GET", third.cookie)).status, 401);
		for (let i = 0; i < 5; i++) assert.equal((await f.request("/pair", "POST", "", "code=wrong")).status, 400);
		assert.equal((await f.request("/pair", "POST", "", "code=wrong")).status, 429);
	} finally { await f.close(); }
});

test("origin/host/encoding checks and header allowlist prevent cross-site and capability forwarding", async () => {
	const f = await fixture();
	try {
		const { cookie } = await f.pair();
		assert.equal((await f.request("/api/chat", "POST", cookie, "{}", { origin: "https://evil.invalid" })).status, 403);
		assert.equal((await f.request("/api/chat", "POST", cookie, "{}", { origin: "" })).status, 403);
		assert.equal((await f.request("/api/chats", "GET", cookie, "", { host: "evil.invalid" })).status, 403);
		assert.equal((await f.request("/api/chats", "GET", cookie, "", { "sec-fetch-site": "cross-site" })).status, 403);
		for (const path of ["/api/%6beys", "//api/keys", "/api/chats/../keys", "/api\\keys"]) assert.notEqual((await f.request(path, "GET", cookie)).status, 200);
		const res = await f.request("/api/chat", "POST", cookie, '{"answer":"bonjour"}', { "content-type": "application/json", "x-learnharness-desktop": "forged", "x-forged-authorization": "Bearer forged" });
		assert.equal(res.status, 200);
		const sent = f.seen.at(-1)!;
		assert.equal(sent.headers["x-learnharness-desktop"], secret);
		assert.equal(sent.headers.authorization, undefined);
		assert.equal(sent.body, '{"answer":"bonjour"}');
		assert.equal(res.headers["cache-control"], "no-store");
	} finally { await f.close(); }
});

test("allowlist supports session continuity, plans/graph and SSE, denies arbitrary new endpoints", () => {
	for (const path of ["/mobile", "/chat/chat_1", "/api/chats/chat_1", "/api/chats/chat_1/stream", "/api/events", "/api/graph", "/api/settings"]) assert(learningRoute("GET", path), path);
	assert(learningRoute("POST", "/api/chat"));
	assert(!learningRoute("POST", "/mobile"));
	assert(!learningRoute("GET", "/api/keys"));
	assert(!learningRoute("PUT", "/api/chats/chat_1/settings"));
});

test("gateway refuses remote targets, weak capabilities, and non-HTTPS public origins", async () => {
	for (const options of [{ target: "https://remote.invalid" }, { secret: "short" }, { publicOrigin: "http://phone.test" }]) {
		await assert.rejects(createMobileCompanion({ target: "http://127.0.0.1:3000", publicOrigin, secret, ...options }));
	}
});

test("shared-host cookies never authorize access; origin-scoped credentials permit the configured HTTPS port", async () => {
    const f = await fixture();
    try {
        const paired = await f.pair();
        const token = paired.cookie.slice(7);
        assert.equal((await f.request("/api/chats", "GET", "", "", { cookie: "__Host-lh-companion=" + token })).status, 401);
        assert.equal((await f.request("/api/chats", "GET", paired.cookie)).status, 200);
    } finally { await f.close(); }
});

test("session-cap eviction and phone logout terminate already-open SSE responses", async () => {
    const f = await fixture();
    try {
        const first = await f.pair();
        // Wrap the promise so Promise resolution does not assimilate the stream-close promise.
        const start = async (cookie: string) => {
            let closed!: Promise<void>;
            await new Promise<void>((resolve, reject) => {
                const req = http.get({ hostname: "127.0.0.1", port: f.port, path: "/api/events", agent: false,
                    headers: { host: new URL(publicOrigin).host, authorization: cookie } }, (res) => {
                    res.on("error", () => {});
                    closed = new Promise<void>((finish) => res.once("close", finish));
                    res.once("data", () => resolve());
                });
                req.on("error", reject);
            });
            return { closed };
        };
        const active = await start(first.cookie);
        for (let i = 0; i < 16; i++) { f.advance(61_000); await f.pair(); }
        await Promise.race([active.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Evicted stream stayed open")), 1000))]);
        assert.equal((await f.request("/api/chats", "GET", first.cookie)).status, 401);
        f.advance(61_000);
        const last = await f.pair();
        const loggedOut = await start(last.cookie);
        assert.equal((await f.request("/mobile/logout", "POST", last.cookie)).status, 303);
        await Promise.race([loggedOut.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Logged-out stream stayed open")), 1000))]);
    } finally { await f.close(); }
});

test("phone login survives host restart with only a hash persisted, and desktop revocation survives the next restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-state-"));
    const stateFile = path.join(dir, "sessions.json");
    let f = await fixture({ stateFile });
    try {
        const { cookie: bearer } = await f.pair();
        assert(!fs.readFileSync(stateFile, "utf8").includes(bearer.slice(7)));
        await f.close();
        f = await fixture({ stateFile });
        assert.equal((await f.request("/api/chats", "GET", bearer)).status, 200);
        f.companion.revoke();
        await f.close();
        f = await fixture({ stateFile });
        assert.equal((await f.request("/api/chats", "GET", bearer)).status, 401);
    } finally {
        await f.close();
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true });
    }
});
