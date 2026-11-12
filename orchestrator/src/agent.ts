import { assertFreeAccountAccess } from './users/free-access.js';
import { noteProviderSignedIn, noteProviderSignedOut } from './backends/sign-in-state.js';
import { assertLicensedExecution } from './license/capabilities.js';
import { licenseState } from './license/runtime.js';
import { initializeTeamOnboarding } from './onboarding-team-state.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync,
  statSync, writeFileSync, rmSync, unlinkSync, renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadGlobalInstructions } from './global-instructions.js';
import { configuredVaultMcpServer, configuredVaultRoot } from './vault-root.js';
import { externalConnectorsToCut } from './mcp-least-privilege.js';
import { join, sep } from 'node:path';
import { loadavg, cpus, homedir } from 'node:os';
import { agentTrashEnabled, restoreAgentDir, setTrashedAgentRefs, trashAgentDir, type AgentTrashRefs, type AgentTrashRestore } from './agent-trash.js';
import {
  AGENTS_DIR, GLOBAL_MEMORY_DIR, TIMON_HOME,
  agentConfig, agentDir, agentLog, agentMemoryDir, agentMemoryFile, agentSystemPrompt,
  missionMemoryDir,
} from './paths.js';
import { appendDatedLog } from './log-file.js';
import { createNotification } from './notifications.js';
import { db, dbApi, type RenamedAgentTrigger, type Source, type MemoryRuleRow } from './db.js';
import { originFromSpawnSource, type UserEventOrigin } from './user-origin.js';
import type { PromptPresentation } from './prompt-presentation.js';
import { recordRequestDelivery } from './agent-request-replies.js';
import { projectFromCwd } from './task-project.js';
import {
  dropAgentBrowserProfiles, holdAgentBrowserProfiles, resolveBrowserProfile, resolveMissionBrowserProfile,
  restoreAgentBrowserProfiles, revokeAgentBrowserGrants,
} from './browser-profiles.js';
import { projectOfTask, resolveBrowserProject, taskIdOfSource } from './browser-project.js';
import { dropAgentMemory, holdAgentMemory, restoreAgentMemory } from './agent-memory-trash.js';
import { listProjects, readRoles, writeRoles, readProjectMemory } from './projects.js';
import { buildGlobalDigest } from './global-digest.js';
import { enqueueMissionReturn } from './mission-return.js';
import { moduleActive } from './kernel/module-state.js';
import { apiBaseUrl } from './api-url.js';
import { bus, type AgentEventSnapshot } from './bus.js';
import { redactDeep, redactText } from './secrets/redact.js';
import { readSkillsContent, readSkillsAllowedTools } from './skills.js';
import { describeSkill } from './skill-registry.js';
import { listSkillFiles, remoteSkillFiles, REMOTE_SKILL_FILES_BUDGET, REMOTE_SKILL_FILES_PROMPT_BUDGET, skillFilesOnDisk } from './skill-files.js';
import {
  dropAgentSkillAttachments, heldAgentSkillAttachments, isSkillId, ownAgentSkills, resolveAgentSkills,
  restoreAgentSkillAttachments, setAgentSkills,
  type AgentSkillsDraft, type AgentSkillsWrite, type ResolvedSkill, type SkillMode, type SkillVia,
} from './skill-attachments.js';
import { refreshToolsCacheFromInit, listMcp } from './mcp.js';
import { journalDirectSkillReads } from './skill-reads.js';
import {
  getBackend, backendMetadata, assertBackendEnabled, backendForModel, catalogBackend, catalogClaimsModel, asBackendName,
  ASSISTANT_DELTA, PROVIDER_RETRY, backendCapabilities, backendNames, canReadSkillOnDemand, defaultBackendName, implicitBackendName,
  type Backend, type BackendCapabilities, type BackendName, type BuildSpawnOpts, type ImageAttachment, type NormalizedEvent, type SpawnResult,
  type RemoteSessionHost, type RemoteSessionResume, type SessionDriver, type SessionEnd,
  type PermissionModel,
  type SpanState,
} from './backends/index.js';
import { ROLE_REGISTRY, getRole, withCurrentCloseFlags, type AgentRoleId } from './agent-roles.js';
import type { InterruptionReason } from './interruption.js';
import { catalogKeeping, mascotPartCatalog, parseAgentAvatar, parseAgentLook, readAgentAvatar, readAgentLook, type AgentAvatarMode, type AgentLook } from './agent-look.js';
import { bestRateLimit } from './rate-limit.js';
import {
  classifyTurnFailure, isFailedResult, resultFailureText, tallyProviderRetry, turnRetryDelayMs, turnRetryPrompt,
  type ProviderRetryTally, type TransientFailureFields,
} from './turn-retry.js';
import { loadSpanState, recordSpans } from './trace-recorder.js';
import { DEFAULT_MAX_LINE_CHARS, fromLegacy, openProcessSession, openRemoteSession } from './backends/engine/index.js';
import {
  sterileResultSignature, sterileExitSignature, noteSterileTurn, noteProductiveTurn,
  isAuthFailureEvent,
} from './backend-breaker.js';
import {
  noteBackendRateLimit,
  noteBackendUnavailable,
  clearBackendCooldown,
  isBackendCoolingDown,
  interruptionForCooldown,
  cooldownReason,
  fallbackFor,
} from './backend-fallback.js';
import { backendStillDry } from './backend-recheck.js';
import { settingBool, settingNum } from './settings.js';
import { profileLimits, wrapMissionLaunch } from './resources.js';
import { getHost, type Host } from './host/index.js';
import {
  backgroundDescendants, cliBaseline, cliProcessPid, readProcessTable, type ProcessEntry,
} from './host/process-tree.js';
import { ensureDaemonToken } from './plugins-bundled/http/auth.js';
import { MissionSession, permissionHost, questionHost, type PermissionGate } from './mission-session.js';
import { processHandle, remoteHandle, type MissionHandle, type RemoteMissionHandle } from './mission-handle.js';
import { parseResumeState, serializeResumeState } from './backends/remote-session.js';
import { developerAutoAllows } from './users/agent-permissions.js';
import { applyMissionMcpServers } from './mission-mcp-servers.js';
import { conversionBackendRefusal, conversionMissionById, conversionToolCardRefusal, isConversionSource } from './users/conversion-mission.js';
import { issueMissionApiToken, ownerForSpawn, PLUGIN_OWNER_PREFIX } from './users/api-tokens.js';
import { missionEgressEnv } from './egress/service.js';
import { baseBackendId, isAccountInstanceId } from './backends/instance-id.js';
import { backendTrust, type BackendTrust } from './backends/registry.js';
import { DEFAULT_BACKEND_CAPABILITIES } from './backends/types.js';
import { BUILTIN_DECLARATIONS } from './backends/builtin-declarations.js';
import { withLaunchPath } from './host/launch-path.js';
import { missionProcessDir, trackMissionProcess } from './host/mission-processes.js';
import { closeLaunchSeal, openLaunchSeal } from './backends/launch-seal.js';
import { assertSpawnPinned, buildSealedSpawn } from './backends/sealed-spawn.js';
import { parkProviderScratch } from './backends/provider-scratch.js';
import { launchBackendName, launchForMission, replaceMissionLaunch, resolveLaunchBackend } from './backends/account-launch.js';
import { servedIconUrl } from './uploads.js';
import {
  systemEnv, secretsEnvFor, inheritEnvEnabled,
  injectedSecretsFor, journalInjectedSecrets,
} from './secrets/env.js';
import { scrubSecretEnv } from './secrets.js';
import { requestedSecretsFor, withRequestedSecrets } from './secrets/requests.js';
export { ROLE_REGISTRY, type AgentRoleId } from './agent-roles.js';

/** Tolerant backend binary resolution (`claude`, `codex`, `grok`).
 *  See the spawn-site comment: a missing binary must surface as ENOENT on the
 *  child's `error` event, never as a synchronous exception that leaves the
 *  mission recorded without a process. */
function resolveBackendBin(host: Host, name: string): string {
  try {
    return host.bin(name);
  } catch (err) {
    console.warn(`[agent] could not resolve binary "${name}" (${(err as Error).message}) — spawning by name`);
    return name;
  }
}

/**
 * Process environment for a mission. `TIMON_API_TOKEN` is a per-mission
 * `api_tokens` row bound to the mission's owner (`docs/MULTI-USER.md` §6):
 * an agent's `timon` CLI does not need to read `daemon-token`, and a
 * `TIMON_API_TOKEN` inherited from the parent (a mission spawning another
 * one) must never win — THIS daemon authenticates, as THIS user. The
 * token never carries `isSuperadmin` (secu-3): even a superadmin launcher
 * yields a capped snapshot (kanban / notify / mission-self). First-run
 * (empty users table) still injects the daemon-token so a machine that
 * has not set up accounts keeps working. Never logged.
 *
 * The base is NOT `process.env` (SECRETS-VAULT.md §6.1): the daemon's
 * environment carries every secret loaded at boot, and inheriting it wholesale
 * handed them to any agent that ran `env`. It is now the system whitelist plus
 * the secrets this precise mission was granted.
 *
 * Layer order, least to most specific: system < secrets < spec < mission. The
 * spec wins over a secret because it carries what the backend profile resolved
 * for THIS launch, and the mission variables win over everything since they
 * identify the run itself.
 *
 * `secrets.inheritEnv` restores the PRE-VAULT behaviour exactly: the daemon
 * environment, then the spec, then the mission variables — the vault layer is
 * removed, not merely reordered. That switch exists to get back to a known
 * state when production breaks, which is the moment to take a variable OUT of
 * the equation, not to add a third hybrid semantics nobody has ever run. It
 * also keeps the launch path free of the vault read and of `requireMasterKey()`
 * — precisely what one wants to rule out when diagnosing.
 */
export function missionEnv(opts: {
  missionId: string;
  agentName: string;
  specEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  project?: string;
  /**
   * Precomputed vault slice. Spawn passes it so the inject journal can record
   * identities without decrypting twice. Omitted by tests, which go through
   * `secretsEnvFor` and must not write `secret_access`.
   */
  secretsEnv?: Record<string, string>;
  /**
   * The CLI is a third party's (a provider plugin's dialect): it gets the
   * system whitelist and the spec's own env, and neither the mission's token,
   * nor the vault slice, nor the daemon environment — `inheritEnv` included.
   * The token reaches the MCP servers by another road (`mission-token-seal.ts`).
   */
  untrusted?: boolean;
  /**
   * The token this launch already issued. Issuing revokes the previous row, so a
   * launch that also minted a reference to it (`launch-seal.ts`, an official
   * provider plugin) hands the same value here instead of asking for a second one.
   */
  token?: string;
}): NodeJS.ProcessEnv {
  const project = opts.project ?? projectFromCwd(opts.cwd) ?? '';
  if (opts.untrusted) return untrustedMissionEnv(opts, project);
  // Ternary, not a discarded result: in inherit mode `secretsEnvFor` must not
  // even be called (no vault read, no master key on the launch path).
  let base: NodeJS.ProcessEnv;
  if (inheritEnvEnabled()) {
    // Legacy escape hatch: inherit the ordinary environment, never the vault.
    // `{ ...process.env }` used to hand every mission the daemon's credentials
    // (TIMON_REMOTE_MASTER, the Telegram token, the VAPID private key).
    const scrubbed = scrubSecretEnv(process.env);
    if (scrubbed.withheld.length) {
      console.warn(`[secrets] inheritEnv withheld ${scrubbed.withheld.length} secret variable(s) from mission ${opts.missionId}: ${scrubbed.withheld.join(', ')}`);
    }
    base = scrubbed.env;
  } else {
    base = { ...systemEnv(), ...(opts.secretsEnv ?? secretsEnvFor({ agent: opts.agentName, project: project || null })) };
  }
  const token = opts.token ?? missionApiToken(opts.missionId);
  const inherited = { ...base, ...(opts.specEnv ?? {}) };
  return {
    ...inherited,
    ...missionEgressEnv(opts.missionId, inherited),
    ...missionIdentityEnv(opts, project),
    TIMON_API_TOKEN: token,
  };
}

/** The mission's own credential: its `api_tokens` row, or the daemon-token on a
 *  machine with no account yet. Issuing revokes the previous row, so call it once
 *  per launch. */
export function missionApiToken(missionId: string): string {
  return dbApi.countUsers() === 0 ? ensureDaemonToken() : issueMissionApiToken(missionId);
}

/** What identifies the run, with no credential in it. */
export function missionIdentityEnv(
  opts: { missionId: string; agentName: string },
  project: string,
): NodeJS.ProcessEnv {
  const traceId = dbApi.getMission(opts.missionId)?.trace_id ?? null;
  const workflow = dbApi.getMission(opts.missionId);
  return {
    TIMON_MISSION_ID: opts.missionId,
    ...(traceId ? { TIMON_TRACE_ID: traceId } : {}),
    ...(workflow?.workflow_run_id ? { TIMON_WORKFLOW_RUN_ID: workflow.workflow_run_id } : {}),
    ...(workflow?.workflow_node_id ? { TIMON_WORKFLOW_NODE_ID: workflow.workflow_node_id } : {}),
    TIMON_AGENT: opts.agentName,
    // The bundled CLI reads TIMON_API (not TIMON_ORCH_URL). Pin it to the
    // address of THIS daemon so a packaged install on :3010 never falls back
    // to the CLI's historical :3000 default.
    TIMON_API: apiBaseUrl(),
    // Project slug, so the `timon` CLI (browser, etc.) can resolve it without
    // guessing: a `code` task's cwd is a worktree, so no slug can be inferred.
    // Same precedence as `taskProjectSlug`: declared > cwd.
    TIMON_PROJECT: project,
  };
}

function untrustedMissionEnv(
  opts: { missionId: string; agentName: string; specEnv?: NodeJS.ProcessEnv },
  project: string,
): NodeJS.ProcessEnv {
  // A plugin's own spec may not name the credential, whatever its case on Windows.
  const spec = Object.fromEntries(
    Object.entries(opts.specEnv ?? {}).filter(([key]) => key.toUpperCase() !== 'TIMON_API_TOKEN'),
  );
  const inherited = { ...systemEnv(), ...spec };
  // Its own egress credential, not the mission's token: it opens the proxy and no route.
  return { ...inherited, ...missionEgressEnv(opts.missionId, inherited), ...missionIdentityEnv(opts, project) };
}



/**
 * Auto-derive `project` from a cwd. Handles both containers AND the host:
 *   /workspace/projects/<slug>/...        → <slug>   (docker)
 *   /workspace/<slug>/...                 → <slug>   (docker)
 *   /home/<user>/.../projects/<slug>/...  → <slug>   (host mode, ex. ~/webdev/projects/timon)
 *
 * Implementation moved to task-project.ts (a pure, database-free testable
 * module); re-exported here because all code imports `projectFromCwd` from agent.js.
 */
export { projectFromCwd };

/* Moved verbatim to `agent-config.ts` (step 1.2) to break the
   `agent ↔ backends ↔ browser-sessions` cycle. Re-exported here: all code —
   including backend dialects — imports these symbols from `agent.js`. */
import {
  type AgentConfig,
  stripProtectedKeys,
  canonicalAgentName,
  loadConfig,
  loadSoul,
  loadIdentityDocs,
  loadSystemPrompt,
  validName,
} from './agent-config.js';

/** A single place holds the memory module's id, like `SECRETS_MODULE_ID`
 *  for the vault: renaming it is one line, not a grep. */
export const MEMORY_MODULE_ID = '@timon/memory';
export { type AgentConfig, stripProtectedKeys, canonicalAgentName, loadConfig, loadSoul, loadSystemPrompt, validName };

export type RunningAgent = {
  missionId: string;
  agentName: string;
  /** The backend CLI's pipes. Absent on a backend with no process
   *  (`Backend.openRemoteSession`), whose session is all there is. */
  proc?: ChildProcessWithoutNullStreams;
  /** What every stop, end and liveness probe goes through (cf.
   *  `mission-handle.ts`). `proc` above is only its pipes. */
  handle: MissionHandle;
  backend: Backend;
  startedAt: number;
  /** True while the agent is processing a turn (from user input, or from the
   *  first message of a turn its CLI opened by itself, to the next `result`
   *  event). Used by /api/agents/active so the UI can tell "thinking" (mid-turn)
   *  from "idle" (mission running but waiting for the next user message). */
  turnActive: boolean;
  /** Wall clock of the most recent turn boundary (turn started or `result`
   *  received). Drives the elapsed-time chip on the strip. */
  turnSince: number;
  /** Where the turn budget (`REAP_TURN_MAX_MS`) of an autonomous mission counts
   *  from: the start of a turn Timon started, then the end of it. A turn the CLI
   *  opens by itself moves nothing, so that a chain of them shares one budget. */
  budgetSince: number;
  /** The open turn is one Timon started (every prompt goes through `onTurnStart`),
   *  so its `result` moves `budgetSince`. Cleared by that `result`: a turn the CLI
   *  opens finds it false. Two clock reads cannot tell who opened a turn (TODO #718). */
  turnOpenedByTimon: boolean;
  /** Wall clock of the last sign of life from the backend: any stdout line,
   *  parsed or not, or any event a session driver emitted. Stream lines the
   *  dialect drops (thinking deltas) and deltas never persisted still prove the
   *  agent is working, which `dbApi.lastEventAt` alone cannot see. */
  lastOutputAt?: number;
  /** Set when we observe a rate-limit signal during this turn, whatever
   *  form the dialect uses to express it (cf. `rate-limit.ts`). On
   *  exit we use it to decide whether a non-zero code should mark the mission
   *  as failed (real crash) or just pause it (transient throttling — the user
   *  can retry later and resume the same chat once quota replenishes). */
  rateLimited: boolean;
  /** A provider-queued request is a pause, not a rejected turn to replay. */
  rateLimitPending?: boolean;
  /** Qualified death cause observed DURING this turn, or null. Set by the two
   *  detections that read the stream: the usage limit (`rate-limit.ts`) and the
   *  circuit breaker (`backend-breaker.ts`). The exit handler persists it so
   *  the task inherits a cause that says something, instead of the generic
   *  `crash` that had the dispatcher replay a dead backend four times in three
   *  minutes (night of 2026-09-01). */
  interruptedBy: InterruptionReason | null;
  /** The CLI said, in a structured field, that it could not authenticate during
   *  this turn (cf. `isAuthFailureEvent`). Consumed by the turn's `result`,
   *  where it makes the breaker trip on the first bounce. */
  authFailed: boolean;
  /** Set when stderr signals that the session we tried to `--resume` no
   *  longer exists (cf. Backend.isSessionNotFoundError). On a resuming spawn
   *  that exits non-zero, this triggers a one-shot retry of the same turn
   *  fresh (without resume) instead of failing the mission. */
  sessionNotFound: boolean;
  /** Why this process was deliberately killed — set BEFORE `proc.kill`.
   *  The exit handler uses this to classify the terminal status without relying
   *  on the exit code alone (SIGTERM gives a non-zero exit that is NOT failure):
   *    - 'idle': reap of an autonomous mission after its turn → `completed`
   *    - 'stopped': manual kill (`timon kill`) → `completed` (intentional stop)
   *    - 'interrupted': chat STOP button — cut the TURN, not the conversation.
   *      Same terminal status as 'stopped', but a distinct death cause
   *      (`stopped` vs `killed`): a manually interrupted task must NOT be
   *      automatically requeued, unlike a mission simply killed by the reaper.
   *    - 'hung': reap of a turn silent for too long → `failed`, cause `timeout`
   *    - 'budget': reap of a turn past its duration budget, still working →
   *      `failed`, cause `turn_budget` (not replayed: it would burn it again)
   *    - 'bounced': a TASK mission whose turn bounced off its provider (sterile
   *      `result`), or a session-driven mission (ACP) whose session died, chat
   *      included → `failed`, with the cause observed on the stream
   *  undefined = unsolicited exit → fall back to the exit code (exit 0
   *  = completed, ≠ 0 = crash → failed). */
  terminationIntent?: 'idle' | 'hung' | 'budget' | 'stopped' | 'interrupted' | 'bounced';
  /** The CLI process itself (the spawned pid, except behind a Windows
   *  `.cmd` shim) and its direct children once its MCP servers were up. What
   *  appears under the CLI after that is work the mission started (cf.
   *  `host/process-tree.ts`). Absent until the `system:init` event, and on a
   *  chat mission: the reaper then sees no background work, as it always did. */
  cliPid?: number;
  cliBaselinePids?: number[];
  /** Background processes seen at the last sweep, for the eviction path. Only
   *  meaningful when `backgroundCheckedFor` equals the current `turnSince`. */
  backgroundCount?: number;
  /** `turnSince` of the idle period whose background work a sweep has read.
   *  The eviction path refuses a mission whose current idle period was never
   *  checked: its count would be a leftover (or absent), not an observation. */
  backgroundCheckedFor?: number;
  /** `turnSince` of the idle period the reaper already logged as spared. */
  backgroundSparedFor?: number;
  /** Last bytes the backend wrote on stderr: the only explanation a CLI gives
   *  when it dies without a `result` (auth refusal, policy denial, crash). */
  stderrTail?: string;
  /** Model requested DURING an active turn, to apply at `result`. A hot
   *  switch during a turn would only take effect on the next CLI turn,
   *  while mixing both models in `result.modelUsage` would muddy the trace.
   *  Defer it without losing the request. A newer request replaces it: only
   *  the latest one counts. */
  pendingModel?: string;
  /** The permission mode the CLI was launched with. A persistent CLI takes
   *  it as a launch argument (`--permission-mode`), so a level changed since
   *  then (`missions.permission_mode_override`) needs a relaunch on the same
   *  session before the next message (`sendToAgent`). */
  permissionMode?: string;
  /** The process is killed to make room for ANOTHER backend on the same
   *  mission (`switchMissionBackend`). Its exit must neither finish the mission
   *  nor publish `mission_complete`: the thread continues on another CLI. */
  switching?: boolean;
  /** A steer stopped the running turn to open the next one with its
   *  instruction (`steerMission`). The `result` that closes the stopped turn
   *  publishes `turn_complete` with `outcome: 'cancelled'` and clears it: the
   *  conversation is not over, so no return, request reply or closure question
   *  may take that turn for the agent's answer (TODO #568). A process being
   *  stopped for the steer (`switching`) keeps it: the next turn runs in another
   *  process, so every `result` this one still flushes is the stopped turn's. */
  steerCancelled?: boolean;
  /** Open-span bookkeeping for the trace (`trace-recorder.ts`). Loaded at
   *  spawn from the mission's `running` spans, mutated by `backend.spans`. */
  spans: SpanState;
  /** The mission's session, whatever the backend speaks (cf. `backends/engine`):
   *  every turn goes through its driver, which owns the process's pipes (or the
   *  connection). Whether that driver is a PROTOCOL (`speaksProtocol`) decides
   *  what a turn's stop and a steer can do. */
  session?: MissionSession;
  /** Retries the provider reported during the current turn (`provider_retry`),
   *  reset when the turn closes. What makes a failure that says nothing
   *  readable as the end of a series of transport failures (TODO #459). */
  providerRetries?: ProviderRetryTally;
};

const running = new Map<string, RunningAgent>();
// Context planning is asynchronous: sends and other switches must wait until
// the replacement process owns the conversation, even while the old one is idle.
const backendSwitches = new Set<string>();

/** Awaited work leading to a turn of this mission that has no process yet. */
const turnPreparations = new Map<string, number>();

/** Counts `work` as preparing a turn: nothing of it shows in `turn_active` yet. */
export async function whileTurnPrepares<T>(missionId: string, work: () => Promise<T>): Promise<T> {
  turnPreparations.set(missionId, (turnPreparations.get(missionId) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const left = (turnPreparations.get(missionId) ?? 1) - 1;
    if (left > 0) turnPreparations.set(missionId, left);
    else turnPreparations.delete(missionId);
  }
}

/** A turn is on its way with none open yet: a launch, or a summary that can take
 *  minutes. A client that reads `turn_active: false` during that wait must not
 *  conclude the turn is over (TODO #727). In memory on purpose: a daemon restart
 *  loses the turn along with the wait. */
export function turnPreparing(missionId: string): boolean {
  return backendSwitches.has(missionId) || turnPreparations.has(missionId);
}

/**
 * Timon's replays of a turn the provider dropped, per mission (TODO #459).
 * Outside `RunningAgent` on purpose: a one-shot CLI exits between the failed
 * `result` and the replay. `spent` counts the replays already scheduled for
 * this turn; `timer` is set while one waits out its backoff. `closed`: the
 * series is over and the turn ended on its failure — kept, not deleted, so a
 * second failed `result` of that same turn (codex: `error`, then
 * `turn.failed`) reads as its echo instead of opening a fresh series, which
 * replayed the turn forever.
 */
type TurnRetryState = {
  spent: number; timer: NodeJS.Timeout | null; fields: TransientFailureFields; closed: boolean;
  /** The backoff is over and the replay is being handed to the mission: its
   *  input is not written yet (a respawn awaits), so the turn is still open. */
  delivering?: boolean;
};
const turnRetries = new Map<string, TurnRetryState>();

/** A replay of this mission's last turn is waiting out its backoff: the turn is
 *  not over, and neither the exit of its CLI nor the reaper may close it. */
export function turnRetryPending(missionId: string): boolean {
  return !!turnRetries.get(missionId)?.timer;
}

/** The turn Timon replays is still open for whoever asks "has it answered?":
 *  its replay waits out its backoff, or is being delivered. Between the failed
 *  `result` and the replay's own input, the persisted facts read as a finished
 *  turn, and a wait took the failure for the answer (TODO #666). In memory on
 *  purpose: a daemon restart loses the replay, so the failure then IS the end
 *  of the turn. */
export function turnRetryAwaited(missionId: string): boolean {
  const state = turnRetries.get(missionId);
  return !!state && (!!state.timer || state.delivering === true);
}

/** Any other input, a stop or a kill supersedes the replay. */
function cancelTurnRetry(missionId: string): void {
  const state = turnRetries.get(missionId);
  if (state?.timer) clearTimeout(state.timer);
  turnRetries.delete(missionId);
}

/** Lookup the turn state for a running mission. Returns null when the
 *  mission isn't held in memory (orchestrator restarted, or the process
 *  already exited). */
export function getTurnState(
  missionId: string,
): { turnActive: boolean; turnSince: number } | null {
  const a = running.get(missionId);
  return a ? { turnActive: a.turnActive, turnSince: a.turnSince } : null;
}

/** The turn as the clients read it (`turn_active`, `turn_complete`): the live
 *  process, the persisted end of turn (`turnEnded`), and a replay Timon still
 *  owes, which keeps the turn going in both (TODO #666). `mission_wait` and
 *  `timon wait` stop on `turn_complete && !turn_active`. */
export function clientTurnState(missionId: string, turnEnded: boolean): { turnActive: boolean; turnComplete: boolean } {
  const replay = turnRetryAwaited(missionId);
  return {
    turnActive: replay || (running.get(missionId)?.turnActive ?? false),
    turnComplete: turnEnded && !replay,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Concurrency guards (anti-freeze) — global cap + load watchdog
   ──────────────────────────────────────────────────────────────────────────── */


const CPU_COUNT = Math.max(1, cpus().length);

/** GLOBAL cap on live backend missions, across ALL sources (dispatcher, wake,
 *  recovery, review/merge pipeline, resume retries, chat…).
 *  This is the only reliable counter: `running.size` = actual live process
 *  count. The dispatcher MAX_PARALLEL cap only bounds countInProgress() in the
 *  DB and ignores everything else — hence the monotonic accumulation behind
 *  the freeze (5 missions at 3pm → 35 at 10pm, never reaped).
 *
 *  Lowered during the day by the resource profile (resources.ts): while the user
 *  works on the machine, four encoding missions are enough to freeze it.
 *  At night, the configured value applies unchanged. */
export const GLOBAL_MAX_LIVE = (): number => profileLimits().maxLive;
/** Normalized one-minute loadavg threshold per core above which we apply
 *  back-pressure (suspension of new autonomous spawns). 0.9 → slow down when
 *  the machine reaches ~90% sustained utilization, BEFORE overheating. */
export const LOAD_THRESHOLD_PER_CPU = (): number => settingNum('TIMON_LOAD_THRESHOLD');

/** Number of actually live backend missions (live processes), across all
 *  sources combined. Central source of truth for effective parallelism. */
export function liveMissionCount(): number {
  return running.size;
}

/** Live missions inside a turn: the work an update of the service would cut
 *  short. An idle live session holds no work in progress and is not counted. */
export function workingMissionCount(): number {
  let working = 0;
  for (const live of running.values()) if (live.turnActive) working += 1;
  return working;
}

/** Ids of the backends (accounts folded into theirs) that have a live mission:
 *  a provider plugin's update waits for them (`plugins/loader.ts`). */
export function liveMissionBackends(): ReadonlySet<string> {
  return new Set([...running.values()].map((a) => baseBackendId(a.backend.name)));
}

/** Machine load state: one-minute loadavg versus normalized per-core threshold. */
export function loadStatus(): { high: boolean; load1: number; threshold: number } {
  const load1 = loadavg()[0] ?? 0;
  const threshold = LOAD_THRESHOLD_PER_CPU() * CPU_COUNT;
  return { high: load1 > threshold, load1, threshold };
}

/** Admission decision for a NEW mission spawn. Called upstream by the
 *  autonomous spawners (dispatcher, wake) so they DEFER rather than launch
 *  when we are at the global cap or overheating. Returns ok=false + a
 *  human-readable reason. */
export function canSpawnMission(): { ok: boolean; reason?: string } {
  const live = running.size;
  if (live >= GLOBAL_MAX_LIVE()) {
    // The slots are often held by processes that have nothing left to do: a
    // wake or task mission whose turn is over waits REAP_IDLE_MS (10 min) for
    // the reaper. A busy exchange between a few agents filled the cap that
    // way on 2026-09-19 and stopped the dispatcher for good (#113). One of
    // them gives its slot back now; the caller's own retry takes it.
    const freed = evictIdleMission();
    return {
      ok: false,
      reason: `global cap reached (${live}/${GLOBAL_MAX_LIVE()} live missions)` +
        (freed ? ` — idle mission ${freed.slice(0, 8)} released, retrying shortly` : ''),
    };
  }
  const ld = loadStatus();
  if (ld.high) {
    return { ok: false, reason: `high load (load1=${ld.load1.toFixed(2)} > threshold ${ld.threshold.toFixed(2)})` };
  }
  return { ok: true };
}



/** Before this, an idle autonomous mission may still be handed its pilot's
 *  next step (`routeToOwnerMissions` delivers INTO a live mission): releasing
 *  it at once would only respawn the same conversation. */
export const EVICT_IDLE_GRACE_MS = 60_000;

/** Last sign of life of a mission: the turn's boundary, any line of its CLI, any
 *  event. The DB adds what reached the stream by another path (permission events,
 *  a message injected into the turn). */
function lastActivityAt(live: RunningAgent): number {
  return Math.max(live.turnSince, live.lastOutputAt ?? 0, dbApi.lastEventAt(live.missionId) ?? 0);
}

/**
 * Releases the slot of the autonomous mission idle for the longest time, if
 * one qualifies: persistent process alive, turn over and nothing heard for at
 * least `graceMs`, no pending permission, not already being stopped or switched.
 * Same exit as the reaper's idle path (`terminationIntent = 'idle'`): the
 * mission ends `terminated` and its session stays resumable. Never a human
 * chat — someone may be reading it. Returns the released mission id.
 */
export function evictIdleMission(now = Date.now(), graceMs = EVICT_IDLE_GRACE_MS): string | null {
  let oldest: RunningAgent | null = null;
  for (const live of running.values()) {
    if (live.turnActive || live.switching || live.terminationIntent) continue;
    if (now - lastActivityAt(live) < graceMs) continue;
    // Waiting for a job it started (cf. reapStaleMissions): releasing it would
    // kill that job under the same mission the reaper just spared. A sweep must
    // have looked during THIS idle period first — the grace (60 s) can end
    // before the first sweep that reads the descendants, and an unread count
    // is not "no job". The reaper's ceiling applies here too.
    if (live.backgroundCheckedFor !== live.turnSince) continue;
    if ((live.backgroundCount ?? 0) > 0 && now - live.turnSince <= REAP_BG_MS()) continue;
    if (missionHasPendingPermission(live.missionId)) continue;
    const m = dbApi.getMission(live.missionId);
    if (!m || m.status !== 'running' || !isAutonomousMission(m)) continue;
    if (!oldest || live.turnSince < oldest.turnSince) oldest = live;
  }
  if (!oldest) return null;
  console.log(
    `[admission] cap reached: releasing idle mission ${oldest.missionId.slice(0, 8)} ` +
    `(${oldest.agentName}, idle ${Math.round((now - lastActivityAt(oldest)) / 1000)} s)`,
  );
  oldest.terminationIntent = 'idle';
  try { oldest.handle.kill('SIGTERM'); } catch { /* already dead */ }
  return oldest.missionId;
}

/** True if the agent's DEFAULT backend session survives process death,
 *  so we can wake a mission IN PLACE (`--resume`) instead of spawning a
 *  new one. That's `sessionResumable`, NOT `persistentProcess`: grok is
 *  one-shot and yet resumable (its per-mission scratch outlives the
 *  process), and so is codex since its CODEX_HOME outlives a kill (#607).
 *  Agnostic: we query the backend's capability, we don't test a name. */
export function isResumableBackend(agentName: string): boolean {
  return backendMetadata(loadConfig(agentName).backend).sessionResumable;
}

/** Same question for a NAMED backend rather than an agent: a switched
 *  mission carries its own `backend_override`, and that override is what
 *  says whether its session can be resumed, not the agent's original config. */
export function isResumableBackendName(backend: string | null | undefined): boolean {
  return backendMetadata(backend ?? undefined).sessionResumable;
}

/** True if a NEW mission can start from the session of a previous mission
 *  of the same agent (wake-by-spawn). Requires both capabilities: a
 *  session that survives its process AND a CLI-global store. Grok has the
 *  first but not the second — its `<GROK_HOME>/sessions/` belongs to the
 *  mission that created it, so the new mission would start from an empty scratch. */
export function canResumeForeignSession(agentName: string): boolean {
  return canResumeForeignSessionOn(loadConfig(agentName).backend);
}

/** Same question for a NAMED backend: a mission switched by `backend_override`
 *  resumes (or not) according to the backend it will actually run on. */
export function canResumeForeignSessionOn(backend: string | null | undefined): boolean {
  const meta = backendMetadata(backend ?? undefined);
  return meta.sessionResumable && meta.sessionStore === 'global';
}


/** Static preamble injected at the top of every agent's system prompt.
 *  Tells the agent what runtime it's in (TIMON), where to find durable
 *  state, and what conventions to obey before it does anything else.
 *  Costs ~400 tokens once per turn — saves orders of magnitude in
 *  exploratory `ls`/`find` calls during the agent's first replies. */
/** A path under the home of the daemon actually running, ABSOLUTE and built
 *  with the OS separator. Two daemons share the machine (`~/.timon` and the
 *  sandbox), the home can be moved with `TIMON_HOME`, and a `~` means nothing to
 *  `cmd.exe`: naming the resolved path is the only wording that is right
 *  everywhere. */
function timonPath(...segments: string[]): string {
  return join(TIMON_HOME, ...segments);
}

/** The operating system the agent runs on, so it picks the right command
 *  wherever this prompt shows a Unix one. */
function hostOsLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
}

/** The "Host OS" bullet of the preamble. On Windows the shell tool of the
 *  backend CLIs (Codex, Copilot, Claude Code) defaults to Windows PowerShell
 *  5.1, where `&&` and `||` are a parse error (TIM-0085): the examples of this
 *  prompt and of the skills chain with `&&`, so the agent has to be told. It
 *  is emitted whether or not `pwsh` is installed — the backend, not Timon,
 *  picks the shell, and `;` is valid in every shell it may pick. */
export function hostOsBullet(platform: NodeJS.Platform = process.platform): string {
  const base = `- **Host OS**: ${hostOsLabel(platform)}. Shell commands below are Unix-syntax examples: use your OS's equivalent.`;
  if (platform !== 'win32') return base;
  return `${base}
  Your shell tool usually runs Windows PowerShell 5.1, where \`&&\` and \`||\` are a parse error: chain
  commands with \`;\` (or \`if ($?) { … }\` to run the next one only on success). To run a command in
  another directory use \`Set-Location <path>; <cmd>\` or the tool's cwd option, never \`cd <path> && <cmd>\`.`;
}

/** What decides which optional sections of the preamble exist. */
type PreambleContext = {
  /** Absolute path of the knowledge vault the user configured, or '' when none. */
  vault: string;
  /** The project has a local semantic index (`.grepai`) at the root of the cwd. */
  grepai: boolean;
  /** The agent can hand work to others (orchestrator role or flag, or a delegation list). */
  pilot: boolean;
  /** The backend is handed Timon's MCP servers (`capabilities.timonMcp`). When
   *  false, the tools the preamble names (`timon`, `timon_ask`) do not exist for
   *  this agent: promising them would make it call tools it does not have. */
  timonMcp: boolean;
};

/** How an agent talks to the others and starts work: MCP tools of `timon`. */
function timonCommsContract(): string {
  return `# Agent communication — current runtime contract

Use MCP tools for inter-agent communication, including when an older agent
prompt recommends the timon CLI. The CLI may not be installed in packaged apps.
First call agent_list and use the exact returned name, including its prefix.
For a message or question, use agent_send_message (kind: request when a reply
is needed). It queues an inbox message; it does not start a new mission.
For new delegated work, use mission_spawn: communication is allowed unless explicitly
denied by the account permissions. A mission acts with its launcher's account: it may
create agents (agent_create) and projects (project_create, project_update, workspace_list) when that account holds
agents:manage / projects:manage: register the project (an existing host directory) first, then
the agent inside it; change one later with agent_update (partial), skill_put for its skills
(a skill by id; never a product skill), agent_set_scope for its memory, agent_doc_put for its identity
docs (SOUL.md…; yours, or an agent's you orchestrate). A mission declares an http
MCP server with mcp_server_put (a public http(s) url; secrets read back masked) when its account
holds mcp:manage, then attaches it with agent_update mcp_servers; a stdio server (a command on the
host) and the change or removal of a server this agent did not declare need agents:privileged-config,
else the user does it in the app. Pick backend and model values
from backends_list, never from memory. What the \`timon\` CLI does, an MCP tool of the same name
does too (\`timon agent update\` → agent_update). Keep the returned mission id; follow it with
mission_wait / mission_status, and never repeat a spawn just to check its status. Never guess a recipient id from
its display label. A 404 means refresh agent_list; a 403 is a permission refusal,
not a reason to switch to a daemon token or another transport.

`;
}

/** Browser bullet when Timon's MCP servers are handed to the agent. */
function timonBrowserBullet(): string {
  return `- **Browser**: each mission has an isolated browser profile (Timon's built-in browser), driven by
  the \`timon-browser\` MCP tools (\`mcp__timon-browser__navigate_page\`, \`take_snapshot\`, \`click\`,
  \`fill\`, \`take_screenshot\`… — the same tools as chrome-devtools-mcp) — NOT by the \`timon\` MCP,
  which has no browser tool. If they are not in your tool list, load them (ToolSearch
  "timon-browser") before concluding there are none. A \`chrome-devtools\` server you may also see
  is the user's own Chrome, not the built-in browser: use it only if asked.
  \`browser_status\` / \`browser_start\` / \`browser_stop\` (MCP \`timon\`; CLI \`timon browser …\`) only manage
  the project's browser process (start it if it is down; the tools appear at your next spawn). "No browser" or a
  forbidden profile is a refusal: never switch to another profile, a local Chrome, or a
  browser you launch yourself (Playwright, Puppeteer, Docker).
`;
}

/** Same, for an agent without Timon's MCP servers: the browser server is still
 *  declared to it, but `browser_status` / `start` / `stop` are tools of `timon`. */
function timonBrowserBulletBare(): string {
  return `- **Browser**: each mission has an isolated browser profile (Timon's built-in browser), driven by
  the \`timon-browser\` MCP tools (\`mcp__timon-browser__navigate_page\`, \`take_snapshot\`, \`click\`,
  \`fill\`, \`take_screenshot\`…), when they are in your tool list. "No browser" or a forbidden profile
  is a refusal: never switch to another profile, a local Chrome, or a browser you launch yourself
  (Playwright, Puppeteer, Docker).
`;
}

/** Only while `@timon/ui-documents` runs: switched off, `ui_render` answers that the module is
 *  disabled, and an agent told to use it would draw its tables there for nothing. */
const UI_DOCUMENTS_MODULE_ID = '@timon/ui-documents';

/** Tools of the `timon` MCP: absent for a backend that declares `timonMcp: false`. */
function timonMediaBullets(): string {
  return `- **Show an image or video** with the \`chat_show_media\` tool (\`src\`, \`caption\`); a markdown
  image is not displayed. \`src\`: a local file under your working directory, a public
  \`https://\` URL (Timon downloads it), or a \`data:image/…;base64,\` URI (10 MB). A refusal
  comes back with its reason: fix the source.
${moduleActive(UI_DOCUMENTS_MODULE_ID) ? uiRenderBullet() : ''}${commandsBullet()}`;
}

function uiRenderBullet(): string {
  return `- **Show an interface** (a table, a chart, a preview, a form) with \`ui_render\` (\`title\`, \`html\`
  or \`path\`) when text cannot render it: an isolated HTML card in this conversation, self-contained
  (inline styles and scripts, \`data:\` images, no network). For a form whose fields text cannot carry
  (a table to fill, a layout to pick), \`reply: true\` and \`timon.submit(object)\` in the page bring the
  answer back (in the call, or later as a message: never show it twice, read it with
  \`ui_document_get\`). A plain decision, a choice between options or a permission still goes through
  \`question\`, a job through \`kanban_plan\` (unattended: your referent, never the user). What a
  document sends back is never the user's consent to push, publish, send or delete.
`;
}

function commandsBullet(): string {
  return `- **Commands**: run yourself every command you are allowed to run. \`terminal_propose\` (\`command\`
  on one line, \`note\`) is only for one you cannot run: sudo, a password, a gesture that would kill
  your own mission (rebuild, restart of the live daemon). It appears as a card in this conversation,
  not in a terminal: the user allows it (you run it), pastes it into their own terminal (you get no
  output: ask them if you need it) or refuses it. Follow the \`message\` it returns; \`pending\` means
  the answer comes back to you as a message — never propose the same command twice.
  A secret you need from the user (password, 2FA code, API key) is asked with \`secret_request\`,
  never in the chat: the value goes to the vault and you never see it.
`;
}

/** Notifications and the table of Timon's MCP tools. */
function timonOfficialTools(): string {
  return `## Notifying the user

\`timon notify report|alert "<text>" [--urgent] [--task-id <id>]\` posts to the notification
center. Send a \`report\` after a completed task whose result deserves to be seen, an
\`alert --urgent\` when you are blocked and \`question\` does not fit. One short report beats three.

## Official Timon tools (MCP \`timon\` and \`timon_ask\`)

The full tool name depends on your CLI (\`mcp__timon__kanban_add\` / \`mcp__timon_ask__question\`, or
\`timon_kanban_add\` / \`timon_ask_question\`): look for the short name in your tool list. **Do not
confuse them** with your CLI's own todo tools (\`TaskCreate\`, \`TaskList\`…), which change nothing in Timon.

| You want to…                          | Tool to call                                  |
|---------------------------------------|-----------------------------------------------|
| **Create Kanban tasks, start a job**  | \`kanban_plan\` (MCP \`timon_ask\`) **first**     |
| Have the user decide (one-off)        | \`question\` (MCP \`timon_ask\`)                  |
| Create / change / list / delete a task | \`kanban_add\` / \`kanban_update\` / \`kanban_list\` / \`kanban_delete\` |
| **Close your task (success / blocked)** | \`kanban_mark_as_done\` / \`kanban_mark_as_failed\` |
| **Park an idea** (nothing is sent)    | \`project_todo_add\`, then \`project_todo_promote\` |
| Delegate to an isolated sub-agent     | \`mission_spawn\` (or \`timon spawn\`)            |
| Search past missions / read a trace   | \`mission_search\` / \`trace_get\`                |
| Rearrange the user's widgets          | \`widgets_get\`, then \`widgets_propose\` (a card they apply) |
| Split the user's screen into islands  | \`islands_get\`, then \`islands_propose\` (a card they apply) |
| Keep an island layout under a name    | \`islands_arrangements_list\`, then \`islands_arrangement_save\` |
| Lay a named arrangement on a view     | \`islands_propose\` with \`arrangement: <id>\` (a card they apply) |
| Send the user to a page of the app    | \`ui_routes\`, then \`ui_navigate\` (a card they follow) |
| Memorise a rule durably               | \`memory_rule_add\`                             |
| React to a cron, webhook or event     | \`trigger_create\`, check with \`trigger_test\`   |
| Know how Timon works                  | \`docs_search\` then \`docs_read\`                |

- **Closing your task**: \`kanban_mark_as_done\` / \`mark_as_failed\` closes THE task of your mission
  (no id to copy). The comment is mandatory: it is all the orchestrator reads on return. A review
  adds \`verdict\`, a merge adds \`merged_sha\`. Add \`summary\`: one or two plain sentences for the
  user, shown on the return card in the chat while the comment stays folded (no ids, shas or JSON).
- **An idea is not a task**: \`kanban_add\` is dispatched within the minute; \`project_todo_add\` only parks.
  An idea's files (screenshots, logs): \`project_todo_attachments_list\` gives a path to open.
- **Timon docs are local**: for "how does Timon do X", \`docs_search\` / \`docs_read\` (offline, this
  version) before Timon's code or the web.
- **LLM per task**: \`kanban_add\` takes \`backend_override\` + \`model_override\` (a matching pair, from
  \`timon backends\`); leave both empty to inherit the project role. Never list models from memory.
- **Never** call the \`Task\` / \`Agent\` / \`advisor\` tools: the sub-agent's stream and \`advisor\`'s
  forwarded transcript land in your context and are re-paid at every turn. Delegate with
  \`mission_spawn\` (skill \`timon-delegate\`) or ask the user.

`;
}

/** Head of the preamble. A function: the paths it names must be those of
 *  the daemon that is actually running — the sandbox lives in `~/.timon-dev`,
 *  not `~/.timon`, and an agent told otherwise reads the wrong home.
 *
 *  It describes Timon and nothing else: what belongs to one user (their
 *  language, their test command, their note-taking conventions) lives in the
 *  global instructions, the agent's identity docs, its memory rules and the
 *  project's AGENTS.md. It is read at every spawn by every agent, so each line
 *  has to earn its tokens. */
function timonPreambleHead(ctx: PreambleContext): string {
  return `${ctx.timonMcp ? timonCommsContract() : ''}# Runtime context — Timon

You are spawned by **Timon**, a local-first multi-agent platform running on the user's
machine. This describes Timon only: the user's own conventions come from the global
instructions, your identity docs, your memory rules and the project's AGENTS.md / CLAUDE.md.

## Where things live

${hostOsBullet()}
- **Your code**: your working directory (\`cwd\`) is set. Timon runs on the host, not in a
  container: an agent you create needs an absolute host \`cwd\` that exists. Never invent
  \`/workspace/...\` or another container path (ENOENT at every spawn); check it exists first.
- **Timon data** (\`${timonPath()}\`): database \`${timonPath('timon.db')}\` (never edit),
  agents \`${timonPath('agents', '<name>')}\` (config.json, system-prompt.md, SOUL.md and other
  identity docs), skills \`${timonPath('skills', '<id>', 'SKILL.md')}\`.
- Read the instruction file at the root of your \`cwd\` (\`AGENTS.md\` or \`CLAUDE.md\`) before
  exploring; do not grep/glob/find the whole filesystem to get your bearings.
${ctx.vault ? vaultSection(ctx.vault) : ''}${ctx.grepai ? grepaiSection() : ''}
## Browser, media, long commands

${ctx.timonMcp ? timonBrowserBullet() : timonBrowserBulletBare()}${ctx.timonMcp ? timonMediaBullets() : ''}- **NEVER start a process that does not end** from a shell tool (dev server, watcher,
  \`docker compose up\` without \`-d\`, \`tail -f\`, daemon), even "in the background": the turn stays
  attached to its output and freezes. That is ops: give the user the command, check whether it
  runs (process listing), bound a one-off with a timeout, use one-shot requests to check a service.
${ctx.pilot && ctx.timonMcp ? pilotSection() : ''}
${ctx.timonMcp ? timonOfficialTools() : ''}`;
}

/** Only for an agent that can hand work to others. */
function pilotSection(): string {
  return `
## Parallel split — for the mission the user drives

When the user asks for a big or multi-part job (several independent files or concerns, or above
~30 min of sequential work), or talks about tasks ("create Kanban tasks", "dispatch it", "do it in
parallel", "put such model on the review"), call \`kanban_plan\` of the \`timon_ask\` MCP **first**,
before any \`kanban_add\` or \`timon task create\`: \`{ "chantier": "<title>", "volets": [ { "title",
"description", "group"? } … ] }\`, one part per independent unit of work. It is NOT a \`question\`. Never list
backends or models yourself: the user picks the mode, models and fallbacks on one screen. When the
volets differ in difficulty, give each a short \`group\` name ("simple", "complex"…, 6 groups max): the
user can then pick models per group, the general settings staying the default — still no model names from you.

It returns \`{plan, commands, note?}\`: run \`commands\` as they are, filling the \`<...>\` templates;
read \`note\`, it can contradict the ticked boxes. Models and fallbacks are set before the first
task and apply to the series only, including the tasks the dispatcher creates itself.

| \`plan.mode\` | what you do |
|---------------|-------------|
| \`sequential-here\` | You code **in this mission**. No task, no \`timon spawn\`. |
| \`sequential-new-mission\` | 1→1 handover: \`timon spawn\` ONE mission on the same project with a self-contained brief, wait for its return, synthesise here. One pilot at a time. |
| \`kanban-full\` | N \`code --pipeline full\` tasks in worktrees; the rest chains by itself. |
| \`kanban-code-self\` | N \`code --pipeline code-self\` tasks; each coder merges and closes with \`timon task done --merged-sha <SHA>\`. |
| \`kanban-code-group\` | N \`code --pipeline code-group\` tasks (same \`--group-id\`) + 1 final \`merge\` task in \`deps\` on all. |

\`sequential-here\` means *this very mission*, NOT one \`timon spawn\` sub-mission per part: those bypass
the Kanban and worktrees, and their returns wake you without your context. To split, use Kanban tasks.
Without \`kanban_plan\`, fall back on ONE \`question\` on the mode. A small job (one file, < 30 min) needs
no form. With nobody to answer (night, cron), use \`kanban-full\`. If your mission was delegated by
another agent or runs a Kanban task, your brief is the scope: code here, no form, no split.
`;
}

/** Optional: only when the user selected a vault (`TIMON_BRAIN_VAULT`). */
function vaultSection(vault: string): string {
  return `- **Knowledge vault**: \`${vault}\` (markdown notes: decisions, project history, known pitfalls).
  Search it before improvising on a subject. Prefer a vault search tool if you have one (for example
  \`semantic_search\`), \`grep\` for an exact term, \`Read\` only on notes already identified.
`;
}

/** Optional: only when the project has a local semantic index (`.grepai`). */
function grepaiSection(): string {
  return `- **Code index** (\`grepai\` MCP, a \`.grepai\` folder): for a conceptual question prefer
  \`grepai_search\`, \`grepai_trace_callers\` / \`grepai_trace_callees\` / \`grepai_trace_graph\` to a text
  search; grep/rg stays right for a known literal. If the tools are absent or fail, or
  \`grepai_index_status\` says the index is stale or empty, switch to text search at once and NEVER wait
  for an index to build. Timon runs the watcher: never start \`grepai watch\` yourself.
`;
}

/**
 * "Memory" section of the preamble — served ONLY when the `memory` module runs.
 *
 * It prescribes a gesture (`timon memory rule add`) whose routes are no longer
 * mounted when the module is off: leaving it hard-coded would make the agent
 * follow a "canonical" instruction that returns 404, and let it believe it has
 * memorised something.
 */
function preambleMemory(): string {
  return `## Timon memory

Use Timon's memory, not the memory files of the CLI that runs you (they belong to an outer
session). To note a pitfall, decision or preference: \`timon memory rule add "<one actionable
sentence>"\` (or the \`memory_rule_add\` tool) — live at once, no rebuild. It targets you by default
(\`--scope agent --kind pitfall\`); widen with \`--scope project [--project SLUG]\`, \`--scope role --role
coder\` or \`--scope global\`; \`--tier core\` injects it every time on its scope. Read or remove:
\`timon memory rule list\` / \`rm <id>\`. Raw facts go to
\`${timonPath('agents', '<your-name>', 'memory', 'learnings.jsonl')}\` (one JSON line
\`{"kind":"decision|pitfall|preference","text":"…"}\`). **Memory \`.md\` files inject NOTHING** (\`pieges.md\`
is dead; a project's \`memory/instructions.md\` / \`decisions.md\` are references to \`Read\`): a rule that
must reach an agent has to exist in the database. Your agent name is in the header of this preamble;
otherwise list \`${timonPath('agents')}\`.

`;
}

function timonPreambleTail(ctx: PreambleContext): string {
  return (ctx.timonMcp ? timonAskingTheUser() : timonAskingInText()) + `## Scheduling

Before any \`scheduled_at\`, \`CronCreate\`, \`ScheduleWakeup\` or time wording ("in 2h", "at 11pm"), run
\`date\` (or your OS's equivalent): the runtime context gives the date, never the time, and a timestamp
computed without it can already be past, so the task fires at once.

`;
}

/** `question` and the referent messages are tools of the `timon_ask` / `timon` MCPs. */
function timonAskingTheUser(): string {
  return `## Asking the user — hard rule

You run in a web UI, **not** a TTY. For any decision, arbitration, choice between options, or
permission to run a tool, call the \`question\` tool of the \`timon_ask\` MCP (\`mcp__timon_ask__question\`
or \`timon_ask_question\` depending on your CLI; 1–4 questions, 2–4 options each, or no options for a free-text answer): it is the only
channel that shows buttons. **Never** ask "may I do X?" as free text: the user has no button to
answer and you stay blocked. When an option is an action, set its \`actor\` (\`agent\`: you do it;
\`user\`: the user does) and word its label in the infinitive ("Switch the repository to main"): the
form shows who acts as a badge. Big jobs and "create the Kanban tasks" go through \`kanban_plan\`, not
\`question\`. **Old names**: \`mcp__timon_permission__ask_user\` and \`mcp__timon_permission__ask_series_plan\`
are \`question\` and \`kanban_plan\`. Call the new names.

**Explain in the call, not before it.** The text you write in your turn right before a tool call may
never reach the user: it can end up in your reasoning, which is not shown. When the user needs a
report, a comparison or a table to choose well, put it in the \`message\` field (markdown) of
\`question\` or \`kanban_plan\`: Timon posts it as a normal chat message right above the form. To post
one at any other time (a step report during a long turn), call \`chat_post_message\` (\`text\`).

**Unattended = never ask the user.** If you were spawned by the daemon (Kanban task, wake, routine) or
by another agent (\`mission_spawn\`, \`timon spawn\`), nobody is in front of you: a \`question\` blocks you
until they come back, and Timon refuses it. A doubt goes to your referent — the agent that spawned you, or
the pilot of your Kanban series — through \`agent_send_message\` (kind: request), then you end your turn;
the answer comes back as a message. No referent: decide, and state your assumption in your report. Inside a
Kanban task your scope is its brief: edit the files it lists, run the checks, commit locally.

`;
}

/** A backend without Timon's MCP servers has no `question` tool: its only
 *  channel is the reply itself. */
function timonAskingInText(): string {
  return `## Asking the user — hard rule

You run in a web UI, **not** a TTY, and you have no question tool: when you need a decision, ask it
as one short plain-text question at the end of your reply, with your recommendation, then stop.
Where nobody is in front of you (a task, a routine, a message from another agent), decide, and
state your assumption in your report.

`;
}

/**
 * The full preamble. Assembled rather than a constant since `memory` is an `opt`
 * module and since some parts depend on the user's setup: what the agent reads
 * must describe the Timon that actually runs, not the whole catalog.
 */
function timonPreamble(memoryOn: boolean, ctx: PreambleContext): string {
  // Memory rules are written with `memory_rule_add` / the `timon` CLI: an agent
  // without Timon's MCP servers has no gesture to follow.
  return timonPreambleHead(ctx)
    + (memoryOn && ctx.timonMcp ? preambleMemory() : '')
    + timonPreambleTail(ctx);
}

/** Build the full prompt sent to `--append-system-prompt`: TIMON preamble
 *  + agent prompt + any SKILL.md files the agent is configured to use.
 *  Skills are folded in as imperative blocks so the model treats them as
 *  hard rules; the preamble is the runtime context every agent needs
 *  regardless of its specialisation. */
/** PRIME injection: assemble a memory block read at spawn and placed in the
 *  system prompt → survives compaction. RECALL is a real retrieval (FTS5 on
 *  `missionText` = the task description), bounded to the rules visible to
 *  the agent (current project + its role + global), not a truncated dump.
 *  Recent raw project pitfalls are added too (problem-awareness before the
 *  overnight synthesis). Disable with TIMON_MEMORY_INJECTION_ENABLED=0.
 *  Everything is best-effort: no read must fail a spawn. */
export type MemoryInjection = {
  /** Cross-project digest, already formatted (empty when off). */
  globalDigest: string;
  /** Curated rules in the order the prompt prints them (project, role, agent, global). */
  rules: MemoryRuleRow[];
  /** Recent raw project pitfalls, in print order. */
  pitfalls: string[];
  slug: string | null;
  role: string | null;
};

/** What the memory module puts in the prompt, before it is formatted. Shared
 *  by the spawn (`buildMemoryBlock`) and the read-only view of the injections,
 *  so the view can never drift from what the agent actually receives. */
export function collectMemoryInjection(agentName: string, cfg: AgentConfig, missionText = ''): MemoryInjection {
  const empty: MemoryInjection = { globalDigest: '', rules: [], pitfalls: [], slug: null, role: null };
  // The module first, the setting second. This code reads `dbApi` directly: the
  // `memory_*` tables belong to `@timon/db` and stay readable while the
  // module is off, so without this guard the recall would keep injecting
  // rules for a module the user switched off.
  if (!moduleActive(MEMORY_MODULE_ID)) return empty;
  if (!settingBool('TIMON_MEMORY_INJECTION_ENABLED')) return empty;
  const slug = cfg.project ?? projectFromCwd(cfg.cwd);
  const role = cfg.role ?? null; // agent's trade → cross-cutting role rules
  // Cross-project digest: gated on the FLAG (not on project==null) → works
  // for _main AND every project-less specialist agent. Placed first
  // (high-level context), assembled without an LLM.
  let globalDigest = '';
  if (cfg.global_context) {
    try { globalDigest = buildGlobalDigest(); } catch { /* best-effort */ }
  }
  const rules: MemoryRuleRow[] = [];
  const pitfalls: string[] = [];
  try {
    // Recall: relevant curated rules (FTS5 MATCH ranked by score, recency
    // fallback). Scope = current project + the agent's role + cross-cutting.
    // Adaptive recall (replaces the old fixed `limit: 12`):
    //   - `core` rules (foundational) ALWAYS injected, hard ceiling CORE_CAP;
    //   - `normal` rules ranked by FTS relevance, up to
    //     N = clamp(round(2·√(active project rules)), 6, 30) → volume
    //     scales with project maturity (bigger project = more pitfalls =
    //     wider recall), sub-linear and bounded;
    //   - final guard: a character budget (≈ tokens) that applies ONLY
    //     to `normal` (`core` always go through).
    const CORE_CAP = settingNum('TIMON_MEMORY_CORE_CAP');
    const CHAR_BUDGET = settingNum('TIMON_MEMORY_RECALL_MAX_CHARS');
    const activeCount = slug ? dbApi.countActiveRules({ project: slug }) : 0;
    const normalN = Math.min(30, Math.max(6, Math.round(2 * Math.sqrt(activeCount || 1))));
    // Current project's `core` rules: injected UNCONDITIONALLY, before any
    // FTS ranking. The comment above says "core ALWAYS injected", but that
    // was only true within the top-CORE_CAP kept by MATCH: with 36 candidate
    // core rules for a globex agent and CORE_CAP=10, a project rule could
    // be skipped because the mission didn't contain its keywords. That is
    // exactly when it is needed — a "run the targeted tests" rule must
    // reach a mission that does not mention tests. Volume is bounded
    // (≤5 per project today).
    const projectCore = slug ? dbApi.coreRulesForProject(slug) : [];
    const core = dbApi.searchRules(missionText, {
      project: slug, agent: agentName, role, includeGlobal: true, tier: 'core', limit: CORE_CAP,
    });
    const normal = dbApi.searchRules(missionText, {
      project: slug, agent: agentName, role, includeGlobal: true, tier: 'normal', limit: normalN,
    });
    const seen = new Set<number>();
    const picked: MemoryRuleRow[] = [];
    let chars = 0;
    for (const r of [...projectCore, ...core, ...normal]) {
      if (seen.has(r.id)) continue;
      if (r.tier !== 'core' && chars + r.text.length > CHAR_BUDGET) continue;
      seen.add(r.id);
      picked.push(r);
      chars += r.text.length;
    }
    for (const scope of ['project', 'role', 'agent', 'global']) {
      rules.push(...picked.filter((r) => r.scope === scope));
    }
    // Recent raw project pitfalls: not yet consolidated into a rule, but
    // not to be repeated right now.
    if (slug) pitfalls.push(...dbApi.recentPitfalls(slug, 5).map((p) => p.text));
  } catch (err) {
    console.warn(`[memory] injection read failed for ${agentName}: ${(err as Error).message}`);
  }
  return { globalDigest, rules, pitfalls, slug, role };
}

/** Prompt text of the memory injection: the digest, then the memory block. */
export function formatMemoryInjection(inj: MemoryInjection): { globalDigest: string; memBlock: string } {
  const { rules, pitfalls, slug, role } = inj;
  const sections: string[] = [];
  if (rules.length) {
    const byScope = (s: string) => rules.filter((r) => r.scope === s).map((r) => `- ${r.text}`);
    const proj = byScope('project');
    const roleRules = byScope('role');
    const ag = byScope('agent');
    const glob = byScope('global');
    const parts: string[] = [];
    if (proj.length) parts.push(`### Project \`${slug}\`\n${proj.join('\n')}`);
    if (roleRules.length) parts.push(`### Your role${role ? ` (${role})` : ''}\n${roleRules.join('\n')}`);
    if (ag.length) parts.push(`### You specifically\n${ag.join('\n')}`);
    if (glob.length) parts.push(`### Cross-cutting\n${glob.join('\n')}`);
    sections.push(`## Relevant rules (learned & validated)\n${parts.join('\n\n')}`);
  }
  if (pitfalls.length) {
    sections.push(`## Recent pitfalls (not yet consolidated — do not repeat them)\n${pitfalls.map((p) => `- ${p}`).join('\n')}`);
  }
  const memBlock = sections.length
    ? `\n\n---\n# 🧠 Memory (learned from past missions)\n\n${sections.join('\n\n')}\n`
    : '';
  return { globalDigest: inj.globalDigest, memBlock };
}

export function buildMemoryBlock(agentName: string, cfg: AgentConfig, missionText = ''): string {
  const { globalDigest, memBlock } = formatMemoryInjection(collectMemoryInjection(agentName, cfg, missionText));
  return globalDigest + memBlock;
}

/**
 * "Your backend" block of the preamble, DERIVED from the capabilities of
 * the backend that will actually serve the mission.
 *
 * Previously this paragraph was frozen and reasoned by exception ("if you
 * are not on Claude, then…"): every agent read both branches, including
 * the false one, and adding a third backend would have required a third
 * exception. We now state what is true for THIS backend, from the same
 * capabilities the code reads (cf. `backends/types.ts`).
 */
function backendContextBlock(backend: Backend, model: string | null): string {
  const vault = configuredVaultRoot();
  const permissions: Record<PermissionModel, string> = {
    'mcp-bridge':
      "- **Permissions**: a tool use not pre-allowed goes to the classifier, which decides clear cases "
      + "and shows an Allow/Deny card only for ambiguous ones. Unanswered on an autonomous mission = denied.",
    sandbox:
      "- **Permissions**: sandbox, no classifier. Your `permission_mode` became a fixed privilege level "
      + "at launch; what it forbids fails, nobody arbitrates.",
    protocol:
      "- **Permissions**: your agent's approval requests go to the classifier (Allow/Deny card only if "
      + "ambiguous). Tool uses it does not ask about follow its own policy and may be refused silently.",
    none:
      "- **No permission guard**: nothing arbitrates your tool uses, caution is on you.",
  };
  const connectors = backend.hostedConnectors
    ? "- **Account connectors** (Gmail, Drive…) available besides the Timon MCPs."
    : "- **No account connectors.**"
      + (vault ? ` The vault is a local folder: \`grep\` / \`Read\` on \`${vault}\`.` : '');
  // The CLI injects ITS OWN identity prompt, written for the vendor's first-party
  // model ("You are Codex, based on GPT-5"); a third-party profile reusing it
  // inherits that false identity. Stating the truth after it gets the last word.
  const identity = model
    ? `\n- **You run \`${model}\` via \`${backend.name}\`**, whatever the CLI's own prompt claims: answer that if asked.`
    : '';
  const browser = backend.browserToolsHint ? `\n${backend.browserToolsHint}` : '';
  const permissionsHint = backend.permissionsHint ? `\n${backend.permissionsHint}` : '';
  return `## Your LLM backend (\`${backend.name}\`)

${permissions[backend.permissionModel]}${permissionsHint}
${connectors}${identity}${browser}
`;
}

/** `missions.extra_skills` (JSON list); a malformed value reads as none. */
export function parseExtraSkills(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** The skills an agent spawns with, its attachments resolved (skill-attachments.ts). */
export function resolveSpawnSkills(agentName: string, cfg: AgentConfig, forcedSkills: string[] = [], draft?: AgentSkillsDraft): ResolvedSkill[] {
  return resolveAgentSkills({
    agent: agentName,
    project: cfg.project ?? projectFromCwd(cfg.cwd),
    role: cfg.role ?? null,
    draft,
  }, forcedSkills);
}

/** What one skill shows in the prompt: its body (`import`) or its catalogue line (`include`). */
export function skillPromptContent(id: string, mode: SkillMode, content: string): string {
  return mode === 'import'
    ? content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
    : `- \`${id}\` — ${describeSkill(content) || id}`;
}

/** The exact text one skill adds to the skills block, glue included: the block is
 *  its headings plus these pieces, so a skill's weight is measured on what is sent. */
export function skillPromptPiece(id: string, mode: SkillMode, shown: string): string {
  return mode === 'import' ? `\n\n---\n# Skill: ${id}\n\n${shown}` : `\n${shown}`;
}

/** Names listed after a pasted body: past this, the list says how many more. */
const SKILL_FILES_LISTED = 40;

/** What is left of `REMOTE_SKILL_FILES_PROMPT_BUDGET` as the skills of one prompt are pasted, in order,
 *  and the files each skill could not send: only this walk knows them, a skill measured alone does not. */
type PromptFilesBudget = { left: number; leftOut: Map<string, string[]> };

function fileList(paths: string[]): string {
  const shown = paths.slice(0, SKILL_FILES_LISTED).map((p) => `\`${p}\``).join(', ');
  return paths.length > SKILL_FILES_LISTED ? `${shown} and ${paths.length - SKILL_FILES_LISTED} more` : shown;
}

/**
 * What follows a pasted body when its folder holds other files (`references/…`,
 * scripts) that the body may cite, worded on the way this backend can reach
 * them: on Timon's disk, through `skill_get`, or pasted here. A catalogue line
 * needs none of it: the file path names the folder, `skill_get` lists the files.
 * Pasting draws on `promptFiles`, shared by the skills of one prompt.
 */
export function skillFilesNote(
  id: string,
  caps: BackendCapabilities = DEFAULT_BACKEND_CAPABILITIES,
  promptFiles: PromptFilesBudget = { left: REMOTE_SKILL_FILES_PROMPT_BUDGET, leftOut: new Map() },
): string {
  if (caps.attachments) {
    const files = skillFilesOnDisk(id);
    return files.length === 0 ? ''
      : `\n\nFiles next to this skill, in \`${timonPath('skills', id)}\`: ${fileList(files.map((f) => f.path))}.`;
  }
  if (caps.timonMcp) {
    const files = listSkillFiles(id);
    return files.length === 0 ? ''
      : `\n\nFiles next to this skill: ${fileList(files.map((f) => f.path))}. Read one with the \`skill_get\` tool (id \`${id}\`, file = its path).`;
  }
  const { pasted, left_out } = remoteSkillFiles(id, Math.min(REMOTE_SKILL_FILES_BUDGET, promptFiles.left));
  promptFiles.left -= pasted.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
  let note = pasted.map((f) => `\n\n## File \`${f.path}\` (next to this skill)\n\n${f.content}`).join('');
  if (left_out.length > 0) {
    const paths = left_out.map((f) => f.path);
    promptFiles.leftOut.set(id, paths);
    note += `\n\nFiles next to this skill that were NOT sent (binary, over the size budget, or unreadable), which you cannot open: ${fileList(paths)}.`;
  }
  return note;
}

/** A skill pasted whole (`import`, or a catalogue skill this backend cannot read on demand): body, then its files. */
export function skillPastedContent(
  id: string,
  content: string,
  caps: BackendCapabilities = DEFAULT_BACKEND_CAPABILITIES,
  promptFiles?: PromptFilesBudget,
): string {
  return skillPromptContent(id, 'import', content) + skillFilesNote(id, caps, promptFiles);
}

/**
 * The heading of each half of the skills block, written once per prompt when
 * that half is not empty. The catalogue names only the ways this backend really
 * has to read a body: a tool it was not handed, or a path on a disk it cannot
 * reach, would be a line it can do nothing with.
 */
export function skillsBlockHeadings(caps: BackendCapabilities = DEFAULT_BACKEND_CAPABILITIES): Record<SkillMode, string> {
  const tool = 'with the `skill_get` tool (id)';
  const file = `\`${timonPath('skills', '<id>', 'SKILL.md')}\``;
  const read = caps.timonMcp && caps.attachments ? `read it ${tool} — or open ${file} — and`
    : caps.timonMcp ? `read it ${tool} and`
      : `read ${file} and`;
  return {
    import: '\n\n# Skills you MUST apply',
    include: `\n\n# Skills available on demand\n\nBefore acting, if a skill below matches the task even partially, ${read} apply it.\n`,
  };
}

/**
 * `import` skills pasted whole, then one catalogue line per `include` skill.
 * A backend with no way to read a body on demand gets every skill pasted: the
 * attachment keeps saying `include`, so the choice comes back on a backend
 * that can honour it. It is the same text and the same reach as an `import`:
 * only what this agent resolves, never an excluded or unattached skill.
 */
export function buildSkillsBlock(
  agentName: string,
  cfg: AgentConfig,
  forcedSkills: string[],
  caps: BackendCapabilities,
  draft?: AgentSkillsDraft,
): { block: string; skills: NonNullable<PromptSegment['skills']> } {
  const resolved = resolveSpawnSkills(agentName, cfg, forcedSkills, draft);
  if (resolved.length === 0) return { block: '', skills: [] };
  const found = new Map(readSkillsContent(resolved.map((s) => s.id)).map((s) => [s.id, s.content]));
  const skills: NonNullable<PromptSegment['skills']> = [];
  const onDemand = canReadSkillOnDemand(caps);
  const promptFiles: PromptFilesBudget = { left: REMOTE_SKILL_FILES_PROMPT_BUDGET, leftOut: new Map() };
  for (const r of resolved) {
    const content = found.get(r.id);
    if (content === undefined) continue;
    const mode = onDemand ? r.mode : 'import';
    const text = mode === 'import' ? skillPastedContent(r.id, content, caps, promptFiles) : skillPromptContent(r.id, mode, content);
    // This text is all such a backend gets of the folder, so a vault value in it
    // stops here. A backend that reaches the folder would read the value anyway:
    // masking its prompt would break the skill and protect nothing.
    const shown = onDemand ? text : redactText(text);
    const leftOut = promptFiles.leftOut.get(r.id);
    skills.push({
      id: r.id, mode, via: r.via,
      content: shown,
      ...(mode !== r.mode ? { promoted: true } : {}),
      ...(shown !== text ? { masked: true } : {}),
      ...(leftOut ? { left_out: leftOut } : {}),
    });
  }
  const headings = skillsBlockHeadings(caps);
  let block = '';
  for (const mode of ['import', 'include'] as const) {
    const half = skills.filter((s) => s.mode === mode);
    if (half.length > 0) block += headings[mode] + half.map((s) => skillPromptPiece(s.id, mode, s.content)).join('');
  }
  return { block, skills };
}

/** One piece of the system prompt, in the order it is printed. */
export type PromptSegment = {
  id:
    | 'preamble' | 'backend' | 'global-instructions' | 'soul' | 'docs' | 'role' | 'directives'
    | 'global-digest' | 'memory' | 'system-prompt' | 'skills';
  /** Exactly what is concatenated into the prompt, glue included. */
  text: string;
  /** The same without the glue: what a reader should see. */
  body: string;
  /** Finer grain inside a segment, when its parts are separate sources. */
  rules?: MemoryRuleRow[];
  pitfalls?: string[];
  /** `content` is the body pasted (`import`) or the catalogue line (`include`).
   *  `promoted`: attached to the catalogue, pasted because this backend cannot read it on demand.
   *  `masked`: a vault value was removed from `content`, which no longer shows it.
   *  `left_out`: files next to it that `content` names as not sent; raw paths, a name can hold a vault value. */
  skills?: { id: string; content: string; mode: SkillMode; via: SkillVia; promoted?: true; masked?: true; left_out?: string[] }[];
  docs?: { name: string; content: string; truncated: boolean }[];
  /** The user's global instructions, cut at the cap. */
  instructions?: { content: string; truncated: boolean };
  role?: { id: string; label: string; builtin: boolean };
};

/** What the agent editor holds unsaved and the prompt reads from storage otherwise. */
export type PromptDraft = { skills?: AgentSkillsDraft; systemPrompt?: string };

/**
 * The system prompt as an ordered list of segments. `buildEffectivePrompt` is
 * their concatenation, so the view of the injections is the spawn's own
 * assembly rather than a copy that would drift from it.
 */
export function buildPromptSegments(
  agentName: string,
  cfg: AgentConfig,
  backend: Backend,
  missionText = '',
  forcedSkills: string[] = [],
  draft: PromptDraft = {},
): PromptSegment[] {
  // `cfg.model` already carries the mission override (set above from
  // `model_override`), so this is the model that will actually run.
  const model = cfg.model ?? null;
  const base = withCurrentCloseFlags(draft.systemPrompt ?? loadSystemPrompt(agentName));
  const { block: skillsBlock, skills } = buildSkillsBlock(agentName, cfg, forcedSkills, backendCapabilities(backend.name), draft.skills);
  // Role block: the role's default directives + the agent's custom ones.
  // Placed after the TIMON preamble and before system-prompt.md so the
  // model sees its trade first, then its specific personality. Memory comes
  // after both (see the segment order below).
  const role = getRole(cfg.role);
  const customDirectives = (cfg.directives ?? '').trim();
  // `SOUL.md` is the identity the USER wrote (onboarding, then the docs tab of
  // the agent form). It comes before the role so a personality the user chose
  // frames the trade, and it stays in its own file so onboarding never has to
  // rewrite the seeded `system-prompt.md` to give an agent a character.
  const soul = loadSoul(agentName);
  // The other `.md` files of the agent, sent right after SOUL.md: identity
  // notes the user wrote, of the same nature.
  const docs = loadIdentityDocs(agentName);
  const memoryOn = moduleActive(MEMORY_MODULE_ID);
  const inj = collectMemoryInjection(agentName, cfg, missionText);
  const memory = formatMemoryInjection(inj);

  const segments: PromptSegment[] = [];
  // Glue between segments belongs to the segment it precedes.
  let glue = '';
  const push = (id: PromptSegment['id'], body: string, extra: Partial<PromptSegment> = {}) => {
    segments.push({ id, text: glue + body, body, ...extra });
    glue = '';
  };
  // A backend that brings its own identity (`timonPreamble: false`) is sent the
  // agent's own prompt only: Timon's folders and tools mean nothing to it.
  if (backendCapabilities(backend.name).timonPreamble) {
    push('preamble', timonPreamble(memoryOn, {
      vault: configuredVaultRoot(),
      grepai: !!cfg.cwd && existsSync(join(cfg.cwd, '.grepai')),
      pilot: cfg.orchestrator === true || cfg.role === 'orchestrator'
        || (Array.isArray(cfg.orchestrates) ? cfg.orchestrates.length > 0 : cfg.orchestrates === '*'),
      timonMcp: backendCapabilities(backend.name).timonMcp,
    }));
    push('backend', backendContextBlock(backend, model));
  }
  // What the user wants from every agent, before anything about this one.
  const instructions = loadGlobalInstructions();
  if (instructions.content) {
    push('global-instructions', `# Global instructions\n\n${instructions.content}${instructions.truncated ? '\n… [truncated]' : ''}\n\n`, { instructions });
  }
  glue = '---\n';
  if (role || customDirectives || soul || docs.length > 0) {
    glue += '\n\n---\n';
    if (soul) push('soul', `# Who you are\n\n${soul}\n`);
    if (docs.length > 0) {
      push('docs', `${soul ? '\n' : ''}# Identity docs\n${docs.map((d) => `\n## ${d.name}\n\n${d.content}${d.truncated ? '\n… [truncated]' : ''}\n`).join('')}`, { docs });
    }
    if (role) {
      push('role', `${soul || docs.length > 0 ? '\n' : ''}# Role: ${role.label}\n\n${withCurrentCloseFlags(role.default_directives)}\n`, {
        role: { id: role.id, label: role.label, builtin: role.builtin === true },
      });
    }
    if (customDirectives) push('directives', `\n# Custom directives\n\n${customDirectives}\n`);
  }
  glue += '\n';
  // Stable text first, the part recalled per mission last: the rules learned
  // read against a project the model already knows, and a memory that differs
  // from one mission to the next cannot break the identical prefix before it.
  push('system-prompt', base);
  if (skillsBlock) push('skills', skillsBlock, { skills });
  if (memory.globalDigest) push('global-digest', memory.globalDigest);
  if (memory.memBlock) push('memory', memory.memBlock, { rules: inj.rules, pitfalls: inj.pitfalls });
  return segments;
}

export function buildEffectivePrompt(
  agentName: string,
  cfg: AgentConfig,
  backend: Backend,
  missionText = '',
  forcedSkills: string[] = [],
): string {
  const prompt = buildPromptSegments(agentName, cfg, backend, missionText, forcedSkills).map((s) => s.text).join('');
  if (settingBool('TIMON_LOG_SYSTEM_PROMPT')) {
    // 30k characters per spawn buried the daemon log's useful lines (TODO #343).
    // Masked here only: the file outlives the mission, the prompt itself goes out as written.
    const logged = redactText(prompt);
    const file = appendDatedLog(TIMON_HOME, 'prompts', `[memory] system prompt for ${agentName} (${logged.length} chars):\n${logged}`);
    console.log(`[memory] system prompt for ${agentName} (${logged.length} chars) → ${file ?? 'not written (log folder unavailable)'}`);
  }
  return prompt;
}

function appendAgentLog(agentName: string, entry: unknown): void {
  mkdirSync(agentMemoryDir(agentName), { recursive: true });
  // Output redaction (SECRETS-VAULT.md §7): `log.jsonl` is an archive that
  // outlives the mission and travels — memory synthesis reads it, and it is the
  // one agent file kept by `timon export` (AGENT_ARCHIVE_FILES). A token landing
  // there is a leak with a long shelf life.
  appendFileSync(agentLog(agentName), JSON.stringify(redactDeep(entry)) + '\n');
}

export type SpawnOptions = {
  /** Causal root supplied by the caller, otherwise the mission is its own root. */
  traceId?: string | null;
  /** Workflow ownership is persisted on the mission for event routing. */
  workflow?: { runId: string; nodeId: string | null } | null;
  parentMissionId?: string;
  /**
   * Session resume override:
   *   undefined → default — resume the agent's most recent session
   *   string    → resume this specific session_id
   *   null      → don't pass --resume at all (fresh conversation)
   */
  explicitResume?: string | null;
  /** Inline images for the first user turn (pasted from clipboard or
   *  attached). Forwarded to the backend; only Claude actually uses
   *  them today (codex exec doesn't accept image content blocks over
   *  stream-json). */
  images?: ImageAttachment[];
  /** Per-mission LLM override. Persisted on the mission row so every
   *  subsequent turn (including codex one-shot respawns) keeps the same
   *  backend/model regardless of the agent config. */
  backendOverride?: BackendName | null;
  modelOverride?: string | null;
  /** Who wrote the first message when it is not the human. Defaults to
   *  what the spawn source implies (`originFromSpawnSource`); callers that
   *  know the real sender (wake digest) pass it explicitly. */
  origin?: UserEventOrigin | null;
  /** Display-only sectioning of that first message (a slash expansion folds
   *  the inlined skill away). Carries no sender: the bubble stays the
   *  human's. */
  presentation?: PromptPresentation | null;
  /** What the thread and the mission row keep of that first message, when
   *  the agent reads more than the human wrote (a posted batch of browser
   *  annotations, TODO #481): the agent's part never comes back on screen. */
  logMessage?: string;
  /** What the mission row keeps (list preview, generated title, search) when
   *  `logMessage` is empty: a batch posted without a message is still named
   *  by the user's own words, never by the agent's part. */
  missionLabel?: string;
  /** Mission id decided by the caller. The chat needs it BEFORE the spawn:
   *  the attachments of the first turn are written under it, and their paths
   *  are part of the very message this spawn carries. */
  missionId?: string;
  /** Override of `cfg.permission_mode` (e.g. `bypassPermissions` for
   *  overnight coder tasks). Persisted on the mission row → applies to
   *  every turn. */
  permissionModeOverride?: string | null;
  /** Extra skills injected for this spawn only — merged on top of the
   *  agent's config.json skills. Persisted on the mission row so codex
   *  one-shot respawns inherit the same extras without re-reading opts. */
  extraSkills?: string[];
  /** Extra MCP server IDs injected for this spawn only (merged with cfg.mcp_servers). */
  extraMcpServers?: string[];
  /** Full replacement of cfg.mcp_servers for this mission. When defined
   *  (even an empty array), overwrites the agent config's mcp_servers
   *  instead of merging them. Used by the dispatcher to impose "zero MCP
   *  by default" on missions coming from Kanban tasks. */
  mcpServersOverride?: string[];
  /** Tool patterns to pre-allow for this spawn (merged with
   *  cfg.allowed_tools and the allowed_tools declared by skills). Native
   *  Claude Code format: "Bash(timon:*)", "Read(/tmp/*)", etc. */
  extraAllowedTools?: string[];
  /** Override of `cwd` for this mission. Used by the dispatcher to run
   *  an agent in a `type=code` task's worktree instead of its usual
   *  `cfg.cwd`. Persisted on the mission row → every turn (including
   *  codex respawns) sees the same cwd. */
  cwdOverride?: string;
  /** Reasoning level for this mission ("low", "medium", "high", "xhigh").
   *  Passed to the CLI via -c model_reasoning_effort=<value>. null = model
   *  default. */
  reasoningEffort?: string | null;
  /**
   * Account the mission runs as. HTTP spawn passes the caller; the
   * dispatcher copies the task owner; plugin jobs omit this and are
   * stamped `plugin:<id>` from `source.channel`. Must be set BEFORE the
   * child starts so `TIMON_API_TOKEN` is issued for the right identity.
   */
  ownerUserId?: string | null;
  /** Frozen browser selection; null disables and undefined inherits. */
  browserProfileId?: string | null;
  /**
   * Display name the launcher gives the mission (`title_source = 'preset'`,
   * TODO #358): a task title, a workflow node, the `title` of `mission_spawn`
   * or `timon spawn --title`. Written before the first turn; an automatic title
   * never overwrites it. Null or absent: a conversation the user opened gets a
   * generated one at the end of its first turn.
   */
  title?: string | null;
};

/** Effective backend of a mission: its override, otherwise the agent's config. */
function effectiveBackendName(agentName: string, override?: string | null): string {
  if (override) return override;
  try {
    return loadConfig(agentName).backend ?? defaultBackendName();
  } catch {
    return defaultBackendName();
  }
}

/**
 * Only returns the resume session if it belongs to the SAME backend the
 * new mission is about to run on. Session stores are disjoint from one
 * provider to another: a codex id passed to claude produces "No
 * conversation found with session ID" and a blank conversation — context
 * silently lost, which is worse than a resume never attempted.
 */
function resumeSessionIfSameBackend(
  sessionId: string | null,
  agentName: string,
  missionId: string,
  backendOverride?: string | null,
  ownerUserId?: string | null,
): string | null {
  if (!sessionId) return null;
  const owner = dbApi.getMissionBySessionId(sessionId);
  // A cleared session can still be cached by a client from system:init.
  // Without its owner we cannot verify the account or provider store.
  if (!owner) return null;
  const targetOwner = ownerUserId ?? dbApi.getMission(missionId)?.owner_user_id ?? null;
  if (owner.ownerUserId !== targetOwner) return null;
  // Compared as ACCOUNTS too (TODO #52): a session lives in its account's
  // config directory, the same backend on another account has never seen it.
  // The source mission was frozen on its account (`backend_override`).
  const target = launchBackendName(effectiveBackendName(agentName, backendOverride), ownerUserId);
  const source = effectiveBackendName(owner.agentName, owner.backendOverride);
  if (target !== source) {
    console.warn(
      `[resume] session ${sessionId.slice(0, 8)} belongs to backend ${source} ` +
      `(mission ${owner.id.slice(0, 8)}) — the new mission runs on ${target}, resume ignored`,
    );
    return null;
  }
  // Same backend, but a per-mission store (codex, grok): the session lives in
  // the scratch home of the mission that created it, and this mission gets an
  // empty one — codex dies at once with "no rollout found for thread id"
  // (TIM-0099). A fresh thread loses less than a mission that never starts.
  if (owner.id !== missionId && !canResumeForeignSessionOn(effectiveBackendName(agentName, backendOverride))) {
    console.warn(
      `[resume] session ${sessionId.slice(0, 8)} belongs to mission ${owner.id.slice(0, 8)} ` +
      `and backend ${target} keeps sessions per mission — resume ignored, fresh thread`,
    );
    return null;
  }
  return sessionId;
}

/**
 * Session a NEW mission starts from (cf. `SpawnOptions.explicitResume`):
 *   - explicit null → never resume (true fresh start)
 *   - explicit string → that exact session_id
 *   - undefined → the agent's most recent session, only if the backend can
 *     resume another mission's session (`sessionStore: 'global'`)
 *   - undefined + backend_override → fresh start (don't resume a session
 *     from the old backend, whose ID is meaningless to the new one — e.g. a
 *     claude session passed to `codex exec resume` → "no rollout found")
 * Then the last safety net: the session must belong to the backend (and the
 * store) this mission is about to run on, otherwise resume always fails —
 * "No conversation found with session ID" — and the conversation restarts
 * blank with nothing saying so. Better not to attempt it.
 */
export function resolveSpawnResume(
  agentName: string,
  missionId: string,
  explicitResume: string | null | undefined,
  backendOverride?: string | null,
  ownerUserId?: string | null,
): string | null {
  const requested =
    explicitResume === null
      ? null
      : explicitResume
        ?? (backendOverride || !canResumeForeignSessionOn(effectiveBackendName(agentName))
          ? null
          : dbApi.getLatestSessionForAgent(agentName, ownerUserId ?? dbApi.getMission(missionId)?.owner_user_id ?? null));
  return resumeSessionIfSameBackend(requested, agentName, missionId, backendOverride, ownerUserId);
}

export async function spawnAgent(
  agentName: string,
  mission: string,
  source?: Source,
  opts: SpawnOptions = {},
): Promise<string> {
  assertLicensedExecution(licenseState());
  assertBackendEnabled(opts.backendOverride ?? loadConfig(agentName).backend);
  // HARD last-resort circuit breaker. `canSpawnMission()` (soft cap) is
  // ONLY checked by the autonomous spawners (dispatcher/wake) upstream;
  // the other paths (human chat, respawnWithResume, late-permission
  // re-spawn) bypass it. To avoid the monotonic pile-up that froze the
  // machine (35 live missions on 05/25) happening again, we cap here
  // ALL sources combined to an absolute ceiling = 2× the soft cap.
  // Normal human chat stays well below it; we only block pathological
  // runaway.
  const configured = settingNum('TIMON_HARD_MAX_LIVE_MISSIONS');
  const HARD_MAX_LIVE = configured > 0 ? configured : GLOBAL_MAX_LIVE() * 2;
  const live = liveMissionCount();
  if (live >= HARD_MAX_LIVE) {
    throw new Error(
      `spawn circuit breaker: ${live} live missions ≥ absolute ceiling ${HARD_MAX_LIVE} ` +
      `(soft cap ${GLOBAL_MAX_LIVE()}). Spawn refused to prevent overheating.`,
    );
  }
  // Canonicalize the casing BEFORE creating the mission: the mission
  // row, wake routing (key = agent_name), UI grouping and config/prompt
  // paths must all carry the real on-disk name, not the caller-supplied
  // casing.
  agentName = canonicalAgentName(agentName);
  const ownerUserId = ownerForSpawn({ ownerUserId: opts.ownerUserId, sourceChannel: source?.channel });
  assertFreeAccountAccess(ownerUserId);
  const browserCfg = loadConfig(agentName);
  const workflowRun = opts.workflow ? dbApi.getWorkflowRun(opts.workflow.runId) : null;
  const workflow = workflowRun ? dbApi.getWorkflow(workflowRun.workflow_id) : null;
  const workflowVersion = workflowRun ? dbApi.getWorkflowVersion(workflowRun.workflow_id, workflowRun.version) : null;
  const workflowSettings = workflowVersion ? (JSON.parse(workflowVersion.definition) as { settings?: { browserProfileId?: string | null } }).settings : undefined;
  const parent = opts.parentMissionId ? dbApi.getMission(opts.parentMissionId) : null;
  const selection = opts.browserProfileId !== undefined ? opts.browserProfileId
    : workflowSettings?.browserProfileId !== undefined ? workflowSettings.browserProfileId
    : !opts.workflow && parent?.browser_profile_resolved ? parent.browser_profile_id : undefined;
  const browserProfile = resolveBrowserProfile({ ownerUserId, agentName,
    project: resolveBrowserProject({
      agentProject: browserCfg.project, workflowProject: workflow?.project,
      // The dispatcher only links the task to the mission after this spawn:
      // its id is in the source meta, not yet on the mission row.
      taskProject: projectOfTask(taskIdOfSource(source)),
      cwdOverride: opts.cwdOverride, agentCwd: browserCfg.cwd }),
    workflowSlug: workflow?.slug, selection });
  const missionId = opts.missionId ?? randomUUID();
  dbApi.createMission(
    missionId,
    agentName,
    opts.logMessage || opts.missionLabel || (opts.logMessage ?? mission),
    source,
    ownerUserId,
    opts.traceId ?? null,
    opts.workflow ?? null,
  );
  dbApi.setMissionBrowserProfile(missionId, browserProfile?.id ?? null);
  if (typeof opts.title === 'string' && opts.title.trim()) {
    dbApi.setMissionPresetTitle(missionId, opts.title.replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  if (opts.parentMissionId) {
    const parent = dbApi.getMission(opts.parentMissionId);
    dbApi.setMissionLineage(missionId, { parentMissionId: opts.parentMissionId, parentAgent: parent?.agent_name });
  }
  // Persist any LLM override BEFORE spawnTurn runs — spawnTurn reads the
  // row to apply them every turn.
  if (opts.backendOverride || opts.modelOverride) {
    dbApi.setMissionLlmOverrides(
      missionId,
      opts.backendOverride ?? null,
      opts.modelOverride ?? null,
    );
  }
  if (opts.extraSkills?.length || opts.extraMcpServers?.length || opts.extraAllowedTools?.length) {
    dbApi.setMissionExtras(
      missionId,
      opts.extraSkills ?? null,
      opts.extraMcpServers ?? null,
      opts.extraAllowedTools ?? null,
    );
  }
  if (opts.cwdOverride) {
    dbApi.setMissionCwdOverride(missionId, opts.cwdOverride);
  }
  if (opts.permissionModeOverride) {
    dbApi.setMissionPermissionModeOverride(missionId, opts.permissionModeOverride);
  }
  if (opts.reasoningEffort !== undefined) {
    dbApi.setMissionReasoningEffort(missionId, opts.reasoningEffort ?? null);
  }
  if (opts.mcpServersOverride !== undefined) {
    dbApi.setMissionMcpOverride(missionId, opts.mcpServersOverride);
  }
  const resumeSession = resolveSpawnResume(agentName, missionId, opts.explicitResume, opts.backendOverride, ownerUserId);
  bus.publish({ kind: 'mission_started', missionId, agent: agentName, channel: source?.channel ?? null, ownerUserId, at: Date.now() });
  try {
    await spawnTurn({
      missionId, agentName, message: mission,
      images: opts.images, resumeSession, logUser: true, logMessage: opts.logMessage,
      origin: opts.origin ?? originFromSpawnSource(source),
      presentation: opts.presentation,
    });
  } catch (err) {
    // Without this rollback the mission row stays status='running' forever
    // (e.g. missing system-prompt.md) — dispatcher then re-spawns the same
    // task every tick, accumulating thousands of zombie rows.
    // Explicit cause: the exception happened AT LAUNCH (missing system
    // prompt, binary not found…). It's a crash, not a mystery — saying so
    // avoids finishMission's `unknown` net flattening it. Except for
    // exhausted quota, which isn't a failure: the dispatcher reads this
    // cause to decide whether to replay the task or switch the series.
    const cause = err instanceof BackendExhaustedError
      ? interruptionForCooldown(err.backend)
      : 'crash';
    dbApi.finishMission(missionId, 'failed', -1, cause);
    throw err;
  }
  return missionId;
}

/**
 * This mission's backend has no more quota: the turn is refused before
 * being launched. A dedicated type so the caller can distinguish it from
 * a real crash — a quota that will reopen deserves neither a failure
 * alert nor a tight retry.
 */
export class BackendExhaustedError extends Error {
  readonly backend: string;
  constructor(backend: string) {
    // "No quota" only when the provider said so: a breaker cooldown is not a quota (TIM-0111).
    const why = cooldownReason(backend);
    super(`backend ${backend} ${why === 'out of quota' ? 'has no quota' : `is ${why}`} — turn refused before spawn`);
    this.name = 'BackendExhaustedError';
    this.backend = backend;
  }
}

/** How long a handover waits for a session handshake (a line-oriented CLI has
 *  none) before giving the conversation back to the backend it was leaving. */
const HANDOVER_START_TIMEOUT_MS = 120_000;

type MissionLaunch = { spec: SpawnResult; proc: ChildProcessWithoutNullStreams; procEnv: NodeJS.ProcessEnv; missionToken: string };

/** Builds the backend's command and spawns it, confined and with the
 *  mission's environment. */
async function launchMissionProcess(
  backend: Backend,
  spawnOpts: BuildSpawnOpts,
  cfg: AgentConfig,
  missionId: string,
  agentName: string,
  confirmSpawn = false,
): Promise<MissionLaunch> {
  // A CLI that a THIRD-PARTY provider plugin drives is not Timon's: it never sees
  // the mission's credentials (SECURITY.md, "Provider plugins"). One a plugin
  // shipped in the release drives is: it gets what a core dialect gets.
  const trust = backendTrust(backend.name);
  // The plugin's `buildSpawn` may ask for a reference to the mission's token
  // (`ctx.provider.mcp`): the seal is open for the whole launch of every backend a
  // plugin brought, and the daemon swaps what comes back at the points where the
  // data leaves for the process. A core dialect has no plugin to answer to.
  const seal = trust === 'core' ? null : openLaunchSeal(missionId, backend.name, spawnOpts, () => missionApiToken(missionId));
  try {
    return await spawnMissionProcess(backend, spawnOpts, cfg, missionId, agentName, seal, trust, confirmSpawn);
  } catch (err) {
    // Whatever failed — the plugin's `buildSpawn`, the launcher, the spawn itself — the
    // references of a launch that never reached a process must not outlive it.
    if (seal) closeLaunchSeal(seal);
    throw err;
  }
}

async function spawnMissionProcess(
  backend: Backend,
  spawnOpts: BuildSpawnOpts,
  cfg: AgentConfig,
  missionId: string,
  agentName: string,
  seal: ReturnType<typeof openLaunchSeal> | null,
  trust: BackendTrust,
  confirmSpawn: boolean,
): Promise<MissionLaunch> {
  const untrusted = trust === 'third-party';
  const spec: SpawnResult = await buildSealedSpawn(backend, spawnOpts, seal);

  // child_process.spawn (not node-pty): the CLI must not detect a TTY on
  // stdin or it falls into interactive mode. Piped stdio gives us the
  // JSONL stream-mode both backends speak.
  //
  // Resource guard: the command is wrapped in a confined systemd scope
  // (capped memory, day/night profile nice/ionice). The wrappers exec()
  // in a chain, so `proc.pid` stays the backend CLI's and everything
  // else (kill, stdio, env) is unchanged. No-op if the guard is disabled
  // or systemd is absent.
  //
  // `host.bin()` resolves the backend binary via
  // `config.host.binaries.<name>` then the process's PATH. This is what
  // fixes the "GUI app's PATH" trap: launched from a .desktop file or an
  // Electron client, the orchestrator inherits a minimal PATH where
  // `claude` doesn't exist, even though it's properly installed.
  // Unresolved, we pass through the bare name: the spawn will fail with
  // ENOENT and the `proc.on('error')` handler below finalizes the
  // mission cleanly, instead of leaving it in flight on a synchronous
  // exception here.
  const host = getHost();
  const cwd = spec.cwd ?? cfg.cwd;
  // Filesystem masking target (audit finding #4): the mission's own directory
  // and the credentials of the backend it actually runs on are the two things
  // a deny list must never swallow. Inert on the current scope launcher —
  // `host/isolation.ts` says why, at length.
  const backendBin = resolveBackendBin(host, spec.cmd);
  const launch = wrapMissionLaunch(backendBin, spec.args, missionId, {
    cwd: cwd ?? undefined,
    backend: backend.name,
    timonHome: TIMON_HOME,
  });
  // Vault slice computed HERE so the inject journal (§8 / §12.8) records the
  // identities without `missionEnv` writing to the database — that function
  // is called from tests that must not fill `secret_access`. inheritEnv
  // skips the vault entirely, same as missionEnv.
  const project = cfg.project ?? projectFromCwd(cwd) ?? '';
  const inherit = inheritEnvEnabled();
  // What the user typed for THIS mission (`secret_request`, no grant) lies over
  // the vault slice; a `once` value is destroyed once it entered the environment.
  const requested = inherit || untrusted ? null : requestedSecretsFor(missionId);
  const vault = inherit || untrusted
    ? null
    : withRequestedSecrets(injectedSecretsFor({ agent: agentName, project: project || null }), requested ?? { env: {}, injected: [] });
  // `stdio: ['pipe','pipe','pipe']` guarantees all three streams; the
  // adapter itself returns node's generic type.
  // The backend's folder and a `node` go on PATH (`host/launch-path.ts`): an npm CLI found
  // under nvm or `%APPDATA%\npm` runs `env node`, and the CLI starts Timon's MCP servers
  // as `node <script>` — with the service's PATH, neither found one (tester report, macOS).
  // From the resolved binary, never `launch.cmd`: under the resource guard that is the wrapper.
  const procEnv = withLaunchPath(missionEnv({
    missionId,
    agentName,
    specEnv: spec.env,
    cwd,
    project: cfg.project,
    secretsEnv: vault?.env,
    untrusted,
    // One token per launch: an official plugin's references resolve to the one the
    // process gets, so neither is revoked by the other.
    ...(seal && !untrusted ? { token: seal.token() } : {}),
  }), {
    platform: host.platform,
    binary: backendBin,
    findNode: () => { try { return host.bin('node'); } catch { return null; } },
    // Only Electron's binary is no `node`: a daemon run from sources IS on the right one.
    selfExecutable: process.versions.electron ? process.execPath : undefined,
  });
  // Issued once: a second call would revoke the row the first one handed out.
  const missionToken = seal ? seal.token() : procEnv.TIMON_API_TOKEN ?? '';
  // Nothing awaited since: a third party's program is still the file checked for this launch.
  assertSpawnPinned(spec);
  const proc = host.spawn(launch.cmd, launch.args, {
    cwd: cwd ?? process.cwd(),
    env: procEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  // A CLI that dies at launch (a shebang whose interpreter is missing: exit 127)
  // closes its stdin before the prompt is written. Unheard, the EPIPE of that
  // write — or of any later one (next message, model switch) — is an uncaught
  // exception that takes the whole daemon down, and the boot after it relaunches
  // the same mission (macOS 0.1.6-rc.1, 26/10/2026). The pipe's error is only
  // logged: the process's exit is what finalises the mission and says why.
  for (const [name, stream] of [['stdin', proc.stdin], ['stdout', proc.stdout], ['stderr', proc.stderr]] as const) {
    stream.on('error', (err: Error) => {
      process.stderr.write(`[${backend.name}:${missionId.slice(0, 8)}] ${name}: ${err.message}\n`);
    });
  }
  journalInjectedSecrets({ missionId, agent: agentName, injected: vault?.injected ?? [] });
  requested?.consume();
  // On disk, for whoever comes after a daemon that dies without ending it.
  trackMissionProcess(proc, missionId, { dir: missionProcessDir(TIMON_HOME), host });
  // The references of this launch mean nothing once its process is gone.
  if (seal) proc.once('close', () => closeLaunchSeal(seal));
  // Node gives a successful spawn its pid synchronously. Without one, wait for
  // the OS error before committing a handover (ENOENT arrives on a later tick).
  if (confirmSpawn && !proc.pid) {
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', reject);
    });
  }
  return { spec, proc, procEnv, missionToken };
}

/**
 * The skills a mission runs with: the agent's own, then the extras its row adds
 * (the dispatcher's timon-task/timon-worktree, a workflow coordinator's skill).
 * Shared by the spawn and the injections view, so what the widget shows cannot
 * drift from what the agent is told. Malformed JSON adds nothing.
 */
export function mergeMissionSkills(skills: string[] | undefined, extraSkills: string | null | undefined): string[] | undefined {
  if (!extraSkills) return skills;
  let extras: unknown;
  try { extras = JSON.parse(extraSkills); } catch { return skills; }
  if (!Array.isArray(extras)) return skills;
  return [...new Set([...(skills ?? []), ...extras.filter((e): e is string => typeof e === 'string')])];
}

/**
 * Spawn a fresh CLI turn for a mission. Used both for the initial spawn
 * (spawnAgent) and for follow-up turns on one-shot backends (sendToAgent
 * → re-spawn). The TIMON missionId is constant across all turns of a chat;
 * what changes per turn is the underlying provider session id (passed via
 * the backend's resume mechanism).
 */
async function spawnTurn(args: {
  missionId: string;
  agentName: string;
  message: string;
  images?: ImageAttachment[];
  resumeSession: string | null;
  logUser: boolean;
  /** Persist only the new input when the actual prompt also replays history. */
  logMessage?: string;
  /** Provenance persisted with the `user` event (see user-origin.ts). */
  origin?: UserEventOrigin | null;
  /** Display sections of that same text, when the runtime authored any. */
  presentation?: PromptPresentation | null;
  /** The daemon restarted under this live remote mission: reopen its session
   *  from the state its driver saved, without replaying any prompt
   *  (`reattachRemoteMissions`). */
  reattach?: RemoteSessionResume;
  /** `message` is a command of the agent itself (`BuildSpawnOpts.agentCommand`). */
  agentCommand?: boolean;
  /** A handover is committed only once the session can start its first turn. */
  onStarted?: () => void;
}): Promise<void> {
  assertLicensedExecution(licenseState());
  const { missionId, agentName, message, images, resumeSession, logUser, origin, reattach } = args;
  const cfg = loadConfig(agentName);
  // Per-mission overrides take precedence over agent config — that's how
  // a fork can keep the same agent identity (skills, MCP, cwd, system
  // prompt) but switch the underlying LLM. Read from the mission row on
  // every turn so a forked codex one-shot keeps the override across its
  // respawns, and a persistent claude picks it up at process spawn.
  const missionRow = dbApi.getMission(missionId);
  // Exclude this turn when deciding whether any prior context survived.
  const historyEventId = dbApi.getLastEventId(missionId);
  assertFreeAccountAccess(missionRow?.owner_user_id);
  if (missionRow) {
    const workflowRun = missionRow.workflow_run_id ? dbApi.getWorkflowRun(missionRow.workflow_run_id) : null;
    const workflow = workflowRun ? dbApi.getWorkflow(workflowRun.workflow_id) : null;
    const profile = resolveMissionBrowserProfile(missionRow, {
      project: resolveBrowserProject({
        agentProject: cfg.project, workflowProject: workflow?.project,
        taskProject: projectOfTask(missionRow.task_id),
        cwdOverride: missionRow.cwd_override, agentCwd: cfg.cwd }),
      workflowSlug: workflow?.slug });
    cfg.browser_profile_id = profile?.id ?? null;
    if (!missionRow.browser_profile_resolved) dbApi.setMissionBrowserProfile(missionId, cfg.browser_profile_id);
  }
  if (missionRow?.backend_override) {
    cfg.backend = missionRow.backend_override as AgentConfig['backend'];
  }
  if (missionRow?.model_override) {
    cfg.model = missionRow.model_override;
  }
  if (missionRow?.reasoning_effort) {
    cfg.reasoningEffort = missionRow.reasoning_effort;
  }
  if (missionRow?.cwd_override) {
    // Same as backend/model: we switch cfg.cwd to the task's worktree so
    // backends see the right filesystem and git points at the
    // timon/task/* branch — no need to touch the agent's persistent
    // cwd.
    cfg.cwd = missionRow.cwd_override;
  }
  if (missionRow?.permission_mode_override) {
    cfg.permission_mode = missionRow.permission_mode_override;
  }
  // SUBSCRIPTION ACCOUNT (TODO #52). Checked here, on every turn, because this
  // is where every launch path crosses: an account deleted, signed out or
  // taken away from the owner since the last turn stops the mission with its
  // reason. The account is then frozen on the row: a session lives in its
  // account's config directory, and an agent re-pointed between two turns must
  // not move a running conversation to another subscription.
  {
    const launch = launchForMission(missionId, cfg.backend ?? defaultBackendName(), missionRow?.owner_user_id);
    if (launch.account) {
      if (missionRow && missionRow.backend_override !== launch.backend) {
        dbApi.setMissionLlmOverrides(missionId, launch.backend, missionRow.model_override ?? null);
      }
      cfg.backend = launch.backend as AgentConfig['backend'];
    } else if (missionRow && !missionRow.backend_override && !cfg.backend) {
      // An agent that names no backend follows the default, which moves with the
      // sign-ins and the preferred provider: the conversation keeps the one it
      // started on, so a session is never resumed by another provider's CLI.
      dbApi.setMissionLlmOverrides(missionId, launch.backend, missionRow.model_override ?? null);
      cfg.backend = launch.backend as AgentConfig['backend'];
    }
  }
  // QUOTA GUARD (incident 2026-08-22). The wake-loop did check the
  // exhausted-quota registry before waking a mission — but only it.
  // Every other path that relaunches a turn (answering a permission, a
  // resume respawn, an internal harness notification resurrecting a
  // session) walked straight into the wall: 36 consecutive turns on a
  // backend announced dry, each dying with a 429 within the minute, on a
  // chat mission no one was watching at 1am.
  //
  // The refusal is here, the one place ALL these paths cross. We don't
  // switch from here: `switchMissionBackend` would call `spawnTurn`
  // again. Those that know how to switch (wake) already did it upstream
  // — their spawn arrives with a `backend_override` out of cooldown and
  // goes through cleanly.
  // The registry only records the last failure: the backend is re-tested
  // before the refusal (backend-recheck.ts), never taken at its word.
  if (await whileTurnPrepares(missionId, () => backendStillDry(cfg.backend, { claimTrial: true }))) {
    // The registry knows WHY this backend is sidelined (quota window, account
    // with no credit, circuit breaker): we record that cause rather than
    // flattening all three into a usage limit.
    dbApi.setMissionInterrupted(missionId, interruptionForCooldown(cfg.backend));
    throw new BackendExhaustedError(cfg.backend ?? 'unknown');
  }
  // Per-spawn skills added by the code (dispatcher, workflow coordinator) are
  // kept apart from `cfg.skills`: they are pasted whole, whatever the
  // attachments say, where a checked skill only gets a catalogue line.
  const forcedSkills = parseExtraSkills(missionRow?.extra_skills);
  applyMissionMcpServers(cfg, missionRow);
  // The conversion mission of a browser recording reads page data nobody vouches for (TODO #469):
  // it runs with Timon's own servers only — an agent's server or an account connector could write
  // a file or send what it read — and, below, on a launch with no shell, no file read and no write.
  const readOnlyTools = isConversionSource(missionRow?.source_meta);
  if (readOnlyTools) cfg.mcp_servers = [];
  // Least-privilege for EXTERNAL claude.ai connectors (Gmail, Drive, a
  // notes connector…) on TASK missions. These connectors are enabled-by-default on
  // the claude CLI side and can ONLY be cut via excluded_mcp_servers; the
  // mcp_servers_override above only handles TIMON-managed MCPs
  // (--mcp-config). Without this block, a task agent inherited ALL the
  // account's claude.ai connectors (a coder with Gmail and every other connector…). So we
  // exclude any external NOT explicitly wanted — "wanted" = listed in
  // cfg.mcp_servers, fed by roles.json (the role's mcp_servers) or
  // task.extra_mcp_servers, plus the one server named by
  // TIMON_VAULT_MCP_SERVER. Opt-in per role: to give another connector to
  // the librarian/researcher, add its id to that role's mcp_servers. Gated on task_id: only task workers are restricted; the
  // orchestrator (wake/chat) keeps its config intact.
  if (missionRow?.task_id || readOnlyTools) {
    const wanted = new Set(cfg.mcp_servers ?? []);
    // No always-on connector for a conversion either (TODO #471): a notes connector can write, and a
    // `bypassPermissions` or `auto` agent would let an injection read in the recording do it.
    const externalsToExclude = externalConnectorsToCut(listMcp(), {
      wanted, kept: configuredVaultMcpServer(), readOnly: readOnlyTools,
    });
    if (externalsToExclude.length) {
      cfg.excluded_mcp_servers = [...new Set([...(cfg.excluded_mcp_servers ?? []), ...externalsToExclude])];
      console.log(`[spawn] ${missionRow?.task_id ? `task ${missionRow.task_id.slice(0, 8)}` : `conversion ${missionId.slice(0, 8)}`} (${agentName}): ${externalsToExclude.length} external connector(s) excluded [${externalsToExclude.join(', ')}]`);
    }
  }
  // allowed_tools: agent config + each active skill's frontmatter +
  // per-spawn extras. This way a skill (e.g. timon-task) carries its own
  // permission prerequisites without duplicating them on every agent.
  {
    const skillAllowed = readSkillsAllowedTools(resolveSpawnSkills(agentName, cfg, forcedSkills).map((sk) => sk.id));
    let extraAllowed: string[] = [];
    if (missionRow?.extra_allowed_tools) {
      try {
        const arr = JSON.parse(missionRow.extra_allowed_tools);
        if (Array.isArray(arr)) extraAllowed = arr.filter((v) => typeof v === 'string');
      } catch { /* malformed JSON — ignore */ }
    }
    if (skillAllowed.length || extraAllowed.length) {
      cfg.allowed_tools = [...new Set([...(cfg.allowed_tools ?? []), ...skillAllowed, ...extraAllowed])];
    }
  }
  // Backend resolved BEFORE the prompt: the preamble describes its
  // capabilities (permissions, connectors) and so must know who will
  // serve the mission.
  const backend = getBackend(cfg.backend);
  // Whatever brought this backend (the agent's, an override, a quota fallback): one that cannot
  // launch without a shell and file writes does not run the conversion at all.
  const confinement = readOnlyTools ? conversionBackendRefusal(backend.name) : null;
  if (confinement) throw new Error(confinement);
  const systemPrompt = buildEffectivePrompt(agentName, cfg, backend, message, forcedSkills);

  // Resolve memory dir based on scope. Create it if needed.
  const scope = cfg.memory_scope ?? 'NONE';
  let memoryDir: string | undefined;
  if (scope === 'SESSION') {
    memoryDir = missionMemoryDir(agentName, missionId);
    mkdirSync(memoryDir, { recursive: true });
  } else if (scope === 'AGENT') {
    memoryDir = agentMemoryDir(agentName);
    mkdirSync(memoryDir, { recursive: true });
  } else if (scope === 'GLOBAL') {
    memoryDir = GLOBAL_MEMORY_DIR;
    mkdirSync(memoryDir, { recursive: true });
  }

  const spawnOpts: BuildSpawnOpts = {
    agentName,
    systemPrompt,
    message,
    images,
    resumeSession,
    cfg,
    missionId,
    memoryDir,
    // A backend that cannot use Timon's MCP servers is not handed them.
    ...(backendCapabilities(backend.name).timonMcp ? {} : { timonMcp: false }),
    ...(readOnlyTools ? { readOnlyTools: true } : {}),
    ...(args.agentCommand ? { agentCommand: true } : {}),
  };
  // A remote backend spawns nothing: its session is opened below, and its
  // handle ends when that session does.
  const remote = backend.openRemoteSession ? remoteHandle() : null;
  if (reattach && !remote) throw new Error(`backend ${backend.name} has no remote session to reattach`);
  const launched = remote ? null : await whileTurnPrepares(missionId, () =>
    launchMissionProcess(backend, spawnOpts, cfg, missionId, agentName, !!args.onStarted));
  const proc = launched?.proc;
  const handle = launched ? processHandle(launched.proc) : remote!;

  const agent: RunningAgent = {
    missionId, agentName, proc, handle, backend, startedAt: Date.now(),
    // A fresh spawn always begins a turn — there's a user message
    // primed into the args/stdin that claude is about to process. A
    // reattached session is mid-turn only if its `result` never came back;
    // either way the clocks restart now, or the reaper would read the
    // daemon's downtime as a hung or idle turn.
    turnActive: reattach ? reattach.turnActive : true,
    turnSince: Date.now(),
    budgetSince: Date.now(),
    turnOpenedByTimon: reattach ? reattach.turnActive : true,
    rateLimited: false,
    interruptedBy: null,
    authFailed: false,
    sessionNotFound: false,
    spans: loadSpanState(missionId),
    permissionMode: cfg.permission_mode,
  };
  running.set(missionId, agent);
  if (!reattach) bus.publish({ kind: 'turn_started', missionId, at: agent.turnSince });
  const logInput = (): void => {
    if (logUser) logUserInput(agent, args.logMessage ?? message, images, origin, args.presentation);
  };
  let resolveStart!: () => void;
  let rejectStart!: (err: Error) => void;
  let starting = !!args.onStarted;
  const startPromise = args.onStarted ? new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  }) : null;
  // A driver may reject during construction, before the await below attaches.
  void startPromise?.catch(() => undefined);
  const launchObserver: TurnLaunchObserver | undefined = args.onStarted ? {
    started: () => {
      if (!starting) return;
      starting = false;
      try {
        args.onStarted!();
        logInput();
      } catch (err) {
        // Thrown here, it would leave spawnTurn with this process still up
        // while the caller gives the mission back to the backend it left.
        rejectStart(err as Error);
        return;
      }
      resolveStart();
    },
    failed: (err) => {
      if (!starting) return false;
      starting = false;
      rejectStart(err);
      return true;
    },
  } : undefined;
  // New turn → new return owed. The flag is per TURN, not per mission: a mission
  // relaunched in place (`timon send`) must be able to report again. A
  // reattached session starts no turn: the return it owes, if any, is the
  // interrupted turn's, already armed before the restart.
  if (!reattach) {
    try { dbApi.markMissionReturnNotified(missionId, false); } catch {}
    // A new session saves its own state; the previous one's would reattach a
    // session this launch replaced.
    if (remote) dbApi.setMissionRemoteResume(missionId, null);
  }

  // One engine for every provider: the definition says what the backend is (a
  // line-oriented CLI, a session protocol, a connection) and the engine opens
  // the matching driver. The driver reads stdout and writes stdin for the whole
  // session, so nothing else may attach to the pipes: two readers on one pipe
  // would each lose half the stream.
  const definition = fromLegacy(backend, {
    ...(launched ? { proc: launched.proc } : {}),
    timonMcp: backendCapabilities(backend.name).timonMcp,
  });
  if (remote) {
    agent.session = openMissionSession(
      agent,
      (host) => openRemoteSession(definition, { spawn: spawnOpts, host, ...(reattach ? { resume: reattach } : {}) }),
      remote,
      launchObserver,
    );
  } else if (launched) {
    // The agent may not hand its own environment on to the MCP servers it starts,
    // so the mission's token travels in the session request. Never logged.
    const token = launched.missionToken;
    agent.session = openMissionSession(agent, (host) => openProcessSession(definition, {
      io: { stdin: launched.proc.stdin, stdout: launched.proc.stdout },
      spawn: spawnOpts,
      host,
      initialStdin: launched.spec.initialStdin,
      onActivity: () => { agent.lastOutputAt = Date.now(); },
      onOverflow: () => console.warn(
        `[agent] ${missionId.slice(0, 8)} stdout line past ${DEFAULT_MAX_LINE_CHARS} chars without a newline — dropped`,
      ),
      ...(token ? { mcpEnv: { TIMON_API_TOKEN: token } } : {}),
    }), undefined, launchObserver);
  }
  handle.onStderr((text) => {
    // Detects a resume session not found so that, on exit, we relaunch
    // the turn on a fresh conversation instead of killing the mission.
    // Only marked if we were actually attempting a resume (otherwise
    // there's nothing to resume).
    if (resumeSession && backend.isSessionNotFoundError?.(text)) {
      agent.sessionNotFound = true;
    }
    agent.stderrTail = `${agent.stderrTail ?? ''}${text}`.slice(-STDERR_TAIL_BYTES);
    process.stderr.write(`[${backend.name}:${missionId.slice(0, 8)}] ${text}`);
  });

  // A handover logs it once its turn starts, after its notice (`started` above).
  if (!launchObserver) logInput();
  // A session-driven dialect answers `initialStdin: null` (contract.test.ts): the
  // driver writes its own handshake and carries the first message through it. A
  // line-oriented one carries it in `initialStdin`, which its driver writes (and,
  // for a one-shot CLI, closes stdin after: the CLI reads its prompt until EOF).
  if (reattach) agent.session!.reattach(reattach.turnActive);
  else agent.session!.begin(message, images);

  // Spawn-time failures (ENOENT when the backend binary isn't in PATH,
  // EACCES, etc.) emit 'error' on the ChildProcess. Without a listener,
  // Node re-throws as an uncaught exception → the whole orchestrator
  // crashes, the API goes down and the UI empties out for every mission.
  // We catch it here, mark the mission failed, and stay alive.
  handle.onError((err) => {
    if (launchObserver?.failed(err)) return;
    running.delete(missionId);
    agent.session?.close();
    process.stderr.write(
      `[${backend.name}:${missionId.slice(0, 8)}] spawn failed: ${err.message}\n`,
    );
    // The stderr line above only reaches the daemon log. The mission itself
    // must SAY why it died: a spawn that never happened leaves a thread with
    // zero event, and the user reads an empty conversation with no cursor and
    // no error (Mac mini, 20/09/2026 — three missions, nothing on screen).
    logSpawnFailed(missionId, backend.name, launched?.spec.cmd ?? backend.name, err);
    // Spawn failure (missing binary, EACCES…): the process never lived →
    // `crash`, the closest "system death" family.
    const reason = dbApi.finishMission(missionId, 'failed', 1, 'crash');
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason });
    appendAgentLog(agentName, {
      kind: 'mission_complete', missionId, status: 'failed',
      exitCode: 1, ts: Date.now(),
    });
    notifyParentOnComplete(missionId, 'failed');
    disposeEphemeralAgentIfDone(agentName);
  });

  handle.onExit((exitCode) => {
    running.delete(missionId);
    // Lets go of the pipes and rejects what the driver still waits for.
    agent.session?.close();
    // This session is over here: nothing left for a later boot to reattach.
    if (remote) dbApi.setMissionRemoteResume(missionId, null);
    if (launchObserver?.failed(new Error(`backend ${backend.name} exited before starting its turn`))) return;
    // Backend switch: a deliberate death immediately followed by a
    // respawn on the same missionId. No finishMission, no
    // mission_complete, no SESSION memory purge — the conversation
    // continues, only the CLI changes.
    if (agent.switching) return;
    // Timon replays this turn shortly (TODO #459): the exit of the CLI that
    // dropped it, one-shot or crashed, is not the end of the mission. Our own
    // kill still is.
    // A series already closed is kept: the exit may come before the turn's
    // second failed `result` is read, which must still read as an echo.
    if (agent.terminationIntent) cancelTurnRetry(missionId);
    else if (turnRetryPending(missionId)) return;
    const failed = exitCode !== 0;
    // The turn ended without the backend ever answering, and nobody asked it to stop: the user
    // would otherwise see "thinking", then nothing (TIM-0049). Say that, and show what it wrote.
    if (agent.turnActive && !agent.interruptedBy && !agent.terminationIntent
        && !agent.sessionNotFound && !agent.rateLimited && !agent.authFailed) {
      logBackendFailed(missionId, backend.name, exitCode, agent.stderrTail ?? '');
    }
    // Process dead mid-turn WITHOUT ever emitting a `result`: same bounce as
    // the sterile result the breaker counts, one step earlier. A CLI whose
    // endpoint is dead can exit before writing a single line of its stream —
    // without this, the breaker would only cover the backends polite enough to
    // report their own failure. Deliberate kills (reaper, chat STOP, config
    // reload) and the resume retry are excluded: those are OUR gestures, not
    // the provider bouncing.
    if (failed && agent.turnActive && !agent.interruptedBy
        && !agent.terminationIntent && !agent.sessionNotFound) {
      const signature = sterileExitSignature(Date.now() - agent.turnSince);
      const trip = signature ? noteSterileTurn(agent.backend.name, signature) : null;
      if (trip) {
        agent.interruptedBy = 'backend_unavailable';
        noteBackendUnavailable(trip);
      }
    }
    // A backend the breaker just sidelined must NOT go through the pause below:
    // its mission is over, and the sooner it is finalised the sooner the series
    // moves onto its fallback. We only persist the cause — the ordinary failure
    // path further down reads it back (COALESCE in `finishMission`) and carries
    // it to the dispatcher.
    if (failed && agent.interruptedBy === 'backend_unavailable') {
      dbApi.setMissionInterrupted(missionId, 'backend_unavailable');
    }
    // Rate-limit exits aren't real failures — the provider just told us to
    // back off. Treat them like a clean turn boundary so the mission stays
    // in `running`, the composer re-enables, and the user can retry once
    // their quota replenishes. We DON'T tear down codex's per-mission HOME
    // here either — the rollout file is what makes resume possible.
    if (failed && agent.rateLimited) {
      // We persist the cause BEFORE handing back control: the mission
      // stays `running` with no process, so it's the reaper (several
      // minutes later, with no in-memory state) or the next boot's
      // zombie sweep that will finalize it. Without this marker, the
      // downstream task inherits a generic `crash` even though we know
      // for a fact it's the usage limit — exactly the manual
      // investigation we're trying to remove.
      // The cause observed on the stream (`exhausted` on a 402), never a
      // hardcoded `rate_limit`: it is what the Kanban will show.
      dbApi.setMissionInterrupted(missionId, agent.interruptedBy ?? 'rate_limit');
      bus.publish({ kind: 'turn_complete', missionId, outcome: 'failed' });
      return;
    }
    // Fresh-fallback: the backend exited because the session to resume
    // can't be found (pruned, or created under a different cwd → silent
    // local store). Rather than letting the mission die, we relaunch THE
    // SAME turn with recorded context and no native resume. No loop possible: we
    // only get here if we were attempting a resume (resumeSession !=
    // null), and the retry passes resumeSession=null. logUser=false: the
    // message was already logged on the first attempt. The new session
    // id will be persisted via the init event.
    if (failed && resumeSession && agent.sessionNotFound) {
      console.warn(
        `[${backend.name}:${missionId.slice(0, 8)}] session ${resumeSession.slice(0, 8)} ` +
          `not found — replaying mission context on a fresh session`,
      );
      // Read before clearing: a new mission that resumed this session has no
      // events yet, its conversation lives on the mission the session came from.
      const sourceMissionId = dbApi.getMissionBySessionId(resumeSession)?.id;
      dbApi.clearMissionSession(missionId);
      spawnRecoveredTurn({ ...args, logUser: false }, historyEventId, sourceMissionId).catch((err) => {
        process.stderr.write(
          `[${backend.name}:${missionId.slice(0, 8)}] fresh-fallback failed: ${(err as Error).message}\n`,
        );
        const reason = dbApi.finishMission(missionId, 'failed', exitCode ?? 1, 'crash');
        bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: exitCode ?? 1, reason });
        appendAgentLog(agentName, {
          kind: 'mission_complete', missionId, status: 'failed',
          exitCode: exitCode ?? 1, ts: Date.now(),
        });
        notifyParentOnComplete(missionId, 'failed');
        disposeEphemeralAgentIfDone(agentName);
      });
      return;
    }
    // A stop WE asked for ends the mission whatever the exit code: `codex exec`
    // exits 0 on SIGTERM, and a one-shot exit 0 reads as a clean turn end — the
    // killed mission stayed `running`, the wake loop asked it whether its task
    // was finished, and that resume found no rollout (TIM-0111).
    if (backend.finishMissionOnExit || failed || agent.terminationIntent) {
      // Mission ALREADY terminal: someone else finalized it before us
      // (kill API, a leaked registry entry's reap, boot's zombie sweep).
      // `finishMission` isn't idempotent — it rewrites `status`/`ended_at`
      // and the following `mission_complete` would relaunch every
      // downstream chain (doc-task, verification-loop, notifyParent) a
      // second time. So we stop here, after the only cleanup left to do.
      if (dbApi.getMission(missionId)?.status !== 'running') {
        if (scope === 'SESSION' && memoryDir) {
          try { rmSync(memoryDir, { recursive: true, force: true }); } catch {}
        }
        disposeEphemeralAgentIfDone(agentName);
        return;
      }
      // An exit ≠ 0 is NOT necessarily a failure. Three outcomes (cf.
      // terminationIntent):
      //  - `terminated`: we killed the process ourselves — a mission that
      //    had finished its turn (idle reaper), a manual kill / config
      //    reload, or a turn cut from the chat (`interrupted`) → a normal
      //    end, with no negative connotation. Only the CAUSE
      //    distinguishes these cases below.
      //  - `failed`: a stuck turn (`hung`) OR an UNREQUESTED non-zero
      //    exit (a real crash).
      //  - `completed`: a clean exit (exit 0) — an explicit, successful
      //    end.
      const intent = agent.terminationIntent;
      const status: 'completed' | 'failed' | 'terminated' =
        intent === 'idle' || intent === 'stopped' || intent === 'interrupted' ? 'terminated'
          : intent === 'hung' || intent === 'budget' || intent === 'bounced' ? 'failed'
            : failed ? 'failed' : 'completed';
      // Death cause, on the same grid as the status above:
      //  - completed           → none (clean end, the task isn't
      //    interrupted)
      //  - hung                → `timeout` (turn silent past the
      //    threshold)
      //  - budget              → `turn_budget` (turn still working past
      //    its duration ceiling)
      //  - idle / stopped      → `killed` (we killed the process
      //    ourselves)
      //  - unsolicited non-zero exit → `crash`
      // We do NOT try to guess a rate_limit here: the only reliable
      // signal is the stream's own (rate_limit_event / 429 / quota
      // message). A heuristic on the exit code alone would be fragile —
      // and indeed, `completed` means nothing: 9 of the 11 quota deaths
      // of 2026-07-29/30 exited with code 0. So this grid is only a
      // GUESS: `finishMission` re-reads the events
      // (detectMissionDeathSignal) and replaces it when they say
      // something else — hence `effectiveReason`.
      const reason: InterruptionReason | null =
        status === 'completed' ? null
          // A bounce the breaker did not (yet) qualify stays `crash`: replayable
          // with backoff, which is what lets a burst reach the threshold.
          : intent === 'bounced' ? agent.interruptedBy ?? 'crash'
          : intent === 'hung' ? 'timeout'
          : intent === 'budget' ? 'turn_budget'
            // `interrupted` before `idle`/`stopped`: the human gesture must
            // stay legible on the Kanban, and it's not replayable.
            : intent === 'interrupted' ? 'stopped'
              : intent === 'idle' || intent === 'stopped' ? 'killed'
                : 'crash';
      const effectiveReason = dbApi.finishMission(missionId, status, exitCode ?? 1, reason);
      bus.publish({ kind: 'mission_complete', missionId, status, exitCode: exitCode ?? 1, reason: effectiveReason });
      appendAgentLog(agentName, {
        kind: 'mission_complete', missionId, status,
        exitCode: exitCode ?? 1, ts: Date.now(),
      });
      notifyParentOnComplete(missionId, status);
      // SESSION memory is ephemeral: delete the dir now that the mission is done.
      if (scope === 'SESSION' && memoryDir) {
        try { rmSync(memoryDir, { recursive: true, force: true }); } catch {}
      }
      // Ephemeral agent: purges the entire folder now that the mission
      // is over. The function checks that no other mission of this agent
      // is running (safety against double spawns) and that the
      // `ephemeral: true` marker is actually present (never nuke a
      // persistent agent by accident).
      disposeEphemeralAgentIfDone(agentName);
      // NOTE: we used to call the backend's dispose() on failed one-shot
      // exits, but that nuked the per-mission scratch state and made the
      // follow-up resume fail with "no rollout found". The per-mission folder
      // now goes only with a backend switch or the retention purge (TIM-0111).
    } else {
      // One-shot backend, clean exit: the mission stays 'running' in the DB
      // so a follow-up user message can re-spawn into the same chat. We
      // just emit a turn_complete event for UI breadcrumbs.
      bus.publish({ kind: 'turn_complete', missionId, outcome: 'completed' });
    }
  });
  if (startPromise) {
    const timer = setTimeout(
      () => launchObserver!.failed(new Error('the backend did not start its turn in time')),
      HANDOVER_START_TIMEOUT_MS,
    );
    try {
      await startPromise;
    } catch (err) {
      // The caller restores the mission: its exit must not finish it.
      agent.switching = true;
      agent.terminationIntent = 'stopped';
      await stopProcessAndWait(agent);
      if (running.get(missionId) === agent) running.delete(missionId);
      agent.session?.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Outcome of a `sendToAgent`. The three cases used to be flattened into a
 * single `false`, and the HTTP caller translated it into a 404 "mission
 * not found": the chat deduced a dead conversation and restarted on a
 * fresh mission, while the agent was simply mid-reply.
 *
 *  - `delivered`      : the message went out (or relaunched a one-shot turn).
 *  - `turn_in_flight` : a turn is running on a one-shot backend — there's
 *                       no input channel until it hands back control.
 *  - `no_live_process`: no more process for this mission → the caller
 *                       may attempt `respawnWithResume`.
 */
export type SendOutcome = 'delivered' | 'turn_in_flight' | 'no_live_process';

export async function sendToAgent(
  missionId: string,
  input: string,
  images?: ImageAttachment[],
  origin?: UserEventOrigin | null,
  presentation?: PromptPresentation | null,
  /** What the thread keeps instead of `input` (see `spawnTurn`'s `logMessage`). */
  logMessage?: string,
  /** `agentCommand`: `input` is a command of the agent (native compaction).
   *  `replayContext`: a mission without a session continues from its recorded
   *  thread; only a message written in that thread asks for it (it costs quota). */
  turn: { agentCommand?: boolean; replayContext?: boolean } = {},
): Promise<SendOutcome> {
  assertLicensedExecution(licenseState());
  assertFreeAccountAccess(dbApi.getMission(missionId)?.owner_user_id);
  if (backendSwitches.has(missionId)) return 'turn_in_flight';
  // A new input starts a new turn: a replay still waiting would answer a
  // request nobody is asking any more.
  if (origin?.turn_retry === undefined) cancelTurnRetry(missionId);
  const cleaned = input.replace(/\n+$/, '');
  const live = running.get(missionId);
  if (live) {
    if (live.backend.persistentProcess) {
      if (isBackendCoolingDown(live.backend.name)
        && await backendStillDry(live.backend.name, { claimTrial: !live.turnActive })) {
        if (live.turnActive) return 'turn_in_flight';
        dbApi.setMissionInterrupted(missionId, interruptionForCooldown(live.backend.name));
        throw new BackendExhaustedError(live.backend.name);
      }
      // The re-test may have awaited a usage probe: the process can have
      // exited meanwhile, and a message written to a dead session is lost.
      if (running.get(missionId) !== live) return 'no_live_process';
      if (!live.turnActive && permissionModeStale(live)) {
        return await relaunchWithPermissionMode(live, cleaned, images, origin, presentation, logMessage);
      }
      logUserInput(live, logMessage ?? cleaned, images, origin, presentation);
      live.session?.send(cleaned, images);
      // New turn starts now — claude will work until it emits `result`.
      beginTurn(live);
      live.budgetSince = live.turnSince;
      return 'delivered';
    }
    // One-shot proc still running mid-turn: refuse — UI should disable the
    // composer while a turn is in flight.
    return 'turn_in_flight';
  }
  // Mission is between turns. For one-shot backends, re-spawn into the
  // same missionId with the provider's session id for context resume.
  const m = dbApi.getMission(missionId);
  if (!m) return 'no_live_process';
  const cfg = loadConfig(m.agent_name);
  // The mission override takes priority: a mission switched to codex
  // runs one-shot even if the agent is configured as persistent claude.
  // Reading only the agent config made it look like a persistent
  // backend and refused the next turn, when re-spawning was enough (cf.
  // spawnTurn, which already applies the same override).
  const backend = backendMetadata(m.backend_override ?? cfg.backend);
  if (backend.persistentProcess) {
    // Persistent process died but mission still in DB — nothing to write
    // to. Caller should kick off a new mission instead.
    return 'no_live_process';
  }
  // Terminal DB row but a very much alive conversation: this is the
  // NORMAL case of a one-shot backend between two turns (the reaper
  // closed the mission with no process, or the boot's zombie sweep
  // marked it `failed`). Without this reopening, the turn we launch here
  // runs on a terminal mission:
  //   - `reapLeakedRegistryEntries` sees a leaked registry entry there
  //     and SIGTERMs the process mid-reply (grok incident of 2026-08-26:
  //     turn killed 44s after its spawn, no event, total silence on the
  //     chat side);
  //   - the exit handler short-circuits everything (`status !==
  //     'running'`): no `mission_complete`, no chaining, no clean turn
  //     end;
  //   - the UI keeps a "finished" mission and doesn't show the reply.
  // `respawnWithResume` and `switchMissionBackend` already reopened it;
  // this path was the only one that didn't.
  if (m.status !== 'running') dbApi.reopenMission(missionId);
  const nextTurn = {
    missionId,
    agentName: m.agent_name,
    message: cleaned,
    images,
    resumeSession: m.session_id,
    logUser: true,
    logMessage,
    origin,
    presentation,
    agentCommand: turn.agentCommand,
  };
  const backendId = m.backend_override ?? cfg.backend ?? defaultBackendName();
  const replay = turn.replayContext && owesContextReplay(m, backendId);
  if (turn.replayContext && !replay && !m.session_id) {
    announceSessionlessTurn(missionId, backendId, m.model_override ?? cfg.model ?? null);
  }
  await (replay ? spawnRecoveredTurn(nextTurn) : spawnTurn(nextTurn));
  return 'delivered';
}

/**
 * The replay stands in for a session that went missing. A backend that ended a
 * turn without reporting one has no session to go missing: replaying would pay
 * the transcript at every turn for a thread it can never reopen. That is read
 * from what the backend did, not from `sessionResumable`: a one-shot declared
 * `false` can still resume within its mission. A failed turn, a session once
 * reported or a handover to another backend prove nothing, and an unknown case
 * replays rather than forgets.
 */
function owesContextReplay(m: { id: string; session_id: string | null }, backend: string): boolean {
  return !m.session_id && !dbApi.turnEndedWithoutSession(m.id, backend);
}

/**
 * The other side of `owesContextReplay`: no replay is owed, so the agent gets this
 * message alone and forgets the turn before it. Only the thread can say so, and
 * once is enough: the message goes on top of the turn it explains, in a row that
 * survives a reload, and a replaced composer cannot lose it.
 */
function announceSessionlessTurn(missionId: string, backend: string, model: string | null): void {
  if (dbApi.sessionlessTurnAnnounced(missionId)) return;
  const payload = { type: 'sessionless_turn', backend, model };
  const row = dbApi.insertEvent(missionId, 'sessionless_turn', payload);
  bus.publish({ kind: 'event', missionId, type: 'sessionless_turn', timestamp: row.timestamp, payload });
}

/** The level stored on the mission since this process was launched differs
 *  from the one it runs in (TODO #430). Without a session to resume, a
 *  relaunch would start a blank thread: the level then waits for the next
 *  launch, and the message goes to the live CLI. */
function permissionModeStale(live: RunningAgent): boolean {
  const m = dbApi.getMission(live.missionId);
  const wanted = m?.permission_mode_override ?? null;
  return wanted !== null && wanted !== (live.permissionMode ?? null) && !!m?.session_id;
}

/**
 * Relaunches an idle persistent CLI on its own session so that the message it
 * is about to receive runs in the mission's new permission mode.
 *
 * Same deliberate death as a backend switch (`switching`): the exit neither
 * finishes the mission nor publishes `mission_complete`, and the provider
 * session is resumed, so the thread carries on where it was. Never mid-turn:
 * the caller checked the turn is over, and `backendSwitches` holds off any
 * other send until the new process owns the conversation.
 */
async function relaunchWithPermissionMode(
  live: RunningAgent,
  message: string,
  images: ImageAttachment[] | undefined,
  origin: UserEventOrigin | null | undefined,
  presentation: PromptPresentation | null | undefined,
  logMessage?: string,
): Promise<SendOutcome> {
  const missionId = live.missionId;
  const m = dbApi.getMission(missionId);
  if (!m?.session_id) return 'no_live_process';
  backendSwitches.add(missionId);
  try {
    live.switching = true;
    live.terminationIntent = 'stopped';
    await stopProcessAndWait(live);
    if (dbApi.getMission(missionId)?.status !== 'running') dbApi.reopenMission(missionId);
    try {
      await spawnTurn({
        missionId,
        agentName: m.agent_name,
        message,
        images,
        resumeSession: m.session_id,
        logUser: true,
        logMessage,
        origin,
        presentation,
      });
    } catch (err) {
      dbApi.finishMission(missionId, 'failed', -1, 'crash');
      throw err;
    }
    return 'delivered';
  } finally {
    backendSwitches.delete(missionId);
  }
}

/**
 * Resource guard notice: a process of this mission was OOM-killed inside its
 * scope. The agent's shell tool only saw `Killed` (exit 137) — without the
 * cause, it reruns the same command and dies the same way. `missionPrefix`
 * is the 8-char id carried by the scope name.
 *
 * Delivered as a system-origin turn on a live persistent process (claude
 * queues it after the current tool call). A one-shot backend mid-turn has no
 * input channel: the notification-center alert, raised by the caller, is then
 * the only trace. Returns how many missions received it.
 */
export async function notifyMissionResourceKill(missionPrefix: string, text: string): Promise<number> {
  let delivered = 0;
  for (const [missionId, live] of running) {
    if (!missionId.startsWith(missionPrefix) || !live.backend.persistentProcess) continue;
    try {
      const outcome = await sendToAgent(missionId, text, undefined, { kind: 'system', from: 'orchestrator' });
      if (outcome === 'delivered') delivered += 1;
    } catch (err) {
      console.warn(`[resources] OOM notice to ${missionId.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }
  return delivered;
}

/**
 * Permission safety net (Layer 2): resurrects a mission whose agent
 * process is actually dead (crash/OOM/kill) by re-spawning it with
 * `--resume <session_id>` and `message` as the first input. Used when the
 * user answers a question AFTER the process died: the long-poll can no
 * longer resume the turn, so we relaunch the conversation at the same
 * point, injecting the answer.
 *
 * Returns false if the mission is still running (→ the caller must go
 * through sendToAgent) or if no session_id is available and the caller did not
 * ask to replay the recorded thread (→ fallback notify). Unlike sendToAgent, we
 * do NOT refuse persistent backends: a persistent claude's death is exactly the
 * case we want to replay.
 */
export async function respawnWithResume(
  missionId: string,
  message: string,
  images?: ImageAttachment[],
  origin?: UserEventOrigin | null,
  presentation?: PromptPresentation | null,
  /** What the thread keeps instead of `message` (see `spawnTurn`'s `logMessage`). */
  logMessage?: string,
  /** Cf. `sendToAgent`. */
  turn: { agentCommand?: boolean; replayContext?: boolean } = {},
): Promise<boolean> {
  if (running.get(missionId)) return false; // still alive → sendToAgent
  const m = dbApi.getMission(missionId);
  if (!m || (!m.session_id && !turn.replayContext)) return false;
  if (origin?.turn_retry === undefined) cancelTurnRetry(missionId);
  dbApi.reopenMission(missionId);
  const nextTurn = {
    missionId,
    agentName: m.agent_name,
    message,
    images,
    resumeSession: m.session_id,
    logUser: true,
    logMessage,
    origin,
    presentation,
    agentCommand: turn.agentCommand,
  };
  try {
    await (m.session_id ? spawnTurn(nextTurn) : spawnRecoveredTurn(nextTurn));
  } catch (err) {
    // Explicit cause: the exception happened AT LAUNCH (missing system
    // prompt, binary not found…). It's a crash, not a mystery — saying so
    // avoids finishMission's `unknown` net flattening it.
    dbApi.finishMission(missionId, 'failed', -1, 'crash');
    throw err;
  }
  return true;
}

/**
 * Persist a user turn in the events table and broadcast it so the chat client
 * can render it immediately and history reloads include it. Mirrors the shape
 * of claude's own stream-json `user` event for client-side homogeneity —
 * with images, the content becomes a blocks array, otherwise a plain string.
 */
function logUserInput(
  agent: RunningAgent,
  text: string,
  images?: ImageAttachment[],
  origin?: UserEventOrigin | null,
  presentation?: PromptPresentation | null,
): void {
  let content: unknown = text;
  if (images && images.length) {
    const blocks: unknown[] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of images) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      });
    }
    content = blocks;
  }
  // `origin` only when the text was not typed by the human: an absent
  // field is what pre-existing events look like, and the chat reads it as
  // the human's own bubble.
  // A presentation with no sender is legitimate: the human typed a slash and
  // the runtime only decided how to SECTION their own text. `readOrigin`
  // needs kind+from, so such a payload keeps the bubble on the human's side.
  const shown = presentation ? { ...(origin ?? {}), presentation } : origin;
  const payload = shown
    ? { type: 'user', message: { role: 'user', content }, origin: shown }
    : { type: 'user', message: { role: 'user', content } };
  const row = db.transaction(() => {
    const event = dbApi.insertEvent(agent.missionId, 'user', payload);
    if (origin?.message_ids) recordRequestDelivery(agent.missionId, event.id, origin.message_ids);
    return event;
  })();
  bus.publish({
    kind: 'event',
    missionId: agent.missionId,
    type: 'user',
    timestamp: row.timestamp,
    payload,
    id: row.id,
  });
}

/* ── Model change mid-conversation ───────────────────────────────────────── */

/**
 * Why a switch happened. Absent from the persisted event when manual: the
 * events already in the database carry no cause, and the chat reads that
 * absence as a deliberate change by the user. Only `fallback` is ever
 * written, so old and new rows stay indistinguishable for the manual case.
 */
export type SwitchCause = 'manual' | 'fallback';

/** Origin of a switch, threaded from the caller down to the persisted event. */
export type SwitchOrigin = {
  cause?: SwitchCause;
  /** Human-readable trigger (`claude out of quota, reopens around 03:00`).
   *  Kept apart from `reason`, which describes the switch's mechanics. */
  causeDetail?: string;
};

/** Fields appended to a switch event when it was NOT asked by the user.
 *  Additive: an empty object for the manual case keeps the payload byte
 *  compatible with what was persisted before the cause existed. */
function causeFields(origin?: SwitchOrigin): { cause?: 'fallback'; cause_detail?: string } {
  if (origin?.cause !== 'fallback') return {};
  return { cause: 'fallback', ...(origin.causeDetail ? { cause_detail: origin.causeDetail } : {}) };
}

/** Persisted trace of the model change, rendered in the chat thread. */
function logModelSwitch(
  missionId: string,
  payload: {
    model: string;
    previous_model: string | null;
    status: ModelSwitchStatus;
    reason?: string;
    /** Backend the model belongs to — lets the chat pick the right logo on
     *  replay, when the mission's current backend may already differ. */
    backend?: string;
    cause?: 'fallback';
    cause_detail?: string;
  },
): void {
  const body = { type: 'model_switch', ...payload };
  const row = dbApi.insertEvent(missionId, 'model_switch', body);
  bus.publish({
    kind: 'event',
    missionId,
    type: 'model_switch',
    timestamp: row.timestamp,
    payload: body,
  });
}

/**
 * - `applied`   : the live process confirmed the change, the next turn
 *                 starts on the new model with the context intact.
 * - `queued`    : a turn was in flight; the request is queued and
 *                 applied as soon as its `result` fires (never lost).
 * - `next_turn` : nothing to apply hot, but the next turn SPAWNS anyway
 *                 (one-shot backend, or no more live process) and
 *                 `spawnTurn` re-reads `model_override` on every turn. So
 *                 the change is effective from the next message on, with
 *                 no loss of session or context.
 * - `persisted` : the process stays alive between turns but didn't take
 *                 the change (a dialect with no hot switch, or a CLI that
 *                 didn't confirm). Only the override in the DB acts — it
 *                 will only be read on the process's next start (crash,
 *                 late resume…).
 */
export type ModelSwitchStatus = 'applied' | 'queued' | 'next_turn' | 'persisted';

export type ModelSwitchOutcome = {
  status: ModelSwitchStatus;
  model: string;
  previousModel: string | null;
  /** Why we couldn't apply it hot, when that's the case. */
  reason?: string;
};

/** Applies a hot switch on an idle process, and traces the result.
 *  Persists nothing: the override is already written by
 *  `setMissionModel`. */
async function applyHotModel(
  agent: RunningAgent,
  model: string,
  previousModel: string | null,
  origin?: SwitchOrigin,
): Promise<boolean> {
  let ok = false;
  try {
    ok = agent.proc ? await agent.backend.setModel!(agent.proc, model) : false;
  } catch {
    ok = false;
  }
  logModelSwitch(agent.missionId, {
    model,
    previous_model: previousModel,
    status: ok ? 'applied' : 'persisted',
    ...(ok ? {} : { reason: "the CLI did not confirm the hot change" }),
    backend: agent.backend.name,
    ...causeFields(origin),
  });
  return ok;
}

/**
 * Changes a mission's model. ALWAYS does both:
 *   1. persists `model_override` (so any later respawn — crash, late
 *      permission, `respawnWithResume` — restarts on the new model),
 *   2. attempts the hot switch if a live process knows how.
 *
 * Returns null if the mission doesn't exist.
 */
export async function setMissionModel(
  missionId: string,
  model: string,
  origin?: SwitchOrigin,
): Promise<ModelSwitchOutcome | null> {
  const m = dbApi.getMission(missionId);
  if (!m) return null;
  assertFreeAccountAccess(m.owner_user_id);

  const cfg = loadConfig(m.agent_name);
  const backendName = m.backend_override ?? cfg.backend ?? defaultBackendName();
  // Anti-mismatch guard: we refuse a model the catalog explicitly
  // attributes to an OTHER backend (switching a claude mission to
  // `gpt-5.5` would kill it on the next spawn). A slug unknown to the
  // catalog goes through — it's the CLI's call, not ours to guess.
  if (!catalogClaimsModel(backendName, model) && backendForModel(model)) {
    throw new Error(
      `model "${model}" does not belong to backend ${backendName} ` +
      `(claimed by ${backendForModel(model)})`,
    );
  }

  const previousModel = m.model_override ?? cfg.model ?? null;
  // `setMissionLlmOverrides` writes BOTH columns: re-read the backend and
  // pass it through unchanged, otherwise a simple model change would
  // erase a forked mission's backend_override.
  dbApi.setMissionLlmOverrides(missionId, m.backend_override ?? null, model);

  const live = running.get(missionId);
  const backend = live?.backend ?? getBackend(backendName);

  // One-shot backend (codex & co): the CLI is respawned ON EVERY TURN
  // and `spawnTurn` re-reads `model_override` along the way. Writing the
  // override is ENOUGH — no setModel to attempt, so no possible failure
  // to report. Same conclusion for a persistent backend with no live
  // process: the next turn goes through a spawn, which will re-read the
  // override.
  if (!backend.persistentProcess || !live) {
    const reason = !backend.persistentProcess
      ? `backend ${backend.name} respawns on every turn`
      : 'no live process, the next turn respawns';
    logModelSwitch(missionId, {
      model, previous_model: previousModel, status: 'next_turn', reason,
      backend: backend.name, ...causeFields(origin),
    });
    return { status: 'next_turn', model, previousModel, reason };
  }

  if (!live.backend.setModel) {
    // Persistent process that survives between turns: without a hot
    // switch, the new model waits for the next start, not the next turn.
    const reason = `backend ${live.backend.name} cannot switch model live`;
    logModelSwitch(missionId, {
      model, previous_model: previousModel, status: 'persisted', reason,
      backend: backend.name, ...causeFields(origin),
    });
    return { status: 'persisted', model, previousModel, reason };
  }

  if (live.turnActive) {
    // Turn in flight: we defer to the `result` rather than mixing two
    // models in the same turn. The most recent request overwrites the
    // previous one.
    live.pendingModel = model;
    logModelSwitch(missionId, {
      model, previous_model: previousModel, status: 'queued',
      backend: backend.name, ...causeFields(origin),
    });
    return { status: 'queued', model, previousModel };
  }

  const ok = await applyHotModel(live, model, previousModel, origin);
  return ok
    ? { status: 'applied', model, previousModel }
    : {
        status: 'persisted',
        model,
        previousModel,
        reason: "the CLI did not confirm the hot change",
      };
}

/* ── BACKEND change mid-conversation ─────────────────────────────────────── */

/** An in-flight turn blocks the switch. A dedicated type so the HTTP
 *  route replies 409 instead of a generic 400 — it's a "try again in a
 *  moment", not a malformed request. */
export class TurnInFlightError extends Error {}

/** Persisted trace of the switch, rendered as a notice in the chat thread.
 *  `pending`: a mission repointed without a turn, its context crosses later. */
export function logBackendSwitch(
  missionId: string,
  payload: {
    backend: string;
    previous_backend: string | null;
    model: string | null;
    previous_model: string | null;
    context_mode: SwitchContextMode | 'pending';
    context_tokens: number;
    reason?: string;
    cause?: 'fallback';
    cause_detail?: string;
  },
): void {
  const body = { type: 'backend_switch', ...payload };
  const row = dbApi.insertEvent(missionId, 'backend_switch', body);
  bus.publish({
    kind: 'event',
    missionId,
    type: 'backend_switch',
    timestamp: row.timestamp,
    payload: body,
  });
}

/** Persisted trace of a handover whose turn never started: the thread says so,
 *  and that the conversation stayed where it was. The notice of a successful
 *  switch is never written for it. */
function logBackendSwitchFailed(
  missionId: string,
  payload: { backend: string; previous_backend: string; model: string | null; reason: string },
): void {
  const body = { type: 'backend_switch_failed', ...payload };
  try {
    const row = dbApi.insertEvent(missionId, 'backend_switch_failed', body);
    bus.publish({ kind: 'event', missionId, type: 'backend_switch_failed', timestamp: row.timestamp, payload: body });
  } catch (insertErr) {
    console.warn(`[agent] could not record the failed backend switch: ${(insertErr as Error).message}`);
  }
}

/**
 * Where the new backend gets its context from:
 * - `transcript`: the full events transcript, nothing is lost;
 * - `summary`   : compacted by the LLM (lossy, but structured);
 * - `tail`      : the summary failed — raw END of the transcript, brutally
 *                 cut. It used to be reported as a `summary`, which was a
 *                 lie: the user was told a model had compressed the thread
 *                 when in fact its beginning had simply been dropped;
 * - `none`      : the mission has no conversational content to send yet.
 */
export type SwitchContextMode = 'transcript' | 'summary' | 'tail' | 'none';

/**
 * What the CALLER asks for, as opposed to what happens.
 *
 * `auto` keeps the historical arbitration (threshold, then transport), and
 * stays the default for everything that switches backend without a human in
 * front of it — a quota fallback at 3am has nobody to ask. The two explicit
 * values exist because the arbitration is a policy, not a truth: someone who
 * knows their thread is worth its tokens can demand it whole, and someone who
 * wants a fresh start can demand the summary even on a short thread.
 */
export type SwitchContextChoice = 'auto' | 'transcript' | 'summary';

/** The whole transcript was demanded and does not fit through the target
 *  CLI's prompt. A dedicated type so the route answers 413 rather than
 *  silently compacting behind the user's back — which is exactly the
 *  behaviour they asked to be able to refuse. */
export class ContextTooLargeError extends Error {
  constructor(readonly detail: { transcriptBytes: number; limitBytes: number }) {
    super(
      `transcript is ${detail.transcriptBytes} B, the target CLI accepts `
      + `${detail.limitBytes} B in one prompt — compact it or switch to a `
      + 'backend that reads its prompt from stdin',
    );
  }
}

export type BackendSwitchOutcome = {
  /** `backend` = actual switch. `model` = same backend, we delegated to
   *  `setMissionModel` (no respawn, no session loss). */
  mode: 'backend' | 'model';
  backend: BackendName;
  previousBackend: BackendName;
  model: string | null;
  previousModel: string | null;
  contextMode: SwitchContextMode;
  /** Estimate of the context actually transmitted, in tokens. */
  contextTokens: number;
  /** Was the context compacted? The UI must tell the user: it's the only
   *  case where information may have been lost. */
  compacted: boolean;
  reason?: string;
};

/** What a switch WOULD do, decided before anything is torn down. Shared by
 *  the switch itself and by the preview the UI asks for, so what the user is
 *  shown and what happens are one and the same computation. */
export type SwitchContextPlan = {
  /** What the context will be. `summary` still has to be produced. */
  mode: SwitchContextMode;
  transcript: string;
  transcriptTokens: number;
  transcriptBytes: number;
  /** Byte ceiling of the target CLI's kickoff, `Infinity` when its prompt
   *  doesn't travel through argv. */
  hardBytes: number;
  /** Threshold above which `auto` compacts, in tokens. 0 = always compact. */
  thresholdTokens: number;
  /** Can the whole thread cross, whatever the threshold says? This is the
   *  physical question, and the only one the user cannot overrule. */
  fitsWhole: boolean;
  reason?: string;
};

/**
 * Decides how the context crosses, without producing anything.
 *
 * Two ceilings, and only one of them is a policy:
 *   - `TIMON_SWITCH_TRANSCRIPT_MAX_TOKENS`, a preference, which `auto`
 *     obeys and an explicit choice overrules;
 *   - what the TARGET CLI can swallow in one prompt, which nobody
 *     overrules — a dialect that passes its prompt through argv dies in
 *     E2BIG before its first token (cf. `Backend.maxPromptBytes`).
 */
export async function planSwitchContext(
  missionId: string,
  backend: BackendName,
  choice: SwitchContextChoice,
  throughEventId?: number,
): Promise<SwitchContextPlan> {
  // Lazy, like every other use of `summary.ts` here: that module imports
  // `agent.ts` back, and a static import would install the cycle at load.
  const { renderTranscript, estimateTokens } = await import('./summary.js');
  const transcript = renderTranscript(dbApi.listEvents(missionId)
    .filter((event) => throughEventId === undefined || event.id <= throughEventId));
  const transcriptTokens = estimateTokens(transcript);
  const transcriptBytes = Buffer.byteLength(transcript, 'utf8');
  const thresholdTokens = settingNum('TIMON_SWITCH_TRANSCRIPT_MAX_TOKENS');
  const targetMax = getBackend(backend).maxPromptBytes;
  // Margin for the kickoff's wrapping (title, explanation, follow-up): the
  // ceiling covers the WHOLE message, not just the context.
  const margin = settingNum('TIMON_SWITCH_KICKOFF_MARGIN_BYTES');
  const hardBytes = targetMax
    ? Math.max(1_000, targetMax - margin)
    : Number.POSITIVE_INFINITY;
  const fitsWhole = transcriptBytes <= hardBytes;
  const base = { transcript, transcriptTokens, transcriptBytes, hardBytes, thresholdTokens, fitsWhole };

  if (!transcript.trim()) return { ...base, mode: 'none' };
  if (!fitsWhole) {
    // The physical ceiling wins over any choice — including an explicit
    // demand for the whole thread, which the caller is told about rather
    // than compacted behind its back (cf. ContextTooLargeError).
    return {
      ...base,
      mode: 'summary',
      reason: `transcript ${transcriptBytes} B > ${backend}'s kickoff ceiling (${hardBytes} B)`,
    };
  }
  if (choice === 'transcript') return { ...base, mode: 'transcript', reason: 'whole transcript requested' };
  if (choice === 'summary') return { ...base, mode: 'summary', reason: 'summary requested' };
  if (thresholdTokens > 0 && transcriptTokens <= thresholdTokens) {
    return { ...base, mode: 'transcript' };
  }
  return {
    ...base,
    mode: 'summary',
    reason: thresholdTokens > 0
      ? `transcript ≈ ${transcriptTokens} tokens > threshold ${thresholdTokens}`
      : 'threshold set to 0: always summarise',
  };
}

/** Keeps the END of a text, within a UTF-8 BYTE budget (the argv limit
 *  counts bytes). Cut from the end because that's where the current
 *  state and the next step are. */
function clampTailToBytes(s: string, maxBytes: number): string {
  // A character weighs at least one byte: starting from `maxBytes`
  // characters can only overshoot, never cut too short.
  let out = s.slice(-maxBytes);
  while (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(Math.max(1, Math.ceil(out.length * 0.05)));
  }
  return out;
}

/**
 * Kickoff of a turn with no native session, built from the recorded thread and
 * announced in it (`context_recovery`). The history is this mission's, or that
 * of the mission a lost session came from when this one has none yet, and only
 * if both belong to the same account: a session id must not open a transcript.
 */
async function replayMissionContext(
  missionId: string,
  continuation: string | null,
  throughEventId?: number,
  sourceMissionId?: string,
): Promise<string> {
  const mission = dbApi.getMission(missionId);
  if (!mission) throw new Error('mission not found');
  const cfg = loadConfig(mission.agent_name);
  const backend = mission.backend_override ?? cfg.backend ?? defaultBackendName();
  const model = mission.model_override ?? cfg.model ?? null;
  const { summarizeForSwitch, buildBackendSwitchKickoff, estimateTokens } = await import('./summary.js');
  let historyId = missionId;
  let plan = await planSwitchContext(missionId, backend, 'auto', throughEventId);
  if (plan.mode === 'none' && sourceMissionId && sourceMissionId !== missionId
      && dbApi.getMission(sourceMissionId)?.owner_user_id === mission.owner_user_id) {
    historyId = sourceMissionId;
    plan = await planSwitchContext(historyId, backend, 'auto');
  }
  let mode: SwitchContextMode = plan.mode;
  let context = plan.mode === 'transcript' ? plan.transcript : '';
  // Even when auto always summarizes (threshold=0), a failed summarizer
  // must not replay an unbounded transcript and consume the whole quota.
  const budget = Math.min(plan.hardBytes, plan.thresholdTokens > 0 ? plan.thresholdTokens * 4 : 16_000);
  if (mode === 'summary') {
    try {
      context = (await summarizeForSwitch(historyId, { backend, model })).summary;
      if (Buffer.byteLength(context, 'utf8') > budget) {
        context = clampTailToBytes(plan.transcript, budget);
        mode = 'tail';
      }
    } catch {
      context = clampTailToBytes(plan.transcript, budget);
      mode = 'tail';
    }
  }
  const payload = { backend, model, context_mode: mode, context_tokens: estimateTokens(context) };
  const row = dbApi.insertEvent(missionId, 'context_recovery', payload);
  bus.publish({ kind: 'event', missionId, type: 'context_recovery', timestamp: row.timestamp, payload });
  return buildBackendSwitchKickoff({ context, mode, missionId, previousBackend: backend, continuation });
}

/**
 * Runs a turn on a fresh session, its prompt carrying the recorded thread. Held
 * like a backend switch: a summary can take minutes with no process registered,
 * and a message sent meanwhile would launch a second one. An agent command means
 * nothing on a session that no longer exists, so the replay carries no request.
 */
async function spawnRecoveredTurn(
  turn: Parameters<typeof spawnTurn>[0],
  throughEventId?: number,
  sourceMissionId?: string,
): Promise<void> {
  backendSwitches.add(turn.missionId);
  try {
    const kickoff = await replayMissionContext(
      turn.missionId, turn.agentCommand ? null : turn.message, throughEventId, sourceMissionId,
    );
    // Stopped during the summary: whoever closed it already told everyone.
    if (dbApi.getMission(turn.missionId)?.status !== 'running') return;
    await spawnTurn({
      ...turn, message: kickoff, resumeSession: null, agentCommand: false, reattach: undefined,
      logMessage: turn.logMessage ?? turn.message,
    });
  } finally {
    backendSwitches.delete(turn.missionId);
  }
}

/** Kills a process and waits for its exit. SIGTERM, then SIGKILL after
 *  the grace period, then we hand back control regardless: an HTTP
 *  request must never hang on a CLI that refuses to die. */
function stopProcessAndWait(agent: RunningAgent, graceMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    const handle = agent.handle;
    if (handle.ended()) { resolve(); return; }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };
    const killTimer = setTimeout(() => { try { handle.kill('SIGKILL'); } catch { /* already dead */ } }, graceMs);
    const giveUpTimer = setTimeout(finish, graceMs * 2);
    handle.onceExit(finish);
    try { handle.kill('SIGTERM'); } catch { finish(); }
  });
}

/**
 * Switches a mission to an OTHER backend without forking it.
 *
 * Session stores are disjoint from one provider to another: no resume is
 * possible, so we must restart from a blank session. But TIMON has all
 * the events in the DB — lossy compaction is not mandatory. Below
 * `TIMON_SWITCH_TRANSCRIPT_MAX_TOKENS`, we resend the FULL transcript;
 * only above it do we fall back to the summary, and we flag it.
 *
 * The missionId, the agent and thus the chat thread are kept: on the UI
 * side it's an info notice in the middle of the conversation, not a new
 * mission. That's the whole difference with `forkMission`, which remains
 * the path for voluntary compaction (and agent change).
 *
 * Returns null if the mission doesn't exist. Throws `TurnInFlightError`
 * if a turn is in flight — killing it would lose the response being
 * produced.
 */
export async function switchMissionBackend(
  missionId: string,
  opts: {
    backend: string;
    model?: string | null;
    message?: string | null;
    /** What the thread keeps of `message`, when the agent reads more than the
     *  human wrote (a posted batch of browser annotations). */
    logMessage?: string;
    inputOrigin?: UserEventOrigin | null;
    inputPresentation?: PromptPresentation | null;
    /** How the context should cross. Defaults to `auto`. */
    contextMode?: SwitchContextChoice;
  } & SwitchOrigin,
): Promise<BackendSwitchOutcome | null> {
  assertLicensedExecution(licenseState());
  const m = dbApi.getMission(missionId);
  if (!m) return null;
  assertFreeAccountAccess(m.owner_user_id);

  if (backendSwitches.has(missionId)) {
    throw new TurnInFlightError('a backend switch is in progress — wait for it to finish');
  }

  assertBackendEnabled(opts.backend);
  const backend = asBackendName(opts.backend);
  if (!backend) {
    throw new Error(`unknown backend "${opts.backend}" (available: ${backendNames().join(', ')})`);
  }
  const cfg = loadConfig(m.agent_name);
  const previousBackend = (m.backend_override ?? cfg.backend ?? defaultBackendName()) as BackendName;
  const previousModel = m.model_override ?? cfg.model ?? null;
  // Target model: the one requested, otherwise the arriving backend's
  // default. We NEVER silently carry over `previousModel` — it belongs
  // to the provider we're leaving, passing it to the new CLI's `--model`
  // would make it fail.
  const requested = opts.model?.trim();
  const model = requested || catalogBackend(backend)?.defaultModel || null;
  if (model && !catalogClaimsModel(backend, model) && backendForModel(model)) {
    throw new Error(
      `model "${model}" does not belong to backend ${backend} `
      + `(claimed by ${backendForModel(model)})`,
    );
  }

  // Same backend: nothing to tear down. A simple model change keeps the
  // session AND the process — going through the switch would be a
  // regression.
  if (backend === previousBackend) {
    const out = model && model !== previousModel
      ? await setMissionModel(missionId, model, opts)
      : null;
    return {
      mode: 'model',
      backend,
      previousBackend,
      model: out?.model ?? previousModel,
      previousModel,
      contextMode: 'none',
      contextTokens: 0,
      compacted: false,
      reason: out
        ? `same backend: model change only (${out.status})`
        : 'backend and model already active',
    };
  }

  const live = running.get(missionId);
  if (live?.turnActive) {
    throw new TurnInFlightError(
      'a turn is in progress — wait for it to finish (or stop it) before changing backend',
    );
  }

  backendSwitches.add(missionId);
  try {

  // Refused while nothing has moved: the conversation stays resumable where it
  // is, with no notice to take back. Not claiming the trial slot: the spawn
  // this leads to claims it (cf. `backendStillDry`).
  const targetLaunch = resolveLaunchBackend(backend, m.owner_user_id);
  if (await backendStillDry(targetLaunch.backend, { claimTrial: false })) {
    throw new BackendExhaustedError(targetLaunch.backend);
  }

  // Lazy import: `summary.ts` already imports `agent.ts` (loadConfig,
  // spawnAgent). Loading it here, at call time, avoids installing an
  // import cycle at module load for a rarely taken path.
  const { summarizeForSwitch, buildBackendSwitchKickoff, estimateTokens } =
    await import('./summary.js');

  const plan = await planSwitchContext(missionId, backend, opts.contextMode ?? 'auto');
  if (opts.contextMode === 'transcript' && !plan.fitsWhole) {
    throw new ContextTooLargeError({
      transcriptBytes: plan.transcriptBytes,
      limitBytes: plan.hardBytes,
    });
  }
  const { transcript, hardBytes } = plan;
  let contextMode: SwitchContextMode = plan.mode === 'summary' ? 'summary' : plan.mode;
  let context = '';
  let reason: string | undefined = plan.reason;
  if (plan.mode === 'transcript') {
    context = transcript;
  } else if (plan.mode === 'summary') {
    const why = plan.reason ?? 'summary requested';
    try {
        // The summary is produced by the backend we're LEAVING (it's
        // still alive and knows the conversation), via a separate
        // one-shot process — or by the arriving one if that fails.
      const out = await summarizeForSwitch(missionId, { backend, model });
      context = out.summary;
      contextMode = 'summary';
      reason = out.summarizedBy === 'target'
        ? `${why} — summarized by ${backend} (${previousBackend} failed: ${out.sourceError})`
        : why;
    } catch (err) {
      // Summary impossible (quota, silent CLI, timeout…): the tail of the
      // transcript beats nothing at all — that's where the current state
      // is. Reported as `tail`, never as a summary: nothing compressed
      // it, the beginning is simply gone.
      const budget = plan.thresholdTokens > 0
        ? Math.min(hardBytes, plan.thresholdTokens * 4)
        : hardBytes;
      context = clampTailToBytes(transcript, budget);
      contextMode = 'tail';
      reason = `summary unavailable (${(err as Error).message}) — transcript tail only`;
    }
    // Safety net: a summary (or a transcript tail) bigger than what the
    // target CLI accepts would make the spawn fail. We truncate from the
    // END — the last section carries the current state and next step.
    if (Buffer.byteLength(context, 'utf8') > hardBytes) {
      context = clampTailToBytes(context, hardBytes);
      reason = `${reason} — truncated to ${backend}'s kickoff ceiling`;
    }
  }
  const contextTokens = estimateTokens(context);

  const kickoff = contextMode === 'none'
    ? (opts.message?.trim()
      || 'Taking over this conversation: introduce yourself in one line and wait.')
    : buildBackendSwitchKickoff({
      context,
      // Only a real, whole transcript may be announced as one. A tail is
      // lossy like a summary — telling the arriving model otherwise would
      // have it assert things whose premises were cut off.
      mode: contextMode,
      missionId,
      previousBackend,
      continuation: opts.message ?? null,
    });

  // What a launch that fails must give back. A remote session stopped below is
  // gone: its saved state would reattach nothing.
  const before = dbApi.getMission(missionId) ?? m;
  const remoteResume = live ? null : dbApi.getMissionRemoteResume(missionId);
  if (live) {
    live.switching = true;
    live.terminationIntent = 'stopped';
    await stopProcessAndWait(live);
  }
  (live?.backend ?? backendMetadata(previousBackend)).dispose?.(missionId);
  // The old backend's per-mission folders (CODEX_HOME & co) leave the way of the
  // new CLI, and stay on disk until its turn has started.
  const parked = parkProviderScratch(missionId);

  let restoreLaunch: (() => void) | null = null;
  try {
    // An explicit choice, unlike an agent re-pointed between two turns: it
    // replaces what the mission was frozen on, even on the same provider.
    restoreLaunch = replaceMissionLaunch(missionId, backend, m.owner_user_id);
    dbApi.setMissionLlmOverrides(missionId, backend, model);
    // The session belonged to the old CLI: keeping it would attempt an
    // impossible resume on the next turn (cf. `sendToAgent`).
    dbApi.clearMissionSession(missionId);
    if (dbApi.getMission(missionId)?.status !== 'running') dbApi.reopenMission(missionId);
    // The replayed history must not be persisted twice. An inbox input still
    // needs its own event and delivery receipt, without the replay wrapper.
    await spawnTurn({
      missionId,
      agentName: m.agent_name,
      message: kickoff,
      resumeSession: null,
      logUser: opts.inputOrigin !== undefined,
      logMessage: opts.logMessage ?? opts.message ?? undefined,
      origin: opts.inputOrigin,
      presentation: opts.inputPresentation,
      // Written once the turn starts, ahead of its input and of the responses
      // it explains: the thread never announces a context nobody received.
      onStarted: () => logBackendSwitch(missionId, {
        backend,
        previous_backend: previousBackend,
        model,
        previous_model: previousModel,
        context_mode: contextMode,
        context_tokens: contextTokens,
        ...(reason ? { reason } : {}),
        ...causeFields(opts),
      }),
    });
  } catch (err) {
    restoreLaunch?.();
    dbApi.restoreMissionHandover(before);
    if (remoteResume) dbApi.setMissionRemoteResume(missionId, remoteResume);
    parked.restore();
    const why = stderrExcerpt((err as Error).message);
    console.warn(`[agent] mission ${missionId.slice(0, 8)}: backend switch ${previousBackend} -> ${backend} failed, state restored: ${logField(why)}`);
    logBackendSwitchFailed(missionId, { backend, previous_backend: previousBackend, model, reason: why });
    // The process stopped above is gone, and `switching` kept its exit from
    // settling the row: left `running`, the reaper would close it as an orphan.
    // `terminated` is what a conversation resumes from between two turns.
    if (live && before.status === 'running') {
      const stopped = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
      bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0, reason: stopped });
      notifyParentOnComplete(missionId, 'terminated');
    }
    throw err;
  }
  parked.drop();

  return {
    mode: 'backend',
    backend,
    previousBackend,
    model,
    previousModel,
    contextMode,
    contextTokens,
    compacted: contextMode === 'summary',
    ...(reason ? { reason } : {}),
  };
  } finally {
    backendSwitches.delete(missionId);
  }
}

/**
 * Who stops a mission, written to the daemon log with the stop. A codex mission
 * killed on 24/10/2026 (TIM-0111) could not be traced to its caller: every stop
 * now names one. Ids only, never a token or a message body.
 */
export type KillOrigin = {
  /** The code path: `DELETE /api/missions/:id`, `kanban: task closed`… */
  source: string;
  /** Who asked, when a request did (`requestActor`). */
  actor?: string | null;
  /** What it was about: the task, the run, the scope. */
  detail?: string | null;
};

/** One line, bounded: an actor or a detail may carry text a caller chose. */
function logField(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}\u2026` : flat;
}

export function describeKillOrigin(origin: KillOrigin): string {
  return [
    `by ${logField(origin.source)}`,
    origin.actor ? `actor ${logField(origin.actor)}` : null,
    origin.detail ? `(${logField(origin.detail)})` : null,
  ].filter(Boolean).join(' ');
}

/**
 * Stops a mission. `killed` = process SIGTERM. `closed` = no process, but
 * a `running` row was lingering in the DB: we finalize it here.
 *
 * Final for the PROCESS, not for the conversation: the send paths reopen a
 * terminated mission (`respawnWithResume`), so the provider's session store
 * stays on disk — a per-mission store (codex's rollout in its CODEX_HOME) is
 * purged after a retention instead (`purgeProviderScratch`, TIM-0111). To
 * just cut the turn, cf. `interruptAgent`.
 *
 * This second outcome exists because a 404 "no running agent" left NO
 * clean way to close a row whose process died without the exit handler
 * running — the only recourse was writing by hand into timon.db while
 * the orchestrator is running, which we never want to have to do. The
 * ghost row doesn't consume a cap slot (which counts real processes),
 * but it pollutes every "missions in progress" view.
 */
export function killAgent(missionId: string, origin: KillOrigin): 'killed' | 'closed' | 'not_found' {
  cancelTurnRetry(missionId);
  const agent = running.get(missionId);
  if (!agent) {
    const m = dbApi.getMission(missionId);
    if (!m || m.status !== 'running') return 'not_found';
    const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
    bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0, reason });
    notifyParentOnComplete(missionId, 'terminated');
    console.warn(`[kill] mission ${missionId.slice(0, 8)} (${m.agent_name}) had no process — row closed, ${describeKillOrigin(origin)}`);
    return 'closed';
  }
  console.warn(`[kill] mission ${missionId.slice(0, 8)} (${agent.agentName}) stopped, ${describeKillOrigin(origin)}`);
  agent.terminationIntent = 'stopped'; // deliberate stop → terminal `completed`, not `failed`
  agent.handle.kill('SIGTERM');
  // The backend lets go of what it holds in memory for this process. The
  // per-mission folder stays: it holds codex's rollout, and the mission can
  // still be written to — closing a task kills its mission one second later
  // (`stopClosedTaskMission`), and the next message to it resumed a thread
  // whose rollout had just been deleted ("no rollout found", TIM-0111).
  agent.backend.dispose?.(missionId);
  return 'killed';
}

/**
 * Outcome of a turn interruption (`POST /api/missions/:id/interrupt`).
 *
 *  - `interrupted`: a process was running, it received SIGTERM.
 *  - `not_running`: the mission exists but has no more process — there's
 *    nothing to cut, and above all nothing broken: the next message
 *    resumes it.
 *  - `not_found`  : no mission with this id.
 */
export type InterruptOutcome = {
  status: 'interrupted' | 'not_running' | 'not_found';
  /** Will the next message resume WITH the context (`--resume`)? False on
   *  a backend whose session doesn't survive its process, or a mission with
   *  no session anchor: there, the interruption is a hard stop and the UI
   *  must say so instead of promising a resume that won't happen. */
  resumable: boolean;
  backend: string | null;
  /** Was a turn actually running? A STOP on an idle process is legitimate
   *  (it frees the slot) but interrupted nothing. */
  turnActive: boolean;
};

/**
 * Cuts the CURRENT turn without killing the conversation.
 *
 * The difference with `killAgent`, and it's the WHOLE reason this
 * function exists: no `backend.dispose()`. The per-mission scratch and
 * the provider session stay on disk, so the next message re-spawns with
 * `--resume` and the agent gets its context back (same mechanism as the
 * idle-chat reap, cf. the reaper loop). `dispose()` is the "I'm done with
 * this chat" gesture; here the user says the opposite: "stop, I'll fix
 * something, we resume".
 *
 * The DB row goes terminal on exit (`terminated`) — the NORMAL state of a
 * conversation between two turns on the one-shot side, and the send
 * paths (`sendToAgent`, `respawnWithResume`) reopen it via
 * `reopenMission`.
 */
/**
 * What `steerMission` did.
 *   - `steered`     : the agent took the instruction into its running turn;
 *   - `no_turn`     : the mission is between turns (a normal message does the job);
 *   - `unsupported` : its backend cannot be redirected right now — NOT queued as
 *                     a next turn, the caller asked for something else;
 *   - `not_running` : no mission with this id.
 */
export type SteerOutcome = 'steered' | 'no_turn' | 'unsupported' | 'not_running';

/**
 * How a steer reached the agent, for the caller to say it:
 *   - `live`    : the running turn read it (a driver's own steer, or the stdin a
 *                 persistent CLI reads between two steps) — nothing was lost;
 *   - `restart` : the turn was stopped and the instruction opened the next one on
 *                 the same session. What the agent wrote until then stays in the
 *                 thread; a step it had not finished is redone.
 */
export type SteerMethod = 'live' | 'restart';

export type SteerResult = { outcome: SteerOutcome; method?: SteerMethod };

/**
 * Redirects the turn that is running, whatever the backend speaks (TODO #488):
 *   1. a driver with its own steer (`SessionDriver.steer`) takes it into the turn;
 *   2. a persistent line-oriented CLI (claude) reads its stdin between two steps:
 *      the instruction is written now, as a mid-turn follow-up always was;
 *   3. a protocol session without a steer (ACP) stops the turn with
 *      `session/cancel` and the instruction is its next prompt — the session and
 *      its history are kept;
 *   4. one process per turn (codex, grok, copilot) has no input channel: the
 *      process is stopped and the next turn resumes its thread with the
 *      instruction. Only with a session to resume, or the agent would lose
 *      everything before it.
 */
export async function steerMission(
  missionId: string,
  input: string,
  origin?: UserEventOrigin | null,
  images?: ImageAttachment[],
  /** How the thread shows the instruction (a reply's quote, `reply-to.ts`). */
  presentation?: PromptPresentation | null,
): Promise<SteerResult> {
  assertLicensedExecution(licenseState());
  const mission = dbApi.getMission(missionId);
  assertFreeAccountAccess(mission?.owner_user_id);
  if (!mission) return { outcome: 'not_running' };
  const live = running.get(missionId);
  if (!live || !live.turnActive) return { outcome: 'no_turn' };
  // A backend switch or a relaunch owns the process: nothing to redirect yet.
  if (backendSwitches.has(missionId) || live.switching) return { outcome: 'unsupported' };
  const cleaned = input.replace(/\n+$/, '');
  const session = live.session;

  if (session?.speaksProtocol && session.canSteer && !images?.length) {
    if (!(await session.steer(cleaned))) return { outcome: 'no_turn' };
    // The instruction is part of the conversation: it shows in the thread, and a
    // resumed session finds it in the transcript.
    logUserInput(live, cleaned, undefined, origin ?? null, presentation ?? null);
    return { outcome: 'steered', method: 'live' };
  }

  if (live.backend.persistentProcess && !session?.speaksProtocol) {
    const sent = await sendToAgent(missionId, cleaned, images, origin, presentation);
    return sent === 'delivered' ? { outcome: 'steered', method: 'live' } : { outcome: 'unsupported' };
  }

  if (session?.speaksProtocol) {
    // The session would queue the prompt behind the cancelled turn anyway; waiting
    // for that turn's `result` keeps the thread in order — the instruction after
    // the end of the turn it stopped, not before it.
    logTurnInterrupted(missionId, { resumable: true, backend: live.backend.name, turn_active: true, reason: 'steered' });
    // Set before the cancel: its `result` may land before `cancel()` resolves.
    // Not cleared on the wait's timeout either — the session queues the
    // instruction behind the stopped turn, so the next `result` is still its.
    live.steerCancelled = true;
    await session.cancel();
    await turnEnded(live, STEER_CANCEL_WAIT_MS);
    if (running.get(missionId) !== live) return { outcome: 'unsupported' };
    const sent = await sendToAgent(missionId, cleaned, images, origin, presentation);
    return sent === 'delivered' ? { outcome: 'steered', method: 'restart' } : { outcome: 'unsupported' };
  }

  return restartTurnWith(live, cleaned, images, origin, presentation);
}

/** How long a steered protocol turn may take to acknowledge its cancel. */
const STEER_CANCEL_WAIT_MS = 5_000;

/** Resolves once the turn is over (or the process gone), at most after `maxMs`. */
async function turnEnded(live: RunningAgent, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (live.turnActive && running.get(live.missionId) === live && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Step 4 of `steerMission`: a one-shot CLI mid-turn. The same deliberate death
 * as `relaunchWithPermissionMode` (`switching`: no `finishMission`, no
 * `mission_complete`, the conversation goes on), but on a running turn.
 */
async function restartTurnWith(
  live: RunningAgent,
  message: string,
  images: ImageAttachment[] | undefined,
  origin: UserEventOrigin | null | undefined,
  presentation?: PromptPresentation | null,
): Promise<SteerResult> {
  const missionId = live.missionId;
  const m = dbApi.getMission(missionId);
  // No thread yet (the CLI has not said which one it opened): a new process
  // would start blank, and the instruction would replace the request.
  if (!m?.session_id) return { outcome: 'unsupported' };
  backendSwitches.add(missionId);
  try {
    live.switching = true;
    live.terminationIntent = 'interrupted';
    // A `result` the dying CLI still flushes belongs to the stopped turn.
    live.steerCancelled = true;
    cancelTurnRetry(missionId);
    logTurnInterrupted(missionId, { resumable: true, backend: live.backend.name, turn_active: true, reason: 'steered' });
    await stopProcessAndWait(live);
    if (dbApi.getMission(missionId)?.status !== 'running') dbApi.reopenMission(missionId);
    try {
      await spawnTurn({
        missionId,
        agentName: m.agent_name,
        message,
        images,
        resumeSession: m.session_id,
        logUser: true,
        origin,
        presentation,
      });
    } catch (err) {
      dbApi.finishMission(missionId, 'failed', -1, 'crash');
      throw err;
    }
    return { outcome: 'steered', method: 'restart' };
  } finally {
    backendSwitches.delete(missionId);
  }
}

export function interruptAgent(missionId: string): InterruptOutcome {
  // STOP during a replay's backoff: the turn ends here, on its failure.
  if (turnRetryPending(missionId)) abandonTurnRetry(missionId, 'stopped by the user');
  const live = running.get(missionId);
  const m = dbApi.getMission(missionId);
  if (!live && !m) return { status: 'not_found', resumable: false, backend: null, turnActive: false };
  // EFFECTIVE backend of the mission: a switched mission carries its own
  // override, and it's the one saying whether the session will survive
  // (cf. `isResumableBackendName`), not the agent's original config.
  const backendName = live?.backend.name
    ?? m?.backend_override
    ?? (m ? safeAgentBackend(m.agent_name) : null);
  const resumable = backendMetadata(backendName ?? undefined).sessionResumable
    // Without a session anchor, there's nothing to resume: the next turn
    // would start from scratch. Say so rather than discover it after the
    // fact.
    && !!m?.session_id;
  if (!live) {
    return { status: 'not_running', resumable, backend: backendName, turnActive: false };
  }
  const turnActive = live.turnActive;
  // A chat on a session protocol: the agent can stop the turn and keep the
  // conversation, so the process is left alive and the next message goes to the
  // same session. A TASK mission keeps the kill below — its `interrupted` death
  // is what makes the task BLOCKED instead of requeued, and an idle process
  // left behind would be reaped as a replayable `killed`.
  if (live.session?.speaksProtocol && turnActive && !dbApi.getTaskByMission(missionId)) {
    logTurnInterrupted(missionId, { resumable, backend: backendName, turn_active: true });
    void live.session.cancel();
    console.log(
      `[interrupt] mission ${missionId.slice(0, 8)} (${live.agentName}, ${backendName}) `
        + '→ session/cancel, process kept',
    );
    return { status: 'interrupted', resumable, backend: backendName, turnActive };
  }
  live.terminationIntent = 'interrupted';
  logTurnInterrupted(missionId, { resumable, backend: backendName, turn_active: turnActive });
  try { live.handle.kill('SIGTERM'); } catch { /* already dead: the exit handler will do the rest */ }
  console.log(
    `[interrupt] mission ${missionId.slice(0, 8)} (${live.agentName}, ${backendName}) `
      + `→ SIGTERM, turn ${turnActive ? 'active' : 'idle'}, resume ${resumable ? 'possible' : 'IMPOSSIBLE'}`,
  );
  return { status: 'interrupted', resumable, backend: backendName, turnActive };
}

/** An agent's default backend, without ever making the caller fail on a
 *  missing or unreadable config (the agent may have been deleted since). */
function safeAgentBackend(agentName: string): string | null {
  try { return loadConfig(agentName).backend ?? null; } catch { return null; }
}

/**
 * Persisted trace of the interruption, rendered as a notice in the
 * thread.
 *
 * Without it, the turn stops silently: the cursor disappears and nothing
 * says whether the agent finished, crashed, or was cut. The notice also
 * serves as a record on replay — a response truncated mid-sentence is
 * explained.
 */
function logTurnInterrupted(
  missionId: string,
  payload: { resumable: boolean; backend: string | null; turn_active: boolean; reason?: 'steered' },
): void {
  const body = { type: 'turn_interrupted', ...payload };
  const row = dbApi.insertEvent(missionId, 'turn_interrupted', body);
  bus.publish({
    kind: 'event',
    missionId,
    type: 'turn_interrupted',
    timestamp: row.timestamp,
    payload: body,
  });
}

/**
 * Persisted trace of a spawn that never happened, rendered as a notice in the
 * thread.
 *
 * The CLI binary is the one dependency Timon cannot repair by itself: the
 * mission dies before its first byte, so nothing else in the thread can
 * explain it. The payload names the backend, the binary looked for and WHY it
 * could not be run — `missing` (ENOENT) and `not_executable` (EACCES) call for
 * two different gestures. No path is carried: the daemon's internals are not
 * the user's business, and the pin to set is keyed by the binary name.
 */
function logSpawnFailed(
  missionId: string,
  backendName: string,
  binary: string,
  err: NodeJS.ErrnoException,
): void {
  const cause = err.code === 'ENOENT'
    ? 'missing'
    : err.code === 'EACCES' || err.code === 'EPERM'
      ? 'not_executable'
      : 'unknown';
  const body = { type: 'spawn_failed', backend: backendName, binary, cause };
  try {
    const row = dbApi.insertEvent(missionId, 'spawn_failed', body);
    bus.publish({
      kind: 'event',
      missionId,
      type: 'spawn_failed',
      timestamp: row.timestamp,
      payload: body,
    });
  } catch (insertErr) {
    // Never let the notice swallow the finalisation that follows it: a mission
    // left `running` with no process is worse than a mission without a notice.
    console.warn(`[agent] could not record the spawn failure: ${(insertErr as Error).message}`);
  }
}

const STDERR_TAIL_BYTES = 4096;
const STDERR_EXCERPT_CHARS = 1500;

/** What a CLI wrote on stderr, fit for the thread: no colour codes, no vault value, no home path, bounded. */
export function stderrExcerpt(raw: string): string {
  const clean = redactDeep(raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, ''))
    .split(homedir()).join('~')
    .trim();
  return clean.length > STDERR_EXCERPT_CHARS ? `…${clean.slice(-STDERR_EXCERPT_CHARS)}` : clean;
}

/**
 * Persisted trace of a backend that ended a turn without answering, rendered as
 * a notice in the thread (TIM-0049). Unlike `spawn_failed` the process did start:
 * the payload carries its exit code and the end of its stderr, the provider's
 * own explanation.
 */
function logBackendFailed(missionId: string, backendName: string, exitCode: number | null, stderr: string): void {
  // The session id lets a tester find the provider's own logs; a backend that dies before its
  // first `result` (Copilot announces it only there) has none, so the mission id stands in.
  const sessionId = dbApi.getMission(missionId)?.session_id ?? null;
  const body = { type: 'backend_failed', backend: backendName, exitCode, missionId, sessionId, stderr: stderrExcerpt(stderr) };
  try {
    const row = dbApi.insertEvent(missionId, 'backend_failed', body);
    bus.publish({ kind: 'event', missionId, type: 'backend_failed', timestamp: row.timestamp, payload: body });
  } catch (insertErr) {
    console.warn(`[agent] could not record the backend failure: ${(insertErr as Error).message}`);
  }
}

export function isRunning(missionId: string): boolean {
  return running.has(missionId);
}

/** How the backend serving a live mission arbitrates tool uses; null when no
 *  process serves it right now. */
export function missionPermissionModel(missionId: string): PermissionModel | null {
  return running.get(missionId)?.backend.permissionModel ?? null;
}

/**
 * Notifies the pilot (lineage `parent_agent`) that a mission it spawned just
 * DIED. Posted to its inbox via `agent_messages` → the pilot sees it on its next
 * wake-up and can react (check the result, chain the follow-up).
 *
 * This is the FALLBACK path, no longer the nominal one: a mission that finished
 * its turn has already reported (`wake.ts handleMissionTurnComplete`, or
 * `handleTaskDone` when it ran a task), and `enqueueMissionReturn` stays silent
 * on the strength of `missions.return_notified`. What is left here is exactly
 * the death that follows NO complete turn — crash, SIGTERM mid-turn, `killAgent`
 * — which is the only case where the pilot still has everything to learn.
 *
 * All errors are caught locally: a failing notification must NEVER block a
 * mission's cleanup.
 */
function notifyParentOnComplete(
  missionId: string,
  status: 'completed' | 'failed' | 'terminated',
): void {
  try {
    enqueueMissionReturn(missionId, status);
  } catch (err) {
    process.stderr.write(
      `[notify] failed for ${missionId.slice(0, 8)}: ${(err as Error).message}\n`,
    );
  }
}

/**
 * Kill all running claude processes for a given agent name. Used after a
 * live config change (skills / MCP toggle) so the next user turn respawns
 * with the new --mcp-config and --append-system-prompt. The claude session
 * survives — getLatestSessionForAgent will find the same session_id and
 * pass it via --resume, restoring the conversation context.
 *
 * Returns the number of processes signalled.
 */
export function killRunningForAgent(agentName: string): number {
  let n = 0;
  for (const [missionId, ra] of running) {
    if (ra.agentName === agentName) {
      ra.terminationIntent = 'stopped'; // config reload, not an error
      ra.handle.kill('SIGTERM');
      n++;
      // We don't delete from `running` here — the exit handler will fire
      // and clean up + emit mission_complete on the bus.
      void missionId;
    }
  }
  return n;
}

/* ────────────────────────────────────────────────────────────────────────────
   Reaper — finalizes/kills ghost missions to keep the live counter accurate
   ──────────────────────────────────────────────────────────────────────────── */

/** Max idle time for a persistent process (claude) on an AUTONOMOUS
 *  mission before reap. An autonomous mission (dispatcher/wake/pipeline…)
 *  that finished its turn keeps its claude process alive indefinitely
 *  (persistentProcess + open stdin) → pile-up. We kill it past this
 *  delay: the session survives (resume possible), only the process is
 *  freed. HUMAN chat missions are never reaped on idle — the user may
 *  resume the thread. */
const REAP_IDLE_MS = (): number => settingNum('TIMON_REAP_IDLE_MS');
/** An active turn (turnActive) SILENT for longer than this is considered
 *  stuck (hung) → SIGTERM. Measured from the last sign of life, not from the
 *  start of the turn: a long turn still emitting tool progress is working
 *  (TIM-0094, seven missions killed at 45 min with a heartbeat seconds old). */
const REAP_HUNG_TURN_MS = (): number => settingNum('TIMON_REAP_HUNG_MS');
/** Hard ceiling on one turn's duration, alive or not; 0 = no ceiling. The
 *  silence threshold above cannot catch a turn that never stops talking. */
const REAP_TURN_MAX_MS = (): number => settingNum('TIMON_REAP_TURN_MAX_MS');
/** Tolerated inactivity for a CHAT mission (a human behind it) before
 *  freeing its process. Much longer than the autonomous idle reap:
 *  someone may come back to their conversation. Cf. the chat branch of
 *  reapStaleMissions. */
const REAP_CHAT_IDLE_MS = (): number => settingNum('TIMON_REAP_CHAT_IDLE_MS');
const REAP_INTERVAL_MS = (): number => settingNum('TIMON_REAP_INTERVAL_MS');
/** Grace period after createMission before a DB=running mission with no
 *  in-memory process is judged orphaned: `spawnTurn` sets `running.set`
 *  AFTER an await (buildSpawn), so a starting mission is briefly
 *  DB=running + absent from the registry. Without this grace, the reaper
 *  could finalize an in-progress spawn. */
const REAP_ORPHAN_GRACE_MS = (): number => settingNum('TIMON_REAP_ORPHAN_GRACE_MS');
/** Hard ceiling of the idle time of an autonomous mission that still has a
 *  process of its own running under its CLI (a test suite started with
 *  `run_in_background`, whose completion notice the mission is waiting for).
 *  Without it, a hung job would hold a global-cap slot for good. */
const REAP_BG_MS = (): number => settingNum('TIMON_REAP_BG_MS');

/** From when an idle mission is worth a look at its background work: the
 *  earlier of the idle reap and the eviction grace, since both end it. */
const BG_PROBE_AFTER_MS = (): number => Math.min(REAP_IDLE_MS(), EVICT_IDLE_GRACE_MS);

/** How the process table is read; replaced by tests, which have no real CLI. */
let readTable: () => Promise<ProcessEntry[]> = () => readProcessTable(getHost());
export function setProcessTableReaderForTest(reader: (() => Promise<ProcessEntry[]>) | null): void {
  readTable = reader ?? (() => readProcessTable(getHost()));
}

/**
 * Remembers what the CLI runs for its own sake, at `system:init`: its MCP
 * servers are spawned by then and none of the mission's own work is, since
 * the first turn only just began. Only autonomous missions are looked at (the
 * only ones the idle reap concerns), which also spares a chat the cost of a
 * table read (a PowerShell call on Windows). Best effort: no baseline simply
 * means the reaper sees no background work, as before.
 */
async function captureCliBaseline(agent: RunningAgent): Promise<void> {
  const pid = agent.handle.pid;
  if (!pid || agent.cliBaselinePids) return;
  try {
    const m = dbApi.getMission(agent.missionId);
    if (!m || !isAutonomousMission(m)) return;
    const table = await readTable();
    if (agent.handle.gone() || agent.cliBaselinePids || table.length === 0) return;
    agent.cliPid = cliProcessPid(table, pid, getHost().platform);
    agent.cliBaselinePids = cliBaseline(table, agent.cliPid);
  } catch { /* the baseline is an optimisation of the reaper, never a requirement */ }
}

/** Processes the mission started and that are still alive. Empty without a
 *  table or a baseline: nothing is assumed to run. */
function backgroundProcesses(live: RunningAgent, table: readonly ProcessEntry[] | undefined): ProcessEntry[] {
  if (!table || live.cliPid === undefined || !live.cliBaselinePids) return [];
  return backgroundDescendants(table, live.cliPid, live.cliBaselinePids);
}

/** Channels of missions spawned autonomously (no human behind them).
 *  They are idle-reapable; everything else (chat) is not. */
const AUTONOMOUS_CHANNELS = new Set([
  'dispatcher', 'wake', 'recovery', 'verification', 'verification-loop',
  'pipeline', 'librarian', 'doc', 'routine',
  // `agent` = sub-mission spawned by an agent via `timon spawn`. No one
  // behind it either: without this a sub-mission stayed alive
  // indefinitely after its turn ended (incident 2026-07-27: a
  // coder held a process for 12h after delivering). The idle
  // reap only frees the SLOT: the return went out at the end of the turn
  // (`wake.ts handleMissionTurnComplete`), so the `terminated` it produces
  // notifies nothing — `missions.return_notified` has already been posted.
  'agent',
]);

export function isAutonomousMission(m: { source_channel: string | null; task_id: string | null }): boolean {
  if (m.task_id) return true; // any dispatched task mission
  return !!m.source_channel && AUTONOMOUS_CHANNELS.has(m.source_channel);
}

/** Missions with ≥1 pending HUMAN permission card. The reaper does NOT
 *  kill a "hung" turn whose only block is this wait: the user may be
 *  slow to click. Autonomous missions, on the other hand, are
 *  auto-resolved on the permissions.ts side (AUTONOMOUS_TIMEOUT_MS), so
 *  they don't stall here. Kept up to date via the bus's permission_*
 *  events (cf. trackPendingPermissions). */
const pendingPermMissions = new Map<string, number>();
export function missionHasPendingPermission(missionId: string): boolean {
  return (pendingPermMissions.get(missionId) ?? 0) > 0;
}
let pendingPermTracked = false;
function trackPendingPermissions(): void {
  if (pendingPermTracked) return; // idempotent
  pendingPermTracked = true;
  bus.on('event', (ev) => {
    // A mission that ends with a card open never sees its resolved/expired.
    if (ev.kind === 'mission_complete') pendingPermMissions.delete(ev.missionId);
    if (ev.kind !== 'event') return;
    if (ev.type === 'permission_request') {
      pendingPermMissions.set(ev.missionId, (pendingPermMissions.get(ev.missionId) ?? 0) + 1);
    } else if (ev.type === 'permission_resolved' || ev.type === 'permission_expired') {
      const n = (pendingPermMissions.get(ev.missionId) ?? 0) - 1;
      if (n <= 0) pendingPermMissions.delete(ev.missionId);
      else pendingPermMissions.set(ev.missionId, n);
    }
  });
}
// Registered at module LOAD time (before any boot: startDispatcher fires
// an immediate dispatch that may spawn a mission emitting a
// permission_request before startReaper even runs). Doing it here
// eliminates any ordering race.
trackPendingPermissions();

/**
 * Periodic sweep of ghost missions (anti-freeze guard):
 *  1. Orphans: mission status=running in DB, persistent backend (claude),
 *     but NO live process in the registry (past the spawn grace period)
 *     → finalized failed + mission_complete. One-shot backends (codex)
 *     are legitimately "running" in DB between two turns with no process
 *     → ignored.
 *  2. Autonomous idle: live persistent process, turn finished
 *     (turnActive false) and nothing heard from it for > REAP_IDLE_MS(),
 *     autonomous mission → SIGTERM (frees the process, session resumable).
 *     Never human chat missions. Spared while its CLI still has a process the
 *     mission itself started (`processTable` says, cf. `reapSweep`), up to
 *     REAP_BG_MS() after the end of the turn.
 *  3. Hung: live process, turn active and silent (no stdout line, no event)
 *     for > REAP_HUNG_TURN_MS() → SIGTERM, cause `timeout`.
 *  4. Turn budget: live process past REAP_TURN_MAX_MS() even though it still
 *     talks → SIGTERM, cause `turn_budget`. 0 disables it. Turns an autonomous
 *     mission's CLI opens by itself share one budget, counted from the end of the
 *     last turn Timon started; nothing else would ever stop that chain.
 *
 * Best-effort: a throwing reaper must not kill the tick (cf. startReaper).
 */
/**
 * Boot, after the plugins loaded and before the zombie sweep and the reaper:
 * reattach every mission a remote backend left alive with a resume state
 * (`RemoteSessionHost.saveResume`). Its work went on on the server while the
 * daemon was down; declaring it dead would lose the turn and replay its task.
 *
 * Each one gets its registry entry here, synchronously with respect to the
 * sweep; its session reopens in the background. A mission that cannot even be
 * reattached (backend gone, unreadable state) gets the reason in its thread and
 * is left to the sweep, which ends it once. Process backends are not touched:
 * their CLI died with the daemon.
 *
 * Returns the ids reattached, for `markZombiesAsFailed` to leave alone.
 */
export async function reattachRemoteMissions(): Promise<Set<string>> {
  const reattached = new Set<string>();
  for (const m of dbApi.listRunningMissions()) {
    if (running.has(m.id)) continue;
    const json = dbApi.getMissionRemoteResume(m.id);
    if (json === null) continue;
    const refuse = (why: string): void => {
      console.warn(`[agent] remote mission ${m.id.slice(0, 8)} (${m.agent_name}) not reattached: ${why}`);
      // Same reasoning as a refused reattachment (`onFailed` above): the run
      // may still be going remotely, so the task is surfaced, not replayed.
      dbApi.setMissionInterrupted(m.id, 'unknown');
      dbApi.insertEvent(m.id, 'result', {
        type: 'result', subtype: 'error', is_error: true, total_cost_usd: 0,
        error: `the remote session could not be resumed after the daemon restarted: ${why}`,
      });
    };
    const state = parseResumeState(json);
    if (!state) { refuse('its saved state is unreadable'); continue; }
    const name = m.backend_override ?? loadConfig(m.agent_name).backend;
    let backend: Backend;
    try {
      backend = getBackend(name);
    } catch (err) {
      refuse((err as Error).message);
      continue;
    }
    // `getBackend` falls back to the default backend on an unknown name: a
    // plugin that did not load must not see its mission handed to another.
    if (!backend.openRemoteSession || (name && backend.name !== name)) {
      refuse(`backend ${name ?? backend.name} is not available any more`);
      continue;
    }
    try {
      await spawnTurn({
        missionId: m.id, agentName: m.agent_name, message: '', resumeSession: m.session_id ?? null, logUser: false,
        reattach: { state, turnActive: !dbApi.missionTurnEnded(m.id) },
      });
      reattached.add(m.id);
      // Its replay was waiting out its backoff when the daemon stopped: the
      // timer died with it, so the turn ends on its failure, said in the thread.
      if (dbApi.lastTurnAwaitsReplay(m.id)) abandonTurnRetry(m.id, 'the daemon restarted during the backoff');
    } catch (err) {
      refuse((err as Error).message);
    }
  }
  return reattached;
}

/**
 * Boot sweep: fails every mission a previous daemon left `running`, except the
 * remote ones this boot reattached (`keep`), and announces each end on the bus.
 *
 * A mission whose turn was still open also gets a persisted `turn_interrupted`
 * (reason `daemon_restarted`) BEFORE its end is announced (TIM-0119). The bus
 * event alone reaches nobody: no SSE client is connected yet at boot. The row
 * is what the stream replays when the chat reconnects, and the chat already
 * renders it as a notice; without it, "Reasoning" just vanished, or stayed.
 * Nothing is replayed automatically: a cut turn may have had side effects
 * (commits, messages sent), and the next message resumes the session anyway.
 */
export function sweepZombieMissions(keep: ReadonlySet<string> = new Set()): string[] {
  const swept = dbApi.markZombiesAsFailed(keep);
  for (const { id } of swept) {
    if (!dbApi.missionTurnOpen(id)) continue;
    const m = dbApi.getMission(id);
    const backend = m?.backend_override ?? (m ? safeAgentBackend(m.agent_name) : null);
    // Persisted only: a bus `event` here would find no stream to write to,
    // and a workflow node on this mission is failed by the workflow
    // reconciliation, which sees the row is no longer `running`.
    dbApi.insertEvent(id, 'turn_interrupted', {
      type: 'turn_interrupted',
      resumable: isResumableBackendName(backend) && !!m?.session_id,
      backend,
      turn_active: true,
      reason: 'daemon_restarted',
    });
  }
  for (const { id, reason } of swept) {
    bus.publish({ kind: 'mission_complete', missionId: id, status: 'failed', exitCode: -1, reason });
  }
  return swept.map((s) => s.id);
}

/** Tests only: what a daemon death leaves behind — rows still `running`, an
 *  empty registry, and no word to any session (a dead process closes nothing). */
export function forgetRunningMissionsForTest(): void {
  running.clear();
}

export function reapStaleMissions(processTable?: readonly ProcessEntry[], now = Date.now()): void {
  let orphaned = 0, idled = 0, hung = 0;
  for (const m of dbApi.listRunningMissions()) {
    // Waiting out the backoff of a replay (TODO #459): idle on purpose.
    if (turnRetryPending(m.id)) continue;
    let live = running.get(m.id);
    // Registry entry that outlived its process (the exit handler did not
    // run). Without this check, the reaper believes the mission is alive:
    // at best it sends a SIGTERM that wakes nobody, and the row stays
    // `running` forever — the chat mission of 2026-08-22 stayed that way
    // for 7 h after its last event, invisible to every sweep (the orphan
    // sweep does not see it because it has an entry; the leak sweep does
    // not see it because it is not terminal). We re-route it onto the
    // "orphan" path, which knows how to finalize it. `gone()` says how the
    // handle knows (cf. `processHandle`).
    const procDead = live && live.handle.gone();
    if (live && !live.switching && procDead) {
      console.warn(
        `[reaper] registry entry ${m.id.slice(0, 8)} (${m.agent_name}) has no live process ` +
        `(pid ${live.handle.pid ?? '?'}) → treating as orphan`,
      );
      running.delete(m.id);
      live = undefined;
    }
    if (!live) {
        // No in-memory process. Legitimate for a one-shot backend between turns;
        // orphaned for a persistent backend past the spawn grace period.
      if (now - m.started_at < REAP_ORPHAN_GRACE_MS()) continue;
      const backendName = m.backend_override ?? loadConfig(m.agent_name).backend;
      if (!backendMetadata(backendName).persistentProcess) {
        // One-shot backend (codex dialect: codex, ollama-cloud…): the process
        // dies at the end of EVERY turn. For a chat mission this is normal
        // — it is waiting for the user's next message, `finishMissionOnExit=false`
        // deliberately keeps it open. But an AUTONOMOUS mission (Kanban task,
        // wake, routine) is waiting for no one: once its turn is done, nothing
        // will ever close it. It remains `running` / `ended_at=NULL` forever.
        // Incident of 2026-08-07: 12 review+doc ollama-cloud missions left as
        // zombies in a single night, with their `result` (success) event properly recorded.
        // We finalize them here the same way the idle reap does on the
        // persistent path: `terminated` (normal completion, not a failure)
        // + `mission_complete` on the bus, so downstream chains
        // (verification-loop, doc-task, notifyParent) still run.
        if (!isAutonomousMission(m)) continue;
        const lastActivity = dbApi.lastEventAt(m.id) ?? m.started_at;
        if (now - lastActivity < REAP_IDLE_MS()) continue;
        const reason = dbApi.finishMission(m.id, 'terminated', 0, 'killed');
        bus.publish({ kind: 'mission_complete', missionId: m.id, status: 'terminated', exitCode: 0, reason });
        notifyParentOnComplete(m.id, 'terminated');
        console.log(
          `[reaper] autonomous one-shot mission ${m.id.slice(0, 8)} (${m.agent_name}, ${backendName}) ` +
            `has no process, idle for ${Math.round((now - lastActivity) / 60000)} min → terminated`,
        );
        idled++;
        continue;
      }
      // Orphan = process disappeared WITHOUT the exit handler running. A real
      // live crash would trigger `proc.on('exit')` (→ failed); this branch only
      // occurs in practice after an orchestrator RESTART (registry emptied,
      // missions still `running` in the DB). This is an interruption, not a
      // mission error → `completed`, not `failed`.
      // Default cause `crash` (the process disappeared without the exit
      // handler running: orchestrator restart, OOM, SIGKILL). finishMission
      // keeps a previously recorded cause — typically the `rate_limit` set
      // at exit, which is THE case that left tasks BLOCKED with no reason.
      const reason = dbApi.finishMission(m.id, 'terminated', 0, 'crash');
      bus.publish({ kind: 'mission_complete', missionId: m.id, status: 'terminated', exitCode: 0, reason });
      console.warn(`[reaper] orphan mission ${m.id.slice(0, 8)} (${m.agent_name}, process absent, DB running) → terminated (${reason ?? 'unknown cause'})`);
      orphaned++;
      continue;
    }
    const autonomous = isAutonomousMission(m);
    const budgetMs = REAP_TURN_MAX_MS();
    // Someone is behind a chat: a loop they asked for is not a leak, each of its
    // turns answers for itself.
    const budgetSpentMs = now - (autonomous ? live.budgetSince : live.turnSince);
    const overBudget = budgetMs > 0 && budgetSpentMs > budgetMs;
    if (live.turnActive) {
      const turnMs = now - live.turnSince;
      const hungMs = REAP_HUNG_TURN_MS();
      if (turnMs <= hungMs && !overBudget) continue;
      // The DB is read only once the in-memory clocks already say "silent".
      const silentMs = now - lastActivityAt(live);
      const silent = silentMs > hungMs;
      if (!silent && !overBudget) continue;
      // Spare a turn blocked only on a pending human permission:
      // this is not a compute hang, the user may click later.
      // (Autonomous missions are auto-resolved by permissions.ts,
      // so if a card is still pending here, this is a chat mission.)
      if (missionHasPendingPermission(m.id)) continue;
      if (silent) {
        console.warn(
          `[reaper] mission ${m.id.slice(0, 8)} (${m.agent_name}) turn active for ${Math.round(turnMs / 60000)} min, ` +
          `silent for ${Math.round(silentMs / 60000)} min → SIGTERM (hung)`,
        );
        live.terminationIntent = 'hung'; // nothing for that long = real problem → terminal `failed`
      } else {
        console.warn(
          `[reaper] mission ${m.id.slice(0, 8)} (${m.agent_name}) turn active for ${Math.round(budgetSpentMs / 60000)} min, ` +
          `last output ${Math.round(silentMs / 1000)} s ago → SIGTERM (turn budget of ` +
          `${Math.round(budgetMs / 60000)} min reached)`,
        );
        live.terminationIntent = 'budget';
      }
      try { live.handle.kill('SIGTERM'); } catch { /* already dead */ }
      hung++;
      continue;
    }
    // Turn finished, process idle: reap if an autonomous mission has been idle long enough.
    // Idle means nothing heard, as in the branch above, not "long since the turn
    // ended". The DB is read only once the in-memory clocks already say so.
    const turnEndedMs = now - live.turnSince;
    const quietMs = now - Math.max(live.turnSince, live.lastOutputAt ?? 0);
    const idleMs = quietMs > Math.min(REAP_IDLE_MS(), REAP_CHAT_IDLE_MS()) ? now - lastActivityAt(live) : quietMs;
    // A turn that ended on `run_in_background` leaves the CLI waiting for the
    // job's completion notice and emitting nothing: that is not idleness (the
    // coder killed twice at 10 min while its test suite was passing, 12/10).
    // Counted from the end of the turn, like `backgroundCheckedFor`: output that
    // stopped this reading would leave a count of 0 behind for the eviction.
    const probed = autonomous && turnEndedMs > BG_PROBE_AFTER_MS();
    const background = probed ? backgroundProcesses(live, processTable) : [];
    live.backgroundCount = background.length;
    // An unreadable table (a mission with a baseline but no table) tells
    // nothing: eviction keeps off it, the idle reap falls back to its old rule.
    if (probed && (processTable?.length || !live.cliBaselinePids)) live.backgroundCheckedFor = live.turnSince;
    if (idleMs > REAP_IDLE_MS() && autonomous) {
      if (background.length > 0 && turnEndedMs <= REAP_BG_MS()) {
        if (live.backgroundSparedFor !== live.turnSince) {
          live.backgroundSparedFor = live.turnSince;
          console.log(
            `[reaper] autonomous mission ${m.id.slice(0, 8)} (${m.agent_name}, ${m.source_channel ?? 'task'}) ` +
            `idle ${Math.round(idleMs / 60000)} min, ${background.length} background process(es) alive → spared ` +
            `(ceiling ${Math.round(REAP_BG_MS() / 60000)} min)`,
          );
        }
        continue;
      }
      console.log(
        `[reaper] autonomous mission ${m.id.slice(0, 8)} (${m.agent_name}, ${m.source_channel ?? 'task'}) ` +
        `idle ${Math.round(idleMs / 60000)} min, ${background.length} background process(es) → SIGTERM` +
        (background.length > 0 ? ' (background ceiling reached)' : ''),
      );
      live.terminationIntent = 'idle'; // turn finished, only free the process → terminal `completed`
      try { live.handle.kill('SIGTERM'); } catch { /* already dead */ }
      idled++;
      continue;
    }
    // Human chat, turn finished a VERY long time ago. Historically exempted
    // from the reap, which made it a slot leak: a chat CLI process never
    // dies on its own, so every open conversation confiscated a global-cap
    // slot for life (night of 2026-08-22: 9 idle chats until 4:45am →
    // 13 processes for a cap of 12, dispatcher and wake stopped — including
    // the wake-up of the agent supposed to fix the problem).
    // Killing the process loses NOTHING: the provider session stays on disk
    // and the user's next message re-spawns with `--resume` on it
    // (SpawnOptions.explicitResume undefined = the agent's latest session).
    if (idleMs > REAP_CHAT_IDLE_MS()) {
      console.log(`[reaper] chat ${m.id.slice(0, 8)} (${m.agent_name}) idle ${Math.round(idleMs / 60000)} min → SIGTERM (session resumable)`);
      live.terminationIntent = 'idle';
      try { live.handle.kill('SIGTERM'); } catch { /* already dead */ }
      idled++;
      continue;
    }
    // No turn, and yet it never stops printing: output pushes the idle marks back
    // for good, which would hand a slot to a process that does nothing else.
    if (overBudget) {
      console.warn(
        `[reaper] mission ${m.id.slice(0, 8)} (${m.agent_name}) no turn for ${Math.round(turnEndedMs / 60000)} min, ` +
        `last output ${Math.round(idleMs / 1000)} s ago → SIGTERM (turn budget of ${Math.round(budgetMs / 60000)} min reached)`,
      );
      live.terminationIntent = 'budget';
      try { live.handle.kill('SIGTERM'); } catch { /* already dead */ }
      hung++;
    }
  }
  const leaked = reapLeakedRegistryEntries(now);
  if (orphaned || idled || hung || leaked) {
    console.log(`[reaper] sweep: ${orphaned} orphan(s), ${idled} idle, ${hung} hung, ${leaked} leaked registry entr(y/ies)`);
  }
}

/**
 * Symmetric of the main loop: that one starts from `running` missions in
 * the DB, so it NEVER sees a process whose mission is already terminal.
 * That case exists nonetheless — the exit handler did not run (mission
 * finalized another way: kill API, aborted `switchMissionBackend`, handler
 * crash) — and it is the worst of all: the entry stays in `running`, so it
 * counts in `liveMissionCount()` and confiscates a global-cap slot forever,
 * with no sweep looking at it. Two entries were in that state for
 * 6 h on 2026-08-22 (`failed` missions, `ended_at` set, process still alive).
 *
 * We do NOT touch entries with no DB row at all: that is the spawn race
 * window (the process is registered before the INSERT), protected by the
 * same grace as orphans.
 */
function reapLeakedRegistryEntries(now: number): number {
  let leaked = 0;
  for (const [missionId, live] of running) {
    if (live.switching) continue; // backend switch in progress: the exit is expected
    const m = dbApi.getMission(missionId);
    if (!m) continue; // spawn currently being recorded
    if (m.status === 'running') continue; // normal case, handled by the main loop
    if (m.ended_at && now - m.ended_at < REAP_ORPHAN_GRACE_MS()) continue; // exit handler in flight
    console.warn(
      `[reaper] leaked registry entry ${missionId.slice(0, 8)} (${m.agent_name}, mission ${m.status} ` +
        `for ${m.ended_at ? Math.round((now - m.ended_at) / 60000) : '?'} min, process still alive) → SIGTERM`,
    );
    live.terminationIntent = 'stopped'; // the mission already has a terminal status
    try { live.handle.kill('SIGTERM'); } catch { /* already dead */ }
    running.delete(missionId); // free the slot immediately, without waiting for exit
    leaked++;
  }
  return leaked;
}

/** One sweep, with the process table read first when a mission could be
 *  waiting on a job of its own. The table is read asynchronously (a PowerShell
 *  call on Windows) so that `reapStaleMissions` itself stays synchronous. */
async function reapSweep(): Promise<void> {
  const now = Date.now();
  let table: ProcessEntry[] | undefined;
  for (const live of running.values()) {
    if (live.turnActive || !live.cliBaselinePids || now - live.turnSince <= BG_PROBE_AFTER_MS()) continue;
    table = await readTable().catch(() => undefined);
    break;
  }
  reapStaleMissions(table);
}

export function startReaper(intervalMs = REAP_INTERVAL_MS()): () => void {
  trackPendingPermissions(); // idempotent — already registered when the module loaded
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return; // a slow table read must not stack sweeps
    sweeping = true;
    void reapSweep()
      .catch((err: unknown) => { console.error('[reaper] error:', (err as Error).message); })
      .finally(() => { sweeping = false; });
  }, intervalMs);
  console.log(
    `[reaper] started (interval=${intervalMs}ms, idle=${REAP_IDLE_MS()}ms, hung=${REAP_HUNG_TURN_MS()}ms, turn_max=${REAP_TURN_MAX_MS()}ms, ` +
    `cap_global=${GLOBAL_MAX_LIVE()}, load_threshold=${(LOAD_THRESHOLD_PER_CPU() * CPU_COUNT).toFixed(1)}/${CPU_COUNT}cpu)`,
  );
  return () => clearInterval(timer);
}

export type AgentSummary = {
  browser_profile_id?: string | null;
  name: string;
  reports_to?: string | null;
  /** Team id, or null/undefined when the agent belongs to no team. */
  team?: string | null;
  /** Registry backend name; defaults to the first active provider (`implicitBackendName`). */
  backend: BackendName;
  cwd: string | null;
  model: string | null;
  permission_mode: string | null;
  allowed_tools: string[];
  disallowed_tools: string[];
  skills: string[];
  mcp_servers: string[];
  excluded_mcp_servers: string[];
  has_system_prompt: boolean;
  /** Explicit project from config, or inferred from cwd. Null = orphan. */
  project: string | null;
  memory_scope: 'NONE' | 'SESSION' | 'AGENT' | 'GLOBAL';
  ephemeral: boolean;
  orchestrator: boolean;
  /** Raw `config.orchestrates` (explicit delegation list), null when derived.
   *  The list the daemon enforces is `effective_orchestrates` on the routes. */
  orchestrates: string[] | '*' | null;
  /** Injects the cross-project digest (hot projects + goals) at spawn. */
  global_context: boolean;
  emoji: string | null;
  color: string | null;
  icon_url: string | null;
  /** Mascot look (`agent-look.ts`), null when none is set. */
  look: AgentLook | null;
  /** Avatar mode (`emoji` | `image` | `mascot`), null = the historical order. */
  avatar: AgentAvatarMode | null;
  /** Role ID (coder, reviewer, …), or null when the agent has none. */
  role: AgentRoleId | null;
  /** Role icon, resolved server-side so the UI does not need the mapping
   *  table. Null when there is no role. */
  role_emoji: string | null;
  /** Custom directives (free text, appended to the system prompt after the
   *  role's default directives). */
  directives: string | null;
  /** Thinking level the agent runs at by default (`--effort`, or the backend's
   *  own flag). null = the model's default. */
  reasoning_effort: string | null;
  /** `plugin:<id>` when a plugin created the agent, null otherwise. */
  created_by: string | null;
};

export type AgentDetails = AgentSummary & { system_prompt: string };


export function getAgent(name: string): AgentDetails | null {
  validName(name);
  if (!existsSync(agentDir(name))) return null;
  const cfg = loadConfig(name);
  return {
    name,
    backend: cfg.backend ?? defaultBackendName(),
    cwd: cfg.cwd ?? null,
    browser_profile_id: cfg.browser_profile_id,
    model: cfg.model ?? null,
    permission_mode: cfg.permission_mode ?? null,
    allowed_tools: cfg.allowed_tools ?? [],
    disallowed_tools: cfg.disallowed_tools ?? [],
    skills: ownAgentSkills(name),
    mcp_servers: cfg.mcp_servers ?? [],
    excluded_mcp_servers: cfg.excluded_mcp_servers ?? [],
    has_system_prompt: existsSync(agentSystemPrompt(name)),
    system_prompt: existsSync(agentSystemPrompt(name))
      ? readFileSync(agentSystemPrompt(name), 'utf8')
      : '',
    reports_to: cfg.reports_to,
    team: cfg.team ?? null,
    project: cfg.project ?? projectFromCwd(cfg.cwd),
    memory_scope: cfg.memory_scope ?? 'NONE',
    ephemeral: cfg.ephemeral === true,
    // By the flag or by the ROLE, never by the name: `_main` used to be
    // hard-coded here, so an orchestrator called anything else wasn't one.
    orchestrator: cfg.orchestrator === true || cfg.role === 'orchestrator',
    orchestrates: cfg.orchestrates ?? null,
    global_context: cfg.global_context === true,
    emoji: cfg.emoji ?? null,
    color: cfg.color ?? null,
    icon_url: servedIconUrl(cfg.icon_url),
    look: readAgentLook(cfg.look),
    avatar: readAgentAvatar(cfg.avatar),
    role: (cfg.role as AgentRoleId | undefined) ?? null,
    role_emoji: null,
    directives: cfg.directives ?? null,
    reasoning_effort: cfg.reasoningEffort ?? null,
    created_by: cfg.created_by ?? null,
  };
}

/**
 * Raw write of an agent's files (system-prompt.md + config.json).
 * Internal — does NOT strip protected flags and is only used by trusted
 * callers (`upsertAgent` after stripping, `createEphemeralAgent`, which must
 * legitimately set `ephemeral: true`). DO NOT export.
 */
function writeAgentFiles(
  name: string,
  systemPrompt: string,
  config: AgentConfig,
): AgentDetails {
  validName(name);
  mkdirSync(agentMemoryDir(name), { recursive: true });
  writeFileSync(agentSystemPrompt(name), systemPrompt);
  writeFileSync(agentConfig(name), JSON.stringify(config, null, 2));
  return getAgent(name)!;
}

/** The agent as the agent events carry it; `null` for a missing or ephemeral one. */
function agentEventSnapshot(name: string): AgentEventSnapshot | null {
  if (!existsSync(agentDir(name))) return null;
  const cfg = loadConfig(name);
  if (cfg.ephemeral === true) return null;
  return Object.freeze({
    name,
    backend: cfg.backend ?? defaultBackendName(),
    model: cfg.model ?? null,
    project: cfg.project ?? projectFromCwd(cfg.cwd),
    role: cfg.role ?? null,
    has_system_prompt: existsSync(agentSystemPrompt(name)),
    created_by: cfg.created_by ?? null,
  });
}

/** Config keys whose value differs between two configs, sorted. */
function changedConfigKeys(before: AgentConfig, after: AgentConfig): string[] {
  const record = (cfg: AgentConfig) => cfg as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(record(before)[key]) !== JSON.stringify(record(after)[key]))
    .sort();
}

function publishAgentUpdated(name: string, changed: readonly string[], previousName: string | null = null): void {
  if (changed.length === 0) return;
  const agent = agentEventSnapshot(name);
  if (agent) bus.publish({ kind: 'agent_updated', agent, changed, previousName });
}

/**
 * Creates or rewrites an agent. `opts.createdBy` is the origin mark of a NEW
 * agent (`plugin:<id>`), written with the agent itself: the `agent_created`
 * event is published as soon as the files exist, and its snapshot must already
 * say who created it. An agent that exists keeps the mark it has.
 */
export function upsertAgent(input: {
  name: string;
  system_prompt: string;
  config?: AgentConfig;
}, opts: { createdBy?: string } = {}): AgentDetails {
  const config = stripProtectedKeys(input.config ?? {});
  // Checked skills are attachments now, never a config.json field.
  const sentSkills = takeSentSkills(config);
  const existed = existsSync(agentDir(input.name));
  const before = existed ? { config: loadConfig(input.name), prompt: readAgentPrompt(input.name) } : null;
  // The agent editor rewrites the whole config but owns neither the reporting
  // line (graph, Company chart) nor the team (isolation panel): a save that
  // does not mention them keeps the values set elsewhere instead of erasing
  // them.
  if (before) {
    const current = before.config;
    // `directives` is no longer a field of the editor (it is a doc now): a save
    // that does not mention it must not erase what a boot has not moved yet.
    // `orchestrator` / `orchestrates` are stripped from the payload (protected
    // keys) but must survive the rewrite: a save from the editor that erased
    // them would take the delegation rights away without anyone asking.
    // The mascot look and the avatar mode are picked elsewhere too
    // (onboarding, the Avatar tab, `agent_update look`, `agent_set_look`).
    for (const key of ['reports_to', 'team', 'orchestrator', 'orchestrates', 'directives', 'created_by', 'look', 'avatar'] as const) {
      if (!(key in config) && current[key] !== undefined) (config as Record<string, unknown>)[key] = current[key];
    }
  }
  settleLook(config, before?.config.look);
  settleAvatar(config);
  // No roleless agents. A FRESH agent created without an explicit role —
  // typically one spawned by `_main`, which tends to omit it — defaults to
  // `orchestrator`. Gated on fresh creation so an update never clobbers an
  // existing role. This is the single chokepoint for all persistent agent
  // creation (POST /api/agents, project seeding, librarian, …).
  if (!config.role && !existed) {
    config.role = 'orchestrator';
  }
  if (!existed && opts.createdBy) config.created_by = opts.createdBy;
  // An existing agent gets its attachments BEFORE its config loses the field: a
  // crash in between leaves the skills in both places, never in neither. A new
  // one AFTER its folder exists, so a failed creation leaves no row behind.
  if (before) writeSkillsOf(input.name, sentSkills, before.config.skills);
  let written = writeAgentFiles(input.name, input.system_prompt, config);
  if (!before) {
    writeSkillsOf(input.name, sentSkills, undefined);
    // The details were read before the attachments existed.
    if (sentSkills.present) written = getAgent(input.name) ?? written;
    const agent = agentEventSnapshot(input.name);
    if (agent) bus.publish({ kind: 'agent_created', agent });
  } else {
    publishAgentUpdated(input.name, [...new Set([
      ...changedConfigKeys(before.config, config),
      ...(sentSkills.present ? ['skills'] : []),
      ...(before.prompt !== input.system_prompt ? ['system_prompt'] : []),
    ])].sort());
  }
  return written;
}

/**
 * `skills` as a caller sends it (`config.skills`, PATCH `skills`): the agent's
 * whole set of checked skills. Taken off the config — it is written as
 * agent-scope attachments (`setAgentSkills`) — and validated before anything is
 * written, so a bad list leaves the agent as it was.
 */
function takeSentSkills(cfg: AgentConfig): { present: boolean; ids: string[] } {
  const raw: unknown = (cfg as Record<string, unknown>).skills;
  delete (cfg as Record<string, unknown>).skills;
  if (raw === undefined) return { present: false, ids: [] };
  if (raw === null) return { present: true, ids: [] };
  if (!Array.isArray(raw)) throw new Error('skills must be a list of skill ids');
  const bad = raw.find((id) => !isSkillId(typeof id === 'string' ? id.trim() : id));
  if (bad !== undefined) throw new Error(`invalid skill id: ${JSON.stringify(bad)}`);
  return { present: true, ids: raw as string[] };
}

function reportSkillsWrite(name: string, w: AgentSkillsWrite, origin: string): void {
  if (w.rejected.length) {
    console.warn(`[skills] ${name}: ${origin}: dropped entries that are not skill ids: ${JSON.stringify(w.rejected)}`);
  }
  if (w.missing.length) {
    console.warn(`[skills] ${name}: ${origin}: attached with no SKILL.md yet (skipped at spawn until it exists): ${w.missing.join(', ')}`);
  }
}

/**
 * A `config.skills` left by an older version (or an imported, restored config)
 * becomes catalogue attachments of the agent; nothing is removed. Null when
 * there was nothing to move.
 */
function absorbConfigSkills(name: string, legacy: unknown): AgentSkillsWrite | null {
  if (legacy === undefined || legacy === null) return null;
  const ids: unknown[] = Array.isArray(legacy) ? legacy : [legacy];
  if (ids.length === 0) return null;
  const w = setAgentSkills(name, ids, { prune: false });
  reportSkillsWrite(name, w, 'config.skills migration');
  return w;
}

/**
 * Moves one agent's `config.skills` to its attachments, then takes the field off
 * config.json — in that order: a crash in between leaves the skills in both
 * places, never in neither. Null when the config has no such field.
 */
export function moveConfigSkills(name: string): AgentSkillsWrite | null {
  validName(name);
  const current = loadConfig(name);
  if (current.skills === undefined) return null;
  const moved = absorbConfigSkills(name, current.skills);
  const next: AgentConfig = { ...current };
  delete next.skills;
  writeFileSync(agentConfig(name), JSON.stringify(next, null, 2));
  publishAgentUpdated(name, ['skills']);
  return moved ?? { attached: [], detached: [], rejected: [], missing: [] };
}

/** The skills sent win (whole set, pruned); else whatever the old config still held is absorbed. */
function writeSkillsOf(name: string, sent: { present: boolean; ids: string[] }, legacy: unknown): void {
  if (sent.present) reportSkillsWrite(name, setAgentSkills(name, sent.ids, { prune: true }), 'skills');
  else absorbConfigSkills(name, legacy);
}

function readAgentPrompt(name: string): string {
  return existsSync(agentSystemPrompt(name)) ? readFileSync(agentSystemPrompt(name), 'utf8') : '';
}

/**
 * Checks the `look` a write carries, in place, before anything is written: an
 * unknown value throws (the routes answer 400 with the message), `null` (or an
 * explicit `undefined` from an in-process caller) clears it. Without a `look`
 * key nothing changes. A mascot pack's part the agent already wears (`stored`)
 * stays accepted in its field while its pack is off (`catalogKeeping`).
 */
function settleLook(config: AgentConfig, stored: unknown): void {
  if (!('look' in config)) return;
  const sent = (config as Record<string, unknown>).look;
  const look = sent === undefined ? null : parseAgentLook(sent, catalogKeeping(mascotPartCatalog(), stored));
  if (look) config.look = look;
  else delete config.look;
}

/** Same rule for the avatar mode: an unknown one throws, `null` clears it. */
function settleAvatar(config: AgentConfig): void {
  if (!('avatar' in config)) return;
  const sent = (config as Record<string, unknown>).avatar;
  const avatar = sent === undefined ? null : parseAgentAvatar(sent);
  if (avatar) config.avatar = avatar;
  else delete config.avatar;
}

/**
 * Partial update of an agent's config.json. Used by the chat side panel to
 * toggle skills / MCP servers without rewriting system-prompt.md. Throws if
 * the agent doesn't exist.
 */
export function patchAgentConfig(
  name: string,
  patch: Partial<AgentConfig>,
): AgentDetails {
  validName(name);
  if (!existsSync(agentDir(name))) throw new Error(`agent not found: ${name}`);
  const current = loadConfig(name);
  const fields = stripProtectedKeys(patch as AgentConfig);
  settleLook(fields, current.look);
  settleAvatar(fields);
  const sentSkills = takeSentSkills(fields);
  const next: AgentConfig = { ...current, ...fields };
  if ('look' in patch && fields.look === undefined) delete next.look;
  if ('avatar' in patch && fields.avatar === undefined) delete next.avatar;
  delete next.skills;
  writeSkillsOf(name, sentSkills, current.skills);
  writeFileSync(agentConfig(name), JSON.stringify(next, null, 2));
  const changed = changedConfigKeys(current, next);
  publishAgentUpdated(name, sentSkills.present && !changed.includes('skills') ? [...changed, 'skills'].sort() : changed);
  return getAgent(name)!;
}

/**
 * Writes (or, with `undefined`, clears) the delegation list. The one door for
 * this protected key: `patchAgentConfig` strips it, so only the operator-only
 * route reaches here. Clearing puts the agent back on the derived default.
 */
export function setAgentOrchestrates(name: string, value: string[] | '*' | undefined): void {
  validName(name);
  if (!existsSync(agentDir(name))) throw new Error(`agent not found: ${name}`);
  const current = loadConfig(name);
  const next: AgentConfig = { ...current };
  if (value === undefined) delete next.orchestrates;
  else next.orchestrates = value;
  writeFileSync(agentConfig(name), JSON.stringify(next, null, 2));
  publishAgentUpdated(name, changedConfigKeys(current, next));
}

/**
 * Deletes an agent. Its folder goes to the trash (`agent-trash.ts`) unless the
 * trash is off in Settings, the agent is ephemeral, or the caller asks for
 * `purge` — the agents Timon creates and removes on its own (workflow nodes,
 * legacy coordinators) are not the user's to restore.
 */
export function deleteAgent(name: string, opts: { purge?: boolean; deletedBy?: string | null } = {}): boolean {
  validName(name);
  const dir = agentDir(name);
  if (!existsSync(dir)) return false;
  // Taken before the removal: the directory is the only place it exists.
  const snapshot = agentEventSnapshot(name);
  // `snapshot` is null for an ephemeral agent: a mission's scratch, never trashed.
  const trashed = !opts.purge && snapshot && agentTrashEnabled()
    ? trashAgentDir(name, { deletedBy: opts.deletedBy ?? null, skills: heldAgentSkillAttachments(name) })
    : null;
  if (!trashed) rmSync(dir, { recursive: true, force: true });
  // Its skill attachments leave the table (TODO #623): an agent recreated
  // under the same name starts without them. A trashed agent carries them in
  // its entry, written above before this removal.
  dropAgentSkillAttachments(name);
  // The other agents stop naming it: a `reports_to` on a missing agent makes
  // their editor refuse every save, and a delegation list would keep a slot
  // for whoever is created later under the same name.
  const refs = dropAgentRefs(name);
  if (trashed && (refs.reports_to.length || refs.orchestrates.length)) setTrashedAgentRefs(trashed.id, refs);
  // An agent recreated under the same name must not inherit what its owner
  // once let the old one do without asking.
  dbApi.deleteApprovalRulesForAgent(name);
  // Same for what it was given access to (TODO #668): a secret or a browser
  // profile is granted by name, so a grant left behind would open it to the
  // next agent of that name. Not kept for a restore either: giving them back
  // is the user's call again.
  const secrets = dbApi.deleteSecretGrantsForAgent(name);
  const allowlists = revokeAgentBrowserGrants(name);
  if (secrets || allowlists) console.log(`[agent] ${name} deleted: ${secrets} secret grant(s) and ${allowlists} browser profile allowlist(s) revoked`);
  // Its own browser profiles hold its signed-in sessions: parked with the
  // trash entry, out of reach of a same-name agent, back with a restore; gone
  // with a deletion that keeps nothing.
  if (trashed) holdAgentBrowserProfiles(name, trashed.id);
  else dropAgentBrowserProfiles(name);
  // Its memory (TODO #670) is keyed by name in the database: left there, an
  // agent recreated under the same name would be injected the old one's rules.
  if (trashed) holdAgentMemory(name, trashed.id);
  else dropAgentMemory(name);
  // Its inbox too: the wake-loop would otherwise try to wake an agent that no
  // longer exists, every sweep, until the messages go stale (TIM-0112).
  const orphaned = dbApi.expirePendingForAgent(name);
  if (orphaned) console.log(`[agent] ${name} deleted: ${orphaned} pending message(s) expired`);
  if (snapshot) bus.publish({ kind: 'agent_deleted', agent: snapshot });
  return true;
}

/** Brings a trashed agent back under its name, announced like a new one. */
export function restoreAgent(trashId: string): AgentTrashRestore {
  const out = restoreAgentDir(trashId);
  if (out.ok) {
    // Before the announcement, like the folder: a mission started on it finds its browser.
    const profiles = restoreAgentBrowserProfiles(out.entry.name, trashId);
    restoreAgentMemory(out.entry.name, trashId);
    for (const p of profiles.dropped) console.warn(`[agent] restore ${out.entry.name}: browser profile "${p}" deleted, another profile now holds its place`);
    // Before the announcement: whoever reacts to it reads the agent's skills.
    restoreAgentSkillAttachments(out.entry.name, out.skills);
    const agent = agentEventSnapshot(out.entry.name);
    if (agent) bus.publish({ kind: 'agent_created', agent });
    if (out.refs) restoreAgentRefs(out.entry.name, out.refs);
  }
  return out;
}

/**
 * Takes a deleted agent out of the other agents' `reports_to` and
 * `orchestrates`, and says who named it. Best effort, file by file: a config
 * that cannot be written keeps its reference and is logged, the deletion
 * itself already happened.
 */
function dropAgentRefs(name: string): AgentTrashRefs {
  const refs: AgentTrashRefs = { reports_to: [], orchestrates: [] };
  const plan = planAgentRefRewrites(name, null);
  for (const change of plan.changes) {
    try {
      writeFileSync(change.path, change.after);
    } catch (err) {
      console.warn(`[agent] delete ${name}: could not update ${change.agent}/config.json: ${(err as Error).message}`);
      continue;
    }
    if (change.fields.includes('reports_to')) refs.reports_to.push(change.agent);
    if (change.fields.includes('orchestrates')) refs.orchestrates.push(change.agent);
    publishAgentUpdated(change.agent, change.fields);
  }
  return refs;
}

/**
 * Puts back what `dropAgentRefs` took, where nothing replaced it since: a
 * `reports_to` the user pointed elsewhere, or a delegation list cleared to the
 * derived default, stays as the user left it.
 */
function restoreAgentRefs(name: string, refs: AgentTrashRefs): void {
  const touched = new Set([...refs.reports_to, ...refs.orchestrates]);
  for (const agent of touched) {
    const path = agentConfig(agent);
    if (!existsSync(path)) continue;
    let cfg: AgentConfig;
    try { cfg = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig; } catch { continue; }
    const fields: string[] = [];
    if (refs.reports_to.includes(agent) && !cfg.reports_to) {
      cfg.reports_to = name;
      fields.push('reports_to');
    }
    if (refs.orchestrates.includes(agent) && Array.isArray(cfg.orchestrates)
      && !cfg.orchestrates.some((n) => n.toLowerCase() === name.toLowerCase())) {
      cfg.orchestrates = [...cfg.orchestrates, name];
      fields.push('orchestrates');
    }
    if (!fields.length) continue;
    try {
      writeFileSync(path, JSON.stringify(cfg, null, 2));
      publishAgentUpdated(agent, fields);
    } catch (err) {
      console.warn(`[agent] restore ${name}: could not update ${agent}/config.json: ${(err as Error).message}`);
    }
  }
}

export type RenameResult = {
  ok: boolean;
  error?: string;
  /** What the caller may be told whoever they are. */
  warnings?: string[];
  /** Triggers to read again. They belong to their owners: a route shows the caller its own only. */
  triggersToCheck?: RenamedAgentTrigger[];
};

/** Why a trigger of `triggersToCheck` needs a look. */
export function renamedTriggerReason(oldName: string, newName: string): string {
  return `its filter tests the agent name by pattern or substring and reads "${newName}" differently from "${oldName}"; left unchanged, check it`;
}

/**
 * The durable half of the warning: the rename's answer goes to whoever renamed
 * (maybe an agent, or another account), and the filter is its owner's to fix.
 * After the commit, and never a reason to fail a rename that already happened.
 */
function notifyRenamedTriggers(oldName: string, newName: string, triggers: readonly RenamedAgentTrigger[]): void {
  const byOwner = new Map<string | null, RenamedAgentTrigger[]>();
  for (const trigger of triggers) {
    // A plugin reads no notification: an administrator does, as for any ownerless row.
    const owner = trigger.owner_user_id?.startsWith(PLUGIN_OWNER_PREFIX) ? null : trigger.owner_user_id;
    byOwner.set(owner, [...byOwner.get(owner) ?? [], trigger]);
  }
  for (const [owner, own] of byOwner) {
    try {
      createNotification({
        type: 'alert',
        title: own.length === 1
          ? `Check a trigger: agent ${oldName} is now ${newName}`
          : `Check ${own.length} triggers: agent ${oldName} is now ${newName}`,
        body: `The filter of these event triggers matches the agent's name by pattern or substring and no longer reads it the same way. They were left unchanged: review each one on the Triggers page.\n${own.map((t) => `- ${t.name}`).join('\n')}`,
        ownerUserId: owner,
      });
    } catch (err) {
      console.warn(`[agent] rename ${oldName}→${newName}: could not notify about ${own.length} trigger(s): ${(err as Error).message}`);
    }
  }
}

/**
 * Rename an agent: MOVE its directory (rather than clone it) AND update every
 * name reference, which is the identity key throughout TIMON:
 *   - DB: missions, tasks, routines, inter-agent messages, memory, triggers,
 *     secret grants and browser profiles (`dbApi.renameAgentRefs`)
 *   - each project's roles.json: spec.agent === old → new
 *   - every agent's config.json: `reports_to` and the entries of `orchestrates`
 *     that name the old agent (case-insensitive, like every agent lookup) —
 *     otherwise the renamed agent silently drops out of its chief's subtree
 *     and of the explicit delegation lists that named it
 * Refuse when the agent has a LIVE mission (the process references its name/cwd)
 * or when the new name is already taken. Idempotent when old === new.
 *
 * Before this helper, the edit route upserted under the new name → a cloned
 * agent while retaining the old one (rename = clone bug).
 */
export function renameAgent(oldName: string, newName: string): RenameResult {
  const result = db.transaction(() => renameAgentLocked(oldName, newName)).immediate();
  // After the commit: a listener that reads the database sees the new name.
  if (result.ok && oldName !== newName) publishAgentUpdated(newName, ['name'], oldName);
  if (result.triggersToCheck?.length) notifyRenamedTriggers(oldName, newName, result.triggersToCheck);
  return result;
}

function renameAgentLocked(oldName: string, newName: string): RenameResult {
  validName(oldName);
  validName(newName);
  if (oldName === newName) return { ok: true };
  if (!existsSync(agentDir(oldName))) return { ok: false, error: `agent not found: ${oldName}` };
  if (existsSync(agentDir(newName))) return { ok: false, error: `agent "${newName}" already exists` };
  for (const r of running.values()) {
    if (r.agentName === oldName) {
      return { ok: false, error: `mission in progress for ${oldName} — stop it before renaming` };
    }
  }
  const projects = listProjects();
  // Config references go FIRST, before anything is moved: they are plain files
  // that can be put back byte for byte, so a failure anywhere below undoes them
  // and the rename either happens whole or not at all.
  const rewrites = planAgentRefRewrites(oldName, newName);
  const written: AgentRefRewrite[] = [];
  const undoRewrites = (): void => {
    for (const w of written) {
      try { writeFileSync(w.path, w.before); } catch (err) {
        console.error(`[agent] rename ${oldName}→${newName}: could NOT restore ${w.path}: ${(err as Error).message}`);
      }
    }
  };
  for (const w of rewrites.changes) {
    try {
      writeFileSync(w.path, w.after);
      written.push(w);
    } catch (err) {
      undoRewrites();
      return { ok: false, error: `Could not update the hierarchy reference in ${w.agent}: ${(err as Error).message}` };
    }
  }
  try {
    renameSync(agentDir(oldName), agentDir(newName));
  } catch {
    undoRewrites();
    return { ok: false, error: 'Could not move the agent directory. Try again in a moment.' };
  }
  let refs: ReturnType<typeof dbApi.renameAgentRefs>;
  try {
    const otherAgents = readdirSync(AGENTS_DIR).filter((agent) => agent !== newName);
    refs = dbApi.renameAgentRefs(oldName, newName, otherAgents);
    const recorded = dbApi.getAllSettings()['orchestrator.main.agent'];
    if (recorded === oldName || (!recorded && oldName === '_main')) {
      dbApi.setSetting('orchestrator.main.agent', newName);
    }
  } catch (error) {
    // A failed database update must leave the old identity usable for a retry.
    renameSync(agentDir(newName), agentDir(oldName));
    undoRewrites();
    throw error;
  }
  for (const slug of projects) {
    try {
      const roles = readRoles(slug);
      let changed = false;
      for (const spec of Object.values(roles)) {
        if (spec && spec.agent === oldName) { spec.agent = newName; changed = true; }
      }
      if (changed) writeRoles(slug, roles);
    } catch (err) {
      // Missing roles.json is normal (skip). But a WRITE failure leaves this
      // project pointing to the old name → a later spawn will break. Log loudly.
      console.warn(`[agent] rename ${oldName}→${newName}: failed to update project ${slug}'s roles.json: ${(err as Error).message}`);
    }
  }
  console.log(`[agent] renamed ${oldName} → ${newName} (directory + DB refs + roles.json + ${written.length} config reference(s))`);
  const warnings = [
    ...rewrites.unreadable.map((a) => `${a}: config.json unreadable, its hierarchy references were not checked`),
    ...refs.warnings,
  ];
  return {
    ok: true,
    ...(warnings.length ? { warnings } : {}),
    ...(refs.triggersToCheck.length ? { triggersToCheck: refs.triggersToCheck } : {}),
  };
}

type AgentRefRewrite = { agent: string; path: string; before: string; after: string; fields: ('reports_to' | 'orchestrates')[] };

/**
 * The config.json edits a rename owes the OTHER agents: `reports_to` naming the
 * old agent, and each `orchestrates` entry naming it. Names compare
 * case-insensitively (`canonicalAgentName` resolves them that way, so a
 * hand-written `Timon.Main` does point at `timon.main`). `'*'` and unrelated
 * entries are left alone. A config that cannot be parsed is reported, never
 * guessed at: it is skipped and the caller says so.
 *
 * `newName` null is a deletion: `reports_to` is removed (back to the derived
 * manager) and the entry leaves the delegation list.
 */
function planAgentRefRewrites(
  oldName: string,
  newName: string | null,
): { changes: AgentRefRewrite[]; unreadable: string[] } {
  const changes: AgentRefRewrite[] = [];
  const unreadable: string[] = [];
  if (!existsSync(AGENTS_DIR)) return { changes, unreadable };
  const isOld = (v: unknown): boolean => typeof v === 'string' && v.toLowerCase() === oldName.toLowerCase();
  for (const agent of readdirSync(AGENTS_DIR)) {
    const path = agentConfig(agent);
    if (!existsSync(path)) continue;
    let before: string;
    let cfg: AgentConfig;
    try {
      before = readFileSync(path, 'utf8');
      cfg = JSON.parse(before) as AgentConfig;
    } catch (err) {
      console.warn(`[agent] rename ${oldName}→${newName}: ${agent}/config.json unreadable (${(err as Error).message}); its references were not rewritten`);
      unreadable.push(agent);
      continue;
    }
    const fields: AgentRefRewrite['fields'] = [];
    if (isOld(cfg.reports_to)) {
      if (newName === null) delete cfg.reports_to;
      else cfg.reports_to = newName;
      fields.push('reports_to');
    }
    if (Array.isArray(cfg.orchestrates) && cfg.orchestrates.some(isOld)) {
      const seen = new Set<string>();
      cfg.orchestrates = cfg.orchestrates
        .flatMap((n) => (isOld(n) ? (newName === null ? [] : [newName]) : [n]))
        .filter((n) => {
          const k = typeof n === 'string' ? n.toLowerCase() : null;
          if (k === null) return true;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      fields.push('orchestrates');
    }
    if (fields.length) changes.push({ agent, path, before, after: JSON.stringify(cfg, null, 2), fields });
  }
  return { changes, unreadable };
}

/**
 * Creates an ephemeral agent and returns its internal name (`_eph-<short-uuid>`).
 * The agent is stored like a normal agent under `~/.timon/agents/<name>/`
 * so the whole pipeline (spawn, MCP config, skills, memory_scope, etc.)
 * works without a special case. The `ephemeral: true` marker in
 * config.json triggers automatic cleanup after its mission ends
 * (`proc.on('exit')` handler in `spawnTurn`).
 *
 * The caller must have the `orchestrator` role (checked at the HTTP layer
 * before reaching this function — best effort, no internal guard).
 *
 * The supplied system prompt is used as-is: the TIMON preamble and declared
 * skills are stacked at spawn time as for every agent.
 */
export function createEphemeralAgent(input: {
  system_prompt: string;
  config?: Omit<AgentConfig, 'ephemeral'>;
  /** Optional human-readable hint baked into the agent name. Sanitised to
   *  the NAME_RE charset. Useful for debugging — the UI can read the slug
   *  to identify what the agent was used for. */
  hint?: string;
}): AgentDetails {
  if (!input.system_prompt || !input.system_prompt.trim()) {
    throw new Error('system_prompt is required for an ephemeral agent');
  }
  const slug = (input.hint ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 24);
  const shortId = randomUUID().slice(0, 8);
  const name = slug ? `_eph-${slug}-${shortId}` : `_eph-${shortId}`;
  // Use writeAgentFiles (internal, trusted) rather than upsertAgent: the latter
  // strips `ephemeral` specifically to prevent API escalation. This is the only
  // legitimate caller allowed to set the flag.
  return writeAgentFiles(name, input.system_prompt, {
    ...(input.config ?? {}),
    ephemeral: true,
  });
}

/**
 * Removes an ephemeral agent directory after its mission ends.
 * No-op if:
 *  - the agent no longer exists (already cleaned up, race)
 *  - the agent is not marked ephemeral (safety — never nuke a persistent
 *    agent by accident)
 *  - another mission for this agent is still running (should not happen — an
 *    ephemeral agent conventionally has one mission — but check in case the
 *    model called `mission_spawn` twice for the same ephemeral agent)
 */
function disposeEphemeralAgentIfDone(agentName: string): void {
  if (!agentName.startsWith('_eph-')) return;
  let cfg: AgentConfig;
  try { cfg = loadConfig(agentName); } catch { return; }
  if (cfg.ephemeral !== true) return;
  for (const a of running.values()) {
    if (a.agentName === agentName) return; // another mission is still live
  }
  try {
    rmSync(agentDir(agentName), { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[timon] dispose ephemeral ${agentName} failed: ${(err as Error).message}\n`,
    );
  }
}

/**
 * The one agent a fresh install is seeded with.
 *
 * `_main` is the technical orchestrator (hardcoded fallbacks throughout), and
 * only a seed name: onboarding has its owner name the main agent, which then
 * replaces it (`main-agent.ts`). No other agent is ever written by the product
 * — an agent is the user's own, created through onboarding or the agent CRUD.
 * Legacy seeding runs when the agents directory is empty, so renaming or
 * deleting it is permanent: `seedDefaultAgent` will not put it back as long as
 * any agent remains.
 */

type SeededLlmDefault = { backend: BackendName; model: string | null };

/** Every built-in backend that can really be executed on this host, in seeding order. */
export function availableSeededLlmDefaults(): SeededLlmDefault[] {
  const host = getHost();
  const found: SeededLlmDefault[] = [];
  for (const [backend, declared] of Object.entries(BUILTIN_DECLARATIONS)) {
    if (!declared.seedsMainAgent || !declared.binary) continue;
    try {
      host.bin(declared.binary.names[0]!);
      found.push({ backend, model: catalogBackend(backend)?.defaultModel ?? null });
    } catch { /* try the next supported CLI */ }
  }
  return found;
}

/** Pick the first built-in backend that can really be executed on this host. */
export function availableSeededLlmDefault(): SeededLlmDefault | null {
  return availableSeededLlmDefaults()[0] ?? null;
}

/**
 * Repair only the untouched LLM choice of Timon's three stock agents.
 *
 * They are seeded before first-run setup writes its detected binary paths. On
 * a Codex-only machine they therefore used to keep the implicit Claude default
 * forever. Explicit backends and custom model choices are never changed, nor
 * are deleted or renamed agents recreated.
 */
function repairSeededLlmDefaults(names: readonly string[], llm: SeededLlmDefault | null): void {
  if (!llm) return;
  for (const name of names) {
    if (!existsSync(agentDir(name))) continue;
    const cfg = loadConfig(name);
    if (cfg.backend !== undefined) continue;
    if (cfg.model !== undefined && cfg.model !== 'sonnet' && cfg.model !== 'claude-sonnet-4-6') continue;
    const next: AgentConfig = { ...cfg, backend: llm.backend };
    if (llm.model) next.model = llm.model;
    else delete next.model;
    writeFileSync(agentConfig(name), JSON.stringify(next, null, 2));
  }
}

/** Create the seed agent if no agent exists yet. */
export function seedDefaultAgent(): void {
  // The wizard and service share a home. Serialize the whole check-and-create
  // with renames; checking the recorded name alone leaves a TOCTOU window.
  db.transaction(seedDefaultAgentLocked).immediate();
}

function seedDefaultAgentLocked(): void {
  initializeTeamOnboarding();
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
  const entries = readdirSync(AGENTS_DIR).filter((n) =>
    statSync(join(AGENTS_DIR, n)).isDirectory(),
  );
  const llm = availableSeededLlmDefault();
  if (entries.length > 0) {
    repairSeededLlmDefaults(['_main'], llm);
    return;
  }
  // Keep the recorded identity check as a fallback for an interrupted setup.
  // The transaction above also closes the gap between this check and creation
  // when the embedded wizard and newly installed service boot on the same home.
  // Duplicate the key to avoid the main-agent.ts -> agent.ts import cycle.
  const named = dbApi.getAllSettings()['orchestrator.main.agent'];
  if (named && existsSync(agentDir(named))) return;
  const llmConfig: AgentConfig = llm
    ? { backend: llm.backend, ...(llm.model ? { model: llm.model } : {}) }
    : { model: 'sonnet' };
  upsertAgent({
    name: '_main',
    system_prompt: defaultMainPrompt(),
    // The role is written, not deduced from the name: `_main` is the seed
    // name, and onboarding lets it be renamed the same day.
    config: { ...llmConfig, permission_mode: 'auto', role: 'orchestrator' },
  });
}

export interface MainPromptEnv {
  /** The agents directory of THIS installation. */
  agentsDir?: string;
  platform?: NodeJS.Platform;
}

/** A plausible absolute project path for the OS, with `<user>`/`<slug>` left
 *  for the reader. Plain literals on purpose: the real home is not needed. */
export function exampleProjectCwd(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\Users\\<user>\\projects\\<slug>';
  if (platform === 'darwin') return '/Users/<user>/webdev/projects/<slug>';
  return '/home/<user>/webdev/projects/<slug>';
}

/** Seeded system prompt for the `_main` orchestrator on a fresh install.
 *  Covers TIMON layout, agent config schema (including backend), and the
 *  Claude/Codex provider choice so the bundled orchestrator can spawn
 *  sub-agents on either backend without guessing the API shape.
 *
 *  A function, not a constant: the API URL is only known once the daemon's
 *  env and config are loaded, and a top-level constant would freeze the
 *  port at module import — the very thing that made a sandbox agent point
 *  at the production daemon. */
export function defaultMainPrompt(env: MainPromptEnv = {}): string {
  const agentsDir = env.agentsDir ?? AGENTS_DIR;
  const platform = env.platform ?? process.platform;
  const exampleCwd = exampleProjectCwd(platform);
  const exampleCwdJson = exampleCwd.replace(/\\/g, '\\\\');
  // No name here: the agent is renamed at setup, and its name reaches it with every mission.
  return `You are the user's main agent, the orchestrator of a personal agentic OS (TIMON).
You receive goals from the user and either answer directly or
decompose them into subtasks delegated to other agents. Be concise.

# TIMON basics

Agents live under \`${join(agentsDir, '<name>')}\` on the user's machine
(the \`agents\` folder of the Timon data directory):

- \`config.json\` — agent settings (see "Agent config" below)
- \`system-prompt.md\` — durable instructions for that agent
- \`memory/\` — long-running notes, logs

The orchestrator HTTP API runs on \`${apiBaseUrl()}\` on this machine.
Use the available MCP tools for common operations. The \`timon\` CLI is optional
and may be absent from packaged installs. Never assume another port:
a second daemon may be running next to this one.

# Agent config schema

\`config.json\` (all fields optional):

\`\`\`json
{
  "backend": ${backendNames().filter((n) => !isAccountInstanceId(n)).map((n) => `"${n}"`).join(' | ')},
  "model": "<provider-specific slug>",
  "permission_mode": "auto" | "acceptEdits" | "plan" | "bypassPermissions",
  "cwd": "${exampleCwdJson}",
  "project": "<slug>",
  "skills": ["<skill-id>", ...],
  "mcp_servers": ["<mcp-id>", ...],
  "excluded_mcp_servers": ["<mcp-id>", ...],
  "allowed_tools": ["<pattern>", ...],
  "disallowed_tools": ["<pattern>", ...]
}
\`\`\`

## Backend selection

TIMON can run an agent on either provider. **The backend is fixed per
agent**, not per message. Neither provider is "the" default: pick the one the
user works on — your own backend when you do not know, and never create an
agent on a backend the user did not choose. **Reuse before creating:** call
\`agent_list\` first and give the work to an agent that already exists
(with its own backend and model) before calling \`agent_create\`.

- \`backend: "claude"\` — long-lived \`claude\` CLI, billed via
  the user's Claude Pro/Max subscription. Models: \`sonnet\`, \`opus\`,
  \`haiku\`.

- \`backend: "codex"\` — OpenAI \`codex\` CLI in one-shot exec mode, billed
  via the user's ChatGPT Pro subscription. Each turn re-spawns with
  \`codex exec resume <thread_id>\` so context is preserved. Models:
  \`gpt-5.6-sol\`, \`gpt-6-astra\`, \`gpt-5.6-terra\`, \`gpt-5.6-luna\`, \`gpt-5.5\`,
  \`gpt-5.4\`, \`gpt-5.4-mini\`, \`gpt-5.3-codex\`, \`gpt-5.2\`.
  Codex has no interactive permission flow — its sandbox is set from
  \`permission_mode\` (\`plan\`→read-only, \`bypassPermissions\`→full access,
  anything else→workspace-write).

Cross-spawn works in both directions: a Claude agent can \`timon spawn
<codex-agent>\` and vice versa.

# Creating / updating agents

Use the \`timon agent\` CLI — it wraps the HTTP API and handles existence
checks so you can't accidentally clobber an agent on create:

\`\`\`bash
# Create (fails if the agent already exists). Prompt comes from stdin
# (heredoc) or --prompt-file PATH. Config flags are optional.
timon agent create codex_helper \\
  --backend codex --model gpt-5.4-mini \\
  --permission-mode auto \\
  --cwd "${exampleCwd}" <<'PROMPT'
You are a coding sidekick. Be terse.
PROMPT

# Update (fails if the agent doesn't exist). Pass only the fields to
# change — others are preserved. Omit stdin/--prompt-file to leave the
# system prompt untouched.
timon agent update codex_helper --model gpt-5.6-sol
\`\`\`

Underneath, \`timon agent\` calls \`POST /api/agents\` (create / full update)
and \`PATCH /api/agents/<name>/config\` (partial config-only update). Hit
those routes directly with curl only if you need something the CLI
doesn't expose. Deletion is intentionally manual — remove the
\`${join(agentsDir, '<name>')}\` folder.

# Spawning missions

\`\`\`bash
timon spawn <agent> "<mission text...>"   # returns {mission_id}
\`\`\`

For cross-agent coordination, prefer MCP tools: \`agent_list\` discovers exact
agent names (including prefixes), \`agent_send_message\` sends a message or a
question, and \`mission_spawn\` starts a new delegated task for another agent.
Never infer an agent id from its display label. If the recipient is unknown,
refresh \`agent_list\` instead of trying guessed names. The MCP works in packaged
installs where the \`timon\` CLI may not be on PATH. These runtime instructions
take precedence over older starter prompts recommending CLI delegation.

**\`timon spawn\` is NOT idempotent.** Each call creates a new mission. If
you call it twice with the same prompt you get two parallel runs of the
same task. After issuing a spawn, treat the mission as live — do NOT
retry the command, do NOT "double-check" by running it again. The
\`mission_id\` in the response is what you use to refer to it from then
on (\`timon wait\`, \`timon send\`, \`timon status\`).

If you genuinely need retry safety (network blip, permission-card
re-prompt) pass \`--idempotency-key <hash>\`: a second call with the same
key within 5 minutes returns the existing \`mission_id\` instead of
spawning a duplicate:

\`\`\`bash
timon spawn example-project "init the repo" --idempotency-key example-project-init-2026-05-15
\`\`\`

# Asking the user clarifying questions

**Only if a human is in this conversation.** Spawned by the daemon or by another agent, you never
ask the user: Timon refuses the call, and the question goes to your referent (the agent that spawned
you, or your series' pilot) through \`agent_send_message\`.

The builtin \`AskUserQuestion\` tool is disabled in TIMON — it needs an
interactive TTY we don't have. To ask the user a clarifying question
with predefined options, call the \`question\` tool of the \`timon_ask\` MCP
server instead (\`mcp__timon_ask__question\`; older prompts call it
\`mcp__timon_permission__ask_user\`, it is the same tool):
same schema (1–4 questions, each with 2–4 options, optional
\`multiSelect\`), and TIMON renders a proper radio/checkbox form in the
chat. For an open question (a name, a phrase), omit \`options\`: the
form shows a single text field (hint with \`placeholder\`) and the
answer is the typed text. Every question with options also ends with a
free-text field. The tool returns \`{answers: {<question text>: <answer>}}\`
once the user submits, or errors if they cancel: \`<answer>\` is the selected
label (an array of labels on a \`multiSelect\`), or — when the user also typed
in that question's field — an object holding the text beside the pick:
\`{choice, text}\`, \`{choices, text}\`, or \`{text}\` alone when they ticked
nothing. That text can qualify or override the pick: take it into account.
Whatever the user must read to answer (a report, a comparison table) goes in
the tool's \`message\` field, which Timon posts as a normal chat message above
the form: text written in the turn right before the call may never be shown.

# Cross-provider continuation (fork)

Each backend's session id is opaque — Claude can't resume a Codex thread
and vice versa. To switch LLMs mid-chat (e.g. fallback when one provider
rate-limits) TIMON compresses the transcript via the current backend and
spawns a *new* mission on the target agent seeded with that summary.

\`\`\`bash
# Pre-compute the summary so a switch is instant (also runs on the
# mission's current backend, so cost stays on whichever subscription
# is hosting the chat).
timon mission summarize <mission_id>            # prints summary, caches it
timon mission summarize <mission_id> --force    # refresh even if cached

# Fork onto another agent. New mission_id, fresh provider session,
# context carried via the summary embedded in the kickoff prompt.
timon mission fork <mission_id> --to codex_helper \\
  --message "User was debugging the auth flow — continue from there."
\`\`\`

The source mission stays intact; the new mission's row carries
\`forked_from\` for lineage. Use this proactively (summarize after each
substantive turn) so a rate-limit fallback can fire without first
re-paying the full-transcript token cost.

# Host environment

TIMON runs the orchestrator as a process on the user's machine — not in
a container — so spawned agents inherit the user's environment
directly:

- The full host \`$PATH\` is available: \`docker\`, \`gh\`, \`kubectl\`,
  language toolchains, anything the user has installed. Reach for the
  native tool first; don't reinvent shell-out shims.
- The user's home folder and dotfiles (\`.config\`, \`.aws\`, \`.ssh\`,
  etc.) are visible. Treat credentials carefully — don't leak them into
  the transcript or send them to external endpoints.
- Agent \`cwd\` values are real host paths (for example
  \`${exampleCwd}\`) — there's no \`/workspace\`
  indirection layer to worry about. Relative paths in commands resolve
  the same way as in your own terminal.

Docker is available natively: \`cd $cwd && docker compose up -d --build\`
just works against the user's local daemon.

# Style

- Be concise. Don't repeat the user's question.
- Default to taking action rather than asking permission, unless the
  action is destructive or expensive.
- When delegating, give the sub-agent a clear, scoped goal and the
  minimum context it needs to act.
`;
}

export function listAgents(): AgentSummary[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const entries = readdirSync(AGENTS_DIR);
  const out: AgentSummary[] = [];
  for (const name of entries) {
    const full = join(AGENTS_DIR, name);
    if (!statSync(full).isDirectory()) continue;
    const cfg = loadConfig(name);
    out.push({
      name,
      backend: cfg.backend ?? implicitBackendName(),
      cwd: cfg.cwd ?? null,
      browser_profile_id: cfg.browser_profile_id,
      model: cfg.model ?? null,
      permission_mode: cfg.permission_mode ?? null,
      allowed_tools: cfg.allowed_tools ?? [],
      disallowed_tools: cfg.disallowed_tools ?? [],
      skills: ownAgentSkills(name),
      mcp_servers: cfg.mcp_servers ?? [],
      excluded_mcp_servers: cfg.excluded_mcp_servers ?? [],
      has_system_prompt: existsSync(agentSystemPrompt(name)),
      reports_to: cfg.reports_to,
      team: cfg.team ?? null,
      project: cfg.project ?? projectFromCwd(cfg.cwd),
      memory_scope: cfg.memory_scope ?? 'NONE',
      ephemeral: cfg.ephemeral === true,
      orchestrator: cfg.orchestrator === true || cfg.role === 'orchestrator',
      orchestrates: cfg.orchestrates ?? null,
      global_context: cfg.global_context === true,
      emoji: cfg.emoji ?? null,
      color: cfg.color ?? null,
      icon_url: servedIconUrl(cfg.icon_url),
      look: readAgentLook(cfg.look),
      avatar: readAgentAvatar(cfg.avatar),
      role: (cfg.role as AgentRoleId | undefined) ?? null,
      role_emoji: null,
      directives: cfg.directives ?? null,
      reasoning_effort: cfg.reasoningEffort ?? null,
      created_by: cfg.created_by ?? null,
    });
  }
  return out;
}

/**
 * Team cloisonnement, seen from the listing an AGENT IN MISSION receives
 * (`agent_list` proxies `GET /api/agents`). Showing it recipients it may not
 * address makes it loop on a refusal, so a teamed agent only sees its own team
 * — plus its pilot and its `reports_to`, the two exemptions `sendAgentMessage`
 * keeps open, otherwise it would not see who to report to.
 *
 * `missionId` null (human session, daemon token, CLI) returns the list
 * untouched: it feeds every picker, and the /bots view needs all the bots to
 * render the teams at all. The mission read is the CALLER'S OWN mission,
 * resolved from the token bound to it — not another user's row, which is why it
 * does not go through `scopedDb`.
 */
export function teamVisibleAgents(agents: AgentSummary[], missionId: string | null): AgentSummary[] {
  if (!missionId) return agents;
  const mission = dbApi.getMission(missionId);
  if (!mission) return agents;
  const self = agents.find((a) => a.name === mission.agent_name);
  const team = self?.team ?? null;
  if (!team) return agents;
  // Canonicalised like `sendAgentMessage` does: a pilot named with another
  // case would drop out of the list the exemption exists to keep visible.
  const keep = new Set<string>([canonicalAgentName(mission.agent_name)]);
  if (mission.parent_agent) keep.add(canonicalAgentName(mission.parent_agent));
  if (self?.reports_to) keep.add(canonicalAgentName(self.reports_to));
  return agents.filter((a) => a.team === team || keep.has(canonicalAgentName(a.name)));
}

/* ────────────────────────────────────────────────────────────────────────────
   Memory files (decisions.md, patterns.md, log.jsonl, …)
   ──────────────────────────────────────────────────────────────────────────── */

const MEMORY_FILE_RE = /^[\w.-]+\.(md|jsonl|txt|json)$/;

function validMemoryFile(file: string): void {
  if (!MEMORY_FILE_RE.test(file)) throw new Error(`invalid memory file: ${file}`);
}

export type MemoryFile = { name: string; size: number; modified: number };

export function listMemory(agent: string): MemoryFile[] {
  validName(agent);
  const dir = agentMemoryDir(agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => MEMORY_FILE_RE.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
}

export function readMemory(agent: string, file: string): string | null {
  validName(agent);
  validMemoryFile(file);
  const path = agentMemoryFile(agent, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function writeMemory(agent: string, file: string, content: string): MemoryFile {
  validName(agent);
  validMemoryFile(file);
  mkdirSync(agentMemoryDir(agent), { recursive: true });
  writeFileSync(agentMemoryFile(agent, file), content);
  const st = statSync(agentMemoryFile(agent, file));
  return { name: file, size: st.size, modified: st.mtimeMs };
}

export function deleteMemory(agent: string, file: string): boolean {
  validName(agent);
  validMemoryFile(file);
  const path = agentMemoryFile(agent, file);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** ADD-only: append instead of overwrite. Used by fact capture
 *  (memory-capture.ts) for learnings.jsonl / pieges.md without a racy
 *  read-modify-write. Creates the directory and file as needed. */
export function appendMemory(agent: string, file: string, content: string): void {
  validName(agent);
  validMemoryFile(file);
  mkdirSync(agentMemoryDir(agent), { recursive: true });
  appendFileSync(agentMemoryFile(agent, file), content);
}

/* ────────────────────────────────────────────────────────────────────────────
   Agent root docs (system-prompt.md, soul.md, anything *.md at the agent root)
   ──────────────────────────────────────────────────────────────────────────── */

// Allowed: any *.md at the agent root. Reserved: config.json (edited via the
// agent form) and anything inside memory/ (separate API).
const DOC_FILE_RE = /^[\w.-]+\.md$/;

/** Largest identity doc a write accepts. */
export const AGENT_DOC_MAX_BYTES = 2 * 1024 * 1024;

function validDocFile(file: string): void {
  if (!DOC_FILE_RE.test(file)) throw new Error(`invalid doc file: ${file}`);
}

const agentDocFile = (name: string, file: string) => join(agentDir(name), file);

export function listDocs(agent: string): MemoryFile[] {
  validName(agent);
  const dir = agentDir(agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && DOC_FILE_RE.test(d.name))
    .map((d) => {
      const st = statSync(join(dir, d.name));
      return { name: d.name, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readDoc(agent: string, file: string): string | null {
  validName(agent);
  validDocFile(file);
  const path = agentDocFile(agent, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function writeDoc(agent: string, file: string, content: string): MemoryFile {
  validName(agent);
  validDocFile(file);
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(agentDocFile(agent, file), content);
  const st = statSync(agentDocFile(agent, file));
  publishAgentUpdated(agent, [`doc:${file}`]);
  return { name: file, size: st.size, modified: st.mtimeMs };
}

export function deleteDoc(agent: string, file: string): boolean {
  validName(agent);
  validDocFile(file);
  // Refuse to delete the load-bearing system prompt.
  if (file === 'system-prompt.md') throw new Error('system-prompt.md cannot be deleted');
  const path = agentDocFile(agent, file);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  publishAgentUpdated(agent, [`doc:${file}`]);
  return true;
}

/**
 * Ends a TASK mission whose turn just bounced, instead of leaving its process
 * idle until the reaper.
 *
 * WHY (night of 2026-09-17). A persistent CLI (claude) stays alive after a
 * failed turn, waiting for a next message nobody sends to a task. Each mission
 * therefore lived the full idle-reap delay (10 min) before dying as `killed` —
 * a gesture of ours, replayable on the same backend — and the breaker, which
 * counts bounces inside a 10-min window, never saw two at once. Eight missions
 * died that way in 2 h 10 while the fallback was configured.
 *
 * A chat is left alone: a human is reading it and decides what comes next.
 */
function finalizeBouncedTask(agent: RunningAgent): void {
  if (!agent.backend.persistentProcess || agent.terminationIntent || agent.sessionNotFound) return;
  if (!dbApi.getTaskByMission(agent.missionId)) return;
  console.warn(
    `[breaker] task mission ${agent.missionId.slice(0, 8)} (${agent.agentName}) bounced off `
    + `${agent.backend.name} → finalised now (${agent.interruptedBy ?? 'crash'})`,
  );
  agent.terminationIntent = 'bounced';
  try { agent.handle.kill('SIGTERM'); } catch { /* already dead */ }
}

/**
 * Tool uses an ACP agent asks about become an Allow/Deny card, like the ones
 * claude's `timon_ask` MCP raises: same requests, same auto-refusal on a
 * mission nobody watches. A developer-owned mission is allowed straight away,
 * as `POST /api/permissions/request` does for the same account and is traced
 * the same way; the rule (`developerAutoAllows`) is shared, so a form card
 * opens its card on both paths. A conversion mission is the exception on both
 * paths: never auto-allowed, its shell or write tools denied before any card.
 */
const sessionPermissionGate: PermissionGate = async (input) => {
  const mission = dbApi.getMission(input.mission_id);
  // A conversion mission is never auto-allowed, and its shell or write cards never open (TODO #469).
  const conversion = conversionMissionById(input.mission_id) !== null;
  const refusal = conversion ? conversionToolCardRefusal(input.tool_name) : null;
  if (refusal) return { behavior: 'deny', message: refusal };
  const owner = mission?.owner_user_id ? dbApi.getUserById(mission.owner_user_id) : undefined;
  if (!conversion && owner?.status === 'active' && developerAutoAllows(owner, input.tool_name)) {
    dbApi.insertEvent(input.mission_id, 'permission_dev_allowed', {
      tool_name: input.tool_name, tool_use_id: input.tool_use_id,
      auth_kind: 'session', user_id: owner.id,
    });
    return { behavior: 'allow' };
  }
  // Loaded here, not at module load: `permissions.ts` imports this file.
  const { requestPermission } = await import('./permissions.js');
  return requestPermission(input);
};

/** The session of a mission: the driver's events join the stream every other
 *  dialect feeds (persistence, SSE, spans, usage), then it is left to start.
 *  `remote` is the handle of a backend with no process: the driver's
 *  `host.end` settles it, as a process's exit would. */
type TurnLaunchObserver = {
  started(): void;
  /** True if a handover owns this failure and will restore the old session. */
  failed(err: Error): boolean;
};

function openMissionSession(
  agent: RunningAgent,
  open: (host: RemoteSessionHost) => SessionDriver,
  remote?: RemoteMissionHandle,
  launch?: TurnLaunchObserver,
): MissionSession {
  const { missionId, agentName, handle, backend } = agent;
  const enrich = backend.enrichEvent;
  let session: MissionSession | null = null;
  let started = !launch;
  const pendingEvents: NormalizedEvent[] = [];
  const emit = (ev: NormalizedEvent): void => {
    // A protocol handshake (or a fast CLI) may speak before its first prompt.
    // The handover notice must precede those events in SQL as well as SSE.
    if (!started) { pendingEvents.push(ev); return; }
    processEvent(agent, enrich ? enrich(ev, missionId) : ev);
    if (ev.type === 'result') session?.observeResult();
  };
  let failed = false;
  const fail = (message: string): void => {
    if (failed || remote?.closing()) return;
    failed = true;
    if (launch?.failed(new Error(message))) return;
    console.warn(`[${backend.name}:${missionId.slice(0, 8)}] session failed: ${message}`);
    // The user reads this in the thread: the mission would otherwise end with
    // no word about why.
    emit({
      type: 'result',
      payload: { type: 'result', subtype: 'error', is_error: true, error: message, total_cost_usd: 0 },
    });
    // `bounced` for a chat too, on purpose, though `finalizeBouncedTask`
    // reserves it for tasks: a chat whose session died ends `failed` (the
    // exit handler maps it so) and the human decides what comes next. Without
    // an intent, the SIGTERM below could be read as a clean exit and the
    // mission recorded `completed` with the error already in its thread.
    if (!agent.terminationIntent) agent.terminationIntent = 'bounced';
    try { handle.kill('SIGTERM'); } catch { /* already dead: the exit handler does the rest */ }
  };
  const host: RemoteSessionHost = {
    emit,
    requestPermission: permissionHost(missionId, agentName, sessionPermissionGate, (command) => {
      // Loaded here, not at module load: `command-requests.ts` imports this file.
      import('./plugins-bundled/terminal-web/command-requests.js')
        .then(({ relayPasteReply }) => relayPasteReply(missionId, command))
        .catch((err: unknown) => console.warn(`[${backend.name}:${missionId.slice(0, 8)}] paste relay: ${(err as Error).message}`));
    }),
    // An agent's own blocking question (an ACP extension request): the `question` card, same gate.
    ask: questionHost(missionId, agentName, sessionPermissionGate),
    end: (outcome: SessionEnd) => {
      // Once a stop is under way, a driver whose connection we cut may still
      // report it as a failure: that is our gesture, not the agent's word.
      if (!remote || remote.closing()) return;
      if (outcome.reason === 'failed') { fail(outcome.message); return; }
      // Stopped on the agent's side: a human gesture, legible and not replayed,
      // like a turn cut from the chat.
      if (outcome.reason === 'cancelled' && !agent.terminationIntent) agent.terminationIntent = 'interrupted';
      remote.settle(outcome.reason === 'completed' ? 0 : null);
    },
    saveResume: (state) => {
      // Validated even late, so a driver learns of a bad state in its tests.
      const json = state === null ? null : serializeResumeState(state);
      if (!remote || remote.closing() || running.get(missionId) !== agent) return;
      dbApi.setMissionRemoteResume(missionId, json);
    },
  };
  const driver = open(host);
  return session = new MissionSession(driver, {
    emit,
    requestPermission: host.requestPermission,
    onTurnStart: () => {
      if (!agent.turnActive) bus.publish({ kind: 'turn_started', missionId, at: Date.now() });
      agent.turnActive = true;
      agent.turnSince = Date.now();
      agent.budgetSince = agent.turnSince;
      launch?.started();
      started = true;
      for (const event of pendingEvents.splice(0)) emit(event);
      agent.turnOpenedByTimon = true;
    },
    onFailed: (message, cause) => {
      // A refused reattachment says nothing about the remote run, which may
      // still be going: its task is surfaced, not replayed into a second run.
      if (cause === 'reattach' && !agent.interruptedBy) agent.interruptedBy = 'unknown';
      fail(message);
    },
  });
}

/** A rejected chat turn has no Kanban completion to trigger its fallback.
 *  Wait for `result`: changing backend while the provider is still producing
 *  output would cut a live turn and lose the final events of its transcript. */
function fallbackRejectedChat(agent: RunningAgent): void {
  if (!agent.rateLimited || agent.rateLimitPending || agent.terminationIntent
      || agent.switching || backendSwitches.has(agent.missionId)
      || running.get(agent.missionId) !== agent) return;
  const mission = dbApi.getMission(agent.missionId);
  // Task and workflow runners own their retries and terminal transitions.
  if (!mission || mission.status !== 'running' || mission.task_id || mission.workflow_run_id
      || dbApi.getTaskByMission(agent.missionId)) return;
  const target = fallbackFor(agent.backend.name, {
    seriesId: dbApi.seriesIdForMission(agent.missionId) ?? agent.missionId,
    scope: 'orchestrator',
    fromModel: mission.model_override ?? loadConfig(agent.agentName).model ?? null,
    missionOwnerUserId: mission.owner_user_id ?? null,
  });
  if (!target) return;
  void switchMissionBackend(agent.missionId, {
    backend: target.backend,
    model: target.model,
    cause: 'fallback',
    causeDetail: `${agent.backend.name} ${agent.interruptedBy ?? 'rate_limit'}`,
    message: 'Your previous backend rejected the last turn because its quota is exhausted. '
      + 'Continue this same conversation and answer the latest user request in the context above.',
  }).catch((err: unknown) => {
    console.warn(`[fallback] chat ${agent.missionId.slice(0, 8)} could not switch: ${(err as Error).message}`);
  });
}

/** A turn begins on a live persistent process, whoever opened it. */
function beginTurn(live: RunningAgent): void {
  // Same rearming as at spawn: this turn owes its own return.
  try { dbApi.markMissionReturnNotified(live.missionId, false); } catch {}
  const wasActive = live.turnActive;
  live.turnActive = true;
  live.turnSince = Date.now();
  if (!wasActive) bus.publish({ kind: 'turn_started', missionId: live.missionId, at: live.turnSince });
  // Clear any rate-limit flag from a prior turn so a real crash on
  // this turn isn't misclassified as a throttle pause.
  live.rateLimited = false;
  live.rateLimitPending = undefined;
  live.interruptedBy = null;
}

/**
 * The CLI opened a turn nobody sent it: a turn that ended on `run_in_background`
 * gets its job's completion notice, and the CLI goes back to work with no input
 * from Timon. Left unseen, the mission reads as idle for that whole turn: reaped
 * mid-work (fcc38cb6, 31/10/2026), first return taken for the last, chat at rest.
 *
 * Only the agent speaking proves it: `system:init`, a status or a task notice
 * also follow a `result` with no turn behind them. Measured over 30 days, 382
 * turns opened this way: each reached a `result`, or a process end within 15 s of
 * its last event, so none leaves a turn open on a silent CLI. A protocol driver
 * announces its turns (`onTurnStart`) and a one-shot process does not outlive its own.
 */
function selfOpenedTurn(agent: RunningAgent, type: string): boolean {
  return type === 'assistant' && !agent.turnActive && !agent.terminationIntent && !agent.switching
    && agent.backend.persistentProcess && !agent.session?.speaksProtocol;
}

function processEvent(agent: RunningAgent, ev: NormalizedEvent): void {
  const { type, payload } = ev;
  // The session driver's `onActivity` already stamped the raw line; this covers a
  // protocol driver, which emits events and has no raw line to report.
  agent.lastOutputAt = Date.now();
  // Partial text: discard it BEFORE persistence. A three-minute turn produces
  // thousands of deltas; writing them to the DB would saturate `events`
  // (SSE replay + summary.ts) and the agent JSONL log for content that the
  // final `assistant` message summarizes in full. Nothing else is needed here:
  // a delta carries neither a session ID, usage, nor a rate-limit signal.
  if (type === ASSISTANT_DELTA) {
    bus.publish({ kind: 'event_delta', missionId: agent.missionId, type, payload });
    return;
  }
  // Before the rate-limit reading below, whose verdict belongs to the new turn.
  if (selfOpenedTurn(agent, type)) beginTurn(agent);
  // The provider retries on its own: the turn goes on (TODO #459). Counted so
  // that its giving up later reads as the end of a series of transport failures.
  if (type === PROVIDER_RETRY) agent.providerRetries = tallyProviderRetry(agent.providerRetries, payload);
  // Usage limit reached. The three known forms (dedicated event, `result`
  // with 429, text from a dialect without structured status) are recognized
  // by `rate-limit.ts`, shared with `db.ts` autopsy — the paths cannot diverge.
  // `includePending`: a queued request counts here as a pause (the later
  // non-zero exit means "quota pending", not "failure"), while autopsy ignores it.
  const rl = bestRateLimit([{ type, payload }], { includePending: true });
  if (rl) {
    // `rateLimited` stays true for BOTH families: it is the flag that keeps the
    // mission out of the replayable `crash` family. Lose it on a 402 and the
    // task gets requeued straight back into the dry account — the loop of the
    // night of 2026-09-01.
    agent.rateLimited = true;
    agent.rateLimitPending = rl.pending;
    agent.interruptedBy = rl.kind === 'exhausted' ? 'exhausted' : 'rate_limit';
    if (!rl.pending) dbApi.setMissionInterrupted(agent.missionId, agent.interruptedBy);
    // The backend is sidelined for ALL TIMON, not just this mission: the limit
    // applies to the account. Otherwise every subsequent mission hits the same
    // wall (cascade from the 2026-08-20 quota incident).
    noteBackendRateLimit(agent.backend.name, rl);
  }
  // Circuit breaker: a turn that failed instantly having produced nothing is a
  // BOUNCE off the provider. It is counted without reading a single error
  // message — which is the whole point, the night of 2026-09-01 died of a
  // sentence nobody had a pattern for. `rl` first: a limit the provider named
  // is already handled above, and better (it knows when its window reopens).
  if (isAuthFailureEvent(type, payload)) agent.authFailed = true;
  const sterile = rl ? null : sterileResultSignature(type, payload);
  // The turn a steer stopped: our gesture, like a cut below — never replayed,
  // never counted by the breaker.
  const steered = type === 'result' && agent.steerCancelled === true;
  const transient = type === 'result' && !steered && transientTurnFailure(agent, payload, !!rl);
  const unattended = transient && unattendedMission(agent.missionId);
  let tripped = false;
  // A turn we are cutting (chat STOP, reap, reload) may well end on an empty
  // error `result`: that is our gesture, neither a bounce nor proof of health.
  if (type === 'result' && !rl && !agent.terminationIntent && !steered) {
    if (sterile && agent.sessionNotFound) {
      // The resume found no thread: we replay the turn on a fresh one, the provider did not bounce.
    } else if (sterile) {
      // The CLI said so itself: the next choice of a default or fallback backend skips it.
      if (agent.authFailed) noteProviderSignedOut(agent.backend.name);
      const trip = noteSterileTurn(
        agent.backend.name, sterile, Date.now(), agent.authFailed ? 'auth' : 'burst',
      );
      if (trip) {
        agent.interruptedBy = 'backend_unavailable';
        noteBackendUnavailable(trip);
      }
    } else if (transient) {
      // A turn the provider dropped got nowhere: it does not break the burst
      // (counted below, once Timon has given up replaying it).
    } else {
      // A turn that got somewhere breaks the burst, and proves the sign-in.
      noteProductiveTurn(agent.backend.name);
      noteProviderSignedIn(agent.backend.name);
    }
  }
  // A failed turn judged transient carries the verdict in its own `result`, and
  // a replay scheduled for it means the turn is NOT over: no `turn_complete`,
  // so nothing downstream (request reply, mission return, closure question)
  // takes the failure for the answer.
  let stored = payload;
  let replaying = false;
  // The second failed `result` of a turn already judged: it restates the
  // verdict, and must not close the turn (or count it) a second time.
  let echo = false;
  if (type === 'result') {
    if (transient) {
      const judged = judgeTransientTurn(agent, payload, unattended);
      const fields = judged.fields;
      echo = judged.echo;
      stored = { ...(payload as Record<string, unknown>), ...fields };
      replaying = !!fields.timon_retry;
      // An unattended turn the provider dropped AND Timon's replays could not
      // cure counts toward the breaker: a backend that keeps doing it is
      // sidelined for the series' fallback instead of being replayed into the
      // same wall. Not each attempt: the burst window (10 min) would trip
      // before the third replay ever ran.
      const trip = unattended && !replaying && !echo
        ? noteSterileTurn(agent.backend.name, `transient: ${resultFailureText(payload).slice(0, 80)}`)
        : null;
      if (trip) {
        agent.interruptedBy = 'backend_unavailable';
        noteBackendUnavailable(trip);
        tripped = true;
      }
    } else if (!turnRetryPending(agent.missionId)) {
      // A turn that closed any other way ends the series of replays.
      turnRetries.delete(agent.missionId);
    }
    // Persisted with its mark: a request reply read from the transcript later
    // skips it, as it skips a replayed failure (`agent-request-replies.ts`).
    if (steered) stored = { ...(payload as Record<string, unknown>), timon_steered: true };
    agent.providerRetries = undefined;
  }
  const row = dbApi.insertEvent(agent.missionId, type, stored);
  // Trace spans (PRD §4.2): after the event, never before it, and never able
  // to fail it — `recordSpans` swallows everything (§12.1).
  recordSpans(agent.backend, agent.spans, stored === payload ? ev : { type, payload: stored }, row.id);
  if (type === 'assistant') journalDirectSkillReads(agent.missionId, payload);
  if (type === 'result') {
    const obj = payload as {
      total_cost_usd?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
    dbApi.updateMissionUsage(
      agent.missionId,
      cost,
      obj.usage?.input_tokens ?? null,
      obj.usage?.output_tokens ?? null,
    );
    // Turn just finished. Persistent backends (claude) stay alive
    // waiting for the next user message — the mission row stays in
    // 'running' but the agent is now idle. The strip uses this to
    // stop showing "thinking" until the user speaks again.
    agent.turnActive = false;
    agent.turnSince = Date.now();
    if (agent.turnOpenedByTimon) agent.budgetSince = agent.turnSince;
    agent.turnOpenedByTimon = false;
    agent.authFailed = false;
    // A successful turn proves the quota is back, regardless of the announced
    // reopening time: observation takes precedence over prediction. A STERILE
    // turn proves nothing of the sort, though: before the breaker existed, the
    // very bounce of a dry backend lifted its own exclusion here, on a `result`
    // carrying no rate-limit signal.
    if (!agent.rateLimited && !sterile) {
      clearBackendCooldown(agent.backend.name);
      dbApi.setMissionInterrupted(agent.missionId, null);
    }
    if (steered) {
      if (!agent.switching) agent.steerCancelled = false;
      bus.publish({ kind: 'turn_complete', missionId: agent.missionId, outcome: 'cancelled' });
    } else if (!replaying && !echo) {
      bus.publish({ kind: 'turn_complete', missionId: agent.missionId });
    }
    if (((sterile && !replaying) || tripped) && !echo && !steered) finalizeBouncedTask(agent);
    // A model switch requested during the turn: the process is idle now, so
    // this is the right time. Intentional `void` — stdout must not wait for the
    // control response.
    const queuedModel = agent.pendingModel;
    if (queuedModel && agent.backend.setModel && !agent.rateLimited) {
      agent.pendingModel = undefined;
      void applyHotModel(agent, queuedModel, null);
    }
  }
  // system:init payloads from the Claude backend carry the full tools[]
  // and mcp_servers[] catalog — feed it into the MCP discovery cache.
  // Codex emits a synthetic system:init with empty arrays, so this is a
  // no-op there.
  if (type === 'system' && (payload as { subtype?: string }).subtype === 'init') {
    try { refreshToolsCacheFromInit(payload); } catch {}
    void captureCliBaseline(agent);
  }
  const sid = agent.backend.extractSessionId(ev);
  if (sid) {
    try { dbApi.setMissionSession(agent.missionId, sid); } catch {}
  }
  bus.publish({
    kind: 'event',
    missionId: agent.missionId,
    type,
    timestamp: row.timestamp,
    payload: stored,
    id: row.id,
  });
  appendAgentLog(agent.agentName, {
    missionId: agent.missionId, type, ts: row.timestamp, payload: stored,
  });
  if (type === 'result') fallbackRejectedChat(agent);
}

/* ── Replaying a turn the provider dropped (TODO #459) ──────────────────── */

function unattendedMission(missionId: string): boolean {
  const m = dbApi.getMission(missionId);
  return !!m && isAutonomousMission(m);
}

/** A failed `result` the provider could not help: transport, 5xx, overload,
 *  or the end of its own retries. Never a quota, an auth refusal, or a turn we
 *  cut ourselves (cf. `classifyTurnFailure`). */
function transientTurnFailure(agent: RunningAgent, payload: unknown, rateLimited: boolean): boolean {
  if (!isFailedResult(payload)) return false;
  const status = (payload as { api_error_status?: unknown }).api_error_status;
  return classifyTurnFailure({
    error: resultFailureText(payload),
    apiErrorStatus: typeof status === 'number' ? status : null,
    providerRetries: agent.providerRetries?.count ?? 0,
    rateLimited,
    authFailed: agent.authFailed,
    interrupted: !!agent.terminationIntent || agent.sessionNotFound || !!agent.switching,
  }) === 'transient';
}

/**
 * What a transient failure says, and whether Timon replays the turn. Only on a
 * mission nobody watches (`isAutonomousMission`): in a human chat the Retry
 * button is the user's, a replay behind their back could send a message twice.
 */
function judgeTransientTurn(
  agent: RunningAgent, payload: unknown, unattended: boolean,
): { fields: TransientFailureFields; echo: boolean } {
  const missionId = agent.missionId;
  const pending = turnRetries.get(missionId);
  // A second failed `result` of the same turn (codex: `error`, then
  // `turn.failed`): the decision is already taken — the replay already waits,
  // or the series already ended. `turnActive` is false once the first `result`
  // closed the turn; a new input clears the state anyway (`cancelTurnRetry`).
  if (pending?.timer || (pending?.closed && !agent.turnActive)) return { fields: pending.fields, echo: true };
  const max = unattended ? Math.max(0, Math.floor(settingNum('TIMON_TURN_RETRIES'))) : 0;
  const spent = pending?.spent ?? 0;
  const tally = agent.providerRetries;
  const failure: TransientFailureFields['transient_failure'] = {
    cause: resultFailureText(payload) || tally?.lastCause || 'provider unreachable',
    provider_retries: tally?.count ?? 0,
    provider_max: tally?.max ?? null,
    timon_retries: spent,
    timon_max: max,
  };
  const m = dbApi.getMission(missionId);
  if (spent >= max || agent.interruptedBy === 'backend_unavailable' || backendSwitches.has(missionId)
      || m?.status !== 'running') {
    const fields: TransientFailureFields = { transient_failure: failure };
    turnRetries.set(missionId, { spent, timer: null, fields, closed: true });
    return { fields, echo: false };
  }
  const attempt = spent + 1;
  const delayMs = turnRetryDelayMs(attempt, settingNum('TIMON_TURN_RETRY_BASE_MS'), tally?.lastDelayMs);
  const fields: TransientFailureFields = {
    transient_failure: failure,
    timon_retry: { attempt, max, delay_ms: delayMs },
  };
  const timer = setTimeout(() => { void runTurnRetry(missionId, attempt, max, failure.cause); }, delayMs);
  timer.unref?.();
  turnRetries.set(missionId, { spent: attempt, timer, fields, closed: false });
  console.warn(
    `[turn-retry] ${missionId.slice(0, 8)} (${agent.agentName}, ${agent.backend.name}) transient failure after `
    + `${failure.provider_retries} provider retries → Timon retry ${attempt}/${max} in ${Math.round(delayMs / 1000)} s`,
  );
  return { fields, echo: false };
}

/** The text the human (or the waking agent) last sent: replayed as is only when
 *  no session holds the conversation, so there is nothing to resume. */
function lastInputText(missionId: string): string | null {
  const rows = dbApi.listEvents(missionId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type !== 'user') continue;
    try {
      const p = JSON.parse(row.payload) as { message?: { content?: unknown }; origin?: { turn_retry?: unknown } };
      if (p.origin?.turn_retry !== undefined) continue;
      if (typeof p.message?.content === 'string' && p.message.content.trim()) return p.message.content;
    } catch { /* unreadable row: keep looking */ }
  }
  return null;
}

async function runTurnRetry(missionId: string, attempt: number, max: number, cause: string): Promise<void> {
  const state = turnRetries.get(missionId);
  if (!state?.timer) return;
  state.timer = null;
  state.delivering = true;
  try {
    await deliverTurnRetry(missionId, attempt, max, cause);
  } finally {
    state.delivering = false;
  }
}

async function deliverTurnRetry(missionId: string, attempt: number, max: number, cause: string): Promise<void> {
  const m = dbApi.getMission(missionId);
  // Killed or finished meanwhile: whoever closed it already told everyone.
  if (!m || m.status !== 'running') { turnRetries.delete(missionId); return; }
  const resumable = running.has(missionId) || !!m.session_id;
  const text = resumable ? turnRetryPrompt(attempt, max, cause) : lastInputText(missionId);
  if (!text) { abandonTurnRetry(missionId, 'nothing to replay: no session and no input'); return; }
  const origin: UserEventOrigin = { kind: 'system', from: 'orchestrator', mission_id: missionId, turn_retry: attempt };
  try {
    let outcome: SendOutcome = await sendToAgent(missionId, text, undefined, origin);
    if (outcome === 'no_live_process' && await respawnWithResume(missionId, text, undefined, origin)) outcome = 'delivered';
    if (outcome !== 'delivered') abandonTurnRetry(missionId, `the mission could not take the retry (${outcome})`);
  } catch (err) {
    abandonTurnRetry(missionId, (err as Error).message);
  }
}

/** The replay never ran: the turn ends here, on its failure. */
function abandonTurnRetry(missionId: string, reason: string): void {
  cancelTurnRetry(missionId);
  console.warn(`[turn-retry] ${missionId.slice(0, 8)} retry abandoned: ${reason}`);
  const payload = { type: 'turn_retry_abandoned', reason };
  const row = dbApi.insertEvent(missionId, 'turn_retry_abandoned', payload);
  bus.publish({ kind: 'event', missionId, type: 'turn_retry_abandoned', timestamp: row.timestamp, payload });
  bus.publish({ kind: 'turn_complete', missionId, outcome: 'failed' });
}
