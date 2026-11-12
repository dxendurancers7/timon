/**
 * The mission CLIs this daemon started, on disk, so that what a dead daemon
 * left running can still be ended (TODO #565).
 *
 * Why a file and not memory: the daemon that knew its missions is precisely
 * the one that is gone. A daemon killed outright (crash, OOM, `taskkill /F`,
 * an app quit in portable mode) runs no exit handler, and its CLIs then live
 * on reparented to init: out of reach of a process-group signal as soon as a
 * CLI started anything in its own group, and of `taskkill /T`, which only
 * follows a living parent. Two readers end them: the next daemon at boot
 * (`kernel-boot.ts`, before the zombie missions are failed) and the desktop
 * once its embedded daemon has stopped (`mission-process-sweep-runner.ts`).
 *
 * One file per process (`<pid>.json`): creating and deleting a file is atomic,
 * so no read-modify-write of a shared list can lose an entry.
 *
 * A pid alone is never enough to signal: after a reboot or enough churn the
 * number belongs to a stranger. Each record carries the process's start
 * identity (start time, plus the boot id on Linux), read at launch; the sweep
 * reads it again and only a process that still answers with the same identity
 * is ended. Anything else in the directory is dropped untouched.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { descendantsOf, readProcessTable, type ProcessEntry } from './process-tree.js';
import type { Host } from './types.js';

export type MissionProcessRecord = {
  pid: number;
  missionId: string;
  /** What the OS says about when this process started — see `processIdentity`. */
  identity: string;
  /** The daemon that launched it, and its identity: while it lives, its records are its own. */
  owner: number;
  ownerIdentity: string;
  recordedAt: number;
};

type IdentityHost = Pick<Host, 'platform' | 'execAsync'>;

const RECORD_FILE = /^(\d+)\.json$/;
const MAX_IDENTITY = 200;

/** `<home>/run/missions`: machine-local, rebuilt by every launch, never exported. */
export function missionProcessDir(home: string): string {
  return join(home, 'run', 'missions');
}

/** A pid that may be signalled at all: `kill(0|-n)` reaches a whole group, `1` is init. */
function signallablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1;
}

/** Linux `starttime` (field 22 of `/proc/<pid>/stat`), read after the LAST `)` of comm. */
export function parseProcStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const start = stat.slice(close + 1).trim().split(/\s+/)[19];
  return start && /^\d+$/.test(start) ? start : null;
}

// The pid travels in the environment and is cast to [int] inside PowerShell: no
// value is ever spliced into the command string, so a non-integer could not
// break out of the WMI filter.
const WINDOWS_CREATION = String.raw`$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:TIMON_MISSION_PID); if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;

/**
 * When `pid` started, as the OS words it, or null when it does not exist (or
 * the platform cannot say). Never throws. Compared verbatim, never parsed.
 */
export async function processIdentity(host: IdentityHost, pid: number): Promise<string | null> {
  if (!signallablePid(pid)) return null;
  try {
    if (host.platform === 'linux') {
      // portability: Linux pseudo-fs, behind the platform guard above
      const start = parseProcStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'));
      if (!start) return null;
      // A start time counts ticks since boot: without the boot, a reboot could match.
      // portability: Linux pseudo-fs, behind the platform guard above
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
      return `${boot || 'boot?'}:${start}`;
    }
    const r = host.platform === 'win32'
      ? await host.execAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREATION], {
          timeout: 10_000, windowsHide: true, env: { ...process.env, TIMON_MISSION_PID: String(pid) },
        })
      : await host.execAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5_000 });
    const said = r.code === 0 ? r.stdout.replace(/^﻿/, '').trim() : '';
    return said && said.length <= MAX_IDENTITY ? said : null;
  } catch {
    return null;
  }
}

/** Written to a temporary name then renamed: a reader never sees half a record. */
export function recordMissionProcess(dir: string, record: MissionProcessRecord): void {
  if (!signallablePid(record.pid)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${record.pid}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, file);
}

export function forgetMissionProcess(dir: string, pid: number): void {
  if (!signallablePid(pid)) return;
  rmSync(join(dir, `${pid}.json`), { force: true });
}

/** A record as it must be to be acted on; anything else is null. */
export function parseMissionProcessRecord(fileName: string, text: string): MissionProcessRecord | null {
  const named = RECORD_FILE.exec(fileName);
  if (!named) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!signallablePid(r.pid) || String(r.pid) !== named[1]) return null;
  if (typeof r.identity !== 'string' || !r.identity || r.identity.length > MAX_IDENTITY) return null;
  if (!signallablePid(r.owner) || r.owner === r.pid) return null;
  if (typeof r.ownerIdentity !== 'string' || !r.ownerIdentity || r.ownerIdentity.length > MAX_IDENTITY) return null;
  if (typeof r.missionId !== 'string' || r.missionId.length > 200) return null;
  if (typeof r.recordedAt !== 'number' || !Number.isFinite(r.recordedAt)) return null;
  return {
    pid: r.pid, missionId: r.missionId, identity: r.identity,
    owner: r.owner, ownerIdentity: r.ownerIdentity, recordedAt: r.recordedAt,
  };
}

/** This daemon's own identity, read once: it never changes while it runs. */
let selfIdentity: Promise<string | null> | undefined;

/**
 * Records a freshly spawned mission CLI and forgets it on exit. The identity is
 * read after the spawn (asynchronous on macOS and Windows); a CLI that exits
 * first is never written, nor one whose daemon cannot name itself (its record
 * could not be told from a dead daemon's). Never throws: a registry that
 * cannot be written leaves the mission as it was before this registry existed.
 */
export function trackMissionProcess(
  proc: Pick<ChildProcess, 'pid' | 'once'>,
  missionId: string,
  opts: { dir: string; host: IdentityHost; now?: () => number; owner?: number },
): void {
  const pid = proc.pid;
  if (!signallablePid(pid)) return;
  const owner = opts.owner ?? process.pid;
  const ownerIdentity = opts.owner === undefined
    // A failed read is not kept: the next launch asks again.
    ? (selfIdentity ??= processIdentity(opts.host, process.pid).then((id) => { if (!id) selfIdentity = undefined; return id; }))
    : processIdentity(opts.host, owner);
  let exited = false;
  let written = false;
  proc.once('exit', () => {
    exited = true;
    if (written) { try { forgetMissionProcess(opts.dir, pid); } catch { /* best effort */ } }
  });
  void Promise.all([processIdentity(opts.host, pid), ownerIdentity]).then(([identity, ownerId]) => {
    if (exited || !identity || !ownerId) return;
    recordMissionProcess(opts.dir, { pid, missionId, identity, owner, ownerIdentity: ownerId, recordedAt: (opts.now ?? Date.now)() });
    written = true;
  }).catch((error: unknown) => {
    console.warn(`[missions] could not record mission process ${pid}: ${(error as Error).message}`);
  });
}

export type SweepOps = {
  platform: Host['platform'];
  identity: (pid: number) => Promise<string | null>;
  table: () => Promise<ProcessEntry[]>;
  /** POSIX only. */
  signal: (pid: number, signal: NodeJS.Signals) => void;
  /** Windows only: ends a living process and its tree (`taskkill /T /F`). */
  endTree: (pid: number) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** Never signalled whatever a record says: this process and its parent. */
  self: readonly number[];
  /** POSIX: how long a SIGTERM is given before SIGKILL. */
  graceMs?: number;
};

/** `kept`: records of a daemon still alive, left in place. */
export type SweepResult = { ended: number[]; dropped: number; kept: number };

/** Production seams over the host adapter. */
export function sweepOpsFor(host: IdentityHost): SweepOps {
  return {
    platform: host.platform,
    identity: (pid) => processIdentity(host, pid),
    table: () => readProcessTable(host),
    signal: (pid, signal) => process.kill(pid, signal),
    endTree: async (pid) => { await host.execAsync('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 10_000, windowsHide: true }); },
    // Not unref'd: in the desktop's runner nothing else holds the event loop,
    // and the process would exit in the middle of the grace, SIGKILL unsent.
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: Date.now,
    self: [process.pid, process.ppid],
  };
}

const quietly = (fn: () => void): void => { try { fn(); } catch { /* gone already */ } };

/**
 * Ends every recorded mission CLI still alive under the same identity, with
 * what it started, and empties the registry. Only for processes whose daemon
 * is gone: the caller is the next daemon before it launches anything, or the
 * desktop after its embedded daemon exited.
 */
export async function endRecordedMissionProcesses(dir: string, ops: SweepOps): Promise<SweepResult> {
  let names: string[];
  try { names = readdirSync(dir); } catch { return { ended: [], dropped: 0, kept: 0 }; }
  const self = new Set(ops.self);
  const ended: number[] = [];
  let dropped = 0;
  let kept = 0;
  /** POSIX: every process signalled, to SIGKILL those still there after the grace. */
  const signalled: { pid: number; name: string | null; identity?: string }[] = [];
  let table: ProcessEntry[] | undefined;

  for (const name of names) {
    const path = join(dir, name);
    // A record being written right now (`recordMissionProcess`); a stale one
    // is what a writer killed mid-write left, and holds nothing to act on.
    if (name.endsWith('.tmp')) {
      try { if (ops.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true }); } catch { /* gone */ }
      continue;
    }
    let record: MissionProcessRecord | null = null;
    try { record = parseMissionProcessRecord(name, readFileSync(path, 'utf8')); } catch { /* unreadable: dropped */ }
    // A living daemon's missions are its own business, even when that daemon
    // is the caller: it may have launched one before sweeping at boot.
    if (record && await ops.identity(record.owner) === record.ownerIdentity) { kept++; continue; }
    rmSync(path, { force: true, recursive: true });
    if (!record || self.has(record.pid) || await ops.identity(record.pid) !== record.identity) {
      dropped++;
      continue;
    }
    ended.push(record.pid);
    if (ops.platform === 'win32') {
      await ops.endTree(record.pid).catch(() => {});
      continue;
    }
    table ??= await ops.table();
    quietly(() => ops.signal(record.pid, 'SIGTERM'));
    signalled.push({ pid: record.pid, name: null, identity: record.identity });
    for (const child of descendantsOf(table, record.pid)) {
      if (!signallablePid(child.pid) || self.has(child.pid)) continue;
      quietly(() => ops.signal(child.pid, 'SIGTERM'));
      signalled.push({ pid: child.pid, name: child.name });
    }
  }

  if (signalled.length === 0) return { ended, dropped, kept };
  const grace = ops.graceMs ?? 3_000;
  for (let waited = 0; waited < grace; waited += 250) {
    await ops.wait(250);
    const now = new Set((await ops.table()).map((p) => p.pid));
    if (signalled.every((s) => !now.has(s.pid))) return { ended, dropped, kept };
  }
  // Same check as before the SIGTERM: the root by identity, the rest by name
  // under the same pid — a few seconds are far too short for a pid to recycle.
  const now = new Map((await ops.table()).map((p) => [p.pid, p]));
  for (const s of signalled) {
    const live = now.get(s.pid);
    if (!live) continue;
    if (s.identity !== undefined ? await ops.identity(s.pid) !== s.identity : live.name !== s.name) continue;
    quietly(() => ops.signal(s.pid, 'SIGKILL'));
  }
  return { ended, dropped, kept };
}

/**
 * `timon service stop` and "Quit and stop the background service": the
 * supervisor ends the daemon's own tree, not what left it — a systemd mission
 * scope is not in the service's cgroup, a CLI's detached child is not in its
 * launchd job's group. A daemon still running keeps its records (owner check).
 * Returns the line for the command's report, or null when there was nothing.
 */
export async function endMissionsOfStoppedDaemon(home: string, host: IdentityHost): Promise<string | null> {
  try {
    const { ended } = await endRecordedMissionProcesses(missionProcessDir(home), sweepOpsFor(host));
    return ended.length ? `ended ${ended.length} mission process(es) the daemon left running` : null;
  } catch (error) {
    return `could not end the daemon's mission processes: ${(error as Error).message}`;
  }
}
