/**
 * Turning a thrown value into something a person can act on.
 *
 * Node's fetch throws a bare `TypeError: fetch failed` and puts the actual
 * reason — DNS, TLS, refused connection — in `.cause`. Reporting only
 * `.message` therefore tells the user nothing at all, which is exactly what
 * happened the first time Atla ran on a machine whose network stack differed.
 *
 * Pure, so the self-test can pin the unwrapping without a socket.
 */

interface CausedError {
  message?: string;
  cause?: unknown;
  code?: string;
  errno?: number;
  syscall?: string;
  hostname?: string;
}

/** Plain-English for the handful of causes that actually come up. */
const EXPLAIN: Record<string, string> = {
  ENOTFOUND: "That hostname didn't resolve — check the endpoint URL and your DNS.",
  EAI_AGAIN: "DNS lookup timed out. The network may be down or a VPN is interfering.",
  ECONNREFUSED: "Nothing is listening there. If it's a local model, check the server is running.",
  ECONNRESET: "The connection was closed mid-request.",
  ETIMEDOUT: "The server didn't respond in time.",
  EPROTO: "TLS handshake failed. A proxy or antivirus intercepting HTTPS is the usual cause.",
  CERT_HAS_EXPIRED: "The server's certificate has expired.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The certificate chain couldn't be verified — often a corporate proxy.",
  SELF_SIGNED_CERT_IN_CHAIN: "A self-signed certificate is in the chain, usually a proxy or antivirus.",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "The system certificate store is missing a root this server needs.",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The server presented a self-signed certificate."
};

/**
 * Walks the cause chain and builds a message that names the real failure.
 * Depth-limited because a cause chain can, in principle, loop.
 */
export function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return String(err);

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as CausedError;
    const msg = (e.message ?? "").trim();
    if (msg && !parts.includes(msg)) parts.push(msg);
    if (e.code) {
      const label = e.hostname ? `${e.code} (${e.hostname})` : e.code;
      if (!parts.includes(label)) parts.push(label);
      const hint = EXPLAIN[e.code];
      if (hint && !parts.includes(hint)) parts.push(hint);
    }
    current = e.cause;
  }

  // "fetch failed" on its own is the useless case this exists to prevent.
  const joined = parts.filter((p) => p.toLowerCase() !== "fetch failed").join(" — ");
  return joined || parts.join(" — ") || "Something went wrong.";
}
