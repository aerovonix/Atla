/**
 * Headless page fetching, with no browser panel involved.
 *
 * The browser tools drive one visible webview, so research meant navigating
 * it over and over — losing the previous page every time and hammering a site
 * with full page loads (scripts, images, trackers) to read its text. This
 * fetches the HTML directly and strips it, which is faster, quieter, doesn't
 * disturb what the user is looking at, and doesn't trip rate limits nearly as
 * fast.
 *
 * What it can't do is anything needing JavaScript or a login — that's what the
 * real browser is still for.
 */

import { fetchWithRetry, HttpError, retryAfterMs } from "./retry.js";

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** A plausible desktop UA. Some sites serve a stub to anything that looks scripted. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”"
  };
  return text
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

/**
 * HTML to readable text. Not a parser — a parser would be a dependency and a
 * lot of surface for something whose only job is to feed a model prose.
 * Script, style and nav furniture go first so their contents don't survive as
 * stray text, then tags are dropped and whitespace collapsed.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  // Block boundaries become newlines, so paragraphs and list items don't run
  // into each other once the tags are gone.
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim().slice(0, 200) : "";
}

/** Absolute links, for following a result without loading the page first. */
export function linksOf(html: string, baseUrl: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 200) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    try {
      out.push({ text: text.slice(0, 120), href: new URL(m[1], baseUrl).toString() });
    } catch {
      /* a malformed href isn't worth failing the whole fetch over */
    }
  }
  return out;
}

/** Says what a non-OK status means, so a limit reads as a limit. */
function describeStatus(host: string, res: Response): string {
  const wait = retryAfterMs(res);
  const waited = wait ? `, and asked to wait ${Math.ceil(wait / 1000)}s` : "";
  if (res.status === 429) return `${host} rate limited this request (429${waited}).`;
  if (res.status === 403) return `${host} refused this request (403) — it may be blocking automated fetches.`;
  if (res.status === 404) return `${host} has nothing at that URL (404).`;
  return `${host} returned ${res.status} ${res.statusText}.`;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  truncated: boolean;
}

export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`"${rawUrl}" isn't a valid URL.`);
  }
  // Only the web. file:// would turn this into an ungated file reader, and
  // the file tools exist for that with an approval in front of them.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be fetched.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchWithRetry(
      url.toString(),
      {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" }
      },
      // One quick retry covers a blip. A site asking for a real wait should
      // reach the model as "rate limited", not as a page that timed out --
      // and waiting it out here would spend the whole timeout doing it.
      { attempts: 2, maxWait: 3000 }
    );
    const type = res.headers.get("content-type") ?? "";
    // An error page is not content. This used to pass any HTML body through
    // whatever its status, so a 429 reached the model as a pile of navigation
    // links: it would report that the search came back empty and try again,
    // never learning it had been rate limited.
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText, describeStatus(url.hostname, res));
    }
    if (!/text\/html|text\/plain|application\/(json|xml|xhtml)/.test(type)) {
      throw new Error(`That URL returned ${type || "a non-text response"}, which there's nothing to read in.`);
    }

    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_BYTES;
    const body = new TextDecoder("utf-8").decode(truncated ? buf.slice(0, MAX_BYTES) : buf);
    const isHtml = type.includes("html");
    return {
      url: res.url || url.toString(),
      title: isHtml ? titleOf(body) : "",
      text: isHtml ? htmlToText(body) : body,
      links: isHtml ? linksOf(body, res.url || url.toString()) : [],
      truncated
    };
  } catch (err) {
    if (controller.signal.aborted) throw new Error("That page took too long to respond.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/**
 * Searching needs its own endpoints, separate from the engine the browser
 * uses.
 *
 * The visible browser runs JavaScript, so `duckduckgo.com/?q=` is right for
 * it. Fetching that same URL as raw HTML returns a shell with two links in it
 * and no results at all -- which is exactly what searching here used to do.
 * These are the HTML-only endpoints, which answer a form POST with real
 * results and no JavaScript.
 */
const SEARCH_ENDPOINTS = [
  { name: "duckduckgo", url: "https://html.duckduckgo.com/html/" },
  { name: "duckduckgo-lite", url: "https://lite.duckduckgo.com/lite/" }
];

export interface SearchResult {
  title: string;
  url: string;
}

/**
 * DuckDuckGo hands back every result as `duckduckgo.com/l/?uddg=<real-url>`.
 * Unwrapping is not cosmetic: results used to be dropped wholesale by a filter
 * that excluded the engine's own hostname, which every single one of these
 * matches, leaving nothing but the region picker to show the model.
 */
function unwrapRedirect(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    const nested = u.searchParams.get("uddg") ?? u.searchParams.get("u");
    const target = nested ? new URL(nested, base) : u;
    return target.protocol === "http:" || target.protocol === "https:" ? target.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Results only, by the class the engine marks them with. Scraping every anchor
 * instead sweeps up the nav, the region list and the privacy links, which read
 * to a model as a page that found nothing.
 */
const RESULT_LINK = /class=["'][^"']*\b(?:result__a|result-link)\b/i;

export function resultsFrom(html: string, base: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 25) {
    if (!RESULT_LINK.test(m[1])) continue;
    const hrefM = /href=["']([^"']+)["']/i.exec(m[1]);
    if (!hrefM) continue;
    const url = unwrapRedirect(decodeEntities(hrefM[1]), base);
    if (!url || seen.has(url)) continue;
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!title) continue;
    seen.add(url);
    out.push({ title, url });
  }
  return out;
}

export interface SearchOutcome {
  results: SearchResult[];
  engine: string;
}

/** Searches the web without the browser panel, trying each endpoint in turn. */
export async function searchWeb(query: string): Promise<SearchOutcome> {
  const trouble: string[] = [];
  for (const endpoint of SEARCH_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchWithRetry(
        endpoint.url,
        {
          method: "POST",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "user-agent": UA,
            "content-type": "application/x-www-form-urlencoded",
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9"
          },
          body: new URLSearchParams({ q: query, kl: "us-en" }).toString()
        },
        // Rate limited here means move to the next endpoint, not wait.
        { attempts: 2, maxWait: 2000 }
      );
      if (!res.ok) {
        trouble.push(describeStatus(new URL(endpoint.url).hostname, res));
        continue;
      }
      const results = resultsFrom(await res.text(), res.url || endpoint.url);
      if (results.length > 0) return { results, engine: endpoint.name };
      trouble.push(`${endpoint.name} returned a page with no results on it`);
    } catch (err) {
      if (controller.signal.aborted) trouble.push(`${endpoint.name} timed out`);
      else trouble.push(`${endpoint.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Saying which engines were tried and what each one did beats "no results",
  // which a model reads as "the web has nothing" and acts on.
  throw new Error(`Search failed. ${trouble.join("; ")}`);
}
