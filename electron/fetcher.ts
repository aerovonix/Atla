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
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" }
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok && !type.includes("text/html")) {
      throw new Error(`${res.status} ${res.statusText}`);
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
