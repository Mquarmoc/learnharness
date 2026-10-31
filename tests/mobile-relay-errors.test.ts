import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { createRequire } from "node:module";
const { createMobileCompanion } = createRequire(import.meta.url)("../electron/mobile-companion.cjs");

test("upstream refusal has a local diagnostic without bearer, capability, body or query data", async () => {
 const server = http.createServer();
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 const port = (server.address() as { port: number }).port;
 await new Promise<void>(resolve => server.close(() => resolve()));
 const origin = "https://phone.tail.test";
 const companion = await createMobileCompanion({ target: "http://127.0.0.1:" + port, secret: "c".repeat(64), publicOrigin: origin });
 const gateway = await companion.listen();
 const call = (path: string, method: string, body = "", token = "") => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const request = http.request({ hostname: "127.0.0.1", port: gateway, agent: false, path, method,
   headers: { Host: new URL(origin).host, Origin: origin, Accept: "application/json", Authorization: "Bearer " + token },
  }, response => {
   let result = ""; response.on("data", chunk => result += chunk);
   response.on("end", () => resolve({ status: response.statusCode!, body: result }));
  });
  request.on("error", reject); request.end(body);
 });
 const warning = console.warn;
 const logs: string[] = [];
 console.warn = (...args) => { logs.push(args.join(" ")); };
 try {
  const { code } = companion.issuePairing();
  const paired = await call("/pair", "POST", new URLSearchParams({ code }).toString());
  const token = JSON.parse(paired.body).token;
  const response = await call("/api/chat?secret-query=fixture-query", "POST", "fixture-private-answer", token);
  assert.equal(response.status, 502);
  assert.match(logs.join("\n"), /ECONNREFUSED/);
  assert.match(logs.join("\n"), /POST/);
  for (const secret of [token, "c".repeat(64), "fixture-private-answer", "fixture-query"]) assert(!logs.join("\n").includes(secret));
 } finally {
  console.warn = warning;
  await companion.close();
 }
});

test("two answer submissions each use a fresh upstream connection and are never replayed", async () => {
 const uses = new WeakMap<object, number>();
 let accepted = 0, received = 0;
 const backend = http.createServer(async (request, response) => {
  request.on("error", () => {});
  received++;
  const count = (uses.get(request.socket) ?? 0) + 1;
  uses.set(request.socket, count);
  if (count > 1) { request.socket.destroy(); return; } // Reproduce the observed reused-socket reset.
  let body = "";
  for await (const chunk of request) body += chunk;
  accepted++;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ body }));
 });
 await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
 const target = "http://127.0.0.1:" + (backend.address() as { port: number }).port;
 const origin = "https://phone.tail.test";
 const companion = await createMobileCompanion({ target, secret: "c".repeat(64), publicOrigin: origin });
 const gateway = await companion.listen();
 const call = (path: string, body: string, token = "") => new Promise<{status: number; body: string}>((resolve, reject) => {
  const request = http.request({ hostname: "127.0.0.1", port: gateway, agent: false, path, method: "POST",
   headers: { Host: new URL(origin).host, Origin: origin, Accept: "application/json", Authorization: "Bearer " + token, "Content-Type": "application/json" },
  }, response => {
   let data = ""; response.on("data", chunk => data += chunk);
   response.on("end", () => resolve({ status: response.statusCode!, body: data }));
  });
  request.on("error", reject); request.end(body);
 });
 try {
  const { code } = companion.issuePairing();
  const paired = await call("/pair", new URLSearchParams({ code }).toString());
  const token = JSON.parse(paired.body).token;
  for (const body of ['{"answer":"first"}', '{"answer":"second"}']) {
   const response = await call("/api/chat", body, token);
   assert.equal(response.status, 200);
   assert.equal(JSON.parse(response.body).body, body);
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(received, 2, "exactly one upstream request per learner submission");
  assert.equal(accepted, 2);
 } finally {
  await companion.close();
  backend.closeAllConnections();
  await new Promise<void>(resolve => backend.close(() => resolve()));
 }
});
