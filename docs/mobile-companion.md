# Mobile companion

Open the **same teaching/practice sessions and learning graph** on the desktop and
phone. There is one desktop backend and one original learner profile; there is
no second database, copying or periodic synchronization.

The desktop app hosts the model connection. Phone learning input uses the
desktop's existing provider and allowance. Provider keys, OAuth credentials and
private IPC leases never go to the phone.

## Private setup

Use private HTTPS, for example Tailscale Serve routed to the loopback companion
listener. Keep existing routes, application authentication and tailnet policies.
Do not enable public Funnel. The phone needs private tailnet access.

Configure the packaged desktop build with:

- `LH_MOBILE_ORIGIN`: exact HTTPS origin, including an optional port, no trailing slash.
- `LH_MOBILE_PORT`: loopback listener port, default 8792.
- `LH_USER_DATA_DIR`: optional explicit **existing** LearnHarness profile. The
  directory contains data/ and the existing connection files. Do not copy keys.
  This also supports an existing Windows MSIX-virtualized profile.
- `LH_MOBILE_AUTO_START=1`: start the companion with the desktop.
- Optional local control paths: `LH_MOBILE_PAIRING_FILE`,
  `LH_MOBILE_CONTROL_FILE` and `LH_MOBILE_STATE_FILE`.

On Windows, inspect sessions from the actual launcher context before selecting
a profile: packaged applications can see redirected files merged into the normal
Roaming path. A scheduled task can see a different set at that same logical path.
Back up learning records before a deliberate recovery; never overwrite a session
or copy provider credentials between profiles.

Normally, open **LearnHarness → Mobile companion…** on the PC and enter its code
at `/pair` on the phone. Codes work once and expire in ten minutes. The desktop
can issue another code, disconnect all phones, or disable the listener.

The phone's **Sessions** link replaces the desktop sidebar. Pick the same saved
session you use on the PC. **Learning map** opens the shared graph. Account,
model and import administration stay on the desktop.

## Browser authentication and restart

Authentication uses an origin-scoped browser token: scheme, hostname **and port**.
The service worker attaches it to this origin's navigation, API and SSE requests.
It never sends it to another origin. Authentication cookies are neither issued
nor accepted, so other applications on the same hostname's other ports do not
receive this token.

The token is stored in this browser origin's localStorage. Only its hash and
original expiry are persisted at the optional local state file. It expires after
twelve hours; restart does not extend that lifetime. With a state file configured,
phone login survives host restart. Disconnect/revoke is persisted too.

The service worker recovers its token from a controlled client after being
suspended. An uncontrolled or stale navigation receives an empty connection
shell, never learner data. Invalid sessions return to pairing after one retry.
Initialization and pairing have deadlines with recovery messages.

“Add to Home Screen” uses the same authenticated browser origin when the browser
shares that storage; a new browser/profile may require pairing. There is no
CacheStorage or offline model execution. Learning records and provider credentials
are not cached by the service worker.

## Windows restart setup

`scripts/windows-mobile-host.pyw` is the quiet Task Scheduler launcher. Place it
beside the packaged LearnHarness.exe with host-config.json:

```json
{ "profile": "C:\\path\\to\\existing\\LearnHarness", "origin": "https://your-pc.your-tailnet.ts.net:8448", "port": 8792 }
```

Register a limited current-user **At log on** task executing pythonw.exe directly,
with this launcher as its argument and this directory as working directory.
Avoid virtual-environment launchers that start a detached second Python process.
Use IgnoreNew, no execution time limit and bounded restart-on-failure settings.
This starts in the background after Windows sign-in; it does not provide service
before sign-in. Point desktop and Start Menu shortcuts at the same launcher with
--open: it asks the existing scheduled task to run and shows its window, rather
than starting an unmanaged second host.

Closing the desktop window hides it while mobile access is enabled. The model
connection and phone listener stay running. Reopen the normal shortcut to show
the window. **Quit and stop phone access** deliberately stops the app; the shortcut
or the next Windows sign-in starts it again. An unexpected backend exit ends the
host with a failure code. Its existing launcher restarts it after five seconds,
up to five times; an explicit Quit returns success and stops these retries.
Task Scheduler retains its separate fallback failure policy.

The launcher locks out duplicate hosts, creates the app suspended, assigns a
kill-on-close Windows Job Object, then resumes it. Stopping the task ends its
owned app/backend process tree. Children use CREATE_NO_WINDOW. A persistent
Tailscale Serve route remains configured across host restarts.

Use an install directory outside a disposable conversation checkout. Startup and
connection status files belong in its run/ directory, outside learner data.
The optional request-pairing control file issues a fresh code when touched.
The connection status contains booleans/counts and public error text, never tokens.
Companion startup failure is caught so the desktop can still open.

## Unpacked desktop authentication check

An unpacked desktop installation must include the locked `jose` package under
`resources/app/node_modules/jose`. The main process verifies ChatGPT ID tokens
there; a development checkout or the standalone server payload does not prove
that this dependency is available to the installed desktop module.

After assembling or updating the installation, run:

```sh
node scripts/smoke-desktop-auth.mjs C:/path/to/resources/app/electron/chatgpt.cjs
```

This uses the installed authentication module, synthetic signed credentials and
an ephemeral loopback callback to check sign-in, rotated-token verification and
restoring a fresh connection. It reads no real credential store and sends no
requests to a provider.

## Validation and limits

Security tests cover authorization, host/origin boundaries, exact route/method
allowlist, pairing expiry/reuse/rate limiting, persistence/revocation, active stream
termination, and rejection of legacy authentication cookies. VM browser tests run
the actual worker/bootstrap scripts. The Windows launcher has an actual Job
Object termination check.

Rendered 375px layout, physical-phone keyboard and native browser service-worker
behavior still require real-device validation when browser controls are unavailable.
The optional preview-mobile.ts script remains an isolated development fixture;
it is not the real synchronized deployment.
