/**
 * Supervision of a project's Docker containers, in the same spirit as
 * `grepai.ts` (index watcher) and `gitremote.ts` (publishing): making
 * visible from the UI a state that only existed in a terminal.
 *
 * The concrete need: half of the maintainer's projects run in Docker behind
 * Traefik. Knowing whether a project's stack is up — and relaunching it — required
 * opening a shell in the right folder. So the state is exposed, along with the three gestures
 * (start / stop / restart) and the project's local URL, derived from the Traefik labels.
 *
 * Source of truth = `docker inspect`, never a compose file parsed by
 * hand: what matters is what really runs, not what is declared.
 * Attaching container → TIMON project is done on the label
 * `com.docker.compose.project.working_dir` compared to the project's `cwd` — the compose
 * project name almost never matches the TIMON slug (a repository folder
 * rarely carries its project's slug).
 */
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { getHost } from './host/index.js';
import { listProjects } from './projects.js';
import { reportOf, resolveProjectCwd, type CwdReport } from './project-cwd.js';

/** A status must never block the UI's poll loop. */
const INSPECT_TIMEOUT_MS = 5000;
/** `docker stop` waits for the container's SIGTERM (10 s by default) then kills. */
const ACTION_TIMEOUT_MS = 120_000;
/** The scan is global: the project grid queries one slug at a time, without
 *  this short cache each card would relaunch a complete `docker inspect`. */
const SCAN_TTL_MS = 1500;

/** Private ports never exposed as a clickable URL: a link
 *  `http://localhost:3306` opens nothing useful, it just suggests
 *  a web interface where there is only a network service. */
const NON_WEB_PORTS = new Set([1025, 1110, 3306, 5432, 6379, 11211, 27017, 33060]);

export type DockerState =
  /** project meta without a `cwd`, or unusable cwd (see `cwd_error`) */
  | 'no-cwd'
  /** CLI docker absent, ou daemon injoignable */
  | 'no-docker'
  /** no compose container attached to this working directory */
  | 'none'
  /** every container of the project runs */
  | 'running'
  /** only part of it runs — typically a service that crashed */
  | 'partial'
  /** containers present, all stopped */
  | 'stopped';

export type DockerContainer = {
  id: string;
  /** docker name without the leading `/` */
  name: string;
  /** service compose (`app`, `db`…), null hors compose */
  service: string | null;
  /** `running` | `exited` | `restarting` | `paused` | `created` | `dead` */
  state: string;
  /** `healthy` | `unhealthy` | `starting`, null without a healthcheck */
  health: string | null;
  /** start of the container, epoch ms — null if never started */
  started_at: number | null;
  /** local URL served by this container (Traefik or published port), null otherwise */
  url: string | null;
  /** published port mappings, e.g. `8089→80` */
  ports: string[];
  /** a `docker compose up -d --build` targeting this service is in flight */
  building: boolean;
  /** message of this service's last failed rebuild, cleared after a few polls */
  build_error: string | null;
};

export type DockerStatus = CwdReport & {
  slug: string;
  state: DockerState;
  cwd: string | null;
  /** name of the compose project (label `com.docker.compose.project`), null if none */
  project: string | null;
  containers: DockerContainer[];
  /** best local URL of the project — Traefik `.localhost` first */
  url: string | null;
  /** a rebuild (whole stack or at least one service) is in flight */
  building: boolean;
  /** message of the stack's last failed rebuild (outside per-service errors) */
  build_error: string | null;
};

type RawContainer = {
  id: string;
  name: string;
  state: string;
  health: { Status?: string } | null;
  started: string;
  labels: Record<string, string> | null;
  ports: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
};

type Run = { ok: boolean; out: string; err: string };

function run(cmd: string, args: string[], timeout: number): Run {
  try {
    const host = getHost();
    const r = host.containers && cmd === 'docker'
      ? host.containers.cli(args, timeout)
      : host.exec(cmd, args, { timeout });
    return {
      ok: r.code === 0,
      out: r.stdout.trim(),
      err: r.stderr.trim(),
    };
  } catch (err) {
    return { ok: false, out: '', err: (err as Error).message };
  }
}

/** Go template composing a valid JSON object per container. The Traefik
 *  labels contain backticks, `||` and commas: any separator-based format
 *  (`docker ps --format`) would get cut at the wrong place.
 *  `index .State "Health"` and not `.State.Health`: the key is absent — not
 *  null — on a container without a healthcheck, which makes the template crash. */
const INSPECT_TMPL = [
  '{"id":{{json .Id}}',
  '"name":{{json .Name}}',
  '"state":{{json .State.Status}}',
  '"health":{{json (index .State "Health")}}',
  '"started":{{json .State.StartedAt}}',
  '"labels":{{json .Config.Labels}}',
  '"ports":{{json .NetworkSettings.Ports}}}',
].join(',');

let cache: { at: number; containers: RawContainer[] | null } | null = null;

/** All the machine's containers (stopped ones included), or null if docker
 *  is unreachable. `null` ≠ `[]`: one means "no docker", the other
 *  "docker runs, no container" — the UI does not show the same thing. */
function scanContainers(): RawContainer[] | null {
  const now = Date.now();
  if (cache && now - cache.at < SCAN_TTL_MS) return cache.containers;

  const store = (containers: RawContainer[] | null): RawContainer[] | null => {
    cache = { at: now, containers };
    return containers;
  };

  // `-a`: a stopped container is precisely what we want to be able to relaunch.
  const ids = run('docker', ['ps', '-a', '--format', '{{.ID}}'], INSPECT_TIMEOUT_MS);
  if (!ids.ok) return store(null);
  const list = ids.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return store([]);

  const inspected = run(
    'docker',
    ['inspect', '--format', INSPECT_TMPL, ...list],
    INSPECT_TIMEOUT_MS,
  );
  // A container gone between the `ps` and the `inspect` makes docker exit with an
  // error while printing the others: what was parsed is kept.
  const out: RawContainer[] = [];
  for (const line of inspected.out.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { out.push(JSON.parse(line) as RawContainer); } catch { /* truncated line */ }
  }
  if (!out.length && !inspected.ok) return store(null);
  return store(out);
}

/** Usable cwd of a project, without a trailing slash (the compose labels have none). */
function stripTrailingSlash(cwd: string): string {
  return cwd.replace(/\/+$/, '') || cwd;
}

/** A container belongs to the project if its compose stack was launched from
 *  the project's working directory — or from a subfolder (`docker/`,
 *  `infra/`…), a frequent case when the compose is not at the root. */
function belongsTo(c: RawContainer, cwd: string): boolean {
  const dir = c.labels?.['com.docker.compose.project.working_dir'];
  if (!dir) return false;
  return dir === cwd || dir.startsWith(cwd + sep);
}

/** Hosts extracted from a Traefik rule. Only `Host(...)` is handled, which covers
 *  the whole fleet; an exotic rule (PathPrefix alone) simply gives zero
 *  URLs, which is better than a wrong link. */
function hostsFromRule(rule: string): string[] {
  const out: string[] = [];
  const re = /Host\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule)) !== null) {
    for (const raw of (m[1] ?? '').split(',')) {
      const host = raw.trim().replace(/^[`'"]|[`'"]$/g, '');
      if (host) out.push(host);
    }
  }
  return out;
}

/** The higher the score, the better the URL. A `.localhost` is what
 *  The user opens in their browser; a Tailscale or public host works too
 *  but is not the link expected from the local machine. */
function urlScore(url: string): number {
  const https = url.startsWith('https://');
  const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  // On a tie, the shallowest host wins: `timon.localhost` is the app,
  // `channels.timon.localhost` or `pma.globex.localhost` are annexes.
  const depth = (host.match(/\./g) ?? []).length;
  const base = url.includes('.localhost')
    ? https ? 100 : 90
    : url.startsWith('http://localhost:') ? 50
    : url.includes('.ts.net') ? 20
    : https ? 40 : 30;
  return base - depth;
}

/** Best Traefik URL of a set of labels. Exported for the tests: it is the
 *  only logic of the module that has a real chance of being silently wrong. */
export function traefikUrl(labels: Record<string, string>): string | null {
  return bestUrl(traefikUrls(labels));
}

function bestUrl(urls: string[]): string | null {
  let best: string | null = null;
  for (const u of urls) if (!best || urlScore(u) > urlScore(best)) best = u;
  return best;
}

/** URLs inferred from a container's Traefik labels. The scheme comes from the router
 *  itself: a `tls`/`websecure` router serves https, the http and https routers
 *  of the same host then coexist and the sort keeps the https one. */
function traefikUrls(labels: Record<string, string>): string[] {
  const routers = new Map<string, { hosts: string[]; tls: boolean }>();
  for (const [key, value] of Object.entries(labels)) {
    const m = /^traefik\.http\.routers\.([^.]+)\.(rule|tls|entrypoints)$/.exec(key);
    if (!m) continue;
    const name = m[1] ?? '';
    const field = m[2];
    const entry = routers.get(name) ?? { hosts: [], tls: false };
    if (field === 'rule') entry.hosts.push(...hostsFromRule(value));
    else if (field === 'tls' && value === 'true') entry.tls = true;
    else if (field === 'entrypoints' && /websecure/.test(value)) entry.tls = true;
    routers.set(name, entry);
  }

  const urls: string[] = [];
  for (const { hosts, tls } of routers.values()) {
    for (const host of hosts) urls.push(`${tls ? 'https' : 'http'}://${host}`);
  }
  return urls;
}

/** Ports published on the host, formatted `8089→80`, and a possible fallback URL. */
function portInfo(ports: RawContainer['ports']): { labels: string[]; urls: string[] } {
  const labelsOut: string[] = [];
  const urls: string[] = [];
  for (const [priv, bindings] of Object.entries(ports ?? {})) {
    if (!bindings?.length) continue;
    const privPort = Number(priv.split('/')[0]);
    for (const b of bindings) {
      if (!b.HostPort) continue;
      // IPv6 and IPv4 produce two bindings of the same port: it is shown
      // only once, otherwise each port line appears twice.
      const label = `${b.HostPort}→${privPort}`;
      if (!labelsOut.includes(label)) labelsOut.push(label);
      if (!NON_WEB_PORTS.has(privPort)) urls.push(`http://localhost:${b.HostPort}`);
    }
  }
  return { labels: labelsOut, urls };
}

function toContainer(c: RawContainer, slug: string): DockerContainer {
  const labels = c.labels ?? {};
  const { labels: ports, urls: portUrls } = portInfo(c.ports);
  const started = Date.parse(c.started);
  const service = labels['com.docker.compose.service'] ?? null;
  return {
    id: c.id.slice(0, 12),
    name: c.name.replace(/^\//, ''),
    service,
    state: c.state,
    health: c.health?.Status ?? null,
    // Docker writes a zero date (`0001-01-01…`) as long as the container has
    // never started: it parses without an error but means nothing.
    started_at: Number.isFinite(started) && started > 0 ? started : null,
    url: bestUrl([...traefikUrls(labels), ...portUrls]),
    ports,
    building: isBuilding(slug, service ?? undefined),
    build_error: getBuildError(slug, service ?? undefined),
  };
}

function buildStatus(slug: string, containers: RawContainer[] | null): DockerStatus {
  const resolved = resolveProjectCwd(slug);
  const cwd = resolved.cwd ? stripTrailingSlash(resolved.cwd) : null;
  const empty = {
    slug, cwd, ...reportOf(resolved), project: null, containers: [], url: null, building: false, build_error: null,
  };
  if (!cwd) return { ...empty, cwd: null, state: 'no-cwd' };
  if (containers === null) return { ...empty, state: 'no-docker' };

  const mine = containers.filter((c) => belongsTo(c, cwd)).map((c) => toContainer(c, slug));
  if (!mine.length) return { ...empty, state: 'none' };

  // Stable sort by service then name: without it the order comes from `docker ps`,
  // which changes on each restart and makes the lines jump around in the UI.
  mine.sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name));

  const up = mine.filter((c) => c.state === 'running').length;
  const state: DockerState = up === 0 ? 'stopped' : up === mine.length ? 'running' : 'partial';
  const project =
    containers.find((c) => belongsTo(c, cwd))?.labels?.['com.docker.compose.project'] ?? null;

  return {
    slug,
    state,
    cwd,
    ...reportOf(resolved),
    project,
    containers: mine,
    building: isBuilding(slug) || mine.some((c) => c.building),
    build_error: getBuildError(slug),
    // A URL only makes sense if something listens on it: Traefik does not route
    // to a stopped container, a dead link is worth less than no link.
    url: bestUrl(mine.filter((c) => c.state === 'running').map((c) => c.url ?? '').filter(Boolean)),
  };
}

/** `docker compose -f … -p …` prefix of the project, or null if the compose
 *  files have disappeared since the stack was launched (repository moved,
 *  worktree deleted) — in which case we fall back on the container ids. */
function composeArgs(cwd: string | null, project: string | null): string[] | null {
  if (!cwd || !project) return null;
  const raw = scanContainers();
  const owner = raw?.find((c) => belongsTo(c, cwd));
  const files = (owner?.labels?.['com.docker.compose.project.config_files'] ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f && existsSync(f));
  if (!files.length) return null;
  const args = ['compose'];
  for (const f of files) args.push('-f', f);
  args.push('-p', project);
  return args;
}

export function getStatus(slug: string): DockerStatus {
  return buildStatus(slug, scanContainers());
}

/** Status of all the known projects, sorted by ascending slug. */
export function listStatuses(): DockerStatus[] {
  const containers = scanContainers();
  return listProjects()
    .map((slug) => buildStatus(slug, containers))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export type DockerAction = 'start' | 'stop' | 'restart';

export function isDockerAction(v: unknown): v is DockerAction {
  return v === 'start' || v === 'stop' || v === 'restart';
}

/** One `docker compose up -d --build` per key `slug` (whole stack) or
 *  `slug:service` (a single container) — never two at the same time on the
 *  same key, otherwise two concurrent builds step on each other on the same
 *  layer cache. */
const builds = new Map<string, { startedAt: number }>();
/** Last error of a build per key, cleared by itself after a delay —
 *  long enough for the widget (4 s poll) to show it at least once,
 *  short enough not to leave a stale error lingering on screen. */
const buildErrors = new Map<string, string>();
const BUILD_ERROR_TTL_MS = 20_000;

function buildKey(slug: string, service?: string): string {
  return service ? `${slug}:${service}` : slug;
}

function isBuilding(slug: string, service?: string): boolean {
  return builds.has(buildKey(slug, service)) || (!service && [...builds.keys()].some((k) => k.startsWith(`${slug}:`)));
}

function getBuildError(slug: string, service?: string): string | null {
  return buildErrors.get(buildKey(slug, service)) ?? null;
}

function setBuildError(key: string, message: string): void {
  buildErrors.set(key, message);
  setTimeout(() => buildErrors.delete(key), BUILD_ERROR_TTL_MS);
}

/**
 * Launches `docker compose up -d --build [service]` in the background and returns
 * right away: unlike `act()`, a build can take several
 * minutes (Next.js, npm install…) and `run()` is synchronous — holding it
 * synchronously would block the orchestrator's event loop, hence ALL
 * the running missions, for the duration of the build. The caller polls `getStatus()`
 * (already done by the widget every 4 s) to see `building` fall back.
 */
export function rebuild(slug: string, target?: string): void {
  const status = getStatus(slug);
  if (status.state === 'no-cwd') throw new Error(`project has no usable working directory${status.cwd_error ? ` (${status.cwd_error})` : ''}`);
  if (status.state === 'no-docker') throw new Error('docker injoignable');
  if (!status.containers.length) throw new Error('no container for this project');

  let service: string | undefined;
  if (target) {
    const found = status.containers.find((c) => c.id === target || c.name === target);
    if (!found) throw new Error(`unknown container for this project: ${target}`);
    if (!found.service) throw new Error('container outside compose: cannot rebuild');
    service = found.service;
  }
  const key = buildKey(slug, service);
  if (builds.has(key)) throw new Error('a rebuild is already running');

  const composePrefix = composeArgs(status.cwd, status.project);
  if (!composePrefix) throw new Error('no compose files found for this project');
  const args = [...composePrefix, 'up', '-d', '--build'];
  if (service) args.push('--', service);

  builds.set(key, { startedAt: Date.now() });
  buildErrors.delete(key);
  cache = null;
  const child = getHost().spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on('exit', (code) => {
    builds.delete(key);
    cache = null;
    if (code !== 0) setBuildError(key, stderr.trim().split('\n').slice(-10).join('\n') || `docker exited with code ${code}`);
  });
  child.on('error', (err) => {
    builds.delete(key);
    cache = null;
    setBuildError(key, err.message);
  });
}

/**
 * Applies an action to the project's containers — all of them, or a single one if `target`
 * is given. `target` is always cross-checked against the project's containers
 * before being passed to docker: without this check, the endpoint
 * would let any container of the machine be stopped from any
 * slug.
 */
export function act(slug: string, action: DockerAction, target?: string): DockerStatus {
  const status = getStatus(slug);
  if (status.state === 'no-cwd') throw new Error(`project has no usable working directory${status.cwd_error ? ` (${status.cwd_error})` : ''}`);
  if (status.state === 'no-docker') throw new Error('docker injoignable');
  if (!status.containers.length) throw new Error('no container for this project');

  const compose = composeArgs(status.cwd, status.project);
  let args: string[];
  let service: string | null = null;
  if (target) {
    const found = status.containers.find((c) => c.id === target || c.name === target);
    if (!found) throw new Error(`unknown container for this project: ${target}`);
    args = [action, found.id];
    service = found.service;
  } else {
    // On the whole stack, compose is used when possible: it alone
    // honours `depends_on`. `docker start db app` launches both at the same time
    // and the app starts before its database — it exits with an error at the first access.
    args = compose ? [...compose, action] : [
      action,
      ...status.containers.map((c) => c.id),
    ];
  }

  const r = run('docker', args, ACTION_TIMEOUT_MS);
  // The cache would hide the effect of the action during its TTL: the UI reads the
  // status again right away and would show the state from before the click.
  cache = null;
  if (!r.ok) {
    const network = action === 'stop' ? null : missingNetwork(r.err);
    if (network) return recreateOnCurrentNetworks(slug, network, compose, target ? service : null, Boolean(target));
    throw new Error(r.err || `docker ${action} failed`);
  }
  return getStatus(slug);
}

/** Name of the network in "network X not found", null for any other error.
 *  Exported for the tests: docker and compose do not word the error
 *  identically (quotes, `Error response from daemon:` prefix). */
export function missingNetwork(stderr: string): string | null {
  const m = /network\s+["']?([^\s"']+)["']?\s+not found/i.exec(stderr);
  return m?.[1] ?? null;
}

/**
 * `start` does not recreate a container: it relaunches it on the network it
 * was created with. If that network has been deleted since (proxy migrated from
 * `traefik_network` to `proxy_net`, TIM-0104), no start goes through any more as long
 * as the container is not recreated. `compose up -d` recreates it on the networks
 * of the current compose — the same gesture as Rebuild, without rebuilding the image.
 */
function recreateOnCurrentNetworks(
  slug: string,
  network: string,
  compose: string[] | null,
  service: string | null,
  targeted: boolean,
): DockerStatus {
  const gone = `Docker network "${network}" no longer exists: these containers were created on it and cannot start until they are recreated.`;
  if (!compose || (targeted && !service)) {
    throw new Error(`${gone} Run \`docker compose up -d\` in the project directory to recreate them on the current networks.`);
  }
  const up = run('docker', [...compose, 'up', '-d', ...(service ? ['--', service] : [])], ACTION_TIMEOUT_MS);
  cache = null;
  if (!up.ok) {
    throw new Error(`${gone} Recreating them with \`docker compose up -d\` failed too: ${up.err || 'unknown error'}. Check the networks declared in the compose file, then click Rebuild.`);
  }
  return getStatus(slug);
}
