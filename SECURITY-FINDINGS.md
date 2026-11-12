# Timon — Security Reverse-Engineering Audit

**Repo**: https://github.com/ai-timon/timon.git (cloned, **not installed**; `--depth 1`, commit `dcf231c`)
**Code size**: ~700k lines of TS/JS (orchestrator ~351k, app ~259k, desktop ~37k, plugins ~21k)
**What it is**: A locally-run AI-agent orchestration system. The "orchestrator" splits a job into tasks and hands each to an agent that uses your already-subscribed CLIs (Claude Code, Codex, Copilot, Grok, …) to write code, review it, and merge. A persistent daemon runs as the Unix user, shells out (`spawn`/`execFile`) to many external CLIs, and exposes a Web UI plus a remote API over HTTP/WebSocket.
**Method**: Structure mapping + static pattern sweep (eval / exec / spawn / fetch / SQL / secrets) + deep reads of the critical paths + **Node-level empirical testing of the core sanitizer and command execution** + a six-way parallel subagent static audit.

> Working-directory note: `/Users/div/Documents/deepseek-harness/default-workspace`'s parent dir is currently denied by the OS (`getcwd` fails), so git cannot run there. The clone therefore landed in `/tmp/timon`. All paths below refer to `/tmp/timon`.

---

## Overall verdict first

This is a **security-mature** codebase; the authors think carefully about authz/authn and command execution. Controls worth flagging:

- **Shell-less command execution**: `host.exec` / `execAsync` / `spawn` all pass an **args array** via `spawnSync` / `execFile` / `node:child_process` (no `shell:true`, no `eval`). `orchestrator/src/host/generic.ts`. → The base case for command injection is closed.
- **Parameterized SQL**: `better-sqlite3` with `db.prepare(...).all(...args)`; no string-concatenated SQL. `orchestrator/src/db.ts`.
- **Public-endpoint allowlist** (`SECU-9`): per-route exact RegExp allowlist, deliberately avoiding the "prefix inheritance" trap; SSE keeps a token escape hatch only in the query string. `orchestrator/src/plugins-bundled/http/auth.ts`.
- **Layered remote-API auth**: daemon-token (64 hex, 0600, never logged), device token (TLS + paired + live DB row), remote-MCP token (independent 256-bit grant that never lets the daemon-token through). `remote-mcp/auth.ts`, `users/upgrade-auth.ts`.
- **Web terminal three-lock**: must be a "person" (session or paired device, never daemon/api token), needs `terminal:open`, and a toggle; WebSocket upgrade enforces same-origin (`Origin` vs proxy-injected `X-Forwarded-Host`). `plugins-bundled/terminal-web/access.ts`.
- **Secret isolation at load**: `TIMON_REMOTE_MASTER`, `TELEGRAM_BOT_TOKEN`, `TIMON_VAPID_PRIVATE_KEY` are injected into env at boot; missions default to the `systemEnv` whitelist + `secretsEnvFor` grant slice, not the whole env. `secrets.ts`, `secrets/env.ts`, `agent.ts:190`.

**Not found in scope**: hardcoded production keys, unparameterized SQL, unvalidated `eval`, or `shell:true`. What follows are holes with real exploitability.

---

## A. Confirmed (I re-ran the code / re-read the source)

### 1. XSS sanitizer bypass: `<svg/onload=alert(1)>` and `<img/src=x/onerror=alert(1)>` survive verbatim
- **File**: `orchestrator/src/browser-annotation-rules.ts:107` (verbatim copy in `desktop/src/native-browser-annotator.ts:172`)
- **Code**: `html = html.replace(/\s(?:value|srcdoc|on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');`
- **Empirical** (ran this file's exact logic under Node):
  ```
  "<svg/onload=alert(1)>"            => "<svg/onload=alert(1)>"   ← not stripped
  "<img/src=x/onerror=alert(1)>"     => "<img/src=x/onerror=alert(1)>"  ← not stripped
  "<div onload=alert(1)>"            => "<div>"                   ← whitespace-delimited one IS stripped
  ```
- **Root cause**: the regex requires **whitespace before** the attribute name; HTML allows `/` as an attribute delimiter, so the classic `<svg/onload=…>` payload is never matched. The function's own docstring guarantees the opposite, and that invariant is violated.
- **Severity = medium (confirmed bypass, latent)**: `browser-annotation-format.ts` renders the sanitized `outerHtml` inside a **fenced markdown code block** (text to the agent), and `browser-annotation-bubble.tsx` draws its own bubble UI — so it is not currently rendered as DOM HTML. Any consumer that renders this markup (a preview, an HTML export, or the markdown↔HTML depot path) would execute stored XSS in the owner's session. The guarded boundary is genuinely broken; it just needs a renderer to light.
- **Fix**: replace the regex pass with an HTML tokenizer/parser (or a strict allow-list of tags/attributes + escape on output); strip any attribute whose name starts with `on`; add `<svg/onload>` and `<img/src=x/onerror>` cases; fix **both** copies.

### 2. OAuth discovery SSRF (low privilege + content-driven redirect)
- **File**: `orchestrator/src/oauth.ts:108-145`
- **Root cause**: `discoverOAuth(mcpUrl)` feeds the **user-stored MCP URL** straight to a bare `fetch(mcpUrl, …)`; `new URL()` parses without validating scheme, no http/https allow-list, no internal-IP filtering. `net-guard.ts`'s `guardedFetch` is **not on this path** (it only applies to mission tokens via `skills-mcp-guard`). The follow-ups then fetch `resource_metadata` (from the `WWW-Authenticate` response header) and `authorization_servers[]` (from the response body) via bare `fetch` too.
- **Impact**: any user with `mcp:manage` (superadmin **not** required) can store `http://169.254.169.254/…`, `http://127.0.0.1:<daemon-port>/…`, or `file:///etc/passwd` and make the daemon fetch it — leaking cloud metadata / loopback services / local files. Worse, an attacker-controlled MCP server can return those internal URLs, steering the daemon's egress content-drivenly inward with no egress filter.
- **Severity = high** (low permission barrier: plain `mcp:manage`).
- **Fix**: validate `mcpUrl` before fetch (http/https only; resolve host and reject link-local / metadata / private ranges unless explicitly allowed), or route this call through `guardedFetch(input, init, { destination })` — and apply it to non-mission callers too.

### 3. `secrets.inheritEnv` pours the whole daemon env (all vault secrets) into every mission
- **File**: `orchestrator/src/agent.ts:190-192` (with `secrets/env.ts:117-123`, `secrets.ts:93-96`)
- **Code**: `const base = inheritEnvEnabled() ? { ...process.env } : { ...systemEnv(), …secretsEnvFor… };`
- **Impact**: with `secrets.inheritEnv=true`, any spawned agent can read `process.env` → `TIMON_REMOTE_MASTER` (remote token master), `TELEGRAM_BOT_TOKEN`, `TIMON_VAPID_PRIVATE_KEY`, and anything else in the env — exactly the leak that `secrets/env.ts` was written to prevent.
- **Severity = medium (confirmed, opt-in with safe default)**.
- **Fix**: treat the flag as a deprecated escape hatch — warn/log when enabled, keep `systemEnv` + `secretsEnvFor` as the default path.

### 4. `docker compose up` missing `--` boundary → CLI argument injection
- **File**: `orchestrator/src/docker.ts:416-417` (and `:509` in `recreateOnCurrentNetworks`)
- **Code**: `const args = [...composePrefix, 'up', '-d', '--build']; if (service) args.push(service);`
- **Root cause**: `service` comes straight from the Docker label `com.docker.compose.service`, with no `--` terminator; the `up` subcommand treats any `-`-starting arg as a flag. A malicious compose stack naming a service like `--force-recreate` / `--pull` changes `docker compose up` behavior.
- **Severity = low** (requires authoring the project's own compose file; does not go beyond compose-authoring).
- **Fix**: `[...compose, 'up', '-d', '--build', '--', service]`.

### 5. macOS `security find-generic-password -a <account>` argument shift
- **File**: `orchestrator/src/host/os-credentials.ts:44-45`
- **Root cause**: `-a <account>` consumes the immediately following arg as the account; a flag-shaped value (e.g. `-w`) shifts the trailing `-w`, changing which keychain entry matches or suppressing the secret output.
- **Severity = low** (read-only keychain, no code execution, but a genuine argument shift).
- **Fix**: validate service/account against a restrictive charset (or require non-flag-shaped values); use `--` where the platform supports it.

---

## B. Recorded by the audit agents (code read, plausible, lower-severity / gated)

| # | Finding | File | Severity | Precondition |
|---|---------|------|----------|--------------|
| 6 | External file API reads/writes arbitrary files; `resolveExternalFile` not confined to TIMON_HOME (absolute + realpath + isFile, but not under a root); TOCTOU | `orchestrator/src/files.ts:611-649` | medium | `files:external` (superadmin) |
| 7 | Notification-sound upload uses a **predictable** temp path `<uid>/<event>.tmp`; `mode:0o600` ignored for a pre-existing symlink → symlink race (CWE-377) | `plugins-bundled/notifications/sound-routes.ts:143-147` | medium | write access in user's sound dir |
| 8 | Agent file sandbox `safeResolve` does not symlink-resolve **nonexistent** paths; check-then-write TOCTOU | `orchestrator/src/files.ts:80-90,111-169` | low | write access inside a specific agent cwd |
| 9 | Agent-import time `isLocalUrl` misses IPv4-mapped IPv6 (`::ffff:a.b.c.d`); diverges from the real guard (net-guard) | `plugins/agent-import/src/plan.ts:118-130` | medium (theoretical) | can submit/replace an import manifest |
| 10 | HMAC webhook verification accepts `sha1` (weak hash) | `plugins/webhook-schemes.ts:131-134` | low | plugin subscribes the webhook |
| 11 | browser-recording `spawnAgent` brief concatenates attacker-controlled `meta.title` into the mission directive → prompt injection | `plugins-bundled/browser-recording/routes.ts:88-94,188` | low/medium | mission instructed to read it |
| 12 | `auth:none` webhook accepts header-less local-proxy traffic by default (`behindTlsProxy` defaults false) | `triggers/webhook.ts:83-91`, `http-peer.ts:46-52` | low | undeclared header-less local proxy |
| 13 | Generic `exec` path has no allow-list/integrity for `host.binaries` (Settings-set pins), unlike `provider-binary.ts`'s `assertProviderExecAllowed` | `host/generic.ts:22-32,69-97` | medium | change a pin or drop a binary in a search path |
| 14 | PowerShell `WINDOWS_CREATION` interpolates `${pid}` into a `-Command` string (neutralized today by `signallablePid` integer validation) | `host/mission-processes.ts:52-65,84` | low (theoretical) | widening pid provenance reintroduces RCE |

---

## C. Prioritized recommendations

1. **Fix #2 (OAuth SSRF)** — low permission, direct read of cloud metadata / loopback / local files. Highest priority.
2. **Fix #1 (XSS sanitizer)** — confirmed bypass; add cases first, switch to parser/allow-list, and fix the desktop copy. Clarify/lock the "outerHtml is never rendered as DOM HTML" contract or escape on output.
3. **#6 / #7** — confine file ops to a root; use `mkdtemp` + `O_EXCL` for temp writes.
4. **#3** — document the `inheritEnv` flag with a warning so the master key can't be leaked by a mis-set switch.
5. **#4 / #5** — terminate positional args with `--`; cheap, zero-cost hardening.

---

## D. Relation to the repo's own `SECURITY.md`

The repo ships a `SECURITY.md` and stresses HTTPS-only remote transport and TLS-device-transport trade-offs. Most findings here are **logic-layer** holes (SSRF, sanitizer, file boundaries, argv boundaries) rather than a transport-layer gap; #2 and #6 are good candidates for the official security-disclosure channel.

---

## Appendix: command snapshots
```
# XSS sanitizer (exact logic from browser-annotation-rules.ts)
"<svg/onload=alert(1)>"            => "<svg/onload=alert(1)>"
"<img/src=x/onerror=alert(1)>"     => "<img/src=x/onerror=alert(1)>"
"<script> reinsertion payload"     => "<scr"   (the agent's "script survives" claim did NOT reproduce; it collapses to "<scr")

# OAuth SSRF: bare fetch(mcpUrl), no scheme allow-list; guardedFetch not on this path
orchestrator/src/oauth.ts:114  →  const r = await fetch(mcpUrl, {...})

# inheritEnv: { ...process.env } poured straight in
orchestrator/src/agent.ts:190-192

# docker argv injection, no -- boundary
orchestrator/src/docker.ts:416-417
```
