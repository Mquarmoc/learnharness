/** Verify the installed Electron auth module with synthetic OAuth only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert(process.argv[2], "Pass the packaged electron/chatgpt.cjs path.");
const authPath = resolve(process.argv[2]);
const require = createRequire(authPath);
const { createChatGPT, SCOPES } = require(authPath);
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(require.resolve("jose")).href);
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "synthetic-runtime-key", alg: "RS256", use: "sig" };
let saved = null, authorization, refreshes = 0;
let complete;
const completed = new Promise((done) => { complete = done; });
async function signed(client, nonce) {
    return new SignJWT(nonce ? { nonce } : {}).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer("https://auth.openai.com").setSubject("synthetic-runtime-user")
        .setAudience(client).setIssuedAt().setExpirationTime("1h").sign(privateKey);
}
const options = {
    store: { read: async () => structuredClone(saved), write: async (value) => { saved = structuredClone(value); } },
    openExternal: async (value) => { authorization = new URL(value); },
    timeoutMs: 5000,
    onChange: (value) => { if (authorization && !value.status.pending) complete(); },
    fetch: async (url, init = {}) => {
        if (url === "https://auth.openai.com/.well-known/jwks.json") return Response.json({ keys: [jwk] });
        if (url === "https://auth.openai.com/api/accounts/oauth/token") {
            const fields = init.body;
            const refresh = fields.get("grant_type") === "refresh_token";
            if (refresh) refreshes++;
            return Response.json({
                access_token: refresh ? "synthetic-renewed-access" : "synthetic-initial-access",
                refresh_token: refresh ? "synthetic-renewed-refresh" : "synthetic-initial-refresh",
                id_token: await signed(fields.get("client_id"), refresh ? undefined : authorization.searchParams.get("nonce")),
                token_type: "Bearer", expires_in: refresh ? 3600 : 1, scope: SCOPES.join(" "),
            });
        }
        if (url === "https://api.openai.com/v1/models") return Response.json({
            models: [{ slug: "synthetic-runtime-model", display_name: "Synthetic model", visibility: "list" }],
        });
        throw new Error("Unexpected request in synthetic auth smoke check.");
    },
};
const connection = createChatGPT(options);
try {
    await connection.login();
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({
        state: authorization.searchParams.get("state"), code: "synthetic-runtime-code", client_id: "oaiapp_runtime_smoke",
    }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await completed;
    assert.equal((await connection.status()).accounts[0]?.connected, true, "Packaged sign-in verification failed.");
    assert.equal((await connection.models()).models.length, 1, "Packaged refresh verification failed.");
    assert.equal(refreshes, 1);
} finally { connection.close(); }
const restarted = createChatGPT(options);
try {
    assert.equal((await restarted.models()).models.length, 1);
    assert.equal((await restarted.status()).accounts[0]?.connected, true);
    assert.equal(refreshes, 1, "A persisted fresh credential should survive restart.");
} finally { restarted.close(); }
console.log(JSON.stringify({ ok: true, signInVerified: true, refreshVerified: true, restartVerified: true, realProviderRequests: 0 }));
