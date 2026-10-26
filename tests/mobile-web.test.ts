import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const { worker, bootstrap } = createRequire(import.meta.url)("../electron/mobile-web.cjs");
const origin = "https://pc.tail.test:8448";

class Channel {
    port1: any = {};
    port2: any;
    constructor() { this.port2 = { postMessage: (data: any) => this.port1.onmessage?.({ data }) }; }
}

function fixture(recoveredToken?: string) {
	const listeners = new Map<string, (event: any) => void>();
	const fetched: Request[] = [];
	const self = { location: { origin }, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
		clients: { get: async () => recoveredToken ? { postMessage: (_value: unknown, ports: any[]) => ports[0].postMessage(recoveredToken) } : null, claim: async () => {} }, skipWaiting: async () => {} };
	vm.runInNewContext(worker, { self, URL, Headers, Request, MessageChannel: Channel, setTimeout, clearTimeout,
		fetch: async (request: Request) => { fetched.push(request); return new Response("ok"); } });
	return { listeners, fetched };
}

test("mobile worker injects its own origin-scoped bearer, never a cookie or cross-port credential", async () => {
	const f = fixture();
	const message = f.listeners.get("message")!;
	message({ origin, source: { url: origin + "/mobile" }, data: { type: "lh-session", token: "safe-token" }, ports: [] });
	let response!: Promise<Response>;
	f.listeners.get("fetch")!({ request: new Request(origin + "/api/chats"), respondWith: (value: Promise<Response>) => response = value });
	await response;
	assert.equal(f.fetched[0]!.headers.get("authorization"), "Bearer safe-token");
	assert.equal(f.fetched[0]!.credentials, "omit");
	assert.equal(f.fetched[0]!.cache, "no-store");
	let intercepted = false;
	f.listeners.get("fetch")!({ request: new Request("https://pc.tail.test:8443/api/chats"), respondWith: () => intercepted = true });
	assert.equal(intercepted, false);
	message({ origin: "https://pc.tail.test:8443", source: { url: "https://pc.tail.test:8443/" }, data: { type: "lh-session", token: "forged" }, ports: [] });
	f.listeners.get("fetch")!({ request: new Request(origin + "/api/events"), respondWith: (value: Promise<Response>) => response = value });
	await response;
	assert.equal(f.fetched.at(-1)!.headers.get("authorization"), "Bearer safe-token");
});

test("public pairing/bootstrap requests do not receive a bearer; browser token lives in per-origin localStorage", () => {
	const f = fixture();
	for (const path of ["/pair", "/mobile-worker.js", "/mobile-bootstrap.js"]) {
		let intercepted = false;
		f.listeners.get("fetch")!({ request: new Request(origin + path), respondWith: () => intercepted = true });
		assert.equal(intercepted, false, path);
	}
	assert.match(bootstrap, /localStorage\.setItem\(key, result.token\)/);
	assert(!worker.includes("caches."));
	assert(!bootstrap.includes("document.cookie"));
});

async function browserFixture(success = true, options: { mode?: "pair" | "gate" | "app"; storage?: Map<string, string>; stalled?: boolean } = {}) {
    const storage = options.storage ?? new Map<string, string>();
    const formHandlers = new Map<string, (event: any) => Promise<void>>();
    const timers = new Map<number, () => void>();
    const button = { disabled: true };
    const error = { textContent: "" };
    let navigation = "", reloads = 0, nextTimer = 0;
    const messages: any[] = [];
    const worker = { postMessage: (message: any, ports: any[]) => { messages.push(message); ports[0].postMessage("ok"); } };
    const form = { addEventListener: (name: string, listener: any) => formHandlers.set(name, listener), querySelector: () => button };
    const serviceWorker = { controller: {}, addEventListener: () => {}, register: async () => ({ active: worker }),
        ready: options.stalled ? new Promise(() => {}) : Promise.resolve({ active: worker }) };
    const mode = options.mode ?? "pair";
    vm.runInNewContext(bootstrap, {
        navigator: { serviceWorker }, location: { origin, assign: (value: string) => navigation = value, replace: (value: string) => navigation = value, reload: () => reloads++ },
        localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
        document: { readyState: "complete", getElementById: (id: string) => id === "error" ? error : id === "mobile-gate" && mode === "gate" ? {} : null, querySelector: () => mode === "pair" ? form : null },
        MessageChannel: Channel, URLSearchParams, AbortSignal,
        setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id: number) => timers.delete(id),
        FormData: class { *[Symbol.iterator]() { yield ["code", "sample-code"]; } },
        fetch: async () => ({ ok: success, json: async () => success ? { token: "scoped-token" } : { error: "This code has expired. Get a new code on the PC." } }),
    });
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);
    return { button, error, storage, messages, timers, navigation: () => navigation, reloads: () => reloads,
        submit: () => formHandlers.get("submit")!({ preventDefault() {} }) };
}

test("pairing form enables after worker readiness, saves scoped token and opens real sessions", async () => {
	const browser = await browserFixture();
	assert.equal(browser.button.disabled, false);
	await browser.submit();
	assert.equal(browser.storage.get("lh-phone-session"), "scoped-token");
	assert.equal(browser.messages.at(-1).token, "scoped-token");
	assert.equal(browser.navigation(), "/mobile");
});

test("expired pairing shows a useful error and permits retry without storing a token", async () => {
	const browser = await browserFixture(false);
	await browser.submit();
	assert.match(browser.error.textContent, /expired/);
	assert.equal(browser.button.disabled, false);
	assert.equal(browser.storage.has("lh-phone-session"), false);
	assert.equal(browser.navigation(), "");
});

test("suspended worker recovers the bearer from its controlled client", async () => {
    const f = fixture("recovered-token");
    let response!: Promise<Response>;
    f.listeners.get("fetch")!({ request: new Request(origin + "/api/events"), clientId: "phone-window",
        respondWith: (value: Promise<Response>) => response = value });
    await response;
    assert.equal(f.fetched[0]!.headers.get("authorization"), "Bearer recovered-token");
});

test("connection shell restores a stored session once, and an expired token returns to pairing without a reload loop", async () => {
    const storage = new Map([["lh-phone-session", "stored-token"]]);
    const first = await browserFixture(true, { mode: "gate", storage });
    assert.equal(first.reloads(), 1);
    assert.equal(first.messages.at(-1).token, "stored-token");
    const second = await browserFixture(true, { mode: "gate", storage });
    assert.equal(second.reloads(), 0);
    assert.equal(second.navigation(), "/pair");
    assert.equal(storage.has("lh-phone-session"), false);
});

test("successful controlled page clears the connection-shell retry marker", async () => {
    const storage = new Map([["lh-phone-session", "stored-token"], ["lh-phone-bootstrap", "stored-token"]]);
    const browser = await browserFixture(true, { mode: "app", storage });
    assert.equal(storage.has("lh-phone-bootstrap"), false);
    assert.equal(storage.get("lh-phone-session"), "stored-token");
    assert.equal(browser.navigation(), "");
});

test("worker installation deadline produces recovery text instead of an endless disabled button", async () => {
    const browser = await browserFixture(true, { stalled: true });
    for (const callback of [...browser.timers.values()]) callback();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.match(browser.error.textContent, /Reload this page/);
});
