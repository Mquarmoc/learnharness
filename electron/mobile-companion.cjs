const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");

const { bootstrap, worker, gatePage } = require("./mobile-web.cjs");
const PAIR_MS = 10 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Exact route/method allowlist. A new desktop API is private until reviewed here. */
function learningRoute(method, pathname) {
	if (method === "GET" || method === "HEAD") {
		return /^\/(?:mobile|chat\/[A-Za-z0-9_-]+)?$/.test(pathname)
			|| /^\/_next\/static\/[A-Za-z0-9_./-]+$/.test(pathname)
			|| /^\/(?:fonts|images|worklets)\/[A-Za-z0-9_./-]+$/.test(pathname)
			|| /^\/(?:favicon.ico|icon.png|apple-icon.png)$/.test(pathname)
			|| /^\/api\/(?:chats|events|settings|models|search|activity|jobs|graph(?:\/(?:status|costs|positions|render-settings|nodes\/[A-Za-z0-9_-]+))?)$/.test(pathname)
			|| /^\/api\/chats\/[A-Za-z0-9_-]+(?:\/(?:stream|settings|markdown))?$/.test(pathname);
	}
	if (method === "POST") return /^\/api\/(?:chat|chats|activity\/abort|chats\/[A-Za-z0-9_-]+\/(?:steer|dismiss|artifact-ui))$/.test(pathname);
	return method === "PUT" && /^\/api\/chats\/[A-Za-z0-9_-]+$/.test(pathname);
}

function pairingPage(error = "", preview = false) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#141414"><title>Pair LearnHarness</title>
<style> *{box-sizing:border-box}body{margin:0;background:#141414;color:#e6e6e6;font:17px/1.5 system-ui;padding:max(24px,env(safe-area-inset-top)) 20px}main{max-width:440px;margin:8vh auto}h1{font-size:30px}p{color:#bbb}label{display:block;margin:24px 0 8px}input,button{font:inherit;border:1px solid #666;border-radius:8px;min-height:48px;width:100%;padding:12px;background:#222;color:inherit}input{font-size:16px}button{margin-top:16px;background:#e6e6e6;color:#141414;font-weight:600;cursor:pointer}:focus-visible{outline:3px solid #a8c9ff;outline-offset:3px}.error{color:#ffb7b7;min-height:26px}.note{border:1px solid #666;padding:12px;border-radius:8px}small{color:#aaa}</style><script src="/mobile-bootstrap.js" defer></script></head><body><main>
<h1>LearnHarness on your phone</h1><p>Continue learning from your PC. Keep the PC awake and LearnHarness open.</p>
${preview ? '<p class="note">Test preview: sample lessons only. No AI account is connected and no model requests are sent.</p>' : ""}
<form method="post" action="/pair"><label for="code">Pairing code from your desktop</label><input id="code" name="code" required maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="help error"><p id="help"><small>${preview ? "Use the test code supplied with this preview link. If it expires, request a fresh test code." : "On the PC, open LearnHarness → Mobile companion."} Each code works once and expires after 10 minutes.</small></p><p id="error" class="error" role="alert">${error}</p><button disabled>Connect this phone</button><noscript>JavaScript is required to pair this phone securely.</noscript></form><p><small>Private HTTPS access. No password or AI key is needed on this phone. After connecting, you can add this page to your home screen.</small></p></main></body></html>`;
}

async function createMobileCompanion({ target, secret, publicOrigin, now = Date.now, preview = false, stateFile }) {
	const upstream = new URL(target);
	const origin = new URL(publicOrigin);
	if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(upstream.hostname)
		|| upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("Mobile target must be the owned loopback server origin.");
	if (origin.protocol !== "https:" || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error("Mobile access requires an exact HTTPS origin.");
	if (!secret || secret.length < 64) throw new Error("Mobile access requires the private desktop capability.");
	// Authentication uses an origin-scoped browser session, never a shared-host cookie.

    const sessions = new Map();
    if (stateFile && fs.existsSync(stateFile)) {
        try {
            const rows = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            if (!Array.isArray(rows) || rows.length > 16 || rows.some((row) => !Array.isArray(row) || !/^[a-f0-9]{64}$/.test(row[0]) || !Number.isFinite(row[1]))) throw new Error("Invalid session state");
            for (const [key, expiry] of rows) if (expiry > now() && expiry <= now() + SESSION_MS) sessions.set(key, expiry);
        } catch { console.error("Phone sessions could not be restored. Pair this phone again."); }
    }
    function persistSessions() {
        if (!stateFile) return;
        const temporary = stateFile + ".tmp";
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify([...sessions]), { mode: 0o600 });
        fs.renameSync(temporary, stateFile);
    }
	let pairing = null;
	let attempts = [];
	const sockets = new Set();
	const liveResponses = new Map();
    function closeSession(key, except) {
        sessions.delete(key);
        persistSessions();
        for (const response of liveResponses.get(key) ?? []) if (response !== except) response.destroy();
    }
	function json(res, status, value) {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	}
	function page(res, status, error = "") {
		res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
		res.end(pairingPage(error, preview));
	}
	const server = http.createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
		// Do not trust forwarded host/origin headers, including from a reverse proxy.
		if (req.headers.host !== origin.host) return json(res, 403, { error: "Use the configured private HTTPS address." });
		if (!req.url?.startsWith("/") || /[%\\]|\/\//.test(req.url.split("?")[0])) return json(res, 400, { error: "Invalid path." });
		const url = new URL(req.url, publicOrigin);
		const pathname = url.pathname;
		if (req.headers["sec-fetch-site"] === "cross-site"
			|| (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== publicOrigin)) {
			return json(res, 403, { error: "Open this page directly before submitting." });
		}
        if (req.method === "GET" && ["/mobile-worker.js", "/mobile-bootstrap.js"].includes(pathname)) {
            res.setHeader("Content-Type", "application/javascript; charset=utf-8");
            res.setHeader("Service-Worker-Allowed", "/");
            res.end(pathname === "/mobile-worker.js" ? worker : bootstrap);
            return;
        }
		if (pathname === "/pair" && req.method === "GET") return page(res, 200);
		if (pathname === "/pair" && req.method === "POST") {
			const pairError = (status, error) => req.headers.accept?.includes("application/json") ? json(res, status, { error }) : page(res, status, error);
            attempts = attempts.filter((time) => time > now() - 60_000);
			if (attempts.length >= 5) { res.setHeader("Retry-After", "60"); return pairError( 429, "Too many attempts. Wait one minute, then try again."); }
			attempts.push(now());
			try {
				let body = "";
				for await (const chunk of req) {
					body += chunk;
					if (body.length > 1024) return pairError( 413, "That code is too long.");
				}
				const supplied = new URLSearchParams(body).get("code")?.replace(/-/g, "").trim().toLowerCase() ?? "";
				const hash = digest(supplied);
				if (!pairing || now() >= pairing.expires || !timingSafeEqual(Buffer.from(hash), Buffer.from(pairing.hash))) {
					return pairError( 400, "This code is invalid, expired, or already used. Get a new code on the PC.");
				}
				pairing = null; // Consume synchronously: concurrent submissions cannot both succeed.
				for (const [key, expiry] of sessions) if (expiry <= now()) closeSession(key);
				if (sessions.size >= 16) closeSession(sessions.keys().next().value);
				const token = randomBytes(32).toString("hex");
				sessions.set(digest(token), now() + SESSION_MS);
                persistSessions();
				return json(res, 200, { token, expiresAt: now() + SESSION_MS });
			} catch { return pairError( 400, "Could not read that code. Please try again."); }
		}
		const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
		const key = digest(token);
		if (!token || (sessions.get(key) ?? 0) <= now()) {
			closeSession(key);
			if (pathname.startsWith("/api/") || pathname === "/mobile/status") return json(res, 401, { error: "Pair this phone again on the PC." });
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			return res.end(gatePage());
		}
        const live = liveResponses.get(key) ?? new Set();
        liveResponses.set(key, live);
        live.add(res);
        const expiry = setTimeout(() => res.destroy(), Math.max(1, sessions.get(key) - now()));
        const release = () => { clearTimeout(expiry); live.delete(res); if (live.size === 0) liveResponses.delete(key); };
        res.once("finish", release);
        res.once("close", release);
		if (pathname === "/mobile/status" && req.method === "GET") return json(res, 200, { companion: true, preview, expiresAt: sessions.get(key) });
		if (pathname === "/mobile/logout" && req.method === "POST") {
			closeSession(key, res);
			res.writeHead(303, { Location: "/pair" });
			return res.end();
		}
		if (pathname === "/manifest.webmanifest" && req.method === "GET") {
			res.setHeader("Content-Type", "application/manifest+json");
			return res.end(JSON.stringify({ name: "LearnHarness", short_name: "LearnHarness", start_url: "/mobile", display: "standalone", background_color: "#141414", theme_color: "#141414" }));
		}
		if (!learningRoute(req.method, pathname)) return json(res, 403, { error: "This action is available on the desktop only." });
		// Build headers from an allowlist: never forward cookies, credentials or a client capability.
		const headers = { host: upstream.host, "x-learnharness-desktop": secret, cookie: "lh-mobile=1" };
		for (const name of ["accept", "content-type", "content-length", "last-event-id", "rsc", "next-router-state-tree", "next-router-prefetch", "next-url"]) {
			if (req.headers[name]) headers[name] = req.headers[name];
		}
		const relay = http.request(new URL(req.url, upstream), { method: req.method, headers }, (response) => {
			const responseHeaders = { ...response.headers, "cache-control": "no-store", "referrer-policy": "no-referrer",
				"content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff" };
			delete responseHeaders["set-cookie"];
			res.writeHead(response.statusCode, responseHeaders);
			response.pipe(res);
			response.on("error", () => res.destroy());
		});
		relay.on("error", () => { if (!res.headersSent) json(res, 502, { error: "The desktop is unavailable. Keep LearnHarness open, then reload." }); else res.destroy(); });
		res.on("close", () => relay.destroy());
		req.pipe(relay);
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	return {
		issuePairing() {
			const code = randomBytes(10).toString("hex");
			pairing = { hash: digest(code), expires: now() + PAIR_MS };
			return { code: code.match(/.{4}/g).join("-"), expiresAt: pairing.expires };
		},
		revoke() {
			pairing = null; sessions.clear();
            persistSessions();
			for (const socket of sockets) socket.destroy(); // End existing SSE/stream access too.
		},
		async listen(port = 0) {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
			return server.address().port;
		},
		async close() {
			pairing = null;
            for (const socket of sockets) socket.destroy();
            sessions.clear(); // Persisted hashes survive normal host restart until their original expiry.
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
module.exports = { createMobileCompanion, learningRoute };
