// Browser storage and service workers are isolated by scheme + host + port.
const bootstrap = `
(() => {
  const key = "lh-phone-session";
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data !== "lh-session") return;
    event.ports[0]?.postMessage(localStorage.getItem(key) || "");
  });
  const deadline = (promise, message) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 8000); })]).finally(() => clearTimeout(timer));
  };
  const control = () => navigator.serviceWorker.controller ? Promise.resolve() : deadline(new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })), "Could not activate phone access. Reload this page and try again.");
  const run = async () => {
    const error = document.getElementById("error");
    try {
      if (!navigator.serviceWorker) throw new Error("This browser needs service-worker support. Try a current Safari or Chrome browser.");
      const registration = await deadline(navigator.serviceWorker.register("/mobile-worker.js", { scope: "/", updateViaCache: "none" }), "Phone access could not start. Reload this page and try again.");
      const ready = await deadline(navigator.serviceWorker.ready, "Phone access could not start. Reload this page and try again.");
      const setToken = (token) => new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error("Could not connect this browser. Reload and try again.")), 8000);
        channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
        (ready.active || registration.active).postMessage({ type: "lh-session", token }, [channel.port2]);
      });
      const form = document.querySelector('form[action="/pair"]');
      if (form) {
        localStorage.removeItem(key);
        localStorage.removeItem("lh-phone-bootstrap");
        await setToken("");
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = form.querySelector("button");
          if (button.disabled) return;
          button.disabled = true;
          error.textContent = "";
          try {
            const response = await fetch("/pair", { method: "POST", headers: { Accept: "application/json" }, body: new URLSearchParams(new FormData(form)), cache: "no-store", signal: AbortSignal.timeout(15000) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Could not pair. Get a new code on the PC.");
            localStorage.setItem(key, result.token);
            await setToken(result.token);
            await control();
            location.assign("/mobile");
          } catch (failure) { error.textContent = failure.message; button.disabled = false; }
        });
        form.querySelector("button").disabled = false;
        return;
      }
      if (document.getElementById("mobile-gate")) {
        const token = localStorage.getItem(key);
        if (!token || localStorage.getItem("lh-phone-bootstrap") === token) { localStorage.removeItem(key); location.replace("/pair"); return; }
        localStorage.setItem("lh-phone-bootstrap", token);
        await setToken(token);
        await control();
        location.reload();
      } else {
        localStorage.removeItem("lh-phone-bootstrap");
        const token = localStorage.getItem(key);
        if (token) await setToken(token);
      }
    } catch (failure) {
      if (error) error.textContent = failure.message;
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else void run();
})();
`;

const worker = `
let token = "";
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.origin !== self.location.origin || !event.source?.url?.startsWith(self.location.origin + "/")) return;
  if (event.data?.type !== "lh-session" || typeof event.data.token !== "string") return;
  token = event.data.token;
  event.ports[0]?.postMessage("ok");
});
async function sessionFor(event) {
  if (token) return token;
  const client = event.clientId && await self.clients.get(event.clientId);
  if (!client) return "";
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(""), 1500);
    channel.port1.onmessage = (message) => { clearTimeout(timer); token = typeof message.data === "string" ? message.data : ""; resolve(token); };
    client.postMessage("lh-session", [channel.port2]);
  });
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || ["/pair", "/mobile-worker.js", "/mobile-bootstrap.js"].includes(url.pathname)) return;
  event.respondWith((async () => {
    const auth = await sessionFor(event);
    const headers = new Headers(event.request.headers);
    if (auth) headers.set("Authorization", "Bearer " + auth); else headers.delete("Authorization");
    return fetch(new Request(event.request, { headers, cache: "no-store", credentials: "omit" }));
  })());
});
`;

function gatePage() {
	return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect LearnHarness</title><script src="/mobile-bootstrap.js" defer></script></head><body style="background:#141414;color:#eee;font:18px system-ui;padding:24px"><main id="mobile-gate"><p>Connecting to your LearnHarness desktopâ€¦</p><p id="error" role="alert"></p><a style="color:#eee;display:inline-flex;align-items:center;min-height:44px;padding:0 8px" href="/pair">Pair this phone</a></main></body></html>';
}
module.exports = { bootstrap, worker, gatePage };
