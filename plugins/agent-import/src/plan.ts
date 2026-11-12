/**
 * The preview: from a manifest, the user's choices and what Timon holds right
 * now, everything an import would do — agent by agent, the final name, what is
 * created, updated or skipped, and why. `apply` computes the same plan again
 * under its lock and executes it, so what was previewed is what is applied,
 * unless Timon changed in between (then the fresh state wins).
 *
 * Only reads here, and only through the plugin's facades and the plugin's own
 * store; the one look at the disk is whether a chosen working directory exists.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { PluginContext } from '@timon-ai/sdk';
import {
  DEFAULT_IMPORT_ROLE, IMPORT_ELEMENTS,
  type AgentChoice, type ImportElement, type ImportOptions, type ImportPreview, type PreviewAgent,
  type PreviewAgentAction, type PreviewElement,
} from './contract.js';
import type { AgentImportManifest, ManifestAgent, ManifestGroup } from './manifest.js';
import { FINGERPRINTED_DOCS, fingerprint, ownedBy, type ImportRecord, type RecordCaller, type Records } from './records.js';
import { redactArgs, sanitizeUrl } from './redact.js';
import { mapSchedule, type SourceSchedule } from './schedule-map.js';
import { stripAllowedTools } from './skill-text.js';

/** The facades the engine uses, nothing more. */
export type EngineContext = Pick<
  PluginContext,
  'id' | 'log' | 'user' | 'assertPermission' | 'agents' | 'skills' | 'mcpServers' | 'memory' | 'triggers' | 'businessEvents' | 'backends'
>;

type BackendCatalog = Awaited<ReturnType<PluginContext['backends']['list']>>;

/** Each rule is injected into every prompt of its agent: past this, the agent drowns in them. */
export const MEMORY_RULES_PER_AGENT = 64;
/** What a trigger's task action holds (`prompt`). */
export const ROUTINE_PROMPT_MAX = 20_000;
/** What `ctx.agents.setAvatar` takes once decoded. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AGENT_NAME_MAX = 100;
const PREFIX_MAX = 30;
const SUFFIX_TRIES = 50;

export type SkillPlan = { sourceId: string; finalId: string; content: string };
export type McpPlan = { name: string; finalId: string; url: string };
export type RoutinePlan = { name: string; instruction: string; cron: string; tz: string | null; enabled: boolean };
export type TeamPlan = { groupKey: string; name: string; color: string | null; existingId: string | null };

export type AgentPlan = {
  source: ManifestAgent;
  action: PreviewAgentAction;
  finalName: string;
  role: string;
  /** `false` on a re-import where the user chose no role: the agent keeps its own. */
  setRole: boolean;
  /** `undefined`: left as it is. */
  project: string | null | undefined;
  cwd: string | null;
  record: ImportRecord | null;
  /** Where `record` was read from in the store. */
  recordKey: string | null;
  /** The account the import runs for (`null`: a job). */
  ownerUserId: string | null;
  /** The source's backend and model when they exist here; `null` = Timon's default. */
  backend: string | null;
  model: string | null;
  /** Which settings come from the source, not from the user: dropped if Timon refuses them. */
  fromSource: { role: boolean; project: boolean; cwd: boolean };
  systemPrompt: string;
  /** Directives after the role's, as the source had them; `null` = none sent. */
  directives: string | null;
  /** `SOUL.md` when selected. */
  soul: string | null;
  /** The other identity documents, written with `SOUL.md`. */
  docs: Array<{ name: string; content: string }>;
  avatar: { mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } | null;
  selected: Record<ImportElement, boolean>;
  skills: SkillPlan[];
  mcp: McpPlan[];
  memories: Array<{ text: string; kind: 'preference' | 'decision' | 'pitfall' }>;
  routines: RoutinePlan[];
  team: TeamPlan | null;
  /** What each element would write, before the user's boxes. */
  counts: Record<ImportElement, number>;
  warnings: string[];
};

export type ImportPlan = {
  sourceApp: string;
  agents: AgentPlan[];
  warnings: string[];
  preview: ImportPreview;
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const lower = (s: string): string => s.toLowerCase();

/** `Grok Bot` → `grok-bot`: the default name prefix. */
export function slugPrefix(app: string): string {
  const slug = app.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, PREFIX_MAX).replace(/-$/, '');
  return slug || 'import';
}

function serverSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 90).replace(/[-.]+$/, '');
  return slug || 'mcp';
}

const withSuffix = (base: string, n: number, max: number): string => {
  if (n === 1) return base;
  const tail = `-${n}`;
  return base.slice(0, max - tail.length) + tail;
};

/** A private/loopback/link-local IPv4, judged by its first two octets. */
function localV4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** The eight 16-bit groups of an IPv6 literal, or null when it is not one. */
function ipv6Groups(host: string): number[] | null {
  const raw = host.split('%')[0]!;
  if (!raw.includes(':')) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** The IPv4 address an IPv6 wrapper embeds, if any (mapped, NAT64, 6to4, compatible). */
function embeddedV4(groups: number[]): [number, number] | null {
  const pair = (hi: number, lo: number): [number, number] => [hi >> 8, hi & 0xff];
  // ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return pair(groups[6]!, groups[7]!);
  // 64:ff9b::a.b.c.d (NAT64)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return pair(groups[6]!, groups[7]!);
  // 2002:a.b.c.d:: (6to4)
  if (groups[0] === 0x2002) return pair(groups[1]!, groups[2]!);
  // Deprecated IPv4-compatible ::a.b.c.d, excluding :: and ::1.
  if (groups.slice(0, 6).every((g) => g === 0) && !(groups[6] === 0 && groups[7]! <= 1)) return pair(groups[6]!, groups[7]!);
  return null;
}

/** An address the daemon would refuse anyway (loopback, LAN, link-local): said in the preview. */
export function isLocalUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) return localV4(Number(v4[1]), Number(v4[2]));
  if (host.includes(':')) {
    // IPv4 forms embedded in an IPv6 literal reach the same host: judge that host.
    const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (dotted) {
      const p = dotted[1]!.split('.').map(Number);
      return localV4(p[0]!, p[1]!);
    }
    const groups = ipv6Groups(host);
    const mapped = groups ? embeddedV4(groups) : null;
    if (mapped) return localV4(mapped[0], mapped[1]);
  }
  return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}

/** The first bytes match the announced type: a picture, not something renamed. */
function avatarOk(mime: string, data: string): boolean {
  if (Math.floor((data.length * 3) / 4) > AVATAR_MAX_BYTES + 3) return false;
  const head = Buffer.from(data.slice(0, 24), 'base64');
  switch (mime) {
    case 'image/png': return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'image/jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/gif': return head.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp': return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Folders of a path written on any OS: a Windows export read on Linux, and the reverse. */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s !== '' && s !== '.' && s !== '..' && !/^[A-Za-z]:$/.test(s));
}

/** How many trailing folders of the source's directory are tried under this machine's home. */
const CWD_TAIL_MAX = 4;

/**
 * A directory of this machine that looks like `sourceCwd`: its trailing
 * folders, longest first, under the home directory (`C:\Users\bob\code\app`
 * → `~/code/app`). Never the home itself. A proposal: applied only if chosen.
 */
export function suggestCwd(sourceCwd: string, home: string = homedir(), exists: (path: string) => boolean = isDirectory): string | null {
  const segments = segmentsOf(sourceCwd);
  for (let n = Math.min(segments.length - 1, CWD_TAIL_MAX); n >= 1; n -= 1) {
    const candidate = join(home, ...segments.slice(-n));
    if (exists(candidate)) return candidate;
  }
  return null;
}

function soulOf(agent: ManifestAgent): string {
  const parts = [`# ${agent.displayName}`];
  if (agent.title) parts.push(`*${agent.title}*`);
  if (agent.soul && agent.soul.trim()) parts.push(agent.soul.trim());
  return `${parts.join('\n\n')}\n`;
}

/** How many characters of a command line the preview shows. */
const COMMAND_LINE_MAX = 200;

/**
 * A command line as the preview shows it: the program's name without its
 * folder, and the arguments with their secret-looking values masked. A secret
 * with no telling flag or prefix is not recognised (see the README).
 */
function commandLine(command: string | undefined, args: readonly string[] | undefined, secrets: Set<string>): string {
  const program = command ? redactArgs([command.split(/[\\/]/).pop() ?? command], secrets)[0] ?? '' : '';
  return [program, ...redactArgs(args ?? [], secrets)].join(' ').trim().slice(0, COMMAND_LINE_MAX);
}

const listOf = (names: readonly string[]): string => names.slice(0, 20).join(', ') + (names.length > 20 ? ', …' : '');

export async function planImport(
  ctx: EngineContext,
  records: Records,
  manifest: AgentImportManifest,
  options: ImportOptions = {},
): Promise<ImportPlan> {
  const sourceApp = manifest.source.app;
  const origin = `plugin:${ctx.id}`;
  const superadmin = ctx.user()?.is_superadmin === true;
  // What another account imported is never built on: its records, skills and
  // servers stay its own (a superadmin aside).
  const caller: RecordCaller = { userId: ctx.user()?.id ?? null, superadmin };
  const holds = (permission: string): boolean => {
    try { ctx.assertPermission(permission); return true; } catch { return false; }
  };
  const may = {
    skills: holds('skills:manage'),
    mcp: holds('mcp:manage'),
    routines: holds('triggers:manage') && holds('kanban:write'),
  };
  const warnings: string[] = [...(manifest.warnings ?? [])];
  if (!may.skills) warnings.push('Your account may not write skills: the skills are left out.');
  if (!may.mcp) warnings.push('Your account may not declare MCP servers: they are left out.');
  if (!may.routines) warnings.push('Your account may not create triggers and tasks: the routines are left out.');

  const agents = await ctx.agents.list();
  const byName = new Map(agents.map((a) => [lower(a.name), a]));
  const skills = new Map((await ctx.skills.list()).map((s) => [s.id, s]));
  const servers = new Map((await ctx.mcpServers.list()).map((s) => [s.id, s]));
  const teams = await ctx.agents.teams.list();
  let catalog: BackendCatalog | null = null;
  if (manifest.agents.some((a) => a.hints?.backend)) {
    try {
      catalog = await ctx.backends.list();
    } catch {
      warnings.push('The backends of this Timon could not be read: imported agents use the default backend and model.');
    }
  }

  // `hermes.` already names the agents of another writer (Hermes Gateway's
  // `hermes.<connection>.<profile>`): imported ones go under `import.`.
  let prefix = options.prefix ?? slugPrefix(sourceApp);
  if (options.prefix === undefined) {
    const foreign = agents.some((a) => lower(a.name).startsWith(`${prefix}.`) && a.createdBy !== origin);
    if (foreign) {
      warnings.push(`Names starting with "${prefix}." are already used by other agents: imported agents are named "import.<name>".`);
      prefix = 'import';
    }
  }

  const choices = new Map((options.agents ?? []).map((c) => [c.sourceRef, c]));
  const taken = new Set(byName.keys());
  const claimedSkills = new Map<string, string>();
  const runSkills = new Map<string, string>();
  const claimedServers = new Set<string>();
  const runServers = new Map<string, string>();
  const groupsOf = new Map<string, ManifestGroup[]>();
  for (const group of manifest.groups ?? []) {
    for (const key of new Set(group.members)) groupsOf.set(key, [...(groupsOf.get(key) ?? []), group]);
  }

  /** A skill id free for this source skill: its own from a previous import, or a fresh one. */
  const skillId = async (sourceId: string, content: string): Promise<string | null> => {
    const sameRun = runSkills.get(`${sourceId}\0${sha(content)}`);
    if (sameRun) return sameRun;
    for (let n = 1; n <= SUFFIX_TRIES; n += 1) {
      const id = withSuffix(sourceId, n, 100);
      if (claimedSkills.has(id)) continue;
      const existing = skills.get(id);
      if (existing) {
        const owner = existing.mine ? await records.skill(id) : null;
        if (!owner || !ownedBy(owner.ownerUserId, caller) || owner.sourceApp !== sourceApp || owner.sourceId !== sourceId) continue;
      }
      claimedSkills.set(id, sourceId);
      runSkills.set(`${sourceId}\0${sha(content)}`, id);
      return id;
    }
    return null;
  };

  const serverId = async (name: string): Promise<string | null> => {
    const sameRun = runServers.get(name);
    if (sameRun) return sameRun;
    const base = serverSlug(name);
    for (let n = 1; n <= SUFFIX_TRIES; n += 1) {
      const id = withSuffix(base, n, 100);
      if (claimedServers.has(id)) continue;
      const existing = servers.get(id);
      if (existing) {
        const owner = existing.mine ? await records.mcp(id) : null;
        if (!owner || !ownedBy(owner.ownerUserId, caller) || owner.sourceApp !== sourceApp || owner.sourceId !== name) continue;
      }
      claimedServers.add(id);
      runServers.set(name, id);
      return id;
    }
    return null;
  };

  /** Hand edits since the import: a write by somebody else, or documents that no longer match. */
  const changedByHand = async (record: ImportRecord): Promise<boolean> => {
    if (record.touched) return true;
    for (const file of FINGERPRINTED_DOCS) {
      if (!(file in record.docs)) continue;
      const now = fingerprint(await ctx.agents.docs.get(record.agent, file));
      if (now !== record.docs[file]) return true;
    }
    return false;
  };

  const plans: AgentPlan[] = [];
  /** What only the preview shows: a proposal and what this Timon lacks. */
  const extra = new Map<AgentPlan, { cwdSuggestion: string | null; backendMissing: boolean; modelMissing: boolean; activeRoutines: number }>();
  for (const source of manifest.agents) {
    const choice: AgentChoice | undefined = choices.get(source.sourceRef);
    const notes: string[] = [];
    const found = await records.find(sourceApp, source.sourceRef, caller);
    const record = found?.record ?? null;
    const current = record ? byName.get(lower(record.agent)) : undefined;
    const previous = record && current && current.mine ? record : null;

    let action: PreviewAgentAction = previous ? 'update' : 'create';
    let finalName = previous ? current!.name : '';
    if (!previous) {
      let base = `${prefix}.${source.key}`;
      if (choice?.name !== undefined) {
        if (AGENT_NAME_RE.test(choice.name) && choice.name.length <= AGENT_NAME_MAX) base = choice.name;
        else notes.push(`"${choice.name.slice(0, 100)}" is not a valid agent name: ${base} is used instead.`);
      }
      base = base.slice(0, AGENT_NAME_MAX);
      for (let n = 1; n <= SUFFIX_TRIES && !finalName; n += 1) {
        const candidate = withSuffix(base, n, AGENT_NAME_MAX);
        if (!taken.has(lower(candidate))) finalName = candidate;
      }
      if (!finalName) {
        action = 'skip';
        finalName = base;
        notes.push('No free name was found for this agent.');
      } else if (lower(finalName) !== lower(base)) {
        notes.push(`${base} is taken: the agent is named ${finalName}.`);
      }
    } else if (choice?.name !== undefined && choice.name !== finalName) {
      notes.push(`Already imported as ${finalName}: the name stays.`);
    }
    if (action !== 'skip') taken.add(lower(finalName));

    if (choice?.include === false) {
      action = 'skip';
      notes.push('Left out.');
    } else if (previous && await changedByHand(previous)) {
      action = 'skip';
      notes.push(`${finalName} was changed by hand since it was imported: it is not overwritten. Rename or delete it to import it again.`);
    }

    const hints = source.hints ?? {};
    const setRole = !previous || choice?.role !== undefined;
    const roleFromSource = choice?.role === undefined && !previous && hints.role !== undefined;
    let role = choice?.role ?? (previous ? current!.role ?? DEFAULT_IMPORT_ROLE : hints.role ?? DEFAULT_IMPORT_ROLE);
    if (setRole && role === 'orchestrator' && !superadmin) {
      notes.push(`Only a superadmin may import an orchestrator: the role is ${DEFAULT_IMPORT_ROLE}.`);
      role = DEFAULT_IMPORT_ROLE;
    }
    if (hints.main) notes.push('This was the main agent at the source: it is imported as an ordinary agent, the main agent here stays the same.');
    const projectFromSource = choice?.project === undefined && !previous && hints.project !== undefined;
    const project = projectFromSource ? hints.project : choice?.project;

    // The working directory: the user's choice, else the source's if it exists here.
    const sourceCwd = hints.cwd ?? null;
    let cwd: string | null = choice?.cwd ?? null;
    let cwdFromSource = false;
    let cwdSuggestion: string | null = null;
    if (choice?.cwd === undefined && sourceCwd !== null) {
      if (isAbsolute(sourceCwd) && isDirectory(sourceCwd)) {
        cwd = sourceCwd;
        cwdFromSource = true;
      } else {
        cwdSuggestion = suggestCwd(sourceCwd);
        notes.push(cwdSuggestion
          ? `The working directory at the source (${sourceCwd.slice(0, 300)}) does not exist on this machine: ${cwdSuggestion} looks like it, choose it to use it. Until then the agent has no working directory.`
          : `The working directory at the source (${sourceCwd.slice(0, 300)}) does not exist on this machine: the agent has no working directory until you choose one.`);
      }
    }
    const cwdMissing = cwd !== null && !isDirectory(cwd);
    if (cwdMissing) notes.push('The chosen working directory does not exist: the agent is created without it.');

    // Backend and model: kept when this Timon has them, never guessed.
    let backend: string | null = null;
    let model: string | null = null;
    let backendMissing = false;
    let modelMissing = false;
    if (hints.backend !== undefined && catalog) {
      const wanted = hints.backend;
      // An account instance (`claude@<account>`) of another machine: its provider, if present here.
      const entry = catalog.backends.find((b) => b.id === wanted) ?? catalog.backends.find((b) => b.id === wanted.split('@')[0]);
      if (!entry) {
        backendMissing = true;
        notes.push(`Backend ${wanted} is not available here: the agent uses the default backend and model.`);
      } else {
        backend = entry.id;
        if (entry.id !== wanted) notes.push(`Backend ${wanted} is an account of the source machine: the agent uses ${entry.id}.`);
        if (hints.model !== undefined) {
          const offered = entry.models.some((m) => m.slug === hints.model) || (entry.slugPrefixes ?? []).some((p) => hints.model!.startsWith(p));
          if (offered) model = hints.model;
          else {
            modelMissing = true;
            notes.push(`Model ${hints.model} is not offered by ${entry.id} here: the agent uses its default model.`);
          }
        }
      }
    } else if (hints.backend === undefined && hints.model) {
      notes.push(`The model at the source (${hints.model}) is not carried over: the agent uses Timon's default.`);
    }

    const wants = (element: ImportElement): boolean => choice?.elements?.[element] ?? true;

    // Skills: text only in v1, and never with pre-authorised tools.
    const skillPlans: SkillPlan[] = [];
    for (const skill of source.skills ?? []) {
      if ((skill.companionFiles?.length ?? 0) > 0 || skill.hasCode === true) {
        notes.push(`Skill ${skill.id} comes with files or scripts: not imported.`);
        continue;
      }
      const stripped = stripAllowedTools(skill.content);
      if (stripped.removed) notes.push(`Skill ${skill.id}: its pre-authorised tools (allowed-tools) are removed.`);
      if (!stripped.content.trim()) continue;
      if (!may.skills || !wants('skills') || action === 'skip') {
        skillPlans.push({ sourceId: skill.id, finalId: skill.id, content: stripped.content });
        continue;
      }
      const id = await skillId(skill.id, stripped.content);
      if (!id) {
        notes.push(`Skill ${skill.id}: no free id was found, not imported.`);
        continue;
      }
      if (id !== skill.id) notes.push(`Skill ${skill.id} is imported as ${id}: the id is taken.`);
      skillPlans.push({ sourceId: skill.id, finalId: id, content: stripped.content });
    }

    // MCP servers: public http only, without their secrets.
    const mcpPlans: McpPlan[] = [];
    const secretNames = new Set(source.hints?.secretNames ?? []);
    for (const server of source.mcpServers ?? []) {
      for (const name of server.secretNames ?? []) secretNames.add(name);
      if (server.transport === 'stdio') {
        const line = commandLine(server.command, server.args, secretNames);
        notes.push(`MCP server ${server.name} runs a command on this machine${line ? ` (${line})` : ''}: not created. Add it by hand from the MCP servers page if you trust it.`);
        continue;
      }
      let url: URL | null = null;
      try { url = server.url ? new URL(server.url) : null; } catch { url = null; }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
        notes.push(`MCP server ${server.name} has no usable http(s) address: not created.`);
        continue;
      }
      // A key carried by the address itself is taken out: the server is made
      // without it, and its name joins the secrets to enter again.
      const found = new Set<string>();
      url = new URL(sanitizeUrl(url.href, found) ?? url.href);
      if (found.size > 0) {
        for (const name of found) secretNames.add(name);
        notes.push(`MCP server ${server.name}: its address carried a secret (${listOf([...found])}), removed. Enter it again once the server is created.`);
      }
      if (isLocalUrl(url)) {
        notes.push(`MCP server ${server.name} points at a local or private address: not created.`);
        continue;
      }
      if (!may.mcp || !wants('mcp') || action === 'skip') {
        mcpPlans.push({ name: server.name, finalId: serverSlug(server.name), url: url.href });
        continue;
      }
      const id = await serverId(server.name);
      if (!id) {
        notes.push(`MCP server ${server.name}: no free id was found, not created.`);
        continue;
      }
      mcpPlans.push({ name: server.name, finalId: id, url: url.href });
    }
    if (secretNames.size > 0) notes.push(`Secrets to enter again in the vault: ${listOf([...secretNames])}.`);

    const memories = (source.memories ?? []).slice(0, MEMORY_RULES_PER_AGENT);
    const dropped = (source.memories?.length ?? 0) - memories.length;
    if (dropped > 0) notes.push(`${dropped} memories over the limit of ${MEMORY_RULES_PER_AGENT} per agent are not imported.`);

    const routinePlans: RoutinePlan[] = [];
    let activeRoutines = 0;
    const keepActive = choice?.keepRoutinesActive === true;
    for (const routine of source.routines ?? []) {
      const mapped = mapSchedule({
        schedule: routine.schedule as SourceSchedule,
        timezone: routine.timezone ?? null,
        enabledInSource: routine.enabledInSource,
      }, 'trigger');
      if (mapped.skipped) {
        notes.push(`Routine "${routine.name}": ${mapped.reason}`);
        continue;
      }
      for (const warning of mapped.warnings) notes.push(`Routine "${routine.name}": ${warning}`);
      if (routine.instruction.length > ROUTINE_PROMPT_MAX) {
        notes.push(`Routine "${routine.name}": its instruction is longer than ${ROUTINE_PROMPT_MAX} characters, not imported.`);
        continue;
      }
      if (mapped.enabled) activeRoutines += 1;
      // On only by the user's choice: an archive alone never schedules tasks.
      routinePlans.push({ name: routine.name, instruction: routine.instruction, cron: mapped.cron, tz: mapped.tz, enabled: mapped.enabled && keepActive });
    }
    if (activeRoutines > 0 && !keepActive) {
      notes.push(`${activeRoutines} routine(s) switched on at the source are imported switched off: choose to keep them active to have them run.`);
    }

    let team: TeamPlan | null = null;
    const groups = groupsOf.get(source.key) ?? [];
    if (groups[0]) {
      const group = groups[0];
      const existing = teams.find((t) => lower(t.name) === lower(group.name));
      team = { groupKey: group.key, name: group.name, color: group.color ?? null, existingId: existing?.id ?? null };
      if (groups.length > 1) notes.push(`An agent belongs to one team: ${group.name} is kept, not ${listOf(groups.slice(1).map((g) => g.name))}.`);
    }

    let avatar: AgentPlan['avatar'] = null;
    if (source.avatar) {
      if (avatarOk(source.avatar.mime, source.avatar.dataBase64)) avatar = { mime: source.avatar.mime, data: source.avatar.dataBase64 };
      else notes.push('The picture is not a valid image of its type, or is too large: not imported.');
    }

    const deliveries = source.hints?.deliveries ?? [];
    if (deliveries.length > 0) notes.push(`Deliveries are not carried over: ${listOf(deliveries)}.`);
    if (source.hints?.hasHistory) notes.push('The conversation history is not imported.');

    // A `SOUL.md` sent as a document is the agent's own (another Timon): kept verbatim.
    const soulDoc = (source.docs ?? []).find((d) => d.name.toLowerCase() === 'soul.md');
    const otherDocs = (source.docs ?? []).filter((d) => d !== soulDoc).map((d) => ({ name: d.name, content: d.content }));

    const counts: Record<ImportElement, number> = {
      soul: 1,
      memory: memories.length,
      skills: skillPlans.length,
      mcp: mcpPlans.length,
      routines: routinePlans.length,
      team: team ? 1 : 0,
    };
    const allowed: Record<ImportElement, boolean> = {
      soul: true, memory: true, skills: may.skills, mcp: may.mcp, routines: may.routines, team: true,
    };
    const selected = Object.fromEntries(IMPORT_ELEMENTS.map((e) => [e, action !== 'skip' && allowed[e] && wants(e) && counts[e] > 0])) as Record<ImportElement, boolean>;

    const agentPlan: AgentPlan = {
      source,
      action,
      finalName,
      role,
      setRole,
      project,
      cwd: cwdMissing ? null : cwd,
      record: previous,
      recordKey: previous ? found?.key ?? null : null,
      ownerUserId: caller.userId,
      backend,
      model,
      fromSource: { role: roleFromSource, project: projectFromSource, cwd: cwdFromSource },
      systemPrompt: source.instructions ?? '',
      directives: source.directives ?? null,
      soul: selected.soul ? soulDoc?.content ?? soulOf(source) : null,
      docs: selected.soul ? otherDocs : [],
      avatar,
      selected,
      skills: selected.skills ? skillPlans : [],
      mcp: selected.mcp ? mcpPlans : [],
      memories: selected.memory ? memories : [],
      routines: selected.routines ? routinePlans : [],
      team: selected.team ? team : null,
      counts,
      warnings: notes,
    };
    plans.push(agentPlan);
    extra.set(agentPlan, { cwdSuggestion, backendMissing, modelMissing, activeRoutines });
  }

  const preview: ImportPreview = {
    source: { app: sourceApp, exportedAt: manifest.source.exportedAt ?? null },
    warnings,
    agents: plans.map((p): PreviewAgent => {
      const elements = Object.fromEntries(IMPORT_ELEMENTS.map((e) => [e, { count: p.counts[e], selected: p.selected[e] } satisfies PreviewElement]));
      const choice = choices.get(p.source.sourceRef);
      return {
        sourceRef: p.source.sourceRef,
        displayName: p.source.displayName,
        action: p.action,
        warnings: p.warnings,
        finalName: p.finalName,
        role: p.role,
        project: p.project ?? null,
        cwd: choice?.cwd ?? p.cwd,
        cwdMissing: (choice?.cwd ?? null) !== null && p.cwd === null,
        sourceCwd: p.source.hints?.cwd ?? null,
        cwdSuggestion: extra.get(p)?.cwdSuggestion ?? null,
        backend: p.backend,
        model: p.model,
        backendMissing: extra.get(p)?.backendMissing ?? false,
        modelMissing: extra.get(p)?.modelMissing ?? false,
        activeRoutines: extra.get(p)?.activeRoutines ?? 0,
        elements,
      };
    }),
  };
  return { sourceApp, agents: plans, warnings, preview };
}
