/**
 * What the daemon may conclude from the peer of an HTTP request.
 */
import type { Request } from 'express';

/**
 * The peer of the TCP connection, not `req.ip`: that one follows
 * `trust proxy` and an `X-Forwarded-For` anyone can write.
 */
export function isLoopbackPeer(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Headers a forwarding hop writes. A loopback peer that carries one is a proxy
 * on this host (`tailscale serve`, Caddy, cloudflared, the app's relay)
 * speaking for a client that may sit anywhere. Matched by name only: their
 * value is the client's word, never a proof.
 */
const PROXY_HEADERS = new Set(['forwarded', 'via', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']);
const PROXY_HEADER_PREFIXES = ['x-forwarded-', 'tailscale-'];

/** The first proxy header of the request, `undefined` when there is none. */
export function proxyHeaderOf(headers: Record<string, unknown>): string | undefined {
  return Object.keys(headers).find((name) => {
    const lower = name.toLowerCase();
    return PROXY_HEADERS.has(lower) || PROXY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
}

export type DirectLoopbackVerdict =
  | { direct: true }
  | { direct: false; reason: 'not_loopback' | 'proxy_header' | 'behind_tls_proxy'; header?: string };

/** A Host authority that names this machine (`localhost`, `127.x`, `[::1]`). */
function hostIsLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * Whether a request comes from a process on this machine talking to the
 * daemon itself, which is what a loopback peer is taken to prove. The peer
 * alone proves nothing once a proxy on this host publishes the daemon: every
 * client of `tailscale serve` arrives from 127.0.0.1. So the peer must be the
 * loopback, the request must carry no forwarding header, the daemon must
 * not be declared behind a TLS proxy (`daemon.behindTlsProxy`) — a proxy that
 * writes no header at all is still a proxy — and a Host that is present must
 * name this machine (a proxy that rewrites Host to a public name is refused).
 */
export function directLoopbackVerdict(req: Request, behindTlsProxy: boolean): DirectLoopbackVerdict {
  if (!isLoopbackPeer(req)) return { direct: false, reason: 'not_loopback' };
  const header = proxyHeaderOf(req.headers);
  if (header !== undefined) return { direct: false, reason: 'proxy_header', header };
  if (behindTlsProxy) return { direct: false, reason: 'behind_tls_proxy' };
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (host && !hostIsLoopback(host)) return { direct: false, reason: 'proxy_header', header: 'host' };
  return { direct: true };
}

export function isDirectLoopbackRequest(req: Request, behindTlsProxy: boolean): boolean {
  return directLoopbackVerdict(req, behindTlsProxy).direct;
}
