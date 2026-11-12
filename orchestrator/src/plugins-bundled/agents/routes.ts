/**
 * Module `@timon/agents` — agents themselves: CRUD, roles, skills, MCP servers,
 * agent files, and the graph that links them all.
 * Tier `core`: without agents, TIMON has nothing to drive.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRole, deleteRole, listRoles, getRole, resetRoleDirectives, updateRole } from '../../agent-roles.js';
import { canonicalAgentName, createEphemeralAgent, deleteAgent, getAgent, restoreAgent, setAgentOrchestrates, teamVisibleAgents, clientTurnState, getTurnState, isAutonomousMission, killRunningForAgent, listAgents, loadConfig, patchAgentConfig, renamedTriggerReason, spawnAgent, upsertAgent } from '../../agent.js';
import { config } from '../../config/load.js';
import { dropTrashedAgentBrowserProfiles, resolveBrowserProfile } from '../../browser-profiles.js';
import { resolveBrowserProject } from '../../browser-project.js';
import { dropTrashedAgentMemory } from '../../agent-memory-trash.js';
import { db, dbApi } from '../../db.js';
import { forbidden, rejectIfDenied, rejectIfNotDaemonToken, rejectUnlessAny, requestHasPermission, viewerFromRequest } from '../../users/identity.js';
import { agentAvatarSchema, applyAgentAvatar } from '../../agent-avatar.js';
import { recordWriteOrigin } from '../../write-origin.js';
import { GLOBAL_INSTRUCTIONS_FILE } from '../../paths.js';
import { GLOBAL_INSTRUCTIONS_MAX_CHARS, readGlobalInstructions, writeGlobalInstructions } from '../../global-instructions.js';
import { agentConfigRefusal, canonicalizePermissionMode, isPrivilegedCaller, overrideAuthority, promptRewriteRefusal, rejectOverride } from '../../users/privileged-overrides.js';
import { scopedDb } from '../../users/scoped-db.js';
import { browseAgentFiles, deleteAgentPath, mkdirAgentPath, moveAgentPath, openAgentFileRaw, openExternalFileRaw, readExternalFile, renameAgentPath, writeAgentFile, writeExternalFile } from '../../files.js';
import { sendMedia } from '../../media-send.js';
import { handleSpawn } from '../../http-helpers.js';
import { defaultExcludedMcpIds, deleteMcp, getMcp, listMcp, missionTransport, redactMcpServer, setMcpOAuth, type McpHttpConfig, type McpStdioConfig, upsertMcp } from '../../mcp.js';
import { buildAuthorizeUrl, discoverOAuth, dynamicRegister, exchangeCode, OAUTH_CALLBACK_PATH, oauthRedirectUri, oauthReturnPath, pkcePair, putPending, randomState, takePending } from '../../oauth.js';
import { apiPort } from '../../api-url.js';
import { agentDir, skillFile } from '../../paths.js';
import { buildInjections } from '../../prompt-injections.js';
import { chooseMainAgent, mainAgentName, mainSeatRemovalRefusal, mainSeatState, renameAgentKeepingSeat } from '../../main-agent.js';
import { missionLiveness, type MissionLiveness } from '../../mission-liveness.js';
import { checkReportsTo } from '../../reports-to.js';
import { orchestratesSchema, mayDelegate } from '../../agent-orchestration.js';
import { delegatingAgent, effectiveOrchestration, UNKNOWN_CALLER } from '../../delegation-guard.js';
import { auditActor, auditRequest } from '../../users/audit-actor.js';
import { agentTrashEnabled, agentTrashRetentionDays, getAgentTrashEntry, isAgentTrashId, listAgentTrash, purgeAgentTrashEntry, readTrashedAgentConfig } from '../../agent-trash.js';
import { listPending as listPendingPermissions } from '../../permissions.js';
import { listAlwaysApprovals, revokeApproval } from '../../approval-rules.js';
import { settingStr } from '../../settings.js';
import {
  defaultImportId, deleteEntryFile, findImportableSkill, importSkill, IMPORTABLE_SOURCES, isImportableId, isManagedPath, listAllSkills,
  planSkillImport, readEntryContent, resolveSkill, SkillImportError, timonSkillPath, writeEntryFile,
} from '../../skill-registry.js';
import { isSystemSkillId, SkillExistsError, upsertSkill } from '../../skills.js';
import { REDACTION_PLACEHOLDER, redactDeep, redactText } from '../../secrets/redact.js';
import { recordBrowserRecordingSkill } from '../../browser-recordings.js';
import {
  conversionMissionOf, isMissionToken, isPlainSkillSegment, mcpHostLabel, mcpWriteRefusal, missionActorLabel, missionBoundToPublicUrls, missionCreatedBy,
  rejectMissionMcpOAuth, skillWriteRefusal,
} from '../../users/skills-mcp-guard.js';
import { AGENT_ICON_URL_PREFIX, isServedIconUrl, readAgentIcon } from '../../uploads.js';
import { registerSkillAttachmentRoutes } from './skill-attachment-routes.js';
import { migrateTrashedAgentSkills } from '../../agent-skills-migration.js';
import { journalMissionSkillRead } from '../../skill-reads.js';
import { listSkillFiles, readSkillFile, SkillFileError } from '../../skill-files.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { apiError } from '../../api-error.js';

/**
 * Aggregate "agents worth showing right now" — derives a single visual
 * state per agent from the current missions table + pending permission
 * map. Used by the chat topbar strip and the agent canvas to render the
 * same colours/animations consistently.
 *
 * Priority (highest wins when an agent has several missions):
 *   needs_action > thinking > done
 *
 * - thinking     : at least one mission running, no pending permissions
 * - needs_action : at least one running mission has a pending permission
 * - idle         : mission running but no turn in progress (conversation open,
 *                  agent waiting)
 * - done         : no running missions but one ended within RECENT_MS
 */
const skillWriteSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9._-]+$/).refine((id) => id !== '.' && id !== '..').optional(),
  path: z.string().min(1).optional(),
  content: z.string().refine((content) => content.trim().length > 0),
  /** Never replace: 409 when the skill already exists. */
  create_only: z.boolean().optional(),
}).refine((body) => Boolean(body.id) !== Boolean(body.path), {
  message: 'Provide either id or path', path: ['id'],
});

/** `?source=&format=` of `GET /api/skills/:id`: the entry of one source, masked or not. */
const skillOriginQuery = z.object({
  source: z.enum(['timon', 'claude-user', 'project', 'plugin']).optional(),
  format: z.enum(['timon', 'claude-skill', 'claude-cmd']).optional(),
}).refine((q) => !q.format || q.source, { message: 'format needs a source' });
/**
 * What a skill read answers (`docs/SECRETS-VAULT.md` §7): a mission token goes to
 * an agent, so a vault value stops here. Any other caller gets the raw text: the
 * editor saves what it loaded, and would overwrite the value with the mask.
 */
function skillReadBody<T>(req: express.Request, body: T): T {
  return isMissionToken(req) ? redactDeep(body) : body;
}

/** A mission read this file masked: its `***` would replace the values for good. */
function overwritesMaskedValue(path: string, content: string): boolean {
  if (!content.includes(REDACTION_PLACEHOLDER) || !isManagedPath(path)) return false;
  try {
    const current = readFileSync(path, 'utf8');
    return redactText(current) !== current;
  } catch {
    return false;
  }
}

/** `?path=` of `GET /api/skills/:id/file`: one string, the guard is `readSkillFile`'s. */
const skillFileQuery = z.object({ path: z.string().min(1).max(512) });

/** `as`: the Timon id the copy takes; absent, the source id with its namespace folded (`plugin:x` → `plugin-x`). */
const skillImportSchema = z.object({
  source: z.enum(IMPORTABLE_SOURCES),
  as: z.string().trim().min(1).max(128).optional(),
}).strict();

/** A stored `icon_url` is a picture this daemon serves; empty/null clears it.
 *  An http(s) address is refused like `file:` or `javascript:`: the window CSP
 *  would never load it (`isServedIconUrl`). A new picture goes through
 *  `PUT /api/agents/:name/avatar`. */
const agentIconUrlSchema = z.union([
  z.null(),
  z.literal(''),
  z.string().refine(isServedIconUrl),
]);
/** Body of `PUT /api/agent-look`. The look's own values are checked by the
 *  config write (`parseAgentLook`), whose refusal names the accepted ones. */
const agentLookRequestSchema = z.object({
  agent: z.string().trim().min(1).max(200).optional(),
  look: z.record(z.string(), z.unknown()).optional(),
  use_mascot: z.boolean().optional(),
}).strict();

const ICON_URL_REFUSAL = 'icon_url must be a picture served by Timon (/api/uploads/…); upload it with PUT /api/agents/:name/avatar';

const RECENT_DONE_MS = 2 * 60 * 1000;
/** Extended window for manually started conversations: their pill is the only
 *  navigation path to the agent from the top bar. At 2 minutes, the pill
 *  disappeared shortly after the agent replied and users had to return to
 *  /agents to find it. Autonomous missions (tasks, cron) keep the short window:
 *  there are many of them and they would overcrowd the strip. */
const RECENT_DONE_CHAT_MS = 30 * 60 * 1000;
type ActiveState = 'thinking' | 'needs_action' | 'done' | 'idle';
const STATE_RANK: Record<ActiveState, number> = {
  needs_action: 4, thinking: 3, idle: 2, done: 1,
};

/** Verifies that an agent config cwd points to a real directory. Prevents an
 *  agent (typically the `_main` LLM) from creating/patching a config with an
 *  invented path (for example `/workspace/projects/foo`): that creates an
 *  agent that crashes immediately on every spawn with ENOENT, without a useful
 *  signal in the UI. Seen in production on 2026-05-21 with agent `assoJS`. */
function validateCwd(cwd: unknown): void {
  if (cwd === undefined || cwd === null || cwd === '') return;
  if (typeof cwd !== 'string') {
    throw new Error('cwd must be a string path');
  }
  if (!existsSync(cwd)) {
    throw new Error(
      `cwd does not exist on the host: "${cwd}". ` +
      `Choose an existing directory on the machine running Timon.`,
    );
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: "${cwd}"`);
  }
}

/** A browser assignment is always checked against the authenticated owner;
 * a mission cannot use the config API to broaden its frozen browser access. */
function validateBrowserAssignment(req: express.Request, name: string, cfg: import('../../agent.js').AgentConfig): void {
  if (cfg.browser_profile_id === undefined) return;
  if (cfg.browser_profile_id !== null && typeof cfg.browser_profile_id !== 'string') throw new Error('browser_profile_id must be a profile id or null');
  if (req.auth?.missionId) {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
    if (!mission?.browser_profile_resolved || cfg.browser_profile_id !== mission.browser_profile_id) throw new Error('a mission cannot change its browser profile assignment');
  }
  resolveBrowserProfile({ ownerUserId: req.auth?.user?.id ?? req.auth?.actorId ?? null,
    agentName: name, project: resolveBrowserProject({ agentProject: cfg.project, agentCwd: cfg.cwd }), selection: cfg.browser_profile_id });
}

/**
 * Graph of mission/task/routine relationships around a root node.
 * BFS up to `depth` (default 3) across:
 *  - mission.parent_mission_id (agent → sub-agent)
 *  - mission.task_id (task → mission spawned by dispatcher)
 *  - mission.forked_from (cross-LLM fork)
 *  - task.routine_id (routine → task)
 *  - task.deps (Kanban dependencies)
 *
 * Returns nodes and edges in the format consumed by dagre on the frontend.
 * Size is limited through `depth` to avoid sending huge graphs from old
 * databases (real-world graphs reach at most hundreds of missions per root).
 */
type GraphNode = {
  id: string;
  kind: 'mission' | 'task' | 'routine';
  label: string;
  status?: string;
  agent?: string;
  startedAt?: number;
};
type GraphEdge = {
  from: string;
  to: string;
  kind: 'spawned' | 'task→mission' | 'routine→task' | 'forked_from' | 'dep' | 'message';
  label?: string;
};

/**
 * Public base URL of the API. Used for the OAuth redirect_uri only when it is
 * https (`oauthRedirectUri`); otherwise the daemon's loopback address is.
 */
function publicApiUrl(): string { return settingStr('TIMON_PUBLIC_API_URL'); }

/** Where to bounce the user back after a successful (or failed) OAuth dance. */
function publicAppUrl(): string { return settingStr('TIMON_PUBLIC_APP_URL'); }

/** Strip a URL down to its origin, returning null on anything malformed. */
function safeOrigin(raw: string): string | null {
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

function callbackPage(opts: { ok: boolean; error?: string; mcpId?: string; returnTo?: string; returnPath?: string }): string {
  const base = opts.returnTo || publicAppUrl();
  const target = `${base}${opts.returnPath ?? '/mcp'}?oauth=${opts.ok ? 'success' : 'error'}` +
    (opts.mcpId ? `&id=${encodeURIComponent(opts.mcpId)}` : '') +
    (opts.error ? `&error=${encodeURIComponent(opts.error.slice(0, 200))}` : '');
  const title = opts.ok ? 'Authorized' : 'Authorization failed';
  const body = opts.ok
    ? `<p>You can close this tab. Returning to TIMON…</p>`
    : `<p>${escapeHtml(opts.error ?? 'unknown error')}</p>`;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:540px;margin:60px auto;padding:0 20px;color:#222}h1{font-size:18px}</style>
<h1>${title}</h1>${body}
<script>
  // Try BroadcastChannel for the parent tab; fall back to a hard redirect.
  try { new BroadcastChannel('timon-mcp-oauth').postMessage(${JSON.stringify({ ok: opts.ok, mcpId: opts.mcpId, error: opts.error })}); } catch(_) {}
  setTimeout(()=>{ location.replace(${JSON.stringify(target)}); }, 600);
</script>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Permissions that open the configuration of an agent for reading. */
const AGENT_READ = ['agents:read', 'agents:manage'] as const;

/** Who a trash entry says deleted the agent: the agent of a mission, the CLI,
 *  or the person's email. Shown in the trash, never used to grant anything. */
function deleterLabel(req: express.Request): string | null {
  const agent = delegatingAgent(req);
  if (agent) return `agent:${agent}`;
  return auditActor(req) ?? req.auth?.user?.email ?? null;
}

/**
 * `reports_to` decides who orchestrates whom, so moving an agent is moving a
 * right. An agent (mission-bound caller) may re-parent only an agent it
 * orchestrates — never itself, or a subordinate could walk out from under its
 * manager — and only under itself or another agent it orchestrates. A human or
 * an operator is not limited. `null` when the change may go ahead.
 */
function reparentRefusal(req: express.Request, target: string, next: string | null): string | null {
  const caller = delegatingAgent(req);
  if (caller === null) return null;
  const current = (() => { try { return loadConfig(target).reports_to ?? null; } catch { return null; } })();
  if ((current ?? '').toLowerCase() === (next ?? '').toLowerCase()) return null;
  const roster = listAgents();
  const main = mainAgentName();
  if (canonicalAgentName(caller) === canonicalAgentName(target)) return 'an agent cannot change its own reporting line';
  if (!mayDelegate(caller, target, roster, main)) return `agent "${caller}" does not orchestrate "${target}"`;
  if (next !== null && !mayDelegate(caller, next, roster, main)) return `agent "${caller}" does not orchestrate "${next}"`;
  return null;
}

/**
 * The team of the agent a mission-bound caller runs, or null. Agents belong to
 * no user: the team is their only boundary, so the trash keeps the one
 * `teamVisibleAgents` draws on the live list — a mission in a team sees and
 * restores the trashed agents of its team only.
 */
function callerTeam(req: express.Request): string | null {
  const missionId = req.auth?.kind === 'api-token' ? req.auth.missionId ?? null : null;
  if (!missionId) return null;
  const mission = scopedDb(viewerFromRequest(req)).getMission(missionId);
  if (!mission) return null;
  try { return loadConfig(mission.agent_name).team ?? null; } catch { return null; }
}

function trashEntryVisible(team: string | null, id: string): boolean {
  if (team === null) return true;
  return readTrashedAgentConfig(id)?.team === team;
}

/**
 * A restore recreates an agent, so it obeys what creating it would (TODO #527):
 * the trashed config is judged as a NEW agent's (`agentConfigRefusal` with no
 * current config) — tools, MCP servers, permission level, backend, directory —
 * and the delegation rights it carries obey the rules of the routes that write
 * them: `orchestrates` is never an agent's to set, the `orchestrator` flag is
 * the operator's alone. Without this, deleting an agent then restoring it
 * handed `agents:manage` the config `agents:privileged-config` guards.
 */
function trashRestoreRefusal(req: express.Request, cfg: Record<string, unknown> | null): string | null {
  const privileged = isPrivilegedCaller(req);
  if (cfg === null) return privileged ? null : 'the trashed agent\'s config cannot be read: only an operator may restore it';
  const orchestrates = cfg.orchestrates;
  const delegates = orchestrates !== undefined && orchestrates !== null && !(Array.isArray(orchestrates) && orchestrates.length === 0);
  if (delegatingAgent(req) !== null && (delegates || cfg.orchestrator === true)) {
    return 'the trashed agent holds delegation rights (orchestrates / orchestrator): an agent cannot restore it, a person must';
  }
  if (privileged) return null;
  if (cfg.orchestrator === true) return 'the trashed agent is flagged orchestrator: only an operator may restore it';
  return agentConfigRefusal(cfg, null, overrideAuthority(req));
}

function withEffectiveOrchestration<T extends object>(
  agent: T,
  effective: { orchestrates: string[] | '*'; source: string } | undefined,
): T & { effective_orchestrates: string[] | '*'; orchestrates_source: string } {
  return {
    ...agent,
    effective_orchestrates: effective?.orchestrates ?? [],
    orchestrates_source: effective?.source ?? 'reports_to',
  };
}

/**
 * Whose mission an ephemeral agent runs. The mission it was spawned for when
 * the caller names one: an unowned mission gets a token with no permission at
 * all, so a helper spawned for a user's mission could not call the API it was
 * created to use. Otherwise the requesting account, as for any spawn.
 */
export function ephemeralOwner(req: Pick<express.Request, 'auth'>, sourceMeta: unknown): string | null {
  const parent = sourceMeta && typeof sourceMeta === 'object'
    ? (sourceMeta as Record<string, unknown>).parent_mission_id
    : undefined;
  if (typeof parent === 'string' && parent) {
    // Through the caller's scope: a mission it cannot see lends it no owner.
    const mission = scopedDb(viewerFromRequest(req)).getMission(parent);
    if (mission) return mission.owner_user_id ?? null;
  }
  return req.auth?.user?.id ?? null;
}

export function registerRoutes(app: express.IRouter): void {
  // The writer of an agent, for the `agent_*` events its write causes.
  app.use('/api/agents', recordWriteOrigin);
  app.post('/api/agents/spawn', handleSpawn);

  // SECU-USERS U-2: the list feeds every picker, so it stays open — but
  // without `agents:read` it carries identity only (name, backend, project,
  // look). The working directory, tools, MCP servers and directives are
  // configuration, read behind the permission like the detail route.
  app.get('/api/agents', (req, res) => {
    const agents = teamVisibleAgents(
      listAgents(),
      req.auth?.kind === 'api-token' ? req.auth.missionId ?? null : null,
    );
    // `main` names the agent one talks to, whatever it was called at
    // onboarding: the UI used to guess it from the literal `_main`, and a
    // second hand-made orchestrator took its place on the Company canvas.
    // `main_seat` says when nobody holds the seat, and who may take it: with
    // every `main` false, the UI could only guess (TIM-0142).
    const seat = mainSeatState();
    const main = seat.holder;
    const main_seat = { holder: seat.holder, empty: seat.empty, candidates: seat.candidates };
    if (!req.auth || AGENT_READ.some((permission) => requestHasPermission(req, permission))) {
      const effective = effectiveOrchestration();
      res.json({ agents: agents.map((a) => ({ ...withEffectiveOrchestration(a, effective.get(a.name)), main: a.name === main })), main_seat });
      return;
    }
    res.json({
      main_seat,
      agents: agents.map((a) => ({
        name: a.name, backend: a.backend, model: a.model, project: a.project, reports_to: a.reports_to, team: a.team,
        ephemeral: a.ephemeral, orchestrator: a.orchestrator, has_system_prompt: a.has_system_prompt,
        emoji: a.emoji, color: a.color, icon_url: a.icon_url, role: a.role, role_emoji: a.role_emoji,
        main: a.name === main,
      })),
    });
  });

  // `/api/agent-roles` and not `/api/roles`: the latter was the core's
  // permission roles (superadmin-only), now the Multi-user plugin's. Both used to be
  // registered on the same path, and Express kept whichever module loaded
  // first — see audit #8 and the claim guard in `kernel/http-service.ts`.
  const customRoleSchema = z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    label: z.string().trim().min(1),
    iconName: z.string(),
    iconSvg: z.string().trim().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    default_directives: z.string().optional(),
    default_model: z.string().optional(),
    default_permission_mode: z.string().optional(),
  }).strict();
  const builtinPromptSchema = z.union([
    z.object({ default_directives: z.string() }).strict(),
    z.object({ reset_directives: z.literal(true) }).strict(),
  ]);
  const authorizeRoles = (req: express.Request, res: express.Response, write = false): boolean => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return write ? !rejectIfDenied(req, res, 'agents:manage')
      : !rejectUnlessAny(req, res, ['agents:read', 'agents:manage']);
  };

  app.get('/api/agent-roles', (req, res) => {
    if (!authorizeRoles(req, res)) return;
    res.json({ roles: listRoles() });
  });

  app.post('/api/agent-roles', (req, res) => {
    if (!authorizeRoles(req, res, true)) return;
    const parsed = customRoleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid role' }); return; }
    try {
      res.status(201).json(createRole(parsed.data));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/agent-roles/:id', (req, res) => {
    if (!authorizeRoles(req, res, true)) return;
    try {
      const schema = getRole(req.params.id)?.builtin ? builtinPromptSchema : customRoleSchema.partial();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid role update' }); return; }
      res.json('reset_directives' in parsed.data
        ? resetRoleDirectives(req.params.id)
        : updateRole(req.params.id, parsed.data));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/agent-roles/:id', (req, res) => {
    if (!authorizeRoles(req, res, true)) return;
    try {
      deleteRole(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /* ── teams ──────────────────────────────────────────────────────────────
   * Teams group project-less bots and decide who they may talk to (see
   * `sendAgentMessage`). They live next to the agent routes because a team is
   * nothing but a label on agents: the membership is a field of the agent's
   * own config.json, written through the SAME path as any other config field.
   */
  const TeamBody = z.object({
    name: z.string().min(1).max(160),
    color: z.string().max(64).nullish(),
  }).strict();
  const TeamPatch = z.object({
    name: z.string().min(1).max(160).optional(),
    color: z.string().max(64).nullish(),
  }).strict();
  const MemberBody = z.object({ agent: z.string().min(1).max(200) }).strict();

  app.get('/api/teams', (req, res) => {
    res.json({ teams: dbApi.listTeams(viewerFromRequest(req)) });
  });

  app.post('/api/teams', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const parsed = TeamBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'name required (1-160 chars), optional color' });
      return;
    }
    const viewer = viewerFromRequest(req);
    res.status(201).json(dbApi.createTeam(`tm-${randomUUID()}`, parsed.data.name.trim(), {
      color: parsed.data.color ?? null,
      ownerUserId: viewer?.id ?? null,
    }));
  });

  app.patch('/api/teams/:id', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const parsed = TeamPatch.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'expected name and/or color' });
      return;
    }
    const next = dbApi.updateTeam(req.params.id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
      ...('color' in (req.body ?? {}) ? { color: parsed.data.color ?? null } : {}),
    }, viewerFromRequest(req));
    if (!next) {
      res.status(404).json(apiError('team_not_found', 'team not found'));
      return;
    }
    res.json(next);
  });

  // Deleting a team deletes no agent: its members are put back outside any
  // team, which is the historical, unrestricted behaviour.
  app.delete('/api/teams/:id', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const viewer = viewerFromRequest(req);
    if (!dbApi.getTeam(req.params.id, viewer)) {
      res.status(404).json(apiError('team_not_found', 'team not found'));
      return;
    }
    let freed = 0;
    for (const agent of listAgents()) {
      if (agent.team !== req.params.id) continue;
      patchAgentConfig(agent.name, { team: null });
      freed += 1;
    }
    dbApi.deleteTeam(req.params.id, viewer);
    res.json({ ok: true, freed });
  });

  app.post('/api/teams/:id/members', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const parsed = MemberBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'agent required' });
      return;
    }
    if (!dbApi.getTeam(req.params.id, viewerFromRequest(req))) {
      res.status(404).json(apiError('team_not_found', 'team not found'));
      return;
    }
    try {
      res.json(patchAgentConfig(parsed.data.agent, { team: req.params.id }));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/teams/:id/members/:name', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (!dbApi.getTeam(req.params.id, viewerFromRequest(req))) {
      res.status(404).json(apiError('team_not_found', 'team not found'));
      return;
    }
    try {
      res.json(patchAgentConfig(req.params.name, { team: null }));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/active', (req, res) => {
    const now = Date.now();
    const scoped = scopedDb(viewerFromRequest(req));
    const missions = scoped.listActiveMissions(
      now - Math.max(RECENT_DONE_MS, RECENT_DONE_CHAT_MS),
    );
    const pending = listPendingPermissions();
    const pendingByMission = new Set(pending.map((p) => p.mission_id));

    type Entry = {
      name: string;
      state: ActiveState;
      mission_id: string;
      /** Latest mission start, for tie-break / "since" rendering. */
      at: number;
      /** When that mission started. `at` moves with every turn; this does not,
       *  so the strip can tell a mission begun after a tab was closed from one
       *  that was already there (several missions of one agent take turns
       *  being the one shown here). */
      started_at: number;
      /** Pending permission count when state === 'needs_action'. */
      pending_count: number;
      /** Fine state of that mission (mission-liveness.ts): `state` cannot tell a
       *  finished turn from a mission that was cut. */
      liveness: MissionLiveness;
      interrupted_reason: string | null;
      pending_messages: number;
      open_deliveries: number;
    };
    const fineOf = (m: { id: string; agent_name: string; status: string }, turn: ReturnType<typeof getTurnState>) => {
      const reason = scoped.getMission(m.id)?.interrupted_reason ?? null;
      const view = clientTurnState(m.id, m.status === 'running' && dbApi.missionTurnEnded(m.id));
      const fine = missionLiveness({
        status: m.status, process_alive: turn !== null, turn_active: view.turnActive,
        turn_complete: view.turnComplete, interrupted_reason: reason,
      });
      return {
        liveness: fine.liveness,
        interrupted_reason: fine.interrupted_reason,
        ...dbApi.missionPendingWork(m.id, m.agent_name, m.status),
      };
    };
    const byAgent = new Map<string, Entry>();
    const bump = (name: string, candidate: Entry) => {
      const cur = byAgent.get(name);
      if (!cur || STATE_RANK[candidate.state] > STATE_RANK[cur.state]) {
        byAgent.set(name, candidate);
      } else if (
        STATE_RANK[candidate.state] === STATE_RANK[cur.state] &&
        candidate.at > cur.at
      ) {
        byAgent.set(name, candidate);
      }
    };

    for (const m of missions) {
      if (m.status === 'running') {
        const pendingForMission = pending.filter((p) => p.mission_id === m.id);
        const hasPending = pendingByMission.has(m.id);
        // 'running' in the DB only means the process is alive — for
        // persistent backends (claude) it stays running between turns.
        // The actual "is claude working right now" bit lives in memory.
        const turn = getTurnState(m.id);
        // A replay Timon still owes is work in progress (TODO #666).
        const isWorking = clientTurnState(m.id, false).turnActive;
        const state: ActiveState = hasPending
          ? 'needs_action'
          : isWorking
            ? 'thinking'
            : 'idle';
        bump(m.agent_name, {
          name: m.agent_name,
          state,
          mission_id: m.id,
          // For mid-turn: count from the turn's start so the strip's
          // elapsed timer reflects "this turn's age". For idle: count
          // from when the last turn ended (or mission start as fallback).
          at: turn?.turnSince ?? m.started_at,
          started_at: m.started_at,
          pending_count: pendingForMission.length,
          ...fineOf(m, turn),
        });
      } else if (
        m.ended_at &&
        now - m.ended_at <=
          (isAutonomousMission(m) ? RECENT_DONE_MS : RECENT_DONE_CHAT_MS)
      ) {
        bump(m.agent_name, {
          name: m.agent_name,
          state: 'done',
          mission_id: m.id,
          at: m.ended_at,
          started_at: m.started_at,
          pending_count: 0,
          ...fineOf(m, null),
        });
      }
    }

    // Surface the agent's project too (UI may want to colour-group). Cheap
    // join: getAgent is a JSON-file read.
    const out = [...byAgent.values()]
      .map((e) => {
        const a = getAgent(e.name);
        return {
          ...e,
          project: a?.project ?? null,
          emoji: a?.emoji ?? null,
          color: a?.color ?? null,
          icon_url: a?.icon_url ?? null,
          role: a?.role ?? null,
          role_emoji: a?.role_emoji ?? null,
        };
      })
      .sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || b.at - a.at);
    res.json({ agents: out, computed_at: now });
  });

  app.get('/api/agents/:name', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const a = getAgent(req.params.name);
    if (!a) {
      res.status(404).json(apiError('agent_not_found', 'agent not found'));
      return;
    }
    res.json(withEffectiveOrchestration(a, effectiveOrchestration([a.name]).get(a.name)));
  });

  // The "always" approvals a human gave this agent from a permission card
  // (`approval-rules.ts`). Each person sees and revokes their own; the
  // operator's daemon token sees every owner's. An agent reads none: what it
  // was let do without asking is not its to inspect, nor to take back.
  const approvalIdSchema = z.string().min(1).max(128);
  const approvalOwner = (req: express.Request, res: express.Response): { owner: string | null } | null => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
    if (delegatingAgent(req) !== null) {
      forbidden(req, res, { kind: 'operator', reason: "an agent cannot read or revoke its own approvals" });
      return null;
    }
    if (req.auth.kind === 'daemon-token') return { owner: null };
    if (!req.auth.user) { res.status(401).json({ error: 'unauthorized' }); return null; }
    return { owner: req.auth.user.id };
  };
  const approvalAgent = (req: express.Request, res: express.Response): string | null => {
    try {
      const agent = getAgent(canonicalAgentName(typeof req.params.name === 'string' ? req.params.name : ''));
      if (agent) return agent.name;
    } catch { /* an invalid name is an unknown agent */ }
    res.status(404).json(apiError('agent_not_found', 'agent not found'));
    return null;
  };
  app.get('/api/agents/:name/approvals', (req, res) => {
    const who = approvalOwner(req, res);
    if (!who) return;
    const name = approvalAgent(req, res);
    if (!name) return;
    res.json({ approvals: listAlwaysApprovals(name, who.owner) });
  });
  app.delete('/api/agents/:name/approvals/:id', (req, res) => {
    const who = approvalOwner(req, res);
    if (!who) return;
    const name = approvalAgent(req, res);
    if (!name) return;
    const id = approvalIdSchema.safeParse(req.params.id);
    // Someone else's rule answers like a missing one: its existence is theirs.
    if (!id.success || !revokeApproval(id.data, name, who.owner)) {
      res.status(404).json({ error: 'approval not found' });
      return;
    }
    auditRequest(req, 'approval.revoke', `${name} ${id.data}`);
    res.json({ ok: true });
  });

  // The delegation list is a right, not a preference: only an operator writes
  // it. A mission-bound caller is an agent, and an agent that could edit this
  // would grant itself the run of the fleet (`orchestrates` is a protected key
  // for the same reason). `null` puts the agent back on the derived default.
  app.put('/api/agents/:name/orchestrates', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (delegatingAgent(req) !== null) {
      auditRequest(req, 'orchestration.write_denied', req.params.name);
      forbidden(req, res, { kind: 'operator', reason: 'an agent cannot change who orchestrates whom' });
      return;
    }
    const name = canonicalAgentName(req.params.name);
    if (!getAgent(name)) {
      res.status(404).json(apiError('agent_not_found', 'agent not found'));
      return;
    }
    const value = (req.body ?? {}) as { orchestrates?: unknown };
    if (!('orchestrates' in value)) {
      res.status(400).json({ error: 'orchestrates required: a list of agent names, "*", or null' });
      return;
    }
    let next: string[] | '*' | undefined;
    if (value.orchestrates !== null) {
      const parsed = orchestratesSchema.safeParse(value.orchestrates);
      if (!parsed.success) {
        res.status(400).json({ error: 'orchestrates must be a list of agent names, "*", or null' });
        return;
      }
      if (parsed.data !== '*') {
        const unknown = parsed.data.filter((n) => !getAgent(canonicalAgentName(n)));
        if (unknown.length) {
          res.status(400).json({ error: `orchestrates: unknown agent(s) ${unknown.join(', ')}` });
          return;
        }
        next = [...new Set(parsed.data.map((n) => canonicalAgentName(n)))].filter((n) => n !== name);
      } else next = '*';
    }
    setAgentOrchestrates(name, next);
    auditRequest(req, 'orchestration.write', `${name} → ${next === undefined ? 'default' : JSON.stringify(next)}`);
    const a = getAgent(name)!;
    res.json(withEffectiveOrchestration(a, effectiveOrchestration([a.name]).get(a.name)));
  });

  // Everything injected into the agent at spawn, in order, as the spawn itself
  // assembles it. Read-only; the blocks name the real source to edit. It
  // exposes memory rules and project files, so an anonymous caller is refused
  // outright rather than left to the first-run open API.
  const injectionsQuery = z.object({ mission_text: z.string().max(4000).optional(), mission_id: z.string().max(128).optional() }).strict();
  app.get('/api/agents/:name/injections', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const query = injectionsQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'Invalid query' }); return; }
    if (!getAgent(req.params.name)) { res.status(404).json(apiError('agent_not_found', 'agent not found')); return; }
    try {
      // A mission of THIS agent only, and only one the caller may see.
      const mission = query.data.mission_id
        ? scopedDb(viewerFromRequest(req)).getMission(query.data.mission_id)
        : undefined;
      const overrides = mission && mission.agent_name.toLowerCase() === req.params.name.toLowerCase() ? mission : null;
      res.json(buildInjections(req.params.name, query.data.mission_text ?? '', overrides));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // The user's global instructions: one file, sent to every agent. Reading it
  // needs the same right as reading an agent; WRITING it changes the prompt of
  // every agent of the install, so it is the operator's alone (a viewer with
  // `agents:manage` cannot rewrite what the others are told), and an anonymous
  // caller is refused whether or not auth is required.
  app.get('/api/global-instructions', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    res.json({ content: readGlobalInstructions(), path: GLOBAL_INSTRUCTIONS_FILE, max_chars: GLOBAL_INSTRUCTIONS_MAX_CHARS });
  });

  app.put('/api/global-instructions', express.text({ type: '*/*', limit: '256kb' }), (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (!isPrivilegedCaller(req)) {
      rejectOverride(req, res, 'global_instructions.write_denied', 'global-instructions', 'only the operator may change the instructions sent to every agent');
      return;
    }
    const text = typeof req.body === 'string' ? req.body : '';
    try {
      writeGlobalInstructions(text);
      res.json({ ok: true, chars: text.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // A rename rewrites every reference to an agent across the install: refused
  // to an anonymous caller even on the first-run loopback, where
  // `rejectIfDenied` alone would let it through.
  app.post('/api/agents/:name/rename', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const body = req.body as { newName?: string; name?: string };
    const newName = (body.newName ?? body.name ?? '').trim();
    if (!newName) {
      res.status(400).json({ error: 'newName required' });
      return;
    }
    try {
      const r = renameAgentKeepingSeat(req.params.name, newName);
      if (!r.ok) {
        res.status(409).json({ error: r.error });
        return;
      }
      // Same rule as the triggers API: another account's trigger stays unnamed
      // here, even to a caller allowed to rename the agent. Its owner is notified.
      const me = req.auth.user?.id ?? null;
      const toCheck = (r.triggersToCheck ?? []).filter((t) => req.auth?.isSuperadmin || (me !== null && t.owner_user_id === me));
      const reason = renamedTriggerReason(req.params.name, newName);
      res.json({
        ok: true,
        name: newName,
        ...(r.warnings?.length ? { warnings: r.warnings } : {}),
        ...(toCheck.length ? { triggers_to_check: toCheck.map((t) => ({ id: t.id, name: t.name, reason })) } : {}),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/agents', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const body = req.body as {
      name?: string;
      system_prompt?: string;
      config?: import('../../agent.js').AgentConfig;
    };
    if (!body.name || typeof body.system_prompt !== 'string') {
      res.status(400).json({ error: 'name and system_prompt required' });
      return;
    }
    // The agent editor saves through here: same rule as the config PATCH.
    if (body.config && 'icon_url' in body.config && !agentIconUrlSchema.safeParse(body.config.icon_url).success) {
      res.status(400).json({ error: ICON_URL_REFUSAL });
      return;
    }
    try {
      validateCwd(body.config?.cwd);
      validateBrowserAssignment(req, body.name, body.config ?? {});
      if (body.config && 'reports_to' in body.config) {
        body.config.reports_to = checkReportsTo(body.name, body.config.reports_to);
        // A brand-new agent has nobody above it to rob; an existing one is
        // re-parented only within the caller's own delegation list.
        if (existsSync(agentDir(body.name))) {
          const refusal = reparentRefusal(req, body.name, body.config.reports_to);
          if (refusal) { rejectOverride(req, res, 'agent.reparent_denied', `agent:${body.name}`, refusal); return; }
        }
      }
      // secu-4: `agents:manage` says WHO may write an agent, not WHAT they may
      // put in it. A non-superadmin neither points an agent at an arbitrary
      // directory nor pre-allocates tools/MCP servers beyond what the agent
      // already declares — that config is what the CLI runs under the user's OS
      // account.
      if (!isPrivilegedCaller(req)) {
        const current = existsSync(agentDir(body.name))
          ? (() => { try { return loadConfig(body.name!); } catch { return null; } })()
          : null;
        const refusal = agentConfigRefusal(
          (body.config ?? {}) as Record<string, unknown>,
          current,
          overrideAuthority(req),
        );
        if (refusal) {
          rejectOverride(req, res, 'agent.config_denied', `agent:${body.name}`, refusal);
          return;
        }
        // An existing agent's prompt is an instruction, but it rides the same
        // privileges the agent was granted: a caller below the target's level,
        // or one that does not orchestrate it, must not rewrite what the
        // target will run as (secu-4, point 2 bis).
        if (current !== null) {
          const promptRefusal = promptRewriteRefusal(req, body.name);
          if (promptRefusal) {
            rejectOverride(req, res, 'agent.prompt_rewrite_denied', `agent:${body.name}`, promptRefusal);
            return;
          }
        }
        // What is stored is read by whichever dialect runs the agent: keep the
        // name they all understand (`canonicalPermissionMode`).
        if (body.config) canonicalizePermissionMode(body.config as Record<string, unknown>, 'permission_mode', current?.permission_mode);
      }
      // Default-deny external MCPs on FRESH agent creation. The user told us
      // they prefer to enable connectors one by one (each external MCP loads
      // its entire tool catalog into every turn → wasted tokens). We only
      // apply the default when:
      //   - the agent doesn't already exist (otherwise we'd clobber a
      //     curated set on save), AND
      //   - the caller didn't explicitly send excluded_mcp_servers
      //     (otherwise we override their explicit choice).
      const isFreshCreation = !existsSync(agentDir(body.name));
      const cfg = { ...(body.config ?? {}) } as import('../../agent.js').AgentConfig;
      if (isFreshCreation && !('excluded_mcp_servers' in (body.config ?? {}))) {
        cfg.excluded_mcp_servers = defaultExcludedMcpIds();
      }
      const agent = upsertAgent({
        name: body.name,
        system_prompt: body.system_prompt,
        config: cfg,
      });
      // After an explicit Save through the agent editor, kill any
      // currently-running process for that agent so the next user turn
      // re-spawns with the updated args (model, permission_mode, skills,
      // MCP set, …). The session_id is preserved on the mission row, so
      // --resume restores the conversation context against the new
      // command line. PATCH /api/agents/:name/config already does this
      // for partial updates; the POST path used to skip it which is why
      // changing the model mid-chat didn't take effect.
      const killed = killRunningForAgent(body.name);
      res.json({ ...agent, _killed: killed });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Ephemeral spawn: daemon-token only. `X-TIMON-Agent` is spoofable and is
  // not identity. The agent is purged with the mission (see
  // `disposeEphemeralAgentIfDone`).
  app.post('/api/agents/ephemeral', async (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (rejectIfNotDaemonToken(req, res)) return;
    const body = req.body as {
      mission?: string;
      system_prompt?: string;
      hint?: string;
      config?: import('../../agent.js').AgentConfig;
      source_channel?: string;
      source_meta?: unknown;
      trace_id?: string;
    };
    if (!body.mission || !body.system_prompt) {
      res.status(400).json({ error: 'mission and system_prompt required' });
      return;
    }
    try {
      if (body.config?.cwd) validateCwd(body.config.cwd);
      const agent = createEphemeralAgent({
        system_prompt: body.system_prompt,
        hint: body.hint,
        config: body.config,
      });
      const source = body.source_channel
        ? { channel: body.source_channel, meta: body.source_meta }
        : { channel: 'agent', meta: body.source_meta };
      const missionId = await spawnAgent(agent.name, body.mission, source, {
        traceId: body.trace_id ?? null,
        ownerUserId: ephemeralOwner(req, body.source_meta),
      });
      if (source.meta && typeof source.meta === 'object') {
        const meta = source.meta as Record<string, unknown>;
        const lineage = {
          parentMissionId: typeof meta.parent_mission_id === 'string' ? meta.parent_mission_id : null,
          parentAgent: typeof meta.parent_agent === 'string' ? meta.parent_agent : null,
          taskId: typeof meta.task_id === 'string' ? meta.task_id : null,
          routineId: typeof meta.routine_id === 'string' ? meta.routine_id : null,
        };
        if (lineage.parentMissionId || lineage.taskId || lineage.routineId || lineage.parentAgent) {
          dbApi.setMissionLineage(missionId, lineage);
        }
      }
      res.status(201).json({ agent_name: agent.name, mission_id: missionId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Who receives the wake recaps and notifications. A human decision: an agent
  // calling this route (X-TIMON-Agent is spoofable but a mission token is not)
  // could otherwise re-seat the orchestrator under itself.
  app.put('/api/agents/main', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (delegatingAgent(req) !== null) {
      forbidden(req, res, { kind: 'operator', reason: 'only a human may designate the main orchestrator' });
      return;
    }
    const parsed = z.object({ name: z.string().min(1).max(128) }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const out = chooseMainAgent(parsed.data.name);
    if (!out.ok) {
      res.status(400).json({ error: out.error });
      return;
    }
    res.json({ ok: true, main: out.name });
  });

  app.delete('/api/agents/:name', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const seatRefusal = mainSeatRemovalRefusal(req.params.name);
    if (seatRefusal) {
      res.status(409).json({ error: seatRefusal });
      return;
    }
    try {
      const ok = deleteAgent(req.params.name, { deletedBy: deleterLabel(req) });
      if (!ok) {
        res.status(404).json(apiError('agent_not_found', 'agent not found'));
        return;
      }
      // The entry a "restore" would act on, when the agent went to the trash.
      const trashed = listAgentTrash().find((e) => e.name === req.params.name) ?? null;
      res.json({ ok: true, trash_id: trashed?.id ?? null });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Trash of deleted agents (TODO #476). It holds whole agents — prompts,
  // identity docs, memory — so an anonymous caller is refused outright, even
  // on the first-run loopback where `rejectIfDenied` alone would let it in.
  app.get('/api/agent-trash', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const team = callerTeam(req);
    const entries = listAgentTrash().filter((e) => trashEntryVisible(team, e.id));
    res.json({ enabled: agentTrashEnabled(), retention_days: agentTrashRetentionDays(), entries });
  });

  app.post('/api/agent-trash/:id/restore', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (!isAgentTrashId(req.params.id) || !getAgentTrashEntry(req.params.id)) { res.status(404).json(apiError('not_found', 'not found')); return; }
    if (!trashEntryVisible(callerTeam(req), req.params.id)) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const refusal = trashRestoreRefusal(req, readTrashedAgentConfig(req.params.id));
    if (refusal) {
      rejectOverride(req, res, 'agent.trash.restore_denied', req.params.id, refusal);
      return;
    }
    try {
      const out = restoreAgent(req.params.id);
      if (!out.ok) {
        res.status(out.code === 'conflict' ? 409 : 404).json({ error: out.error });
        return;
      }
      auditRequest(req, 'agent.trash.restore', `${out.entry.id} → ${out.entry.name}`);
      res.json({ ok: true, name: out.entry.name, agent: getAgent(out.entry.name) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Purging is final: a person's gesture, never a mission's (the automatic
  // purge follows the retention the user set).
  app.delete('/api/agent-trash/:id', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (delegatingAgent(req) !== null) {
      forbidden(req, res, { kind: 'operator', reason: 'only a person may empty the trash for good' });
      return;
    }
    if (!isAgentTrashId(req.params.id)) { res.status(404).json(apiError('not_found', 'not found')); return; }
    try {
      // Same as the automatic sweep: an entry from before TODO #623 takes its
      // skill attachments out of the table before it goes.
      migrateTrashedAgentSkills();
      if (!purgeAgentTrashEntry(req.params.id)) { res.status(404).json(apiError('not_found', 'not found')); return; }
      // The agent's parked browser profiles, and their signed-in sessions, go with it (TODO #668).
      dropTrashedAgentBrowserProfiles(req.params.id);
      // And its parked memory (TODO #670).
      dropTrashedAgentMemory(req.params.id);
      auditRequest(req, 'agent.trash.purge', req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/agents/:name/config', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Allow-list the patchable fields to keep arbitrary payloads from
      // sneaking unexpected keys into config.json.
      const allowed: (keyof import('../../agent.js').AgentConfig)[] = [
        'backend', 'cwd', 'model', 'permission_mode',
        'allowed_tools', 'disallowed_tools',
        'skills', 'mcp_servers', 'excluded_mcp_servers', 'project',
        'emoji', 'color', 'icon_url', 'look', 'avatar',
        'role', 'directives', 'global_context', 'browser_profile_id',
        'team', 'reports_to', 'memory_scope',
      ];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) {
        if (k in body) patch[k] = body[k];
      }
      // `timon agent set-scope` and agent_set_scope send this; it used to be
      // dropped here, so the scope never changed.
      if ('memory_scope' in patch && !['NONE', 'SESSION', 'AGENT', 'GLOBAL'].includes(patch.memory_scope as string)) {
        res.status(400).json({ error: 'memory_scope must be NONE, SESSION, AGENT or GLOBAL' });
        return;
      }
      if ('reports_to' in patch) {
        patch.reports_to = checkReportsTo(req.params.name, patch.reports_to);
        const refusal = reparentRefusal(req, req.params.name, patch.reports_to as string | null);
        if (refusal) { rejectOverride(req, res, 'agent.reparent_denied', `agent:${req.params.name}`, refusal); return; }
      }
      if ('icon_url' in patch) {
        const icon = agentIconUrlSchema.safeParse(patch.icon_url);
        if (!icon.success) { res.status(400).json({ error: ICON_URL_REFUSAL }); return; }
      }
      if ('cwd' in patch) validateCwd(patch.cwd);
      if ('browser_profile_id' in patch || 'project' in patch || 'cwd' in patch) validateBrowserAssignment(req, req.params.name, { ...loadConfig(req.params.name), ...patch });
      // secu-4: same rule as the creation path — a non-superadmin may only
      // narrow what an admin granted to this agent.
      if (!isPrivilegedCaller(req)) {
        const current = (() => {
          try { return loadConfig(req.params.name); } catch { return null; }
        })();
        const refusal = agentConfigRefusal(patch, current, overrideAuthority(req));
        if (refusal) {
          rejectOverride(req, res, 'agent.config_denied', `agent:${req.params.name}`, refusal);
          return;
        }
        canonicalizePermissionMode(patch, 'permission_mode', current?.permission_mode);
        // `directives` and `global_context` feed the prompt at spawn, so they
        // obey the same rewrite guard as `system_prompt` (secu-4, point 2 bis).
        // `skills` writes the agent's own skill attachments: the same guard as
        // `skill_attach` on the agent scope (skill-attachment-routes.ts).
        if ('directives' in patch || 'global_context' in patch || 'skills' in patch) {
          const promptRefusal = promptRewriteRefusal(req, req.params.name);
          if (promptRefusal) {
            rejectOverride(req, res, 'agent.prompt_rewrite_denied', `agent:${req.params.name}`, promptRefusal);
            return;
          }
        }
      }
      const next = patchAgentConfig(req.params.name, patch);
      // Skills, MCP servers and allowed_tools all affect how claude is spawned
      // (--append-system-prompt content, --mcp-config, --allowedTools). The
      // running process was started with the old values, so kill it to force
      // a respawn with the updated config on the next user turn. The claude
      // session_id survives in the DB, so --resume preserves history.
      const respawnTriggers = [
        'skills', 'mcp_servers', 'excluded_mcp_servers',
        'allowed_tools', 'disallowed_tools', 'model', 'permission_mode',
        'role', 'directives', 'browser_profile_id', 'memory_scope',
      ] as const;
      const needsRespawn = respawnTriggers.some((k) => k in patch);
      let killed = 0;
      if (needsRespawn) killed = killRunningForAgent(req.params.name);
      res.json({ ...next, _killed: killed });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('agent not found')) {
        res.status(404).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // Sets or removes an agent's profile picture. Same right as the config PATCH
  // (`agents:manage`): who may reconfigure an agent may re-skin it.
  app.put('/api/agents/:name/avatar', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const parsed = agentAvatarSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { clear: true } or { dataUrl } or { mime, data } (png, jpeg, webp, gif)' });
      return;
    }
    try {
      const done = applyAgentAvatar(req.params.name, parsed.data);
      if (!done) {
        res.status(404).json(apiError('agent_not_found', 'agent not found'));
        return;
      }
      res.json({ ok: true, name: done.name, icon_url: done.icon_url });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // `agent_set_look`: an agent changes its own head, or the head of an agent it
  // orchestrates. A mission-token door only — a person or the CLI has the
  // config PATCH. Cosmetic, so it is narrower than that PATCH, never wider:
  // another agent is refused even when the launching account holds
  // `agents:manage` (that is `agent_update`'s job).
  app.put('/api/agent-look', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const caller = delegatingAgent(req);
    if (caller === null) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'agent_set_look changes the look of the agent running the calling mission; it takes a mission token',
        hint: 'From the app or the CLI, set `look` / `avatar` with PATCH /api/agents/:name/config (timon agent update).',
      });
      return;
    }
    const parsed = agentLookRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { look: { shape, color, eyes, acc? }, use_mascot?: boolean, agent?: string } (look or use_mascot: true)' });
      return;
    }
    const { look, use_mascot: useMascot } = parsed.data;
    if (look === undefined && useMascot !== true) {
      res.status(400).json({ error: 'nothing to change: pass look, or use_mascot: true' });
      return;
    }
    const target = parsed.data.agent ?? caller;
    const roster = listAgents();
    if (caller === UNKNOWN_CALLER || !mayDelegate(caller, target, roster, mainAgentName())) {
      auditRequest(req, 'agent.look_denied', `${caller === UNKNOWN_CALLER ? 'unknown' : caller} → ${target}`);
      forbidden(req, res, {
        kind: 'scope',
        reason: caller === UNKNOWN_CALLER
          ? `this mission does not orchestrate "${target}"`
          : `agent "${caller}" does not orchestrate "${target}": agent_set_look only changes your own look or the look of an agent you orchestrate`,
        hint: 'Leave `agent` out to change your own look; for another agent, an operator uses agent_update look.',
      });
      return;
    }
    let name: string;
    try {
      const found = getAgent(canonicalAgentName(target));
      if (!found) { res.status(404).json(apiError('agent_not_found', 'agent not found')); return; }
      name = found.name;
    } catch {
      res.status(404).json(apiError('agent_not_found', 'agent not found'));
      return;
    }
    try {
      const patch: Partial<import('../../agent.js').AgentConfig> = {};
      if (look !== undefined) (patch as Record<string, unknown>).look = look;
      if (useMascot === true) patch.avatar = 'mascot';
      const next = patchAgentConfig(name, patch);
      auditRequest(req, 'agent.look', `${caller} → ${name}`);
      res.json({ ok: true, name: next.name, look: next.look, avatar: next.avatar });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get(`${AGENT_ICON_URL_PREFIX}:file`, (req, res) => {
    try {
      const { bytes, contentType } = readAgentIcon(req.params.file);
      res.setHeader('content-type', contentType);
      // A new picture is a new uuid: nothing to invalidate.
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      res.send(bytes);
    } catch (err) {
      const msg = (err as Error).message;
      res.status(msg === 'not found' ? 404 : 400).json({ error: msg });
    }
  });

  app.get('/api/graph', (req, res) => {
    const root = String(req.query.root ?? '');
    const id = String(req.query.id ?? '');
    const depth = Math.max(1, Math.min(Number(req.query.depth ?? 3), 10));
    if (!['mission', 'task', 'routine'].includes(root) || !id) {
      res.status(400).json({ error: 'root (mission|task|routine) and id required' });
      return;
    }
    const scope = scopedDb(viewerFromRequest(req));
    if (root === 'mission' && !scope.getMission(id)) {
      res.status(404).json(apiError('not_found', 'not found')); return;
    }
    if (root === 'task' && !scope.getTask(id)) {
      res.status(404).json(apiError('not_found', 'not found')); return;
    }

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>(); // "kind:id"

    function nodeKey(kind: GraphNode['kind'], n: string): string {
      return `${kind}:${n}`;
    }

    function pushMission(mId: string): void {
      if (nodes.has(nodeKey('mission', mId))) return;
      const m = scope.getMission(mId);
      if (!m) return;
      nodes.set(nodeKey('mission', mId), {
        id: nodeKey('mission', mId),
        kind: 'mission',
        label: m.mission.slice(0, 60),
        status: m.status,
        agent: m.agent_name,
        startedAt: m.started_at,
      });
    }
    function pushTask(tId: string): void {
      if (nodes.has(nodeKey('task', tId))) return;
      const t = scope.getTask(tId);
      if (!t) return;
      nodes.set(nodeKey('task', tId), {
        id: nodeKey('task', tId),
        kind: 'task',
        label: t.title,
        status: t.status,
        agent: t.agent_name,
        startedAt: t.created_at,
      });
    }
    function pushRoutine(rId: string): void {
      if (nodes.has(nodeKey('routine', rId))) return;
      const r = dbApi.getRoutine(rId);
      if (!r) return;
      nodes.set(nodeKey('routine', rId), {
        id: nodeKey('routine', rId),
        kind: 'routine',
        label: r.name,
        status: r.enabled ? 'enabled' : 'disabled',
        agent: r.agent_name,
      });
    }

    // Frontier: { kind, id, depth }
    const frontier: Array<{ kind: GraphNode['kind']; id: string; d: number }> = [
      { kind: root as GraphNode['kind'], id, d: 0 },
    ];
    if (root === 'mission') pushMission(id);
    else if (root === 'task') pushTask(id);
    else pushRoutine(id);

    while (frontier.length > 0) {
      const cur = frontier.shift()!;
      const key = nodeKey(cur.kind, cur.id);
      if (visited.has(key)) continue;
      visited.add(key);
      if (cur.d >= depth) continue;

      if (cur.kind === 'mission') {
        const m = scope.getMission(cur.id);
        if (!m) continue;
        // Up: parent + task + fork source
        if (m.parent_mission_id) {
          pushMission(m.parent_mission_id);
          edges.push({ from: nodeKey('mission', m.parent_mission_id), to: key, kind: 'spawned' });
          frontier.push({ kind: 'mission', id: m.parent_mission_id, d: cur.d + 1 });
        }
        if (m.task_id) {
          pushTask(m.task_id);
          edges.push({ from: nodeKey('task', m.task_id), to: key, kind: 'task→mission' });
          frontier.push({ kind: 'task', id: m.task_id, d: cur.d + 1 });
        }
        if (m.forked_from) {
          pushMission(m.forked_from);
          edges.push({ from: nodeKey('mission', m.forked_from), to: key, kind: 'forked_from' });
          frontier.push({ kind: 'mission', id: m.forked_from, d: cur.d + 1 });
        }
        // Down: children
        for (const c of scope.listChildMissions(cur.id)) {
          pushMission(c.id);
          edges.push({ from: key, to: nodeKey('mission', c.id), kind: 'spawned' });
          frontier.push({ kind: 'mission', id: c.id, d: cur.d + 1 });
        }
      } else if (cur.kind === 'task') {
        const t = scope.getTask(cur.id);
        if (!t) continue;
        // Up: routine + deps
        if (t.routine_id) {
          pushRoutine(t.routine_id);
          edges.push({ from: nodeKey('routine', t.routine_id), to: key, kind: 'routine→task' });
          frontier.push({ kind: 'routine', id: t.routine_id, d: cur.d + 1 });
        }
        try {
          const deps = JSON.parse(t.deps) as string[];
          for (const dep of deps) {
            pushTask(dep);
            edges.push({ from: nodeKey('task', dep), to: key, kind: 'dep' });
            frontier.push({ kind: 'task', id: dep, d: cur.d + 1 });
          }
        } catch { /* deps parse error → skip */ }
        // Down: missions launched from this task
        for (const m of scope.listMissionsByTask(cur.id)) {
          pushMission(m.id);
          edges.push({ from: key, to: nodeKey('mission', m.id), kind: 'task→mission' });
          frontier.push({ kind: 'mission', id: m.id, d: cur.d + 1 });
        }
      } else if (cur.kind === 'routine') {
        // Down: tasks created by this routine
        for (const t of scope.listTasksByRoutine(cur.id)) {
          pushTask(t.id);
          edges.push({ from: key, to: nodeKey('task', t.id), kind: 'routine→task' });
          frontier.push({ kind: 'task', id: t.id, d: cur.d + 1 });
        }
      }
    }

    // Message edges: add agent_message flows between missions already present
    // in the graph. Do NOT extend the frontier — messages must not add missions,
    // otherwise a talkative agent would make the graph explode. "Orphaned"
    // messages (peer outside the graph) are ignored in this root-centered view.
    const missionIdsInGraph = new Set<string>();
    for (const n of nodes.values()) {
      if (n.kind === 'mission') missionIdsInGraph.add(n.id.slice('mission:'.length));
    }
    const seenMsgEdges = new Set<string>();
    for (const mid of missionIdsInGraph) {
      const msgs = scope.listMessagesForMission(mid, 50);
      for (const msg of msgs) {
        const toMid = msg.to_mission;
        if (!toMid || !missionIdsInGraph.has(toMid)) continue;
        const fromKey = nodeKey('mission', msg.from_mission);
        const toKey = nodeKey('mission', toMid);
        const ek = `msg:${fromKey}→${toKey}:${msg.kind}`;
        if (seenMsgEdges.has(ek)) continue;
        seenMsgEdges.add(ek);
        edges.push({ from: fromKey, to: toKey, kind: 'message', label: msg.kind });
      }
    }

    res.json({ nodes: [...nodes.values()], edges });
  });

  registerSkillAttachmentRoutes(app);

  app.get('/api/skills', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : undefined;
    res.json({ skills: skillReadBody(req, listAllSkills({ cwd })) });
  });

  app.get('/api/skills/:id', (req, res) => {
    try {
      const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : undefined;
      const origin = skillOriginQuery.safeParse({ source: req.query.source, format: req.query.format });
      if (!origin.success) {
        res.status(400).json({ error: 'invalid source or format' });
        return;
      }
      const entry = resolveSkill(req.params.id, { cwd, origin: origin.data.source ? { source: origin.data.source, format: origin.data.format } : undefined });
      if (!entry) {
        res.status(404).json(apiError('skill_not_found', 'skill not found'));
        return;
      }
      const content = readEntryContent(entry) ?? '';
      if (isMissionToken(req)) journalMissionSkillRead(req.auth!.missionId!, entry.id);
      // The files `skill_get` names after the body: only a Timon skill is read by a mission.
      res.json(skillReadBody(req, { ...entry, content, ...(entry.source === 'timon' ? { files: listSkillFiles(entry.id) } : {}) }));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // One file next to a Timon skill's SKILL.md, for an agent that cannot open
  // Timon's disk (`skill_get` with `file`). Same audience as the body above:
  // any authenticated caller, masked for a mission; the path guard is `readSkillFile`'s.
  app.get('/api/skills/:id/file', (req, res) => {
    const parsed = skillFileQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    try {
      res.json(skillReadBody(req, { id: req.params.id, ...readSkillFile(req.params.id, parsed.data.path) }));
    } catch (err) {
      if (err instanceof SkillFileError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/api/skills', (req, res) => {
    if (rejectIfDenied(req, res, 'skills:manage')) return;
    const parsed = skillWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid skill', fields: parsed.error.flatten().fieldErrors });
      return;
    }
    const body = parsed.data;
    const refusal = skillWriteRefusal(req, {
      path: body.path ?? skillFile(body.id!),
      content: body.content,
      byPath: body.path !== undefined,
    });
    if (refusal) {
      rejectOverride(req, res, 'skill.write_denied', `skill:${body.id ?? body.path}`, refusal);
      return;
    }
    if (isMissionToken(req) && overwritesMaskedValue(body.path ?? skillFile(body.id!), body.content)) {
      res.status(409).json({
        error: 'this skill holds vault values, and what a mission reads of it shows them as ***: writing that text back would destroy them. '
          + 'Change it from the skill editor of the app, or write it without the mask',
        code: 'skill_masked',
      });
      return;
    }
    // The conversion mission of a browser recording never replaces a skill, asked or not.
    const conversion = conversionMissionOf(req);
    const createOnly = body.create_only === true || conversion !== null;
    try {
      if (body.path) {
        writeEntryFile(body.path, body.content, { createOnly });
        res.json({ ok: true, path: body.path });
        return;
      }
      if (!body.id) {
        res.status(400).json({ error: 'id required (new TIMON skill)' });
        return;
      }
      const written = upsertSkill(body.id, body.content, { createOnly });
      // Same tick as the refusal check: no second write of this mission can slip in between.
      if (conversion) {
        recordBrowserRecordingSkill(conversion.missionId, body.id, { kind: 'agent', id: conversion.agent }, { recordingId: conversion.recording?.id });
      }
      res.json(written);
    } catch (err) {
      if (err instanceof SkillExistsError) {
        res.status(409).json({ error: err.message, code: 'skill_exists' });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // A `claude-user` or `plugin` skill is invisible to missions: importing it
  // copies its folder into ~/.timon/skills, where it becomes attachable. The
  // source is named by registry id + source, never by a path from the caller.
  app.post('/api/skills/:id/import', (req, res) => {
    if (rejectIfDenied(req, res, 'skills:manage')) return;
    const parsed = skillImportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid import', fields: parsed.error.flatten().fieldErrors });
      return;
    }
    const entry = findImportableSkill(req.params.id, parsed.data.source);
    if (!entry) {
      res.status(404).json({ error: `no ${parsed.data.source} skill ${req.params.id}` });
      return;
    }
    const id = parsed.data.as ?? defaultImportId(entry.id);
    if (!isImportableId(id)) {
      res.status(400).json({ error: `invalid skill id: ${id} (lowercase letters, digits, . _ -)`, code: 'invalid_id', suggested: defaultImportId(entry.id) });
      return;
    }
    if (isSystemSkillId(id)) {
      res.status(409).json({ error: `${id} is a product skill id: pick another id`, code: 'skill_exists' });
      return;
    }
    try {
      const plan = planSkillImport(entry);
      // Same guard as a write by id: a skill that pre-authorises tools needs agents:privileged-config.
      const refusal = skillWriteRefusal(req, { path: skillFile(id), content: plan.content });
      if (refusal) {
        rejectOverride(req, res, 'skill.import_denied', `skill:${id}`, refusal);
        return;
      }
      res.status(201).json({ ok: true, ...importSkill(plan, id) });
    } catch (err) {
      if (err instanceof SkillExistsError) {
        res.status(409).json({ error: `a Timon skill ${id} already exists: import it under another id`, code: 'skill_exists' });
        return;
      }
      if (err instanceof SkillImportError) {
        res.status(err.code === 'too_large' ? 413 : 400).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'skill import failed' });
    }
  });

  app.delete('/api/skills/:id', (req, res) => {
    if (rejectIfDenied(req, res, 'skills:manage')) return;
    try {
      const queryPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
      // Without `?path=` the id is joined to the skills folder: a `..` or a
      // separator in it (`%2F` survives the router) would walk out of it.
      if (!queryPath && !isPlainSkillSegment(req.params.id)) {
        res.status(400).json({ error: `invalid skill id: ${req.params.id}` });
        return;
      }
      const path = queryPath ?? timonSkillPath(req.params.id);
      const refusal = skillWriteRefusal(req, { path });
      if (refusal) {
        rejectOverride(req, res, 'skill.delete_denied', `skill:${req.params.id}`, refusal);
        return;
      }
      const ok = deleteEntryFile(path);
      if (!ok) {
        res.status(404).json(apiError('skill_not_found', 'skill not found'));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name/files', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const r = browseAgentFiles(req.params.name, rel);
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Bytes of a previewable file (image, video, PDF, Office) for the Files
  // widget's viewer. Same permission and same sandbox as the listing above;
  // what leaves is decided by the file's magic bytes (see `openAgentFileRaw`).
  app.get('/api/agents/:name/files/raw', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    sendMedia(req, res, () => openAgentFileRaw(req.params.name, rel), false);
  });

  // A file OUTSIDE the agent's folder, reached from a link the agent posted once
  // the user confirmed it. Its own permission (`files:external`, held by a
  // superadmin through `*`), absent from the mission-token cap so an agent can
  // never use it on its own, and absolute paths only: the sandbox above stays
  // as it is.
  app.get('/api/agents/:name/files/external', (req, res) => {
    if (rejectIfDenied(req, res, 'files:external')) return;
    const abs = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      res.json(readExternalFile(abs));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name/files/external/raw', (req, res) => {
    if (rejectIfDenied(req, res, 'files:external')) return;
    const abs = typeof req.query.path === 'string' ? req.query.path : '';
    sendMedia(req, res, () => openExternalFileRaw(abs), false);
  });

  app.put('/api/agents/:name/files/external', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
    // Writing is also what `agents:manage` guards inside the folder: both are needed.
    if (rejectIfDenied(req, res, 'files:external') || rejectIfDenied(req, res, 'agents:manage')) return;
    const abs = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      res.json(writeExternalFile(abs, typeof req.body === 'string' ? req.body : ''));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/agents/:name/files', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const r = deleteAgentPath(req.params.name, rel);
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/agents/:name/files', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const action = typeof req.query.action === 'string' ? req.query.action : 'file';
    try {
      if (action === 'mkdir') {
        res.json(mkdirAgentPath(req.params.name, rel));
      } else if (action === 'rename') {
        const name = typeof req.query.name === 'string' ? req.query.name : '';
        res.json(renameAgentPath(req.params.name, rel, name));
      } else if (action === 'move') {
        const to = typeof req.query.to === 'string' ? req.query.to : '';
        res.json(moveAgentPath(req.params.name, rel, to));
      } else {
        res.json(writeAgentFile(req.params.name, rel, ''));
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // The editor of the Files widget saves through the app's PUT proxy, which
  // forwards the body as text/plain. The daemon never had this route (only
  // GET/POST/DELETE), so every save came back 404 (bug #62 of the beta).
  app.put('/api/agents/:name/files', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const content = typeof req.body === 'string' ? req.body : '';
    try {
      res.json(writeAgentFile(req.params.name, rel, content));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mcp', (_req, res) => {
    try {
      res.json({ servers: listMcp() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mcp/:id', (req, res) => {
    try {
      const s = getMcp(req.params.id);
      if (!s) {
        res.status(404).json(apiError('mcp_not_found', 'mcp not found'));
        return;
      }
      // audit CLI/MCP P1-4: the full transport (headers, OAuth tokens, stdio env) must not
      // reach a caller who cannot manage MCP servers. Superadmin and
      // `mcp:manage` holders keep the values — the editor round-trips them on
      // save, so masking there would corrupt real secrets — everyone else gets
      // the shape with every secret value scrubbed. A mission token is never
      // shown them, `mcp:manage` or not: its context is what a prompt injection
      // reads. A PUT that sends the masked value back keeps the stored one
      // (`missionTransport`).
      const full = !isMissionToken(req)
        && (req.auth?.isSuperadmin || requestHasPermission(req, 'mcp:manage'));
      res.json(full ? s : redactMcpServer(s));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mcp', async (req, res) => {
    const body = (req.body ?? {}) as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      transport?: unknown;
    };
    try {
      const mission = isMissionToken(req);
      const id = typeof body.id === 'string' ? body.id : '';
      // A mission's refusal runs before the permission check so that the agent
      // reads WHY (the MCP catalogue relays `reason`), not a bare 403.
      const existing = id && mission ? getMcp(id) : null;
      const refusal = id && body.transport && typeof body.transport === 'object'
        ? await mcpWriteRefusal(req, { id, name: body.name, transport: body.transport, existing })
        : null;
      if (refusal) {
        rejectOverride(req, res, 'mcp.write_denied', `mcp:${id}`, refusal);
        return;
      }
      if (rejectIfDenied(req, res, 'mcp:manage')) return;
      if (!id || !body.transport || typeof body.transport !== 'object') {
        res.status(400).json({ error: 'id and transport are required' });
        return;
      }
      let transport = body.transport as McpStdioConfig | McpHttpConfig;
      if (mission) {
        // The agent only ever read masked secrets: keep the stored ones where
        // the server still points at the same place, refuse to carry them elsewhere.
        const restored = missionTransport(existing, transport);
        if ('refusal' in restored) {
          rejectOverride(req, res, 'mcp.write_denied', `mcp:${id}`, restored.refusal);
          return;
        }
        transport = restored.transport;
      }
      const saved = upsertMcp({
        id,
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        transport,
        // Stamped at creation only: a later write by a privileged mission
        // must not hand an agent's missions a server a human declared.
        createdBy: mission ? (existing ? existing.created_by : missionCreatedBy(req)) ?? undefined : undefined,
        publicOnly: missionBoundToPublicUrls(req),
      });
      if (mission) {
        const where = transport.type === 'http' ? mcpHostLabel(transport.url) : 'a host command';
        auditRequest(req, 'mcp.write', `mcp:${id} — ${missionActorLabel(req)} — ${transport.type} ${where}`);
      }
      // The saved server carries the secrets `missionTransport` just put back:
      // a mission must not read them from the response of its own write.
      res.json(mission ? redactMcpServer(saved) : saved);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mcp/:id/oauth/start', async (req, res) => {
    if (rejectMissionMcpOAuth(req, res, `mcp:${req.params.id}`)) return;
    if (rejectIfDenied(req, res, 'mcp:manage')) return;
    try {
      const id = req.params.id;
      const s = getMcp(id);
      if (!s) { res.status(404).json(apiError('mcp_not_found', 'mcp not found')); return; }
      if (s.transport.type !== 'http') {
        res.status(400).json({ error: 'oauth only applies to http transport' });
        return;
      }
      const redirectUri = oauthRedirectUri(publicApiUrl(), apiPort());
      const metadata = s.transport.oauth?.metadata ?? await discoverOAuth(s.transport.url);
      // A client registered under another redirect URI (the old default, a
      // changed port or public URL) would be refused at the publisher: register again.
      const saved = s.transport.oauth?.redirect_uri === redirectUri ? s.transport.oauth?.client : undefined;
      const client = saved ?? await dynamicRegister(metadata, redirectUri, 'TIMON', s.transport.url);
      const { verifier, challenge } = pkcePair();
      const state = randomState();
      // Capture where the user came from so the post-callback bounce lands on
      // the same scheme/host they were already on (avoids forcing https on a
      // user who's browsing the app over http).
      const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      const returnTo = safeOrigin(origin) ?? safeOrigin(referer) ?? undefined;
      // The Apps page asks to come back to itself; anything else lands on /mcp.
      const returnPath = oauthReturnPath((req.body as { return_path?: unknown } | undefined)?.return_path);
      putPending(state, {
        mcp_id: id, code_verifier: verifier, redirect_uri: redirectUri,
        metadata, client, created_at: Date.now(), return_to: returnTo,
        seed_url: s.transport.url,
        ...(returnPath ? { return_path: returnPath } : {}),
      });
      // Persist metadata + client early so a later "Save" in the UI doesn't
      // wipe them and so subsequent retries skip discovery/registration.
      setMcpOAuth(id, { metadata, client, redirect_uri: redirectUri,
        tokens: s.transport.oauth?.tokens });
      const scope = (metadata.scopes_supported || []).join(' ') || undefined;
      const authorize_url = buildAuthorizeUrl(metadata, client, redirectUri, state, challenge, scope);
      res.json({ authorize_url });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const errParam = typeof req.query.error === 'string' ? req.query.error : '';
    const pending = state ? takePending(state) : null;
    if (errParam || !pending || !code) {
      res.status(400).type('html').send(callbackPage({
        ok: false,
        error: errParam || (!pending ? 'unknown or expired state' : 'missing code'),
      }));
      return;
    }
    try {
      const tokens = await exchangeCode(
        pending.metadata, pending.client, pending.redirect_uri, code, pending.code_verifier, pending.seed_url,
      );
      setMcpOAuth(pending.mcp_id, {
        metadata: pending.metadata,
        client: pending.client,
        redirect_uri: pending.redirect_uri,
        tokens,
      });
      res.type('html').send(callbackPage({ ok: true, mcpId: pending.mcp_id, returnTo: pending.return_to, returnPath: pending.return_path }));
    } catch (err) {
      res.status(500).type('html').send(callbackPage({ ok: false, error: (err as Error).message, returnTo: pending.return_to, returnPath: pending.return_path }));
    }
  });

  app.delete('/api/mcp/:id', async (req, res) => {
    try {
      const mission = isMissionToken(req);
      const refusal = mission
        ? await mcpWriteRefusal(req, { id: req.params.id, existing: getMcp(req.params.id) })
        : null;
      if (refusal) {
        rejectOverride(req, res, 'mcp.delete_denied', `mcp:${req.params.id}`, refusal);
        return;
      }
      if (rejectIfDenied(req, res, 'mcp:manage')) return;
      const ok = deleteMcp(req.params.id);
      if (!ok) {
        res.status(404).json(apiError('mcp_not_found', 'mcp not found'));
        return;
      }
      if (mission) auditRequest(req, 'mcp.delete', `mcp:${req.params.id} — ${missionActorLabel(req)}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
}
