# Experimental mobile companion

Continue a desktop lesson or practice session from a phone browser. The PC remains
the host: one session store, one learning graph, and the existing desktop model
connection. Closing LearnHarness or sleeping the PC interrupts phone access.

This feature is experimental. Automated security/learning checks and HTTPS probes
have run; rendered 375px layout, touch/keyboard behavior and a physical phone have
not been verified because browser automation was blocked. Do not treat the sample
preview as a live AI tutor.

## Private desktop setup

Use a **dedicated HTTPS hostname that serves only LearnHarness on every port**.
Browser cookies do not isolate ports. An app on another port of the same hostname
could receive and replay the phone session cookie. A different port on a shared
PC hostname is therefore unsuitable for real learning records. Production mode
rejects explicit non-default HTTPS ports and the desktop asks the operator to
confirm that the whole hostname is dedicated.

For Tailscale, a dedicated Service hostname is one option. Defining a Service and
approving its host require tailnet administration; do not replace existing Serve
routes or broaden access rules. See [Tailscale Services](https://tailscale.com/docs/features/tailscale-services).

1. Build this fork using the normal desktop packaging workflow. The installed
   upstream app does not acquire this feature automatically.
2. Launch that desktop build with `LH_MOBILE_ORIGIN=https://your-dedicated-host`
   and optionally `LH_MOBILE_PORT=8792`. Do not put a path or trailing slash in
   the origin. The companion listener binds only to 127.0.0.1.
3. Route private HTTPS to that listener. Preserve other apps, authentication,
   tailnet policies and routes. Never use public Funnel for this feature.
4. Open **LearnHarness → Mobile companion…** in the desktop application menu.
   Enable it only after confirming the dedicated hostname. Copy the one-use code
   shown in the native dialog to `https://your-dedicated-host/pair` on the phone.
5. Choose an existing session. Model/account setup stays on the desktop.
   The phone's **Sessions** link replaces the desktop sidebar; **Learning map**
   opens the shared graph view. Browser “Add to Home Screen” creates a shortcut.
   There is no offline model execution and no service worker/data cache.

Codes expire in ten minutes. Browser sessions expire after twelve hours or when
the desktop restarts. The desktop menu can issue a new code, disconnect every
phone (including active streams), or stop the listener. **Disconnect phone**
revokes the current session. At most sixteen browser sessions are retained;
eviction also terminates that session's streams.

## Security boundary

The Electron main process owns pairing, revocation and the HTTP relay. It injects
the existing private desktop capability only after authentication and an exact
route/method allowlist. The original Next proxy and trusted-window header injector
remain intact. No desktop capability, provider key, ChatGPT credential or IPC lease
is returned to the phone.

The phone can read learning records and submit learning input; those submissions
can use the desktop's configured model allowance. Keys, provider/account changes,
global/session model settings, file imports, manual background-job creation and
session deletion are denied. New API routes are denied until explicitly reviewed.
GET settings is read-only and contains the existing non-secret settings record.

Requests require the configured host. Writes require the exact origin and
cross-site fetches are denied. Responses use no-store and deny embedding.
Revocation/logout/expiry terminate active responses. Pairing is rate limited.
This is not a security boundary against malware running as the desktop owner or
against script injection in the learning origin.

## Isolated sample preview

`scripts/preview-mobile.ts` deliberately owns only
`.fresh-data/mobile-preview`. It seeds short Russian, Luxembourgish and aviation
examples and injects the repository's faux engine into the real turn handler.
It never uses a real model connection. All model responses identify themselves
as scripted. It does not import, copy or alter the installed learner profile.

Run with `LH_MOBILE_ORIGIN` set to the private preview HTTPS origin:

```powershell
$env:LH_MOBILE_ORIGIN='https://your-pc.your-tailnet.ts.net:8448'
node node_modules/tsx/dist/cli.mjs scripts/preview-mobile.ts
```

The preview reserves loopback 8792 (gateway), 8793 (Next) and 8794 (scripted turn
adapter). Check they are unused first. It permits a shared-host port **only for
synthetic data**, labels the UI accordingly, and writes a one-use test code to
`.fresh-data/mobile-preview/pairing.json`. Touch
`.fresh-data/mobile-preview/request-pairing` to issue a fresh test code. That is
a local test control, never an HTTP administration endpoint.

Keep the preview running while trying it. Stopping it invalidates all browser
sessions. Remove only the preview's Serve route when retiring it; preserve other
routes. No startup task or scheduler is installed.

## Validation

- `tests/mobile-companion.test.ts`: fail-closed authentication, exact API allowlist,
  code expiry/reuse/rate limiting, cookie flags, session expiry/logout/revocation,
  host/origin/header checks and denial of shared-host production configuration.
- Existing desktop capability, scripted teaching, sidebar and setup interaction
  tests cover compatibility.
- `scripts/smoke-mobile-continuity.ts ORIGIN COOKIE_FILE` submits a synthetic quiz
  answer through private HTTPS, reads the persisted answer and scripted reaction,
  and verifies the lesson again after reload. It refuses a non-preview host.
- Five-persona source/HTTP review was performed. Visual/device checks remain open.
