/**
 * File browser scoped to an agent's working directory.
 *
 * Used by the chat sidebar "Files" tab so the user can poke around the
 * code an agent is acting on without leaving the chat. Reads are always
 * sandboxed under `agent.cwd` — any request that resolves outside (via
 * symlink or `..`) is rejected before touching disk. Writes go through
 * the same sandbox check and refuse to clobber directories.
 *
 * Large files are truncated at MAX_FILE_BYTES on read so the UI doesn't
 * try to render a 50 MB minified bundle. Binary files are detected via a
 * NUL-byte sniff and surfaced as a stub instead of garbled text.
 */

import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { MAX_LOCAL_MEDIA_BYTES, MediaError, mediaHeaders, sniffMedia } from './chat-media.js';
import { safeAttachmentName } from './chat-attachments.js';
import type { OpenedFile } from './media-send.js';
import { chooseRevealLane, getHost, type RevealVia } from './host/index.js';
import { toPosixRelative } from './host/portable-names.js';
import { TIMON_HOME, agentDir } from './paths.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { cwdProblem } from './cwd-check.js';
import { readFileSync as readFile } from 'node:fs';

const MAX_FILE_BYTES = 256 * 1024;
const HIDDEN_PREFIXES = ['.git'];

export type DirEntry = {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  modified: number;
  /** Absolute path on the host, built with `node:path` so it carries the OS's own separators. */
  abs: string;
};

export type DirListing = {
  kind: 'dir';
  path: string;
  /** Absolute path of the listed folder on the host. */
  abs: string;
  entries: DirEntry[];
};

export type FileBody = {
  kind: 'file';
  path: string;
  size: number;
  modified: number;
  binary: boolean;
  truncated: boolean;
  content: string;
};

export type ReadResult = DirListing | FileBody;

function loadAgentCwd(agentName: string): string {
  const cfgPath = join(agentDir(agentName), 'config.json');
  if (!existsSync(cfgPath)) {
    throw new Error(`agent not found: ${agentName}`);
  }
  const cfg = JSON.parse(readFile(cfgPath, 'utf8')) as { cwd?: string };
  if (!cfg.cwd) {
    throw new Error(`agent "${agentName}" has no cwd configured`);
  }
  const problem = cwdProblem(cfg.cwd);
  if (problem === 'cwd not found') throw new Error(`agent cwd does not exist on disk: ${cfg.cwd}`);
  if (problem) throw new Error(`agent ${problem}: ${cfg.cwd}`);
  // Resolve the real path once so symlinked roots are anchored.
  return realpathSync(cfg.cwd);
}

/** Verify the requested relative path stays inside the sandboxed root.
 *  Returns the resolved absolute path on success. */
function safeResolve(root: string, rel: string): string {
  // On Windows a leading `\` is drive-rooted, not relative: strip it like `/`.
  const cleaned = (rel || '').replace(sep === '\\' ? /^[\\/]+/ : /^\/+/, '');
  const abs = resolve(root, cleaned);
  // Resolve the deepest EXISTING ancestor, so a symlinked parent cannot smuggle
  // a not-yet-created leaf outside the root. (Resolving only `abs` left a new
  // path unresolved, and a later write followed the symlink out.)
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  let real = abs;
  try {
    const anchor = realpathSync(existing);
    real = tail.length ? join(anchor, ...tail) : anchor;
  } catch {
    real = abs;
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error('path escapes agent cwd');
  }
  return real;
}

/** Where `target` (inside `root`) sits, in the forward-slash form the API
 *  answers with on every OS — the client never sees `docs\a.md` (TODO #541). */
function relFrom(root: string, target: string): string {
  return target === root ? '' : toPosixRelative(target.slice(root.length + 1));
}

function isHidden(name: string): boolean {
  return HIDDEN_PREFIXES.includes(name) || name.startsWith('.DS_Store');
}

function sniffBinary(buf: Buffer): boolean {
  // First 8 KB sample — NUL byte is a strong signal.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export function browseAgentFiles(agentName: string, relPath: string): ReadResult {
  const root = loadAgentCwd(agentName);
  const target = safeResolve(root, relPath);
  const st = statSync(target);
  const relFromRoot = relFrom(root, target);

  if (st.isDirectory()) {
    const raw = readdirSync(target, { withFileTypes: true });
    const entries: DirEntry[] = raw
      .filter((d) => !isHidden(d.name))
      .map((d) => {
        const childAbs = join(target, d.name);
        let size = 0, modified = 0;
        try {
          const cs = statSync(childAbs);
          size = cs.size;
          modified = cs.mtimeMs;
        } catch { /* unreadable child */ }
        const kind: DirEntry['kind'] = d.isDirectory()
          ? 'dir'
          : d.isFile()
            ? 'file'
            : d.isSymbolicLink()
              ? 'symlink'
              : 'other';
        return { name: d.name, kind, size, modified, abs: childAbs };
      })
      .sort((a, b) => {
        // Directories first, then alpha.
        if (a.kind !== b.kind) {
          if (a.kind === 'dir') return -1;
          if (b.kind === 'dir') return 1;
        }
        return a.name.localeCompare(b.name);
      });
    return { kind: 'dir', path: relFromRoot, abs: target, entries };
  }

  if (st.isFile()) {
    const buf = readFileSync(target);
    const binary = sniffBinary(buf);
    const truncated = buf.length > MAX_FILE_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
    const content = binary
      ? `[binary file, ${st.size} bytes — preview omitted]`
      : slice.toString('utf8');
    return {
      kind: 'file',
      path: relFromRoot,
      size: st.size,
      modified: st.mtimeMs,
      binary,
      truncated,
      content,
    };
  }

  throw new Error(`unsupported entry kind at ${relFromRoot}`);
}

/** Reject path patterns that smell like an accident: the agent's own
 *  config, anything under .git internals (we can browse but not edit),
 *  lockfiles auto-managed by package managers. The list is conservative —
 *  expand if real cases come up. */
const WRITE_DENY = [
  /(^|\/)\.git\//i,        // git internals
  /(^|\/)node_modules\//i, // npm install would rewrite anyway
];

/** Windows resolves `\` as a separator and ignores case, so `.GIT\hooks\x`
 *  reaches `.git/hooks/x` there: the deny list reads every request that way,
 *  on every OS — refusing an odd POSIX name costs nothing (TODO #541). */
function writeDenied(rel: string): boolean {
  const probe = '/' + rel.replaceAll('\\', '/');
  return WRITE_DENY.some((re) => re.test(probe));
}

export type WriteResult = {
  kind: 'file';
  path: string;
  size: number;
  modified: number;
};

export function writeAgentFile(
  agentName: string,
  relPath: string,
  content: string,
): WriteResult {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('path required');
  }
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }
  if (writeDenied(relPath)) {
    throw new Error(`writes refused under this path: ${relPath}`);
  }
  const root = loadAgentCwd(agentName);
  const target = safeResolve(root, relPath);
  // If the target exists and is a directory, refuse — otherwise we'd
  // turn `src/` into a regular file containing the user's blob.
  if (existsSync(target)) {
    const st = statSync(target);
    if (!st.isFile()) {
      throw new Error(`refusing to overwrite non-file: ${relPath}`);
    }
  } else {
    // Allow creating new files. Make the parent dir if it doesn't exist
    // yet (also sandbox-checked because safeResolve already vetted the
    // full path's resolution stays inside root).
    mkdirSync(dirname(target), { recursive: true });
  }
  writeFileSync(target, content, 'utf8');
  const st = statSync(target);
  const relFromRoot = relFrom(root, target);
  return {
    kind: 'file',
    path: relFromRoot,
    size: st.size,
    modified: st.mtimeMs,
  };
}

export function deleteAgentPath(
  agentName: string,
  relPath: string,
): { kind: 'deleted'; path: string } {
  if (!relPath) throw new Error('path required');
  if (writeDenied(relPath)) throw new Error(`deletes refused under this path: ${relPath}`);
  const root = loadAgentCwd(agentName);
  const target = safeResolve(root, relPath);
  if (target === root) throw new Error('cannot delete the agent root');
  if (!existsSync(target)) throw new Error(`not found: ${relPath}`);
  const st = statSync(target);
  if (st.isDirectory()) {
    rmSync(target, { recursive: true, force: true });
  } else {
    unlinkSync(target);
  }
  return { kind: 'deleted', path: relPath.replace(/^\/+/, '') };
}

export function mkdirAgentPath(
  agentName: string,
  relPath: string,
): { kind: 'dir'; path: string } {
  if (!relPath) throw new Error('path required');
  if (writeDenied(relPath)) throw new Error(`mkdir refused under this path: ${relPath}`);
  const root = loadAgentCwd(agentName);
  const target = safeResolve(root, relPath);
  if (existsSync(target)) {
    const st = statSync(target);
    if (!st.isDirectory()) throw new Error(`a file already exists at: ${relPath}`);
  }
  mkdirSync(target, { recursive: true });
  const relFromRoot = relFrom(root, target);
  return { kind: 'dir', path: relFromRoot };
}

/**
 * Moves a file or folder into another folder of the same agent (drag and drop
 * in the Files widget). Never overwrites: an entry of the same name at the
 * destination is a refusal. The source is resolved lexically so that moving a
 * symlink moves the link itself, not its target.
 */
export function moveAgentPath(
  agentName: string,
  fromRel: string,
  toDirRel: string,
): { kind: 'moved'; from: string; path: string } {
  const from = (fromRel || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!from) throw new Error('path required');
  const root = loadAgentCwd(agentName);
  const src = resolve(root, from);
  if (src === root || !src.startsWith(root + sep)) throw new Error('path escapes agent cwd');
  // A symlinked parent could still lead out of the root.
  safeResolve(root, relFrom(root, dirname(src)));
  if (!lstatSync(src, { throwIfNoEntry: false })) throw new Error(`not found: ${from}`);
  const destDir = safeResolve(root, toDirRel || '');
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new Error(`not a folder: ${toDirRel || '/'}`);
  }
  const dest = join(destDir, basename(src));
  const destRel = relFrom(root, dest);
  if (writeDenied(from) || writeDenied(destRel)) {
    throw new Error(`moves refused under this path: ${from}`);
  }
  if (dest === src) throw new Error('already in this folder');
  if (destDir === src || destDir.startsWith(src + sep)) {
    throw new Error('cannot move a folder into itself');
  }
  if (lstatSync(dest, { throwIfNoEntry: false })) {
    throw new Error(`${basename(src)} already exists in the destination`);
  }
  renameSync(src, dest);
  return { kind: 'moved', from, path: destRel };
}

/** Renames an entry in place. `newName` is a bare name: no separator, so it can never move the entry. */
export function renameAgentPath(
  agentName: string,
  relPath: string,
  newName: string,
): { kind: 'renamed'; from: string; path: string } {
  const name = (newName || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
    throw new Error('invalid name');
  }
  const from = (relPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!from) throw new Error('path required');
  const root = loadAgentCwd(agentName);
  const src = resolve(root, from);
  if (src === root || !src.startsWith(root + sep)) throw new Error('path escapes agent cwd');
  safeResolve(root, relFrom(root, dirname(src)));
  const srcStat = lstatSync(src, { throwIfNoEntry: false });
  if (!srcStat) throw new Error(`not found: ${from}`);
  const dest = join(dirname(src), name);
  const destRel = relFrom(root, dest);
  if (writeDenied(from) || writeDenied(destRel)) {
    throw new Error(`renames refused under this path: ${from}`);
  }
  if (dest === src) throw new Error('same name');
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  // On a case-insensitive volume (Windows, macOS by default) `Notes.txt` finds
  // `notes.txt` itself: a change of case only, which the rename performs.
  // Anything else found there is another entry and is never overwritten.
  const caseOnly = existing !== undefined
    && name.toLowerCase() === basename(src).toLowerCase()
    && existing.ino === srcStat.ino && existing.dev === srcStat.dev;
  if (existing && !caseOnly) throw new Error(`${name} already exists here`);
  renameSync(src, dest);
  return { kind: 'renamed', from, path: destRel };
}

export type RevealResult =
  | {
    kind: 'revealed';
    path: string;
    /** Channel actually used, reported by the host adapter — useful
     *  on the UI side to say why nothing opened when the desktop is not
     *  reachable. */
    via: RevealVia;
  }
  | {
    /** Nothing was launched: the daemon has no desktop session (Windows
     *  service in session 0, macOS LaunchDaemon). `absolutePath` is the path
     *  already validated and confined to the agent folder; the client that
     *  lives in the user's session shows it. Never read as "revealed". */
    kind: 'client';
    path: string;
    absolutePath: string;
    isDir: boolean;
  };

/** The file is on the daemon's machine and nothing could show it: no desktop
 *  session here, and the caller cannot open it on its own. Mapped to 409 with
 *  `code` so the UI can say so in the user's language. */
export class RevealUnavailableError extends Error {
  readonly code = 'no_desktop_session';
  constructor() {
    super('could not open the desktop file manager: the file is on the machine running the Timon daemon, which has no desktop session to show it on');
  }
}

/** Opens the location in the host desktop's file manager.
 *
 *  For a file we go through org.freedesktop.FileManager1.ShowItems:
 *  it opens the parent folder with the file *selected*, where an
 *  `xdg-open` on a file would launch it in its associated application
 *  (opening a .sh in an editor is not what is asked here).
 *  Falls back on `xdg-open` of the parent folder if no manager answers
 *  on the bus.
 *
 *  The daemon only launches something if it proves a desktop is there
 *  (`chooseRevealLane`); otherwise, a client installed in the user's
 *  session (`clientCanOpen`, the Electron app) receives the already
 *  validated path and opens it itself. */
export async function revealAgentPath(
  agentName: string,
  relPath: string,
  opts: { clientCanOpen?: boolean } = {},
): Promise<RevealResult> {
  const root = loadAgentCwd(agentName);
  const target = safeResolve(root, relPath);
  if (!existsSync(target)) throw new Error(`not found: ${relPath || '/'}`);
  const relFromRoot = relFrom(root, target);

  const gui = getHost().gui;
  const lane = chooseRevealLane({
    hostHasGui: Boolean(gui),
    // Where the adapter does not say, `gui` itself is the proof (Linux probes
    // the display before exposing it).
    hostSession: gui ? (gui.desktopSession ? await gui.desktopSession() : 'graphical') : 'none',
    clientCanOpen: opts.clientCanOpen === true,
  });
  if (lane === 'none') throw new RevealUnavailableError();
  if (lane === 'client') {
    return { kind: 'client', path: relFromRoot, absolutePath: target, isDir: statSync(target).isDirectory() };
  }
  const via = await gui!.reveal(target);
  return { kind: 'revealed', path: relFromRoot, via };
}

/* ── Viewer: raw bytes of a previewable file ───────────────────────────
   The listing above returns text and stubs binaries out. The Files widget's
   viewer needs the bytes themselves — an image, a video, a PDF, an Office
   document — served from the Timon origin under the same sandbox as every
   other read. What leaves is decided by the file's own first bytes, never by
   its name or a declared type; the name only tells a docx from an xlsx, both
   being a zip. SVG and HTML are refused: served same-origin, they run script. */

export type ViewerKind = 'image' | 'video' | 'pdf' | 'docx' | 'xlsx' | 'pptx';

const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/** An Office file is read whole by the browser to be unzipped: it is bounded
 *  well below what a video, which streams, may weigh. */
export const MAX_VIEWER_OFFICE_BYTES = 50 * 1024 * 1024;
const VIEWER_HEAD_BYTES = 32;

function isOfficeExt(ext: string): ext is keyof typeof OFFICE_MIME {
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx';
}

/** The part every document of a kind must carry: what tells a docx from any
 *  other zip renamed to `.docx`. */
const OFFICE_ROOT_PART = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
} as const;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
/** The end record sits in the last 22 bytes plus a comment of at most 64 KiB. */
const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + 0xffff;
/** A central directory is ~50 bytes per entry; this is far above any real
 *  document and keeps the read of a hostile one bounded. */
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  return buf.subarray(0, readSync(fd, buf, 0, length, position));
}

/**
 * Whether the open zip is an OOXML container holding `rootPart`. Reads the end
 * record and the central directory only — bounded, nothing is decompressed —
 * so a generic zip renamed `.docx`, a docx renamed `.xlsx` and a truncated
 * archive are told apart from a real document without unpacking any of them.
 * Zip64 archives (a 0xFFFF/0xFFFFFFFF sentinel) are not Office files under the
 * size bound and are refused.
 */
function zipHasPart(fd: number, size: number, rootPart: string): boolean {
  const tailLength = Math.min(size, EOCD_SEARCH_BYTES);
  const tailStart = size - tailLength;
  const tail = readAt(fd, tailLength, tailStart);
  let eocd = -1;
  for (let i = tail.length - EOCD_MIN_BYTES; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE && i + EOCD_MIN_BYTES + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  const entries = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) return false;
  const eocdPosition = tailStart + eocd;
  if (dirSize === 0 || dirSize > MAX_CENTRAL_DIRECTORY_BYTES || dirOffset + dirSize > eocdPosition) return false;
  const dir = readAt(fd, dirSize, dirOffset);
  if (dir.length !== dirSize) return false;
  let at = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > dir.length || dir.readUInt32LE(at) !== CENTRAL_ENTRY_SIGNATURE) return false;
    const nameLength = dir.readUInt16LE(at + 28);
    const extraLength = dir.readUInt16LE(at + 30);
    const commentLength = dir.readUInt16LE(at + 32);
    if (at + 46 + nameLength > dir.length) return false;
    if (dir.toString('utf8', at + 46, at + 46 + nameLength) === rootPart) return true;
    at += 46 + nameLength + extraLength + commentLength;
  }
  return false;
}

/** Headers for what is not a chat image or video. A PDF is shown inline and
 *  carries no `sandbox` policy — Chromium's PDF viewer refuses to load under
 *  one — but it is a document that cannot run script in our origin. An Office
 *  file is only ever downloaded or parsed by our own code, so it stays a
 *  sandboxed attachment. */
function documentHeaders(mime: string, name: string, inline: boolean): Record<string, string> {
  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return {
    'content-type': mime,
    'x-content-type-options': 'nosniff',
    ...(inline ? {} : { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }),
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'accept-ranges': 'bytes',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
}

/** Same sandbox as the listing, plus what a path that names a network share
 *  must not do: on Windows, merely testing that it exists makes the machine
 *  authenticate to that host — so it is refused before anything touches disk. */
function assertLocalRelative(rel: string): void {
  if (rel.includes('\0') || /^[\\/]{2}/.test(rel) || /^[a-z]:[\\/]/i.test(rel)) {
    throw new MediaError(400, 'invalid path', 'path_refused');
  }
}

/**
 * Opens an agent's file for the viewer, or refuses with a `MediaError`:
 * 403 outside the working directory, 404 absent or not a regular file, 413
 * over the size bound, 415 for anything the viewer will not put in front of a
 * browser. The descriptor the caller streams from is the one checked here.
 */
export function openAgentFileRaw(agentName: string, relPath: string): OpenedFile {
  assertLocalRelative(relPath);
  let target: string;
  try {
    target = safeResolve(loadAgentCwd(agentName), relPath);
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'path escapes agent cwd') throw new MediaError(403, message, 'outside_cwd');
    if (message.startsWith('agent not found')) throw new MediaError(404, message);
    throw new MediaError(400, message);
  }
  return openForViewer(target);
}

/** The checks and the descriptor of `openAgentFileRaw`, once the path is settled. */
function openForViewer(target: string): OpenedFile {
  let fd: number;
  try {
    fd = openSync(target, 'r');
  } catch {
    throw new MediaError(404, 'not found');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0) throw new MediaError(404, 'not found');
    const head = Buffer.alloc(VIEWER_HEAD_BYTES);
    const bytes = head.subarray(0, readSync(fd, head, 0, VIEWER_HEAD_BYTES, 0));
    const name = safeAttachmentName(target.split(/[\\/]/).pop());
    const media = sniffMedia(bytes);
    if (media) {
      if (st.size > MAX_LOCAL_MEDIA_BYTES) throw new MediaError(413, 'file too large');
      return { fd, size: st.size, name, media };
    }
    if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
      if (st.size > MAX_LOCAL_MEDIA_BYTES) throw new MediaError(413, 'file too large');
      return {
        fd, size: st.size, name,
        headers: (download) => documentHeaders('application/pdf', name, !download),
      };
    }
    const ext = extname(target).slice(1).toLowerCase();
    const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (zip && isOfficeExt(ext)) {
      if (st.size > MAX_VIEWER_OFFICE_BYTES) throw new MediaError(413, 'file too large');
      if (!zipHasPart(fd, st.size, OFFICE_ROOT_PART[ext])) throw new MediaError(415, 'this file has no preview');
      return {
        fd, size: st.size, name,
        headers: () => documentHeaders(OFFICE_MIME[ext], name, false),
      };
    }
    throw new MediaError(415, 'this file has no preview');
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────────
   Files outside an agent's folder — only reached after the user confirmed
   a link the agent posted, and only for an account holding `files:external`
   (see the routes). The path is absolute; nothing about it is relative to the
   agent. Reads and writes target an existing regular file: this never lists a
   folder and never creates a file.
   ──────────────────────────────────────────────────────────────────── */

/**
 * `/D:/…` is the `file:` URL spelling of a Windows path, and some clients send it
 * bare (TIM-0076). On Windows it would resolve to `\\D:\\…` on the current drive;
 * elsewhere `/D:/` is a legitimate folder named `D:` and stays untouched.
 */
export function normalizeExternalPath(absPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && /^[\\/][a-z]:[\\/]/i.test(absPath) ? absPath.slice(1) : absPath;
}

/** Credential stores the external-file API must never open, wherever a link points. */
function protectedExternalRoots(): string[] {
  const home = homedir();
  return [
    join(TIMON_HOME, 'secrets.env'),
    join(TIMON_HOME, 'daemon-token'),
    join(home, '.ssh'), join(home, '.aws'), join(home, '.gnupg'), join(home, '.kube'),
    join(home, '.netrc'), join(home, '.config', 'gcloud'), join(home, '.config', 'gh'),
    join(home, '.claude'), join(home, '.codex'), join(home, '.docker'),
  ];
}

const SECRET_FILE_NAMES = new Set([
  '.env', 'secrets.env', 'credentials', 'credentials.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);

/** Refuse a real path that sits in a credential store or is named like a secret. */
function assertExternalAllowed(real: string): void {
  if (SECRET_FILE_NAMES.has(basename(real))) throw new Error('refused: this file holds secrets');
  for (const root of protectedExternalRoots()) {
    if (real === root || real.startsWith(root + sep)) throw new Error('refused: this location holds credentials');
  }
}

/** An absolute local path to an existing regular file, resolved through symlinks. */
function resolveExternalFile(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0')) {
    throw new Error('an absolute local path is required');
  }
  const absPath = normalizeExternalPath(input);
  if (!isAbsolute(absPath) || /^[\\/]{2}/.test(absPath)) {
    throw new Error('an absolute local path is required');
  }
  let real: string;
  try { real = realpathSync(absPath); } catch { throw new Error(`not found: ${input}`); }
  if (!statSync(real).isFile()) throw new Error(`not a file: ${input}`);
  assertExternalAllowed(real);
  return real;
}

export function readExternalFile(absPath: string): FileBody {
  const target = resolveExternalFile(absPath);
  const st = statSync(target);
  const buf = readFileSync(target);
  const binary = sniffBinary(buf);
  const truncated = buf.length > MAX_FILE_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  return {
    kind: 'file',
    path: absPath,
    size: st.size,
    modified: st.mtimeMs,
    binary,
    truncated,
    content: binary ? `[binary file, ${st.size} bytes — preview omitted]` : slice.toString('utf8'),
  };
}

export function writeExternalFile(absPath: string, content: string): WriteResult {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const target = resolveExternalFile(absPath);
  writeFileSync(target, content, 'utf8');
  const st = statSync(target);
  return { kind: 'file', path: absPath, size: st.size, modified: st.mtimeMs };
}

export function openExternalFileRaw(absPath: string): OpenedFile {
  let target: string;
  try {
    target = resolveExternalFile(absPath);
  } catch (err) {
    const message = (err as Error).message;
    throw new MediaError(message.startsWith('not ') ? 404 : 400, message);
  }
  return openForViewer(target);
}
