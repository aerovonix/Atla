import { browserControl } from "./browserBridge.js";
import { runCommand, getCwd } from "./terminal.js";
import { applyEdit, currentContent, listDir, numberLines, readFileText, resolvePath, writeFileText } from "./files.js";
import { diffStat, unifiedDiff } from "../shared/diff.js";
import { describeError } from "../shared/errors.js";
import { capture, focusedWindowTitle, listWindows, perform, toScreenCoords } from "./desktop.js";
import { fetchPage } from "./fetcher.js";
import { decide, describeAction, type DesktopAction, type DesktopPolicy } from "../shared/desktopPolicy.js";
import type { ToolEvent } from "../shared/types.js";

const MAX_PAGE_CHARS = 8000;
const MAX_DETAIL_CHARS = 1500;

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  description:
    "Search the web in the app's real browser and return the actual text of the results page. Use this whenever the user asks you to search, google, or look something up, and for current events, docs, prices, or any fact you're unsure of. This performs a real search — always prefer it over opening a search engine's home page.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query, as you would type it into a search box." }
    },
    required: ["query"]
  }
};

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: "browser_navigate",
    description:
      "Really open a URL in the app's browser — the user watches it load — and return that page's actual visible text. Use it when you have a specific address. To search, use web_search instead; navigating to a search engine's home page just loads an empty search box.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to open, including https://" }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_read_page",
    description:
      "Read the actual text of the page currently open in the browser. Use this when the user refers to the page they are looking at ('this page', 'what does it say', 'summarize this').",
    parameters: { type: "object", properties: {}, required: [] }
  },
  {
    name: "browser_click",
    description:
      "Click a real link or button on the current page by its visible text and return the resulting page's text. Use this to open a search result or follow a link.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The visible text of the link or button to click." }
      },
      required: ["text"]
    }
  },
  {
    name: "browser_find_links",
    description: "List links on the current page whose text matches a query. Useful before clicking.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against link text." }
      },
      required: ["query"]
    }
  },
  {
    name: "browser_open_tab",
    description:
      "Open a URL in a NEW background tab, keeping the current page loaded. Use this instead of browser_navigate when you'll want to come back to what's open — comparing sources, or working through several results.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL to open in the new tab." } },
      required: ["url"]
    }
  },
  {
    name: "browser_list_tabs",
    description: "List the browser tabs that are open, with their URLs and which one is active.",
    parameters: { type: "object", properties: {}, required: [] }
  },
  {
    name: "browser_switch_tab",
    description: "Make another open tab the active one and read it. The page is already loaded, so this costs no page load.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Tab id from browser_list_tabs." } },
      required: ["id"]
    }
  },
  {
    name: "browser_close_tab",
    description: "Close a tab you no longer need. The first tab can't be closed.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Tab id from browser_list_tabs." } },
      required: ["id"]
    }
  },
  {
    name: "browser_go_back",
    description: "Go back one page in the built-in browser and return the resulting page's text.",
    parameters: { type: "object", properties: {}, required: [] }
  }
];

export const QUIET_WEB_TOOLS: ToolDef[] = [
  {
    name: "fetch_url",
    description:
      "Read a web page's text directly, without opening the browser. Much faster than browser_navigate and it doesn't disturb the page the user is looking at, so use it for research, reading docs, and following search results — anywhere you just need what a page says. It can't run JavaScript or use a login, so fall back to browser_navigate for pages that need either.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http/https URL." },
        links: { type: "boolean", description: "Also return the page's links. Useful on a results or index page." }
      },
      required: ["url"]
    }
  },
  {
    name: "quiet_search",
    description:
      "Search the web and get the results page as text, without opening the browser. Prefer this over web_search when you're gathering information rather than showing the user something. You can call it several times in a row cheaply.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"]
    }
  }
];

export const TERMINAL_TOOL: ToolDef = {
  name: "run_command",
  description:
    "Run a shell command on the user's machine and get back its output and exit code. The command runs in the app's terminal pane, which the user is watching. The working directory carries over between calls — use `cd` to move around, and `pwd` (or `Get-Location` on Windows) to check where you are. There is no TTY, so don't start interactive programs, REPLs, watchers, or anything that waits for input; they will hang. The user may be asked to approve each command, and may say no.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run, exactly as it would be typed in a shell." },
      quiet: {
        type: "boolean",
        description:
          "True to run without opening the terminal pane. Use it for routine steps the user doesn't need to watch — checking a path, listing a directory, launching something. Leave it off when the output is the point, or when the command is long-running and they'd want to see it."
      }
    },
    required: ["command"]
  }
};

export const FILE_TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the user's disk and return it with line numbers. Relative paths resolve against the terminal's current directory. Use this before editing anything, so the text you match on is exactly what's there.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file. Absolute, or relative to the current directory." }
      },
      required: ["path"]
    }
  },
  {
    name: "list_dir",
    description:
      "List the files and folders in a directory. Directories are shown with a trailing slash. Dotfiles are omitted. Use this to find your way around before reading.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Defaults to the current directory." }
      },
      required: []
    }
  },
  {
    name: "write_file",
    description:
      "Create a file, or replace one entirely, with the content you supply. Parent folders are created as needed. The user is shown a diff and may decline. For changing part of an existing file, prefer edit_file — a full rewrite risks dropping content you didn't read.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write. Absolute, or relative to the current directory." },
        content: { type: "string", description: "The complete new contents of the file." }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description:
      "Replace one exact stretch of text in a file with another. 'old_text' must appear exactly once — include surrounding lines to make it unique — and must match the file character for character, so read the file first. The user is shown a diff and may decline.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit." },
        old_text: { type: "string", description: "The exact text to replace, copied from the file." },
        new_text: { type: "string", description: "What to put in its place. Empty string deletes the text." }
      },
      required: ["path", "old_text", "new_text"]
    }
  }
];

export const DESKTOP_TOOLS: ToolDef[] = [
  {
    name: "desktop_list_windows",
    description:
      "List the windows currently open on the user's desktop, by title. Use this first to find out what's there and what you're allowed to work in.",
    parameters: { type: "object", properties: {}, required: [] }
  },
  {
    name: "desktop_screenshot",
    description:
      "Take a screenshot of the user's screen, or of one window by name, and look at it. Coordinates you read from the image are what desktop_click expects. Take a fresh one after anything that changes the screen — acting on a stale screenshot clicks the wrong thing.",
    parameters: {
      type: "object",
      properties: {
        window: { type: "string", description: "Part of a window title. Omit for the whole screen." }
      },
      required: []
    }
  },
  {
    name: "desktop_click",
    description:
      "Click at a point on the screen. Say what you are clicking in 'target' — the visible label of the button or control — so the user can see what you meant and so anything irreversible can be caught before it happens.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal pixel position." },
        y: { type: "number", description: "Vertical pixel position." },
        target: { type: "string", description: "The visible text of what you're clicking, e.g. 'Save'." },
        button: { type: "string", description: "'left' (default) or 'right'." },
        double: { type: "boolean", description: "True for a double-click." }
      },
      required: ["x", "y", "target"]
    }
  },
  {
    name: "desktop_type",
    description: "Type text into whatever currently has focus. Click the field first.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The text to type." } },
      required: ["text"]
    }
  },
  {
    name: "desktop_key",
    description:
      "Press a single key: enter, tab, escape, backspace, delete, up, down, left, right, home, end.",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "The key name." } },
      required: ["key"]
    }
  }
];

function clip(text: string): string {
  if (text.length <= MAX_PAGE_CHARS) return text;
  return `${text.slice(0, MAX_PAGE_CHARS)}\n…[truncated, ${text.length - MAX_PAGE_CHARS} more characters]`;
}

/** What a tool card shows when expanded — enough to audit, not the whole page. */
function detailOf(content: string): string {
  return content.length <= MAX_DETAIL_CHARS ? content : `${content.slice(0, MAX_DETAIL_CHARS)}\n…`;
}

function argsOf(raw: unknown): string {
  try {
    const s = JSON.stringify(raw ?? {}, null, 2);
    return s === "{}" ? "" : s;
  } catch {
    return "";
  }
}

export interface ToolContext {
  searchEngineUrl: string;
  /**
   * Asks the user whether a command may run. Absent means no approver is
   * wired up, which is treated as a refusal — a missing gate must never read
   * as an open one.
   */
  approveCommand?: (command: string, cwd: string) => Promise<boolean>;
  /**
   * Asks the user whether a file change may land, showing the diff. Absent is
   * a refusal, for the same reason as `approveCommand`.
   */
  approveWrite?: (target: string, diff: string) => Promise<boolean>;
  /** What the model may do outside Atla. Absent means nothing. */
  desktop?: DesktopPolicy;
  /**
   * Asks about a desktop action. Absent is a refusal, like the others — a
   * missing gate on the one capability that reaches the whole machine must
   * never read as an open one.
   */
  approveDesktop?: (summary: string, reason: string) => Promise<boolean>;
}

export interface ToolResult {
  content: string;
  event: ToolEvent;
}

/** What a tool actually did, before it gets wrapped up as a ToolEvent. */
interface ToolOutcome {
  content: string;
  summary: string;
  /** Base64 PNG, for tools that hand back something to look at. */
  image?: string;
  url?: string;
  path?: string;
  wrote?: boolean;
  diff?: string;
}

/**
 * The one path every file mutation takes: resolve, diff, ask, then write.
 * An edit that changes nothing never reaches the user — asking them to approve
 * a no-op trains them to click through the prompt without reading it.
 */
async function commitWrite(
  ctx: ToolContext,
  target: string,
  before: string,
  after: string,
  verb: string
): Promise<ToolOutcome> {
  const diff = unifiedDiff(before, after);
  if (!diff) {
    return { content: `${target} already has that content; nothing to change.`, summary: target, path: target };
  }
  const allowed = ctx.approveWrite ? await ctx.approveWrite(target, diff) : false;
  if (!allowed) {
    throw new Error("The user declined this file change. Don't retry it; ask them what they'd rather do.");
  }
  await writeFileText(target, after);
  const { added, removed } = diffStat(diff);
  return {
    content: `${verb} ${target} (+${added} -${removed})

${diff}`,
    summary: target,
    path: target,
    wrote: true,
    diff
  };
}

/** Maps a tool call onto the policy layer's action shape. */
function toDesktopAction(name: string, args: Record<string, unknown>): DesktopAction {
  switch (name) {
    case "desktop_list_windows":
      return { kind: "list" };
    case "desktop_screenshot":
      return { kind: "screenshot" };
    case "desktop_click":
      return {
        kind: "click",
        x: Math.round(Number(args.x ?? 0)),
        y: Math.round(Number(args.y ?? 0)),
        button: String(args.button ?? "left") === "right" ? "right" : "left",
        double: Boolean(args.double)
      };
    case "desktop_type":
      return { kind: "type", text: String(args.text ?? "") };
    default:
      return { kind: "key", key: String(args.key ?? "") };
  }
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "web_search": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("Missing 'query'.");
      const url = ctx.searchEngineUrl.includes("%s")
        ? ctx.searchEngineUrl.replace("%s", encodeURIComponent(query))
        : `${ctx.searchEngineUrl}${encodeURIComponent(query)}`;
      const page = await browserControl.navigate(url);
      return {
        content: `Search results for "${query}" (${page.url}):\n\n${clip(page.text)}`,
        summary: query,
        url: page.url
      };
    }
    case "browser_navigate": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("Missing 'url'.");
      const page = await browserControl.navigate(url);
      return { content: `${page.title} — ${page.url}\n\n${clip(page.text)}`, summary: page.url, url: page.url };
    }
    case "browser_read_page": {
      const page = await browserControl.readPage();
      return {
        content: `${page.title} — ${page.url}\n\n${clip(page.text)}`,
        summary: page.url || "current page",
        url: page.url
      };
    }
    case "browser_click": {
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("Missing 'text'.");
      const page = await browserControl.click(text);
      return {
        content: `Clicked "${text}". Now on ${page.title} — ${page.url}\n\n${clip(page.text)}`,
        summary: text,
        url: page.url
      };
    }
    case "browser_find_links": {
      const query = String(args.query ?? "").trim();
      const { links } = await browserControl.findLinks(query);
      const list = links.slice(0, 40).map((l) => `- ${l.text} → ${l.href}`).join("\n");
      return {
        content: links.length ? `Matching links:\n${list}` : `No links matching "${query}".`,
        summary: query
      };
    }
    case "run_command": {
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("Missing 'command'.");
      const cwd = getCwd();
      const allowed = ctx.approveCommand ? await ctx.approveCommand(command, cwd) : false;
      if (!allowed) {
        throw new Error("The user declined to run this command. Don't retry it; ask them what they'd rather do.");
      }
      const { code, output } = await runCommand(command, Boolean(args.quiet));
      const body = output.trim() || "(no output)";
      return {
        content: `$ ${command}
(in ${cwd}, exit code ${code})

${clip(body)}`,
        summary: command
      };
    }
    case "fetch_url": {
      const page = await fetchPage(String(args.url ?? ""));
      const links =
        args.links && page.links.length
          ? `\n\nLinks:\n${page.links.slice(0, 60).map((l) => `- ${l.text} -> ${l.href}`).join("\n")}`
          : "";
      return {
        content: `${page.title || page.url}\n${page.url}\n\n${clip(page.text)}${links}`,
        summary: page.title || page.url,
        url: page.url
      };
    }
    case "quiet_search": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("Missing 'query'.");
      const url = ctx.searchEngineUrl.includes("%s")
        ? ctx.searchEngineUrl.replace("%s", encodeURIComponent(query))
        : `${ctx.searchEngineUrl}${encodeURIComponent(query)}`;
      const page = await fetchPage(url);
      // The links are the useful half of a results page; the prose around
      // them is mostly the engine's own furniture.
      const results = page.links
        .filter((l) => /^https?:/.test(l.href) && !/duckduckgo|google\.|bing\./.test(new URL(l.href).hostname))
        .slice(0, 25)
        .map((l) => `- ${l.text} -> ${l.href}`)
        .join("\n");
      return {
        content: `Results for "${query}":\n\n${results || clip(page.text)}`,
        summary: query,
        url: page.url
      };
    }
    case "read_file": {
      const target = resolvePath(String(args.path ?? ""));
      const { text } = await readFileText(target);
      return { content: `${target}

${numberLines(text)}`, summary: target, path: target };
    }
    case "list_dir": {
      const raw = String(args.path ?? "").trim();
      const target = raw ? resolvePath(raw) : getCwd();
      return { content: `${target}

${await listDir(target)}`, summary: target, path: target };
    }
    case "write_file": {
      const target = resolvePath(String(args.path ?? ""));
      const after = String(args.content ?? "");
      const before = await currentContent(target);
      return commitWrite(ctx, target, before, after, before ? "Rewrote" : "Created");
    }
    case "edit_file": {
      const target = resolvePath(String(args.path ?? ""));
      const before = await currentContent(target);
      if (!before) throw new Error(`${target} is empty or does not exist. Use write_file to create it.`);
      const after = applyEdit(before, String(args.old_text ?? ""), String(args.new_text ?? ""));
      return commitWrite(ctx, target, before, after, "Edited");
    }
    case "desktop_list_windows":
    case "desktop_screenshot":
    case "desktop_click":
    case "desktop_type":
    case "desktop_key": {
      const action = toDesktopAction(name, args);
      const policy = ctx.desktop;
      if (!policy) throw new Error("Desktop control is off. The user can turn it on in Settings.");

      // The focused window is read immediately before the check, not cached:
      // the user can alt-tab between one action and the next, and an
      // allowlist checked against a stale title guards the wrong window.
      const focused = action.kind === "list" ? "" : await focusedWindowTitle();
      const nearby = action.kind === "click" ? String(args.target ?? "") : "";
      const verdict = decide(policy, action, focused, nearby);
      if (!verdict.allowed) throw new Error(verdict.reason);

      if (verdict.confirm) {
        const summary = describeAction(action, focused);
        const ok = ctx.approveDesktop ? await ctx.approveDesktop(summary, verdict.reason) : false;
        if (!ok) throw new Error("The user declined this desktop action. Don't retry it; ask what they'd rather do.");
      }

      if (action.kind === "list") {
        const windows = await listWindows();
        const list = windows.map((w) => `- ${w.title}`).join("\n");
        return { content: windows.length ? `Open windows:\n${list}` : "No windows found.", summary: `${windows.length} windows` };
      }
      if (action.kind === "screenshot") {
        const shot = await capture(String(args.window ?? "") || undefined);
        return {
          content: `Screenshot of ${shot.title} (${shot.width}x${shot.height}). Coordinates you read from this image are what desktop_click expects.`,
          summary: shot.title,
          image: shot.dataUrl
        };
      }
      // Converted here rather than in the tool schema so the model keeps
      // working in the one coordinate space it can actually see.
      const real =
        action.kind === "click" || action.kind === "move"
          ? { ...action, ...toScreenCoords(action.x, action.y) }
          : action;
      await perform(real);
      return { content: `Done: ${describeAction(action, focused)}`, summary: describeAction(action, focused) };
    }
    case "browser_open_tab": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("Missing 'url'.");
      const { id } = await browserControl.openTab(url);
      // Give the new tab a moment to load before reading it; it was created
      // by a React commit, so it isn't navigable the instant it exists.
      await new Promise((r) => setTimeout(r, 1200));
      const page = await browserControl.readPage();
      return { content: `Opened tab ${id}: ${page.title} — ${page.url}\n\n${clip(page.text)}`, summary: page.url, url: page.url };
    }
    case "browser_list_tabs": {
      const { tabs } = await browserControl.listTabs();
      const list = tabs.map((t) => `- ${t.id}${t.active ? " (active)" : ""} — ${t.url || "blank"}`).join("\n");
      return { content: tabs.length ? `Open tabs:\n${list}` : "No tabs open.", summary: `${tabs.length} tabs` };
    }
    case "browser_switch_tab": {
      await browserControl.switchTab(String(args.id ?? ""));
      const page = await browserControl.readPage();
      return { content: `${page.title} — ${page.url}

${clip(page.text)}`, summary: page.url, url: page.url };
    }
    case "browser_close_tab": {
      const { closed } = await browserControl.closeTab(String(args.id ?? ""));
      return { content: `Closed tab ${closed}.`, summary: closed };
    }
    case "browser_go_back": {
      const page = await browserControl.goBack();
      return { content: `${page.title} — ${page.url}\n\n${clip(page.text)}`, summary: page.url, url: page.url };
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const argsText = argsOf(rawArgs);
  try {
    const outcome = await run(name, args, ctx);
    return {
      content: outcome.content,
      event: {
        name,
        summary: outcome.summary,
        ok: true,
        args: argsText,
        detail: detailOf(outcome.content),
        url: outcome.url,
        path: outcome.path,
        wrote: outcome.wrote,
        diff: outcome.diff,
        image: outcome.image
      }
    };
  } catch (err) {
    const message = describeError(err);
    return {
      content: `Tool "${name}" failed: ${message}`,
      event: { name, summary: message, ok: false, args: argsText, detail: message }
    };
  }
}

export function collectTools(opts: {
  webSearch: boolean;
  browserTools: boolean;
  terminal?: boolean;
  files?: boolean;
  desktop?: boolean;
  forced?: string[];
}): ToolDef[] {
  const all = [
    WEB_SEARCH_TOOL,
    ...QUIET_WEB_TOOLS,
    ...BROWSER_TOOLS,
    TERMINAL_TOOL,
    ...FILE_TOOLS,
    ...DESKTOP_TOOLS
  ];
  const picked = new Set<string>();
  // Searching is itself a browser action, so browser control always implies a
  // search tool. Otherwise "google X" leaves the model no option but to open a
  // search engine's home page, which scrapes as useless navigation chrome.
  if (opts.webSearch || opts.browserTools) {
    picked.add(WEB_SEARCH_TOOL.name);
    // The quiet pair rides with search rather than with browser control: they
    // need no browser at all, and they are the cheap path for research.
    for (const t of QUIET_WEB_TOOLS) picked.add(t.name);
  }
  if (opts.browserTools) for (const t of BROWSER_TOOLS) picked.add(t.name);
  if (opts.terminal) picked.add(TERMINAL_TOOL.name);
  if (opts.files) for (const t of FILE_TOOLS) picked.add(t.name);
  if (opts.desktop) for (const t of DESKTOP_TOOLS) picked.add(t.name);
  // An @[tool] mention grants that tool for this turn, toggle or not.
  for (const name of opts.forced ?? []) {
    if (all.some((t) => t.name === name)) picked.add(name);
  }
  return all.filter((t) => picked.has(t.name));
}
