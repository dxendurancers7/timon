/**
 * Annotating the built-in browser (TODO #468): the pure rules, without Electron, so that they are
 * tested on their own and the daemon can compare its masking with them.
 *
 * The tab preload points (it alone sees the element the user clicked) and sends a descriptor; the
 * engine adds what only the host can read: the component's source over CDP and a cropped capture.
 * Everything a page sends is untrusted: `normalizeAnnotationPick` bounds it and masks it again,
 * as `normalizePageEvent` does for a recording. Page text, outerHTML, title and source path stay
 * DATA for the agent, never instructions: the daemon fences them before any turn sees them.
 *
 * The source is read by walking `Runtime.getProperties` listings only. `Runtime.callFunctionOn`
 * would run a function in the page's realm, where a patched builtin, a Proxy trap or a getter
 * decides what comes back (spike #468). A listing calls no getter and no trap; the one thing it
 * cannot avoid is formatting the stack of an `Error` nobody read yet, which runs the page's
 * `Error.prepareStackTrace` once: that text is untrusted like any other page string.
 */

import { detectSecret, isSecretField, isSecretPlaceholder, maskUrl, RECORDING_AGENT_ALLOWED_COMMANDS, type SecretHint } from './native-browser-recorder.js';

export const ANNOTATION_VERSION = 1;
/** Annotate mode ends after a minute without a pick or a hover. */
export const ANNOTATION_IDLE_MS = 60_000;
/** Picks waiting for the panel to collect them; a full queue refuses new ones rather than evicting. */
export const ANNOTATION_MAX_PICKS = 20;
/** A preload pick carries up to 8 KiB of outerHTML; anything far bigger is not from our preload. */
export const ANNOTATION_EVENT_MAX_BYTES = 24 * 1024;
/** Hover moves are throttled by the preload; a page hammering the channel gets dropped. */
export const ANNOTATION_MAX_PAGE_EVENTS_PER_SECOND = 30;
export const ANNOTATION_OUTER_HTML_MAX = 8 * 1024;
export const ANNOTATION_TEXT_MAX = 300;
/** Longest side of a thumbnail, in CSS pixels (the engine forces deviceScaleFactor 1). */
export const ANNOTATION_THUMBNAIL_MAX_SIDE = 800;
export const ANNOTATION_THUMBNAIL_MAX_BYTES = 200 * 1024;
/** Context kept around the element in its thumbnail. */
export const ANNOTATION_THUMBNAIL_PADDING = 24;
/** Own-property listings one source lookup may make: a fiber is never deeper than this. */
export const ANNOTATION_SOURCE_MAX_LISTINGS = 16;

/** Commands only the user may send, marked `commandActor: 'human'` by the daemon. */
export const ANNOTATION_CONTROL_COMMANDS: ReadonlySet<string> = new Set(['annotateStart', 'annotateStop', 'annotatePick', 'annotateCollect', 'annotateHighlight',
  // Drops the bubble's pins of annotations sent or deleted elsewhere (the app's queue chip, its history; TODO #481).
  'annotateUnpin',
  // Where the elements of the PWA's pins are now: rectangles the preload reported (TODO #491).
  'annotatePins']);
/** Longest selector a pick keeps, and so the longest one a re-highlight takes. */
export const ANNOTATION_SELECTOR_MAX = 500;
/**
 * While the user annotates, an agent may only read: an `Input.dispatch*` of its own would reach the
 * preload as trusted input and become a pick the user never made.
 */
export const ANNOTATION_AGENT_ALLOWED_COMMANDS: ReadonlySet<string> = RECORDING_AGENT_ALLOWED_COMMANDS;

export type AnnotationStopReason = 'user' | 'escape' | 'idle' | 'tab-change' | 'tab-closed' | 'profile-stopped';

export interface AnnotationRect { x: number; y: number; width: number; height: number }

/** Ways to find the element again, best first: the agent tries the next one when a page changed. */
export type AnnotationLocator =
  | { kind: 'css'; value: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'text'; value: string }
  | { kind: 'xpath'; value: string };

export interface AnnotationTarget {
  selector: string;
  xpath: string;
  tag: string;
  role: string;
  /** Accessible name (label, aria-label, placeholder): a page string, never a field value. */
  name: string;
  /** Visible text, '' for a form field, an editor or a secret field. */
  text: string;
  inputType: string;
  id: string;
  classes: string[];
  locators: AnnotationLocator[];
  /** The heuristic detector thinks the text may hold a secret. */
  flagged?: SecretHint;
}

export interface AnnotationPick {
  /** Viewport point the user clicked, CSS pixels. */
  point: { x: number; y: number };
  target: AnnotationTarget;
  rect: AnnotationRect;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  outerHtml: string;
  outerHtmlTruncated: boolean;
}

export type AnnotationSource =
  | { detected: false }
  | {
    detected: true;
    framework: 'react' | 'vue' | 'svelte';
    /** Path or served path as the page reports it: the daemon accepts it only inside the mission's cwd. */
    file: string;
    line?: number;
    column?: number;
    component?: string;
    via: 'debugSource' | 'debugStack' | 'vueFile' | 'svelteMeta';
    /** Lines of the served (transformed) code, not of the original file. */
    approximate?: true;
  };

export interface AnnotationThumbnail { mimeType: 'image/jpeg'; data: string; width: number; height: number }

export interface AnnotationCapture extends AnnotationPick {
  version: typeof ANNOTATION_VERSION;
  id: string;
  capturedAt: string;
  tabId: string;
  url: string;
  title: string;
  source: AnnotationSource;
  thumbnail?: AnnotationThumbnail;
}

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

export function acceptsAnnotationEventSize(payload: unknown): boolean {
  try { return JSON.stringify(payload).length <= ANNOTATION_EVENT_MAX_BYTES; } catch { return false; }
}

function rectOf(value: unknown): AnnotationRect | null {
  if (!isPlainObject(value)) return null;
  const x = numberOf(value.x, -1e6, 1e6);
  const y = numberOf(value.y, -1e6, 1e6);
  const width = numberOf(value.width, 0, 1e6);
  const height = numberOf(value.height, 0, 1e6);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

/** One preload pick as a bounded, masked descriptor; null when it is not one. */
export function normalizeAnnotationPick(raw: unknown): AnnotationPick | null {
  if (!isPlainObject(raw) || raw.type !== 'pick') return null;
  const rect = rectOf(raw.rect);
  const point = isPlainObject(raw.point) ? { x: numberOf(raw.point.x, 0, 1e5), y: numberOf(raw.point.y, 0, 1e5) } : null;
  const viewport = isPlainObject(raw.viewport) ? { width: numberOf(raw.viewport.width, 0, 1e5), height: numberOf(raw.viewport.height, 0, 1e5) } : null;
  if (!rect || !point || point.x === null || point.y === null || !viewport || viewport.width === null || viewport.height === null) return null;
  const tag = tokenOf(raw.tag);
  if (!tag) return null;
  const inputType = tokenOf(raw.inputType);
  const role = tokenOf(raw.role);
  const autocomplete = stringOf(raw.autocomplete, 256);
  const secret = raw.secret === true || isSecretField(inputType, autocomplete);
  const fieldLike = isFieldLike(tag, inputType, role, raw.editable === true);
  const name = stringOf(raw.name, 120);
  const text = secret || fieldLike ? '' : stringOf(raw.text, ANNOTATION_TEXT_MAX);
  const xpath = stringOf(raw.xpath, 500);
  const target: AnnotationTarget = {
    selector: stringOf(raw.selector, ANNOTATION_SELECTOR_MAX), xpath: XPATH.test(xpath) ? xpath : '', tag, role,
    name: isSecretPlaceholder(name) ? '' : name, text, inputType,
    id: stringOf(raw.id, 128),
    classes: (Array.isArray(raw.classes) ? raw.classes : []).slice(0, 20).map((value) => stringOf(value, 64)).filter(Boolean),
    locators: [],
  };
  target.locators = locatorsOf(target);
  const hint = detectSecret(text) ?? detectSecret(name);
  if (hint) target.flagged = hint;
  const outer = sanitizeOuterHtml(raw.outerHtml);
  const scroll = isPlainObject(raw.scroll) ? { x: numberOf(raw.scroll.x, 0, 1e7) ?? 0, y: numberOf(raw.scroll.y, 0, 1e7) ?? 0 } : { x: 0, y: 0 };
  return {
    point: { x: point.x, y: point.y }, target, rect, viewport: { width: viewport.width, height: viewport.height }, scroll,
    // A secret field's markup is dropped whole: its attributes can still name what it holds.
    outerHtml: secret ? '' : outer.html, outerHtmlTruncated: secret ? false : outer.truncated,
  };
}

export interface AnnotationHover { rect: AnnotationRect; tag: string }

/** A hover (native highlight) or a PWA preview: a rectangle and a tag, nothing else is kept. */
export function normalizeAnnotationHover(raw: unknown): AnnotationHover | null {
  if (!isPlainObject(raw) || raw.type !== 'hover') return null;
  const rect = rectOf(raw.rect);
  const tag = tokenOf(raw.tag);
  return rect && tag ? { rect, tag } : null;
}

/** The selector of a re-highlight, as a pick stored it; anything else is refused, never trimmed into another one. */
export function annotationSelectorOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > ANNOTATION_SELECTOR_MAX || /[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

/** The rectangle of a `DOM.getBoxModel` border quad, in viewport CSS pixels. */
export function boxModelRect(raw: unknown): AnnotationRect | null {
  const border = isPlainObject(raw) && isPlainObject(raw.model) ? raw.model.border : null;
  if (!Array.isArray(border) || border.length !== 8 || !border.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const xs = [border[0], border[2], border[4], border[6]] as number[];
  const ys = [border[1], border[3], border[5], border[7]] as number[];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return rectOf({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
}

export function annotationTitle(raw: unknown): string {
  return stringOf(raw, 200);
}

/** Page URL as stored with an annotation: tokens masked, '' for an internal page. */
export function annotationUrl(raw: string): string {
  return maskUrl(raw);
}

/**
 * The region captured for a thumbnail: the element plus some context, clipped to the viewport.
 * `capturePage` takes viewport CSS pixels and returns an empty image off screen, so a target
 * scrolled out of view gets no thumbnail rather than a blank one.
 */
export function thumbnailRect(rect: AnnotationRect, viewport: { width: number; height: number },
  padding = ANNOTATION_THUMBNAIL_PADDING): AnnotationRect | null {
  const left = Math.max(0, Math.floor(rect.x - padding));
  const top = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  if (right - left < 2 || bottom - top < 2) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Thumbnail size keeping the aspect ratio, longest side at most `max`. */
export function thumbnailSize(width: number, height: number, max = ANNOTATION_THUMBNAIL_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// ---------------------------------------------------------------------------------------------
// Source: a passive walk over CDP own-property listings.

/** The part of a CDP `Runtime.PropertyDescriptor` the walk reads. */
export interface CdpProperty {
  name: string;
  value?: { type?: string; subtype?: string; value?: unknown; objectId?: string; description?: string };
  get?: unknown;
  set?: unknown;
}
/** Lists an object's own properties (`Runtime.getProperties`, ownProperties, no preview). */
export type OwnProperties = (objectId: string) => Promise<CdpProperty[]>;

const FRAMEWORK_KEYS = /^(?:__reactFiber\$|__vueParentComponent$|__svelte_meta$)/;

class SourceWalk {
  private listings = 0;
  constructor(private readonly own: OwnProperties) {}

  async list(objectId: string): Promise<CdpProperty[]> {
    if (++this.listings > ANNOTATION_SOURCE_MAX_LISTINGS) return [];
    const properties = await this.own(objectId);
    return Array.isArray(properties) ? properties : [];
  }

  /**
   * A data property holding an object, never an accessor (its getter is not called) and never a
   * Proxy: no real fiber or component is one, and its traps would be the page's code.
   */
  static object(properties: CdpProperty[], name: string | ((name: string) => boolean)): string | null {
    const property = properties.find((candidate) => typeof name === 'string' ? candidate.name === name : name(candidate.name));
    const value = property && !property.get && !property.set ? property.value : undefined;
    if (!value || (value.type !== 'object' && value.type !== 'function') || value.subtype === 'proxy' || value.subtype === 'null') return null;
    return typeof value.objectId === 'string' ? value.objectId : null;
  }

  static primitive(properties: CdpProperty[], name: string): unknown {
    const property = properties.find((candidate) => candidate.name === name);
    if (!property || property.get || property.set || !property.value) return undefined;
    return property.value.type === 'string' || property.value.type === 'number' ? property.value.value : undefined;
  }

  async path(objectId: string, names: string[]): Promise<CdpProperty[] | null> {
    let current = objectId;
    for (const name of names) {
      const next = SourceWalk.object(await this.list(current), name);
      if (!next) return null;
      current = next;
    }
    return this.list(current);
  }
}

function sourceFile(value: unknown): string {
  const text = stringOf(value, 500);
  if (!text) return '';
  // A served URL: only its path names a file; the query is a cache buster or worse. Any other
  // scheme (javascript:, data:, webpack-internal:) names no file; a Windows drive letter is a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
    try {
      const url = new URL(text);
      return ['http:', 'https:', 'file:'].includes(url.protocol) ? decodeURIComponent(url.pathname).slice(0, 500) : '';
    } catch { return ''; }
  }
  return text;
}

const position = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e7 ? value : undefined;
const componentName = (value: unknown) => {
  const text = stringOf(value, 120);
  return /^[A-Za-z_$][\w$.]*$/.test(text) ? text : '';
};

/**
 * The frame of a React 19 `_debugStack` that names the JSX call site: the second `at` line (the
 * first is React's own `jsxDEV`). Untrusted text: only a well-formed location is kept.
 */
export function stackFrame(stack: unknown, index = 1): { file: string; line: number; column: number; component?: string } | null {
  if (typeof stack !== 'string') return null;
  const frames = stack.slice(0, 8192).split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at '));
  const frame = frames[index];
  if (!frame) return null;
  const match = /^at (?:(?:async )?([^\s(]+) \()?(.+?):(\d+):(\d+)\)?$/.exec(frame);
  if (!match) return null;
  const file = sourceFile(match[2]);
  const line = position(Number(match[3]));
  const column = position(Number(match[4]));
  if (!file || !line || !column) return null;
  const component = componentName(match[1]?.split('.').at(-1));
  return { file, line, column, ...(component ? { component } : {}) };
}

/** The source of the DOM node `objectId` designates, read without running any page code. */
export async function readSource(objectId: string, own: OwnProperties): Promise<AnnotationSource> {
  const walk = new SourceWalk(own);
  const node = await walk.list(objectId);
  const key = node.find((property) => FRAMEWORK_KEYS.test(property.name))?.name;
  if (!key) return { detected: false };

  if (key.startsWith('__reactFiber$')) {
    const fiberId = SourceWalk.object(node, key);
    if (!fiberId) return { detected: false };
    const fiber = await walk.list(fiberId);
    const ownerType = SourceWalk.object(fiber, '_debugOwner');
    let component = '';
    if (ownerType) {
      const type = await walk.path(ownerType, ['type']);
      if (type) component = componentName(SourceWalk.primitive(type, 'displayName')) || componentName(SourceWalk.primitive(type, 'name'));
    }
    const debugSource = SourceWalk.object(fiber, '_debugSource');
    if (debugSource) {
      const source = await walk.list(debugSource);
      const file = sourceFile(SourceWalk.primitive(source, 'fileName'));
      if (file) {
        const line = position(SourceWalk.primitive(source, 'lineNumber'));
        const column = position(SourceWalk.primitive(source, 'columnNumber'));
        return { detected: true, framework: 'react', file, via: 'debugSource',
          ...(line ? { line } : {}), ...(column ? { column } : {}), ...(component ? { component } : {}) };
      }
    }
    const stackProperty = fiber.find((property) => property.name === '_debugStack');
    if (stackProperty?.value?.subtype === 'error') {
      const stackId = SourceWalk.object(fiber, '_debugStack');
      const frame = stackId ? stackFrame(SourceWalk.primitive(await walk.list(stackId), 'stack')) : null;
      if (frame) {
        const name = component || frame.component;
        return { detected: true, framework: 'react', file: frame.file, line: frame.line, column: frame.column,
          via: 'debugStack', approximate: true, ...(name ? { component: name } : {}) };
      }
    }
    return { detected: false };
  }

  if (key === '__vueParentComponent') {
    const component = SourceWalk.object(node, key);
    const type = component ? await walk.path(component, ['type']) : null;
    const file = type ? sourceFile(SourceWalk.primitive(type, '__file')) : '';
    if (!type || !file) return { detected: false };
    const name = componentName(SourceWalk.primitive(type, '__name')) || componentName(SourceWalk.primitive(type, 'name'));
    return { detected: true, framework: 'vue', file, via: 'vueFile', ...(name ? { component: name } : {}) };
  }

  const meta = SourceWalk.object(node, key);
  const loc = meta ? await walk.path(meta, ['loc']) : null;
  const file = loc ? sourceFile(SourceWalk.primitive(loc, 'file')) : '';
  if (!loc || !file) return { detected: false };
  const line = position(SourceWalk.primitive(loc, 'line'));
  const column = position(SourceWalk.primitive(loc, 'column'));
  return { detected: true, framework: 'svelte', file, via: 'svelteMeta', ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Session: annotate mode on one tab, and the picks waiting to be collected.

export class AnnotationSession {
  private readonly pageEvents: number[] = [];
  /** The anchors' rectangles, on a budget of their own: scrolling must not starve the picks. */
  private readonly rectEvents: number[] = [];
  private lastActivity: number;
  active = true;
  stoppedReason: AnnotationStopReason | null = null;

  constructor(readonly tabId: string, private readonly now: () => number = Date.now) {
    this.lastActivity = now();
  }

  touch(): void { this.lastActivity = this.now(); }

  /** False when the page sends faster than a person moves. */
  admitPageEvent(): boolean { return this.admit(this.pageEvents); }

  /** The preload reports at most ~30 a second; past 40, the page is the one sending. */
  admitRectEvent(): boolean { return this.admit(this.rectEvents, ANNOTATION_MAX_PAGE_EVENTS_PER_SECOND + 10); }

  private admit(events: number[], max = ANNOTATION_MAX_PAGE_EVENTS_PER_SECOND): boolean {
    const now = this.now();
    while (events.length && now - events[0]! >= 1000) events.shift();
    if (events.length >= max) return false;
    events.push(now);
    return true;
  }

  /** Milliseconds left before the idle stop; 0 once idle. */
  idleRemaining(): number {
    return Math.max(0, this.lastActivity + ANNOTATION_IDLE_MS - this.now());
  }

  stop(reason: AnnotationStopReason): void {
    if (!this.active) return;
    this.active = false;
    this.stoppedReason = reason;
  }
}
