/**
 * What the browser is allowed to fetch, and how fast that decision is made.
 *
 * Three separate ideas live here, and keeping them separate is what stops the
 * fast path from breaking pages:
 *
 * 1. *Who* to block — trackers, by domain. The old version scanned ~170
 *    entries linearly per request; a page issues hundreds, so that is tens of
 *    thousands of string comparisons per load. Walking the hostname's own
 *    suffixes against a Set is 3-4 lookups regardless of list size, which is
 *    what lets the list grow to thousands without the cost growing with it.
 *
 * 2. *What* to block — by resource type. The large lever, but a dangerous one:
 *    dropping images and fonts wrecks a page visually. So it only applies when
 *    nobody is looking at it.
 *
 * 3. *What to strip* — tracking parameters and beacons. These cost nothing
 *    visually and are pure surveillance, so they go in every mode.
 *
 * Pure, so the self-test can pin all three without opening a socket.
 */

/** Resource kinds Electron reports on webRequest. */
export type ResourceKind =
  | "mainFrame"
  | "subFrame"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "object"
  | "media"
  | "xhr"
  | "ping"
  | "cspReport"
  | "webSocket"
  | "other";

/**
 * How much of a page to load.
 *
 * Three tiers, each refusing strictly more than the last, so raising the
 * setting can never load *more* of something than the tier below.
 *
 * - `normal`: everything except trackers. Layout, images and fonts intact —
 *   what someone actually looking at the page should get.
 * - `fast`: also drops webfonts, video, embeds and subframes. Text reflows
 *   into a fallback face and ad slots collapse, but the page is recognisably
 *   itself and images still load.
 * - `lightning`: also drops images. What is left is text, layout and
 *   behaviour — a reader view assembled by refusing bytes rather than by
 *   rewriting the page.
 *
 * Scripts and stylesheets survive every tier, deliberately. Blocking scripts
 * would be the single biggest saving and it is the one thing we will not do:
 * a client-rendered page with no scripts has no text either, so the fastest
 * tier would reliably produce blank pages on exactly the sites people most
 * want read quickly.
 */
export type SpeedTier = "normal" | "fast" | "lightning";

/**
 * What each tier refuses, over and above trackers.
 *
 * Written out per tier rather than composed, so reading one line tells you
 * everything that tier drops.
 */
const TIER_BLOCKS: Readonly<Record<SpeedTier, ReadonlySet<ResourceKind>>> = {
  normal: new Set<ResourceKind>(),
  fast: new Set<ResourceKind>(["font", "media", "object", "subFrame"]),
  lightning: new Set<ResourceKind>(["font", "media", "object", "subFrame", "image"])
};

/**
 * Pure telemetry. `ping` is hyperlink auditing, `cspReport` is a report-only
 * beacon — neither renders anything, so both go in every mode including the
 * one a person is watching.
 */
const ALWAYS_DEAD: ReadonlySet<ResourceKind> = new Set(["ping", "cspReport"]);

/**
 * Query parameters that exist only to identify you across sites. Stripping
 * them changes nothing about what the page renders — the site still gets the
 * request, just without the label attached to you.
 */
export const TRACKING_PARAMS: readonly string[] = [
  // Google / analytics
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_name", "utm_cid", "utm_reader", "utm_referrer", "utm_social", "utm_brand",
  "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "gad_source", "gcl_au", "_ga", "_gl",
  // Meta
  "fbclid", "fb_action_ids", "fb_action_types", "fb_source", "fb_ref",
  // Microsoft / Yandex / others
  "msclkid", "yclid", "ysclid", "_openstat", "twclid", "ttclid", "igshid", "si",
  // Mail and CRM
  "mc_cid", "mc_eid", "mkt_tok", "vero_id", "vero_conv", "hsa_cam", "hsa_grp",
  "hsa_mt", "hsa_src", "hsa_ad", "hsa_acc", "hsa_net", "hsa_kw", "hsa_tgt", "hsa_ver",
  "_hsenc", "_hsmi", "hsCtaTracking",
  // Commerce and misc
  "icid", "ref_src", "ref_url", "cmpid", "campaign_id", "affiliate_id", "irclickid",
  "oly_anon_id", "oly_enc_id", "wickedid", "rb_clickid", "s_cid", "spm", "scm"
];

const TRACKING_PARAM_SET: ReadonlySet<string> = new Set(TRACKING_PARAMS);

/**
 * Removes tracking parameters from a URL.
 *
 * Returns the original string when nothing changed, so callers can cheaply
 * tell whether a redirect is warranted at all — rewriting every URL that
 * needed no rewriting would cost a redirect round trip per request.
 */
export function stripTracking(url: string): string {
  // `si` is a real parameter on some sites and a tracker on others, so it is
  // only stripped where it is known to be one. A general strip would break
  // legitimate links, which is exactly the "don't wreck the page" rule.
  const SI_HOSTS = new Set(["youtu.be", "www.youtube.com", "youtube.com", "open.spotify.com"]);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.search) return url;

  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower === "si" && !SI_HOSTS.has(parsed.hostname)) continue;
    if (TRACKING_PARAM_SET.has(lower) || lower.startsWith("utm_")) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return url;
  // Drop a now-empty "?" rather than leaving a bare question mark behind.
  if (![...parsed.searchParams.keys()].length) parsed.search = "";
  return parsed.toString();
}

/**
 * Every suffix of a hostname, longest first: a.b.example.com yields
 * a.b.example.com, b.example.com, example.com, com. Matching against these
 * means one Set lookup per label instead of one comparison per list entry,
 * and it catches subdomains for free — blocking "doubleclick.net" also
 * catches "stats.g.doubleclick.net" with no wildcard rule.
 */
export function hostSuffixes(hostname: string): string[] {
  const host = (hostname ?? "").toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!host) return [];
  const parts = host.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("."));
  return out;
}

export interface BlockIndex {
  domains: ReadonlySet<string>;
  /** Hosts explicitly rescued from a broader domain rule. */
  allow: ReadonlySet<string>;
  /** Path substrings, checked only after the domain misses. */
  patterns: readonly string[];
}

export function buildIndex(
  domains: readonly string[],
  patterns: readonly string[],
  allow: readonly string[] = []
): BlockIndex {
  const norm = (s: string) => s.toLowerCase().replace(/^\.+|\.+$/g, "");
  return {
    domains: new Set(domains.map(norm).filter(Boolean)),
    allow: new Set(allow.map(norm).filter(Boolean)),
    patterns: [...patterns].map((p) => p.toLowerCase()).filter(Boolean).sort((a, b) => b.length - a.length)
  };
}

/**
 * True when this host should be blocked. The allowlist wins, so a CDN that
 * shares a domain with a tracker can be rescued by name — the difference
 * between blocking analytics and breaking the site that uses it.
 */
export function hostBlocked(index: BlockIndex, hostname: string): boolean {
  const suffixes = hostSuffixes(hostname);
  for (const s of suffixes) if (index.allow.has(s)) return false;
  for (const s of suffixes) if (index.domains.has(s)) return true;
  return false;
}

export interface BlockDecision {
  block: boolean;
  reason: "tracker" | "weight" | "beacon" | null;
}

/**
 * The whole per-request decision.
 *
 * The main frame is never blocked, whatever the rules say. Refusing the
 * document itself turns "this page has trackers" into "this page is broken",
 * and leaves someone staring at a blank panel with no explanation.
 */
export function decideRequest(
  index: BlockIndex,
  url: string,
  kind: ResourceKind,
  opts: { blockTrackers: boolean; tier: SpeedTier }
): BlockDecision {
  if (kind === "mainFrame") return { block: false, reason: null };
  if (ALWAYS_DEAD.has(kind)) return { block: true, reason: "beacon" };
  if (TIER_BLOCKS[opts.tier].has(kind)) return { block: true, reason: "weight" };
  if (!opts.blockTrackers) return { block: false, reason: null };

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { block: false, reason: null };
  }

  if (hostBlocked(index, host)) return { block: true, reason: "tracker" };
  const lower = url.toLowerCase();
  for (const p of index.patterns) {
    if (lower.includes(p)) return { block: true, reason: "tracker" };
  }
  return { block: false, reason: null };
}

/**
 * The tier actually in force right now.
 *
 * A hidden panel overrides the choice and drops to `lightning`: the model is
 * driving, nobody is looking, and fetching images and webfonts to render into
 * a view no one can see is pure waste. When the panel is open the person's own
 * choice always wins, so the fast path never quietly degrades what someone is
 * actually looking at.
 */
export function tierFor(opts: {
  panelVisible: boolean;
  chosen: SpeedTier;
  leanWhenHidden: boolean;
}): SpeedTier {
  if (!opts.panelVisible && opts.leanWhenHidden) return "lightning";
  return opts.chosen;
}
