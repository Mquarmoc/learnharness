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
