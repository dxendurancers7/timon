import {
  execFile,
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join } from 'node:path';
import type { TimonConfig } from '../config/schema.js';
import { TIMON_HOME } from '../paths.js';
import type { Capability, ExecOpts, ExecResult, Host, SpawnOpts } from './types.js';
import { findExecutableBinary, resolvePinnedBinary, type BinarySearchOptions } from './binary-path.js';
import { spawnDetachedGeneric } from './detached.js';
import { inspectListenPort } from './listen-port.js';
import { detectDesktopSession, type DesktopSession } from './desktop-session.js';
import { opensAsFolder, revealInFileManager } from './reveal.js';
import { windowsDirectLaunch, windowsShimLaunch } from './windows-shell.js';

/** Where the adapter reads `host.binaries` at each resolution. */
export type BinaryPins = () => Record<string, string | null>;

/** A file group/other can modify is refused: a pin must not be swappable. */
function fileWritableByOthers(mode: number): boolean {
  return (mode & 0o022) !== 0;
}
/** A directory is refused only when WORLD-writable, so a group-writable
 *  package-manager bin (Homebrew's 0775) stays usable. */
function dirWorldWritable(mode: number): boolean {
  return (mode & 0o002) !== 0;
}

/**
 * A Settings pin names the program to run. Refuse one that resolves to a
 * non-file, or to a file group/other can modify, or to a world-writable
 * directory: a dropped `/tmp/evil` pinned as `git` would otherwise run as the
 * daemon. A private `mkdtemp` fixture (0700) and Homebrew's 0775 bin pass. On
 * POSIX the owner must be this user or root.
 */
function assertTrustedBinary(resolved: string): string {
  if (!isAbsolute(resolved)) throw new Error(`binary pin must be absolute: ${resolved}`);
  let st: ReturnType<typeof statSync> | undefined;
  try {
    st = statSync(resolved);
  } catch {
    // A Windows app-execution alias (`WindowsApps\winget.exe`) can answer EACCES
    // to stat; `resolvePinnedBinary` already vouched for it, so only POSIX
    // refuses here.
    if (process.platform === 'win32') return resolved;
    throw new Error(`binary pin not found: ${resolved}`);
  }
  if (!st.isFile()) throw new Error(`binary pin is not a file: ${resolved}`);
  if (process.platform !== 'win32') {
    if (fileWritableByOthers(st.mode)) throw new Error(`binary pin is writable by group/other: ${resolved}`);
    const dir = dirname(resolved);
    let dirStat: ReturnType<typeof statSync> | undefined;
    try { dirStat = statSync(dir); } catch { dirStat = undefined; }
    if (dirStat && dirWorldWritable(dirStat.mode)) throw new Error(`binary pin sits in a world-writable directory: ${dir}`);
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      if (st.uid !== uid && st.uid !== 0) throw new Error(`binary pin is not owned by this user or root: ${resolved}`);
    }
  }
  return resolved;
}

function resolveBin(pins: BinaryPins, name: string, options: BinarySearchOptions): string {
  const configured = pins()[name];
  if (configured) {
    const pinned = resolvePinnedBinary(name, configured, options);
    if (pinned) return assertTrustedBinary(pinned);
    throw new Error(`binary "${name}" not found or not executable: ${configured}`);
  }
  const resolved = findExecutableBinary(name, options);
  if (resolved) return resolved;
  throw new Error(`binary "${name}" not found in PATH`);
}

function resultOf(r: ReturnType<typeof spawnSync>): ExecResult {
  return {
    code: r.status ?? (r.error ? 1 : 0),
    stdout: typeof r.stdout === 'string' ? r.stdout : r.stdout?.toString() ?? '',
    stderr: typeof r.stderr === 'string' ? r.stderr : r.stderr?.toString() ?? r.error?.message ?? '',
  };
}

/**
 * `binaryOptions` stands in for the real platform and environment in tests.
 * `pins` defaults to the config the adapter was built with; the daemon passes
 * the LIVE config instead, so a path pinned from Settings reaches the next
 * spawn without a restart (TODO #413).
 */
export function createGenericHost(
  config: TimonConfig,
  binaryOptions: BinarySearchOptions = {},
  pins: BinaryPins = () => config.host.binaries,
): Host {
  const bin = (name: string) => resolveBin(pins, name, binaryOptions);
  const findRuntime = (name: 'node' | 'bun') => {
    try { return bin(name); } catch { return null; }
  };
  // An npm shim (`.cmd`) cannot be spawned directly on Windows: EINVAL before
  // any process exists (TIM-0009). What it runs is started in its place, so the
  // CLI dies with the daemon (TODO #603); a shim we cannot read that way goes
  // through `cmd.exe`. Real binaries are passed through untouched.
  const launch = (file: string, args: string[]) => {
    const direct = windowsDirectLaunch(file, args, { findRuntime, platform: binaryOptions.platform });
    if (direct) return { file: direct.file, args: direct.args, extra: {} };
    const shim = windowsShimLaunch(file, args);
    return shim
      ? { file: shim.file, args: shim.args, extra: { windowsVerbatimArguments: true as const } }
      : { file, args, extra: {} };
  };
  const exec = (name: string, args: string[], opts: ExecOpts = {}) => {
    const l = launch(bin(name), args);
    return resultOf(spawnSync(l.file, l.args, { ...opts, ...l.extra, encoding: 'utf8' }));
  };
  const execAsync = (name: string, args: string[], opts: ExecOpts = {}) => new Promise<ExecResult>((resolve) => {
    const l = launch(bin(name), args);
    execFile(l.file, l.args, { ...opts, ...l.extra }, (error, stdout, stderr) => resolve({
      code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
      stdout: stdout?.toString() ?? '',
      stderr: stderr?.toString() ?? error?.message ?? '',
      // `killed` is also set when the output overran `maxBuffer`: the command
      // did answer then, too much.
      ...(error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { timedOut: true } : {}),
    }));
  });
  // A spawn must NEVER fail with a synchronous exception: the callers
  // (agent.ts first of all) rely on the child's `error` event to
  // finalise cleanly. Unresolved binary → the bare name is passed and node
  // reports the ENOENT through that channel, as before the adapter.
  const spawn = (name: string, args: string[], opts: SpawnOpts = {}): ChildProcess => {
    let resolved = name;
    try { resolved = bin(name); } catch { /* ENOENT fallback through the `error` event */ }
    // `opts.env` set = COMPLETE environment, passed verbatim. Merging it
    // with `process.env` would void the allowlist of `missionEnv`
    // (SECRETS-VAULT.md §6.1): the daemon's secrets would come back this way,
    // and the absence tests would pass for the wrong reasons. Without
    // `opts.env`, inheritance stays node's default.
    const l = launch(resolved, args);
    return nodeSpawn(l.file, l.args, { ...(opts.env ? { ...opts, env: opts.env } : opts), ...l.extra });
  };

  const unitsDir = join(TIMON_HOME, 'tmp', 'units');
  const pidFile = (unit: string) => join(unitsDir, `${unit}.pid`);
  const readPid = (unit: string): number | null => {
    try {
      const pid = Number(readFileSync(pidFile(unit), 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  const docker = (() => {
    if (config.host.docker === 'disabled') return undefined;
    try {
      bin('docker');
      if (exec('docker', ['info'], { timeout: 5_000 }).code !== 0) return undefined;
      return { cli: (args: string[], timeoutMs = 120_000) => exec('docker', args, { timeout: timeoutMs }) };
    } catch { return undefined; }
  })();

  // `gui` is always carried on Windows and macOS (unless `host.gui: 'disabled'`):
  // the file-manager route must stay mounted. Whether this daemon can actually
  // put a window on a desktop is a separate, per-request answer — the service
  // runs in session 0 (S4U) or the `system` launchd domain, where nothing it
  // launches is visible. Only the file manager is wired — no `openTerminal`.
  const nativePlatform = binaryOptions.platform ?? process.platform;
  const nativeGui = (nativePlatform === 'win32' || nativePlatform === 'darwin')
    && config.host.gui !== 'disabled';
  let session: Promise<DesktopSession> | undefined;
  const gui: Host['gui'] = nativeGui ? {
    reveal: (path) => revealInFileManager(
      nativePlatform as 'win32' | 'darwin',
      path,
      opensAsFolder(nativePlatform as 'win32' | 'darwin', path),
    ),
    // A process never changes session: one probe per daemon lifetime.
    desktopSession: () => (session ??= detectDesktopSession(nativePlatform)),
  } : undefined;

  const capabilities = (): Capability[] => {
    const out: Capability[] = [];
    if (docker) out.push('containers');
    if (config.host.traefik) out.push('traefik');
    if (gui) out.push('gui');
    for (const capability of ['git', 'grepai', 'uvx'] as const) {
      try { bin(capability); out.push(capability); } catch { /* capability missing */ }
    }
    return out;
  };

  return {
    platform: process.platform as Host['platform'],
    inspectPort: (address, port) => inspectListenPort({ platform: process.platform as Host['platform'], execAsync }, address, port),
    capabilities,
    bin,
    exec,
    execAsync,
    spawn,
    confine: (cmd, args) => ({ cmd, args }),
    services: {
      start(unit, cmd, args, cwd) {
        mkdirSync(unitsDir, { recursive: true });
        const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
        if (!child.pid) throw new Error(`cannot start unit "${unit}"`);
        writeFileSync(pidFile(unit), String(child.pid));
        child.unref();
      },
      stop(unit) {
        const pid = readPid(unit);
        if (pid !== null && alive(pid)) process.kill(pid, 'SIGTERM');
        rmSync(pidFile(unit), { force: true });
      },
      status(unit) {
        const pid = readPid(unit);
        return pid !== null && alive(pid) ? 'running' : 'stopped';
      },
      self: () => ({ status: 'running' }),
      selfRestart: () => {},
    },
    containers: docker,
    gui,
    spawnDetached: (spec) => spawnDetachedGeneric(spec),
  };
}
