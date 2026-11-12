/**
 * The notification sound a user imported, one per event.
 *
 * The browser decodes and plays; the daemon only keeps the bytes of the
 * account, so the same sound follows the user to every device. What that
 * makes of this route:
 *
 *  - **Session only, owner only.** The path carries no user id: the account is
 *    the session's, so another account's file cannot be named.
 *  - **Sniffed, not trusted.** The declared type is ignored; the first bytes
 *    must be one of the known audio containers, and the response type comes
 *    from that sniff — never from the client — with `nosniff` and an
 *    `attachment` disposition, so an uploaded file is never rendered as a page.
 *  - **Bounded.** 1 MiB, read AFTER authentication so an anonymous body is
 *    never buffered. Duration is checked by the browser, which decodes it.
 *  - **Written atomically**, `0600`, under a directory per account.
 */
import express, { type Request, type Response, type Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { NOTIFICATION_SOUNDS_DIR } from '../../paths.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth } from '../../users/identity.js';
import { apiError } from '../../api-error.js';

export const SOUND_EVENTS = ['taskDone', 'taskBlocked', 'approval', 'missionDone', 'taskStarted'] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];
export const SOUND_MAX_BYTES = 1024 * 1024;

const EventParam = z.enum(SOUND_EVENTS);
/** Account ids are uuids; anything else never reaches a path. */
const USER_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The container of an audio file from its first bytes, or `null`. */
export function sniffAudio(b: Buffer): string | null {
  if (b.length < 12) return null;
  const ascii = (from: number, to: number): string => b.toString('latin1', from, to);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // MPEG audio frame sync (MP3) and ADTS (AAC) share the 11-bit sync word.
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return (b[1]! & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  return null;
}

type Meta = { mime: string; name: string; size: number; updatedAt: number };

function fileOf(userId: string, event: SoundEvent): string {
  return join(NOTIFICATION_SOUNDS_DIR, userId, event);
}

function readMeta(userId: string, event: SoundEvent): Meta | null {
  try {
    const raw = JSON.parse(readFileSync(`${fileOf(userId, event)}.json`, 'utf8')) as Partial<Meta>;
    if (typeof raw.mime === 'string' && typeof raw.size === 'number') {
      return { mime: raw.mime, name: typeof raw.name === 'string' ? raw.name : '', size: raw.size, updatedAt: Number(raw.updatedAt) || 0 };
    }
  } catch { /* absent or unreadable: no sound */ }
  return null;
}

function sessionUserId(req: Request, res: Response): string | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!isPersonAuth(auth) || !auth.user || !USER_ID.test(auth.user.id)) {
    res.status(403).json({ error: 'session_required', message: 'a notification sound belongs to a signed-in account' });
    return null;
  }
  return auth.user.id;
}

/** A display name from the client: control characters and path parts are dropped. */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').split(/[\\/]/).pop()!.slice(0, 80);
}

export function registerSoundRoutes(router: Router): void {
  const raw = express.raw({ type: () => true, limit: SOUND_MAX_BYTES, inflate: false });

  router.get('/api/notifications/sounds', (req, res) => {
    const userId = sessionUserId(req, res);
    if (!userId) return;
    const sounds: Record<string, { name: string; size: number; mime: string; updatedAt: number }> = {};
    for (const event of SOUND_EVENTS) {
      const meta = readMeta(userId, event);
      if (meta) sounds[event] = { name: meta.name, size: meta.size, mime: meta.mime, updatedAt: meta.updatedAt };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sounds, maxBytes: SOUND_MAX_BYTES });
  });

  router.get('/api/notifications/sounds/:event', (req, res) => {
    const userId = sessionUserId(req, res);
    if (!userId) return;
    const event = EventParam.safeParse(req.params.event);
    if (!event.success) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    const meta = readMeta(userId, event.data);
    const file = fileOf(userId, event.data);
    if (!meta || !existsSync(file)) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    const bytes = readFileSync(file);
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment; filename="notification-sound"');
    res.send(bytes);
  });

  // Auth BEFORE the body is read: an anonymous upload is never buffered.
  router.put('/api/notifications/sounds/:event', (req, res) => {
    const userId = sessionUserId(req, res);
    if (!userId) return;
    const event = EventParam.safeParse(req.params.event);
    if (!event.success) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    raw(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status;
        res.status(status === 413 ? 413 : 400).json({
          error: status === 413 ? 'too_large' : 'invalid_body',
          message: status === 413 ? `a sound is at most ${SOUND_MAX_BYTES / 1024} KiB` : 'could not read the sound',
        });
        return;
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'invalid_body', message: 'expected the sound bytes' });
        return;
      }
      const mime = sniffAudio(body);
      if (!mime) {
        res.status(415).json({ error: 'unsupported_format', message: 'not a known audio file (WAV, MP3, OGG, FLAC, AAC/M4A, WebM)' });
        return;
      }
      const file = fileOf(userId, event.data);
      mkdirSync(join(NOTIFICATION_SOUNDS_DIR, userId), { recursive: true, mode: 0o700 });
      // An unpredictable name opened with O_EXCL: a symlink or file planted at a
      // guessable `<file>.tmp` cannot be followed, so the write cannot be steered.
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
      const meta: Meta = { mime, name: cleanName(req.header('x-sound-name')), size: body.length, updatedAt: Date.now() };
      const metaTmp = `${file}.${randomUUID()}.json.tmp`;
      writeFileSync(metaTmp, JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
      renameSync(metaTmp, `${file}.json`);
      try { chmodSync(file, 0o600); } catch { /* best effort off POSIX */ }
      auditRequest(req, 'notification-sound.set', event.data);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ ok: true, event: event.data, mime, size: body.length, name: meta.name });
    });
  });

  router.delete('/api/notifications/sounds/:event', (req, res) => {
    const userId = sessionUserId(req, res);
    if (!userId) return;
    const event = EventParam.safeParse(req.params.event);
    if (!event.success) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    const file = fileOf(userId, event.data);
    rmSync(file, { force: true });
    rmSync(`${file}.json`, { force: true });
    auditRequest(req, 'notification-sound.clear', event.data);
    res.json({ ok: true });
  });
}
