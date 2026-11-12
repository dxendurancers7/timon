/**
 * OAuth 2.1 client for remote MCP servers.
 *
 * Implements the bits of the MCP authorization spec we actually need to let
 * users click a button and authorize a hosted MCP from the TIMON UI:
 *   - Resource/AS metadata discovery (RFC 9728 + RFC 8414).
 *   - Dynamic Client Registration (RFC 7591) — required for almost every
 *     MCP server in the wild today since they don't pre-register clients.
 *   - Authorization code flow with PKCE S256 (RFC 7636).
 *   - Refresh tokens.
 *
 * Pending PKCE state (code_verifier) lives in memory — the round-trip is
 * ~10s while the user clicks "Authorize" in their browser, so persisting
 * to disk would be over-engineering. If the orchestrator restarts mid-flow
 * the user just retries.
 */
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { OAuthClient, OAuthMetadata, OAuthTokens } from './plugins/contract/mcp-servers.js';
import { assertUrlShape, classifyAddress, guardedFetch, type DestinationPolicy } from './plugins/net-guard.js';
export type { OAuthClient, OAuthMetadata, OAuthTokens } from './plugins/contract/mcp-servers.js';

export type PendingAuth = {
  mcp_id: string;
  code_verifier: string;
  redirect_uri: string;
  metadata: OAuthMetadata;
  client: OAuthClient;
  created_at: number;
  /** Where to bounce the browser after a successful callback. Captured from
   *  the user's Origin at /oauth/start so we don't force https on a user
   *  who's browsing the app over http (or vice versa). */
  return_to?: string;
  /** The app page the browser goes back to (`OAUTH_RETURN_PATHS`), `/mcp` when absent. */
  return_path?: OAuthReturnPath;
  /** The MCP URL the user configured, kept so the callback judges egress against it. */
  seed_url?: string;
};

/** Where a finished authorization may send the browser back: a closed list, never a caller's path. */
export const OAUTH_RETURN_PATHS = ['/mcp', '/apps'] as const;
export type OAuthReturnPath = typeof OAUTH_RETURN_PATHS[number];

export function oauthReturnPath(value: unknown): OAuthReturnPath | undefined {
  return (OAUTH_RETURN_PATHS as readonly unknown[]).includes(value) ? value as OAuthReturnPath : undefined;
}

/** Path of the callback the publisher sends the browser back to (a public route: `state` + PKCE are its credential). */
export const OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';

/**
 * The redirect URI registered with a publisher. A public https address when
 * one is configured (remote access through a proxy); otherwise the daemon's
 * own loopback address (RFC 8252 § 7.3). Publishers accept plain http only
 * for `localhost` itself: Supabase refuses `http://api.timon.localhost`, the
 * old default, at dynamic registration — and nothing answered there anyway.
 */
export function oauthRedirectUri(publicApiUrl: string | null | undefined, port: number): string {
  const base = (publicApiUrl ?? '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[^/]+/i.test(base)) return `${base}${OAUTH_CALLBACK_PATH}`;
  return `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
}

const PENDING = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function reapPending(): void {
  const now = Date.now();
  for (const [k, v] of PENDING) {
    if (now - v.created_at > PENDING_TTL_MS) PENDING.delete(k);
  }
}

export function putPending(state: string, p: PendingAuth): void {
  reapPending();
  PENDING.set(state, p);
}

export function takePending(state: string): PendingAuth | null {
  reapPending();
  const v = PENDING.get(state);
  if (!v) return null;
  PENDING.delete(state);
  return v;
}

/**
 * A host the user may legitimately self-host an MCP server on: `localhost`, a
 * `.local`/`.internal`/`.lan`/`.home` name, or a private IP literal. A plain
 * DNS name is NOT self-hosted: `classifyAddress` answers `blocked` for any
 * non-IP string, so treating "not public" as private would fail open and let a
 * public server steer the daemon into `127.0.0.1` or the LAN.
 */
function isSelfHosted(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return true;
    if (isIP(host) === 0) return false;
    return classifyAddress(host) !== 'public';
  } catch {
    return false;
  }
}

/**
 * Egress policy for one OAuth request. The URL the user configured — and a
 * follow-up on the same origin (the `/.well-known/...` paths) — may live on
 * loopback, a LAN, a split-DNS name or a tailnet: the user chose it, so private
 * access is allowed (metadata/link-local stay blocked by the guard). A URL the
 * server supplies on ANOTHER origin may reach private space only when both ends
 * are explicitly local names / private literals, so a public MCP server cannot
 * steer the daemon into the internal network.
 */
function oauthPolicy(seed: string | undefined, target: string): DestinationPolicy {
  if (!seed) return { allowPrivateNetwork: false };
  let seedUrl: URL;
  let targetUrl: URL;
  try { seedUrl = new URL(seed); targetUrl = new URL(target); } catch { return { allowPrivateNetwork: false }; }
  if (targetUrl.origin === seedUrl.origin) {
    // The user configured this transport: plain HTTP stays usable on a LAN MCP,
    // but only for a URL that is itself HTTP (no silent downgrade of a redirect).
    return {
      allowPrivateNetwork: true,
      allowPlainHttp: targetUrl.protocol === 'http:' && seedUrl.protocol === 'http:',
    };
  }
  const selfHosted = isSelfHosted(seed) && isSelfHosted(target);
  return {
    allowPrivateNetwork: selfHosted,
    // A self-hosted stack may advertise its authorization server on another port
    // over plain HTTP; keep that, but never downgrade an HTTPS seed.
    allowPlainHttp: selfHosted && seedUrl.protocol === 'http:' && targetUrl.protocol === 'http:',
  };
}

/**
 * `fetch` through the egress guard. Every URL is shape-checked (http/https only,
 * no credentials) and every resolved address is judged, redirects included.
 * `seed` is the MCP URL the user configured; omit it to require a public target.
 */
function oauthFetch(seed: string | undefined, url: string, init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> {
  return guardedFetch(url, init, { destination: (u) => oauthPolicy(seed, u.href) });
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return b64url(randomBytes(24));
}

/**
 * Resolve the OAuth metadata for an MCP HTTP endpoint.
 *
 * Strategy:
 *   1. Probe the MCP URL with an unauthenticated POST. If we get a 401 with
 *      a `WWW-Authenticate: Bearer resource_metadata="..."` hint, follow it.
 *   2. Otherwise try `/.well-known/oauth-protected-resource` relative to the
 *      MCP URL — if present it gives us the authorization_servers[] list.
 *   3. Fall back to `/.well-known/oauth-authorization-server` on the MCP's
 *      origin (common for self-hosted MCPs that serve auth from the same host).
 */
export async function discoverOAuth(mcpUrl: string): Promise<OAuthMetadata> {
  const seed = new URL(mcpUrl);
  assertUrlShape(seed);
  const origin = seed.origin;

  // (1) probe the MCP endpoint and look at the WWW-Authenticate hint
  let resourceMetadataUrl: string | undefined;
  try {
    const r = await oauthFetch(mcpUrl, mcpUrl, {
      method: 'POST',
      headers: { accept: 'application/json,text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'timon', version: '0' } },
      }),
    });
    if (r.status === 401) {
      const www = r.headers.get('www-authenticate') || '';
      const m = www.match(/resource_metadata="([^"]+)"/i);
      if (m) resourceMetadataUrl = m[1];
    }
  } catch {
    // network failure here is fine — we fall through to well-known probing.
  }

  // (2) explicit resource-metadata URL → fetch it, follow authorization_servers
  const triedAsUrls: string[] = [];
  if (resourceMetadataUrl) {
    const rmd = await fetchJson(mcpUrl, resourceMetadataUrl);
    const asList = Array.isArray(rmd?.authorization_servers) ? rmd.authorization_servers : [];
    for (const as of asList) {
      if (typeof as === 'string') triedAsUrls.push(asMetadataUrl(as));
    }
  }

  // (3) try /.well-known/oauth-protected-resource at the MCP's origin
  if (!triedAsUrls.length) {
    const rmd = await fetchJsonSafe(mcpUrl, origin + '/.well-known/oauth-protected-resource');
    const asList = Array.isArray(rmd?.authorization_servers) ? rmd.authorization_servers : [];
    for (const as of asList) {
      if (typeof as === 'string') triedAsUrls.push(asMetadataUrl(as));
    }
  }

  // (4) last resort: AS metadata directly on the MCP's origin
  if (!triedAsUrls.length) {
    triedAsUrls.push(origin + '/.well-known/oauth-authorization-server');
  }

  for (const url of triedAsUrls) {
    const md = await fetchJsonSafe(mcpUrl, url);
    const auth = typeof md?.authorization_endpoint === 'string' ? md.authorization_endpoint : null;
    const tok = typeof md?.token_endpoint === 'string' ? md.token_endpoint : null;
    if (auth && tok) {
      const reg = typeof md?.registration_endpoint === 'string' ? md.registration_endpoint : undefined;
      const scopes = Array.isArray(md?.scopes_supported)
        ? (md!.scopes_supported as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      const ccm = Array.isArray(md?.code_challenge_methods_supported)
        ? (md!.code_challenge_methods_supported as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      return {
        authorization_endpoint: auth,
        token_endpoint: tok,
        registration_endpoint: reg,
        scopes_supported: scopes,
        code_challenge_methods_supported: ccm,
      };
    }
  }

  throw new Error(
    'could not discover OAuth metadata for ' + mcpUrl +
    ' (tried WWW-Authenticate hint, /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server)',
  );
}

function asMetadataUrl(asIssuer: string): string {
  // Per RFC 8414 the metadata URL is /.well-known/oauth-authorization-server
  // appended to the issuer's *path*, not always its origin. For most
  // real-world MCP setups the issuer is just the origin so this is a no-op.
  const u = new URL(asIssuer);
  const path = u.pathname.replace(/\/$/, '');
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

async function fetchJson(seed: string, url: string): Promise<Record<string, unknown>> {
  const r = await oauthFetch(seed, url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

async function fetchJsonSafe(seed: string, url: string): Promise<Record<string, unknown> | null> {
  try {
    return await fetchJson(seed, url);
  } catch {
    return null;
  }
}

/**
 * RFC 7591 Dynamic Client Registration. Most MCP servers don't pre-issue
 * client_ids so we register one on the fly the first time we authorize.
 */
export async function dynamicRegister(
  metadata: OAuthMetadata,
  redirectUri: string,
  clientName = 'TIMON',
  seedUrl?: string,
): Promise<OAuthClient> {
  if (!metadata.registration_endpoint) {
    throw new Error('authorization server does not support dynamic client registration');
  }
  const r = await oauthFetch(seedUrl, metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client + PKCE
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`dynamic client registration failed: ${r.status} ${body.slice(0, 200)}`);
  }
  const j = (await r.json()) as Record<string, unknown>;
  const client_id = j.client_id;
  if (typeof client_id !== 'string') throw new Error('registration response missing client_id');
  return { client_id, client_secret: typeof j.client_secret === 'string' ? j.client_secret : undefined };
}

export function buildAuthorizeUrl(
  metadata: OAuthMetadata,
  client: OAuthClient,
  redirectUri: string,
  state: string,
  challenge: string,
  scope?: string,
): string {
  const u = new URL(metadata.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

export async function exchangeCode(
  metadata: OAuthMetadata,
  client: OAuthClient,
  redirectUri: string,
  code: string,
  codeVerifier: string,
  seedUrl?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: codeVerifier,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  const r = await oauthFetch(seedUrl, metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`token exchange failed: ${r.status} ${txt.slice(0, 200)}`);
  }
  return parseTokenResponse(await r.json());
}

/**
 * A refused refresh names its HTTP status only: the provider's body may echo
 * the refresh token it refuses, and this error ends up in the daemon's log.
 */
export class OAuthRefreshError extends Error {
  constructor(readonly status: number) {
    super(`refresh failed: HTTP ${status}`);
    this.name = 'OAuthRefreshError';
  }
}

export async function refreshTokens(
  metadata: OAuthMetadata,
  client: OAuthClient,
  refreshToken: string,
  seedUrl?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  const r = await oauthFetch(seedUrl, metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) {
    await r.body?.cancel().catch(() => undefined);
    throw new OAuthRefreshError(r.status);
  }
  const next = parseTokenResponse(await r.json());
  // Servers may omit refresh_token on refresh → keep the old one.
  if (!next.refresh_token) next.refresh_token = refreshToken;
  return next;
}

function parseTokenResponse(j: unknown): OAuthTokens {
  const o = (j ?? {}) as Record<string, unknown>;
  const access_token = o.access_token;
  if (typeof access_token !== 'string') throw new Error('token response missing access_token');
  const expires_in = typeof o.expires_in === 'number' ? o.expires_in : undefined;
  return {
    access_token,
    token_type: typeof o.token_type === 'string' ? o.token_type : 'Bearer',
    refresh_token: typeof o.refresh_token === 'string' ? o.refresh_token : undefined,
    expires_at: expires_in ? Date.now() + expires_in * 1000 : undefined,
    scope: typeof o.scope === 'string' ? o.scope : undefined,
  };
}
