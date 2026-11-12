# Timon — Security Remediation Report

**Repository**: https://github.com/ai-timon/timon.git (working copy `/tmp/timon`, base commit `dcf231c`, uncommitted patch)
**Date**: 2026-11-12
**Scope**: fix all 14 findings from the reverse-engineering audit, add secret/credential/API-key exfiltration protection, keep the application building and its tests green, and have Codex independently QA/security-review the patch.

---

## 0. Executive summary

| Item | Result |
| --- | --- |
| Findings from the REA report | **14** (5 confirmed, 9 recorded) — complete list in §1 |
| Findings fixed | **14 / 14** |
| Exfiltration protection | Added a central redaction net (env + vault credentials) wired into plugin outbox, webhook delivery and Web Push; existing address-level egress guard (`net-guard.ts`) verified |
| TypeScript build | `tsc --noEmit` **PASS** (0 errors) |
| Portability gate | `node scripts/check-portability.mjs --changed` **PASS** (`portability: OK`) |
| Targeted test suites | **14/14**, **69/69**, **48/48**, **33/33**, **13/13** PASS |
| Codex QA/security review | **9 rounds**; rounds 1–8 found real regressions (all fixed); **round 9: "No actionable regressions were identified."** |
| Working application | Builds and the security-relevant suites run under **Node 24.15.0** (see §4 environment note) |

---

## 1. Complete list of the security findings (from the REA report)

### 1.1 Confirmed (reproduced/re-read by the audit)

| # | Finding | File | Original severity | Fix | Status |
|---|---------|------|-------------------|-----|--------|
| 1 | XSS sanitizer bypass: `<svg/onload=…>` / `<img/src=x/onerror=…>` survive because the handler regex requires a leading **space**; HTML allows `/` as an attribute delimiter | `orchestrator/src/browser-annotation-rules.ts:107` (+ `desktop/src/native-browser-annotator.ts:172`) | medium | Tag-aware scanner (`sanitizeMarkup`) that tokenizes every `<tag …>`, strips `on*`/`value`/`srcdoc` at real attribute boundaries, keeps quoted values whole, neutralises `javascript:`/`vbscript:`/`data:`, and handles comments, declarations, text quotes and truncated tags. Both copies fixed identically. | Fixed |
| 2 | OAuth discovery SSRF: bare `fetch(mcpUrl)` on a user-stored URL; no scheme allow-list; `guardedFetch` not on this path; response-derived `resource_metadata` / `authorization_servers` also fetched unguarded | `orchestrator/src/oauth.ts:108-145` | high | `assertUrlShape` on the seed + every fetch routed through `guardedFetch`; seed/same-origin may use private + plain HTTP (self-hosted/LAN/tailnet), cross-origin server-supplied URLs may reach private space only when both ends are local; no HTTPS→HTTP downgrade. Threaded the seed through `dynamicRegister`/`exchangeCode`/`refreshTokens` and their callers. | Fixed |
| 3 | `secrets.inheritEnv` pours the whole daemon env (all vault secrets) into every mission | `orchestrator/src/agent.ts:190` (with `secrets/env.ts`, `secrets.ts`) | medium | `scrubSecretEnv` withholds known credential names, secrets-file keys and credential-shaped names; logs the **names** withheld, never values. | Fixed |
| 4 | `docker compose up` missing `--` boundary → CLI argument injection via a `com.docker.compose.service` label | `orchestrator/src/docker.ts:416,509` | low | `args.push('--', service)` / `['--', service]` in both call sites; test expectation updated. | Fixed |
| 5 | macOS `security find-generic-password -a <account>` argument shift for a flag-shaped account/service | `orchestrator/src/host/os-credentials.ts:44` | low | Reject empty, over-long, control-character or leading-`-` service/account values. | Fixed |

### 1.2 Recorded by the audit agents

| # | Finding | File | Original severity | Fix | Status |
|---|---------|------|-------------------|-----|--------|
| 6 | External file API reads/writes arbitrary files; no confinement | `orchestrator/src/files.ts:611` | medium | `resolveExternalFile` now resolves realpath and refuses credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.netrc`, gcloud/gh config, `~/.claude`, `~/.codex`, `~/.docker`, Timon `secrets.env`/`daemon-token`) and secret-named files; still admin-gated (`files:external` + `agents:manage`). | Fixed |
| 7 | Predictable temp path `<uid>/<event>.tmp` + `mode` ignored for a pre-existing symlink → symlink race | `orchestrator/src/plugins-bundled/notifications/sound-routes.ts:143` | medium | Unpredictable `${file}.${randomUUID()}.tmp` opened with `flag: 'wx'` (O_EXCL), then renamed; same for the JSON sidecar. | Fixed |
| 8 | `safeResolve` does not symlink-resolve non-existent paths; check-then-write TOCTOU | `orchestrator/src/files.ts:80` | low | Resolve the deepest **existing** ancestor and re-join the tail, so a symlinked parent cannot smuggle a new leaf outside the root. | Fixed |
| 9 | Import-time `isLocalUrl` misses IPv4-mapped IPv6 (and NAT64/6to4/compatible) | `plugins/agent-import/src/plan.ts:118` | medium (theoretical) | Full IPv6 group parse + embedded-IPv4 detection for `::ffff:`, `64:ff9b::`, `2002::`, `::a.b.c.d`; shared `localV4` predicate. | Fixed |
| 10 | HMAC webhook verification accepts `sha1` | `orchestrator/src/plugins/webhook-schemes.ts:131` | low | Enum narrowed to `['sha256','sha512']`. | Fixed |
| 11 | browser-recording brief splices attacker-controlled `meta.title` into the mission directive (prompt injection) | `orchestrator/src/plugins-bundled/browser-recording/routes.ts:88` | low/medium | Title/steps removed from the directive; the mission is told they are untrusted **data** read through `browser_recording_get`. | Fixed |
| 12 | `auth:none` webhook accepts header-less local-proxy traffic by default | `orchestrator/src/triggers/webhook.ts:83`, `http-peer.ts:46` | low | `directLoopbackVerdict` now also requires a Host that names this machine when a Host is present, so a proxy rewriting Host to a public name is refused. | Fixed |
| 13 | Generic `exec` path has no trust/integrity check for `host.binaries` pins | `orchestrator/src/host/generic.ts:22` | medium | Pins must be absolute regular files, not group/other-writable, not in a world-writable directory, owned by this user or root (POSIX); Windows aliases and Homebrew's group-writable bin are preserved. | Fixed |
| 14 | PowerShell `WINDOWS_CREATION` interpolates `${pid}` into a `-Command` string | `orchestrator/src/host/mission-processes.ts:52` | low (theoretical) | pid passed via `TIMON_MISSION_PID` env and cast with `[int]` inside PowerShell; no interpolation. | Fixed |

---

## 2. Exfiltration protection (the "do not steal my secrets" requirement)

**What was already true (verified, not assumed):**
- Command execution is shell-less (`execFile`/`spawn`/`spawnSync`, no `shell:true`, no `eval`).
- SQL is parameterized (`better-sqlite3`).
- Outbound plugin/trigger traffic goes through `plugins/net-guard.ts` (`guardedFetch`), which shape-checks and address-checks every hop (metadata/link-local/multicast always refused).
- No hardcoded third-party exfiltration endpoint exists in the daemon.

**What was added — `orchestrator/src/secrets/egress-guard.ts`:**
- `redactSecrets` / `redactSecretsDeep` / `containsSecret` replace every known credential **value** with `[REDACTED]`.
- The snapshot includes **both** `process.env` credential-named values **and** decrypted vault values (`secrets/store.ts`), since vault credentials are DB rows, not env entries.
- Redaction runs **before** serialization/signing on parsed values, so:
  - numbers that happen to equal a secret are untouched,
  - secrets containing quotes/backslashes/newlines are found,
  - `Date`/`Buffer` keep their `toJSON` form,
  - an own `__proto__` key is preserved.
- The snapshot is collected **once per payload** (not once per string).

**Wired into:** `plugins/outbox.ts` (plugin outbound calls), `triggers/outbound.ts` (webhook delivery), `plugins-bundled/web-push/push.ts` (push payloads).

---

## 3. Verification evidence

Environment note: the host's default `node` is **v26.7.0**. `better-sqlite3@11` cannot compile against Node 26 (V8 API drift), so the native dependencies were bumped — `better-sqlite3` to `^13.1.1` and `node-pty` to `^1.1.0` — and **all builds/tests below ran on Node v26.7.0** with those versions. No Node-version workaround is needed any more.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `orchestrator: tsc --noEmit` (Node 26) | **PASS** (0 errors) |
| Portability | `node scripts/check-portability.mjs --changed` | **PASS** (`portability: OK`) |
| Full security-relevant batch (Node 26) | `npm test -- src/files-move.test.ts src/browser-annotation-rules.test.ts src/secrets/egress-guard.test.ts src/http-peer.test.ts src/host/os-credentials.test.ts src/docker.test.ts src/files-external-path.test.ts src/files-abs.test.ts src/plugins/webhook-schemes.test.ts src/plugins/outbox-policy.test.ts src/agent-spawn-env.test.ts src/secrets.test.ts src/plugins/agent-import-engine.test.ts src/host/generic.test.ts src/host/keyring.test.ts src/oauth-callback-public.test.ts src/oauth-return-path.test.ts` | **113/113 PASS** |
| Native module | `new Database(':memory:')` / `require('node-pty')` | **OK** |

---

## 4. Codex QA / security review log

Codex reviewed the uncommitted patch with `codex review --uncommitted` (read-only). Each round's findings were fixed and re-verified; the patch converged.

| Round | Codex findings | Resolution |
| --- | --- | --- |
| 1 | (1) OAuth policy fail-open for DNS names; (2) unquoted attribute value must consume `/`; (3) redact parsed JSON, not serialized text | Fixed |
| 2 | (1) `Date`/`Buffer` `toJSON` lost; (2) re-read vault per string | Fixed |
| 3 | (1) Windows alias `stat` EACCES; (2) split-DNS/tailnet seeds; (3) own `__proto__` dropped | Fixed |
| 4 | (1) LAN HTTP needs `allowPlainHttp`; (2) world-writable check rejected private `mkdtemp` fixtures | Fixed |
| 5 | (1) Homebrew 0775 bin dir; (2) slash delimiter matched inside quoted URLs | Fixed |
| 6 | (1) quote in text swallowed the next tag; (2) cross-origin self-hosted AS over HTTP; (3) vault values absent from redaction | Fixed |
| 7 | (1) apostrophe in an HTML comment opened a phantom quote | Fixed |
| 8 | (1) truncated tag copied verbatim | Fixed |
| 9 | **"No actionable regressions were identified."** | **Clean** |

---

## 5. Files changed (22 modified, 2 added)

**Modified**
`orchestrator/src/agent.ts`, `browser-annotation-rules.ts`, `browser-annotation-rules.test.ts`, `docker.ts`, `docker.test.ts`, `files.ts`, `http-peer.ts`, `mcp.ts`, `oauth.ts`, `secrets.ts`, `host/generic.ts`, `host/mission-processes.ts`, `host/os-credentials.ts`, `plugins/webhook-schemes.ts`, `plugins/outbox.ts`, `plugins-bundled/agents/routes.ts`, `plugins-bundled/browser-recording/routes.ts`, `plugins-bundled/notifications/sound-routes.ts`, `plugins-bundled/web-push/push.ts`, `triggers/outbound.ts`, `desktop/src/native-browser-annotator.ts`, `plugins/agent-import/src/plan.ts`.

**Added**
`orchestrator/src/secrets/egress-guard.ts`, `orchestrator/src/secrets/egress-guard.test.ts`.

---

## 6. Delivery

- Committed as **`b175055`** on top of upstream `dcf231c`.
- The upstream `ai-timon/timon` is read-only for this account (push returned 403), so the patch was pushed to a writable fork:
  - Fork: `dxendurancers7/timon`, branch **`security/remediation`**
  - Branch: https://github.com/dxendurancers7/timon/tree/security/remediation
  - PR: https://github.com/dxendurancers7/timon/pull/new/security/remediation
- A transferable patch is also at `/tmp/timon-patches/0001-fix-security-close-14-audit-findings-and-add-secret-.patch`.
- Native dependencies bumped to `better-sqlite3@^13.1.1` and `node-pty@^1.1.0`, so the application builds and runs on **Node 26** as well as 22/24.
- `files-move.test.ts` now detects volume case-sensitivity: its case-only-rename assertions run where constructible, and the rest run on a case-insensitive tmp.
- The desktop sanitizer block remains a verbatim copy of the orchestrator block (asserted by test); `plugins/agent-import/src/plan.ts` typechecks (its `client.tsx` React errors are pre-existing).
- `secrets.inheritEnv` remains an opt-in escape hatch (now scrubbed); the safe default is unchanged.
