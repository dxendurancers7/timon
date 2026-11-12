/**
 * The daemon's second pass over an annotation of the built-in browser (TODO #468).
 *
 * The desktop bounds and masks a pick first (`desktop/src/native-browser-annotator.ts`); what it
 * sends is still untrusted here and bounded again before it is sealed: the preload runs next to a
 * page nobody vouches for. The two packages are built apart, so the helpers below are a copy of
 * the desktop's, kept honest by `browser-annotation-rules.test.ts`. Copied verbatim between the
 * two markers: change them together.
 *
 * Page text, outerHTML, title and the source path the page reports are DATA for the agent, never
 * instructions. The path in particular is accepted only inside the reading mission's cwd
 * (`missionSourcePath`): a page cannot point an agent at `~/.timon/…`.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { detectSecret, isSecretField, isSecretPlaceholder, maskUrl } from './browser-recording-rules.js';
import type { AnnotationRect, AnnotationLocator, AnnotationTarget } from './plugins/contract/browser-annotations.js';
export type { AnnotationRect, AnnotationLocator, AnnotationTarget } from './plugins/contract/browser-annotations.js';

export const ANNOTATION_OUTER_HTML_MAX = 8 * 1024;
export const ANNOTATION_TEXT_MAX = 300;
export const ANNOTATION_THUMBNAIL_MAX_SIDE = 800;
export const ANNOTATION_THUMBNAIL_MAX_BYTES = 200 * 1024;
/** What the user types about the element: the instruction, bounded like a chat message would not be. */
export const ANNOTATION_COMMENT_MAX = 4_000;
const SOURCE_PATH_MAX = 1_024;

export type AnnotationSourceFramework = 'react' | 'vue' | 'svelte';
export type AnnotationSourceVia = 'debugSource' | 'debugStack' | 'vueFile' | 'svelteMeta';
/** The source as the page reported it. `file` is page data: never handed out before `missionSourcePath`. */
export type RawAnnotationSource =
  | { detected: false }
  | { detected: true; framework: AnnotationSourceFramework; file: string; line?: number; column?: number;
    component?: string; via: AnnotationSourceVia; approximate?: true };

export interface AnnotationThumbnail { mimeType: 'image/jpeg'; data: string; width: number; height: number }

export interface SanitizedAnnotationCapture {
  capturedAt: number;
  /** Masked like a recorded URL; '' for an internal page. */
  url: string;
  title: string;
  point: { x: number; y: number };
  target: AnnotationTarget;
  rect: AnnotationRect;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  outerHtml: string;
  outerHtmlTruncated: boolean;
  source: RawAnnotationSource;
  thumbnail: AnnotationThumbnail | null;
}

// --- copied from desktop/src/native-browser-annotator.ts ------------------------------------
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Control characters are dropped: a page string ends up in a terminal or a prompt. */
function stringOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, max) : '';
}

function tokenOf(value: unknown): string {
  const text = stringOf(value, 32).toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(text) ? text : '';
}

function numberOf(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
}

const XPATH = /^(?:\/[a-z][a-z0-9-]*(?:\[\d{1,5}\])?)+$/i;
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);

/** A form field or an editor: whatever text it holds was typed, it is never a label. */
function isFieldLike(tag: string, inputType: string, role: string, editable: boolean): boolean {
  if (editable || /^(textbox|searchbox|combobox)$/.test(role)) return true;
  if (tag === 'textarea' || tag === 'select') return true;
  return tag === 'input' && !BUTTON_INPUT_TYPES.has(inputType);
}

/** Selector with fallbacks, best first: what survives a page change differs from page to page. */
export function locatorsOf(target: Pick<AnnotationTarget, 'selector' | 'role' | 'name' | 'text' | 'xpath'>): AnnotationLocator[] {
  const locators: AnnotationLocator[] = [];
  if (target.selector) locators.push({ kind: 'css', value: target.selector });
  if (target.role && target.name) locators.push({ kind: 'role', role: target.role, name: target.name });
  const text = target.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (text) locators.push({ kind: 'text', value: text });
  if (target.xpath) locators.push({ kind: 'xpath', value: target.xpath });
  return locators;
}

const VOID_OR_RAW = 'script|style|noscript|template|iframe|object|embed';
/** A quoted value is consumed whole and kept; an unsafe attribute is removed only at a
 *  delimiter, so `/value=` inside an `href` is never mistaken for an attribute. */
const QUOTED_OR_ATTR = String.raw`"[^"]*"|'[^']*'|[\s/](?:value|srcdoc|on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`;

/** Drop unsafe attributes inside ONE tag (`<...>`); quoted values are kept whole. */
function stripUnsafeAttributes(tag: string): string {
  return tag.replace(new RegExp(QUOTED_OR_ATTR, 'gi'), (match) =>
    match[0] === '"' || match[0] === "'" ? match : '');
}

/**
 * Walk the markup tag by tag. A quote in TEXT must not swallow the tag after it:
 * only a `<tag …>` span is handed to `stripUnsafeAttributes`, and the span ends at
 * the first `>` outside a quoted attribute value.
 */
function sanitizeMarkup(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const next = html[lt + 1] ?? '';
    // `<` that does not open a tag (a comparison in text) is literal.
    if (!/[A-Za-z/!]/.test(next)) { out += '<'; i = lt + 1; continue; }
    // A comment may hold a quote (`<!-- don't -->`): copy it whole, never scan it.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) { out += html.slice(lt); break; }
      out += html.slice(lt, end + 3);
      i = end + 3;
      continue;
    }
    // A declaration (`<!doctype …>`) carries no attributes; its quotes are not ours.
    if (next === '!') {
      const end = html.indexOf('>', lt + 1);
      if (end < 0) { out += html.slice(lt); break; }
      out += html.slice(lt, end + 1);
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < html.length; j++) {
      const c = html[j]!;
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= html.length) {
      // A tag cut off by truncation still has its attributes stripped.
      out += stripUnsafeAttributes(html.slice(lt));
      break;
    }
    out += stripUnsafeAttributes(html.slice(lt, j + 1));
    i = j + 1;
  }
  return out;
}

/**
 * Second pass over the outerHTML the preload already stripped: a page that swapped the DOM between
 * the two reads still cannot ship a script, a style sheet or a field value. Regexes, not a parser:
 * the result is bounded data shown to an agent, never markup rendered anywhere.
 *
 * HTML allows `/` as well as whitespace between attributes, so the attribute patterns accept both
 * (`<svg/onload=...>` is the classic payload). Inline handlers, field values and `srcdoc` are
 * removed, and `javascript:`/`vbscript:`/`data:` in a navigable attribute is neutralised.
 */
export function sanitizeOuterHtml(raw: unknown): { html: string; truncated: boolean } {
  if (typeof raw !== 'string') return { html: '', truncated: false };
  const marked = raw.endsWith(OUTER_HTML_TRUNCATED_MARK);
  let html = raw.slice(0, ANNOTATION_OUTER_HTML_MAX * 4).replaceAll(OUTER_HTML_TRUNCATED_MARK, '');
  html = html.replace(new RegExp(`<(${VOID_OR_RAW})\\b[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, 'gi'), '');
  html = html.replace(new RegExp(`<\\/?(?:${VOID_OR_RAW})\\b[^>]*>`, 'gi'), '');
  // Field values, `srcdoc` (which could hold any markup) and inline handlers.
  html = sanitizeMarkup(html);
  // `javascript:`/`vbscript:`/`data:` in a navigable attribute is neutralised.
  html = html.replace(/((?:href|src|xlink:href|action|formaction|poster|background)\s*=\s*["']?\s*)(?:javascript|vbscript|data)\s*:/gi, '$1#');
  html = html.replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\s*>)/gi, '$1$2');
  html = html.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return { html: html.slice(0, ANNOTATION_OUTER_HTML_MAX),
    truncated: marked || html.length > ANNOTATION_OUTER_HTML_MAX || raw.length > ANNOTATION_OUTER_HTML_MAX * 4 };
}

/** The preload ends the clone of a subtree too big to take whole with this comment. */
export const OUTER_HTML_TRUNCATED_MARK = '<!--timon:truncated-->';

// --- end of copy ------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Daemon side: what a pick becomes before it is sealed.

function rectOf(value: unknown): AnnotationRect | null {
  if (!isPlainObject(value)) return null;
  const x = numberOf(value.x, -1e6, 1e6);
  const y = numberOf(value.y, -1e6, 1e6);
  const width = numberOf(value.width, 0, 1e6);
  const height = numberOf(value.height, 0, 1e6);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

function pairOf(value: unknown, a: 'x' | 'width', b: 'y' | 'height', max: number): Record<string, number> | null {
  if (!isPlainObject(value)) return null;
  const first = numberOf(value[a], 0, max);
  const second = numberOf(value[b], 0, max);
  return first === null || second === null ? null : { [a]: first, [b]: second };
}

const FRAMEWORKS: readonly AnnotationSourceFramework[] = ['react', 'vue', 'svelte'];
const VIAS: readonly AnnotationSourceVia[] = ['debugSource', 'debugStack', 'vueFile', 'svelteMeta'];

function lineOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined;
}

function sourceOf(raw: unknown): RawAnnotationSource {
  if (!isPlainObject(raw) || raw.detected !== true) return { detected: false };
  const framework = FRAMEWORKS.find((name) => name === raw.framework);
  const via = VIAS.find((name) => name === raw.via);
  const file = typeof raw.file === 'string' && raw.file.length <= SOURCE_PATH_MAX && !/[\x00-\x1f\x7f]/.test(raw.file) ? raw.file.trim() : '';
  // A scheme other than a drive letter (`C:`) is not a file on this machine.
  if (!framework || !via || !file || /^[a-z][a-z0-9+.-]+:/i.test(file)) return { detected: false };
  const component = stringOf(raw.component, 120);
  const line = lineOf(raw.line);
  const column = lineOf(raw.column);
  return {
    detected: true, framework, file, via,
    ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}),
    ...(component && /^[A-Za-z_$][\w$.]*$/.test(component) ? { component } : {}),
    ...(raw.approximate === true ? { approximate: true as const } : {}),
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A JPEG within the desktop's caps, or nothing: no other format is ever shown to anyone. */
export function thumbnailOf(raw: unknown): AnnotationThumbnail | null {
  if (!isPlainObject(raw) || raw.mimeType !== 'image/jpeg' || typeof raw.data !== 'string') return null;
  const width = raw.width;
  const height = raw.height;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > ANNOTATION_THUMBNAIL_MAX_SIDE || height > ANNOTATION_THUMBNAIL_MAX_SIDE) return null;
  if (raw.data.length > Math.ceil(ANNOTATION_THUMBNAIL_MAX_BYTES / 3) * 4 || raw.data.length % 4 !== 0 || !BASE64.test(raw.data)) return null;
  const bytes = Buffer.from(raw.data, 'base64');
  if (bytes.length > ANNOTATION_THUMBNAIL_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return { mimeType: 'image/jpeg', data: raw.data, width, height };
}

/**
 * One capture of the desktop (`AnnotationCapture`) bounded and masked again; null when it is not
 * one. The desktop's id and tab are dropped: the daemon names its own annotation.
 */
export function sanitizeAnnotationCapture(raw: unknown, now: () => number = Date.now): SanitizedAnnotationCapture | null {
  if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.target)) return null;
  const rect = rectOf(raw.rect);
  const point = pairOf(raw.point, 'x', 'y', 1e5);
  const viewport = pairOf(raw.viewport, 'width', 'height', 1e5);
  const tag = tokenOf(raw.target.tag);
  if (!rect || !point || !viewport || !tag) return null;
  const t = raw.target;
  const inputType = tokenOf(t.inputType);
  const role = tokenOf(t.role);
  const secret = isSecretField(inputType);
  const name = stringOf(t.name, 120);
  const text = secret || isFieldLike(tag, inputType, role, false) ? '' : stringOf(t.text, ANNOTATION_TEXT_MAX);
  const xpath = stringOf(t.xpath, 500);
  const target: AnnotationTarget = {
    selector: stringOf(t.selector, 500), xpath: XPATH.test(xpath) ? xpath : '', tag, role,
    name: isSecretPlaceholder(name) ? '' : name, text, inputType, id: stringOf(t.id, 128),
    classes: (Array.isArray(t.classes) ? t.classes : []).slice(0, 20).map((value) => stringOf(value, 64)).filter(Boolean),
    locators: [],
  };
  target.locators = locatorsOf(target);
  const hint = detectSecret(text) ?? detectSecret(name);
  if (hint) target.flagged = hint;
  const outer = sanitizeOuterHtml(raw.outerHtml);
  const scroll = isPlainObject(raw.scroll) ? { x: numberOf(raw.scroll.x, 0, 1e7) ?? 0, y: numberOf(raw.scroll.y, 0, 1e7) ?? 0 } : { x: 0, y: 0 };
  const captured = typeof raw.capturedAt === 'string' ? Date.parse(raw.capturedAt) : Number.NaN;
  return {
    capturedAt: Number.isFinite(captured) ? captured : now(),
    url: typeof raw.url === 'string' ? maskUrl(raw.url.slice(0, 16_384)) : '',
    title: stringOf(raw.title, 200),
    point: { x: point.x!, y: point.y! }, target, rect, viewport: { width: viewport.width!, height: viewport.height! }, scroll,
    outerHtml: secret ? '' : outer.html, outerHtmlTruncated: secret ? false : outer.truncated,
    source: sourceOf(raw.source),
    thumbnail: thumbnailOf(raw.thumbnail),
  };
}

/** The user's comment: the one instruction of an annotation, control characters dropped but lines kept. */
export function sanitizeAnnotationComment(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, ANNOTATION_COMMENT_MAX);
}

const PRIVATE_V4 = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Whether a page belongs to the user's own development: loopback, `*.localhost`, a LAN address or
 * an mDNS `*.local` name. Only such a page has its text and markup handed to an agent; an outside
 * site's own words could be written to steer it.
 */
export function isDevelopmentUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return PRIVATE_V4.test(host);
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
}

function realOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * The source path a page reported, as a path relative to `cwd`, or null. Accepted only when it
 * names an existing file inside `cwd` once symlinks are resolved, and holds no `..` segment: an
 * absolute path inside the cwd, a path relative to it, or a served pathname (`/src/App.tsx` of a
 * dev server rooted there). Anything else keeps the component's name and no path.
 */
export function missionSourcePath(file: string, cwd: string | null | undefined): string | null {
  if (!cwd || !file || file.length > SOURCE_PATH_MAX || /[\x00-\x1f\x7f]/.test(file)) return null;
  if (file.split(/[\\/]+/).some((segment) => segment === '..')) return null;
  const root = realOrNull(cwd);
  if (!root) return null;
  const candidates = isAbsolute(file) ? [file, join(root, file.replace(/^[\\/]+/, ''))] : [join(root, file)];
  for (const candidate of candidates) {
    const real = realOrNull(candidate);
    if (!real) continue;
    const rel = relative(root, real);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    try { if (!statSync(real).isFile()) continue; } catch { continue; }
    return rel.split(sep).join('/');
  }
  return null;
}
