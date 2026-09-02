// Presentation and parsing helpers for tool calls. Pure functions, shared by
// the renderer (which draws the cards) and the self-test (which checks them).

import type { ToolEvent } from "./types.js";

export interface ToolInfo {
  name: string;
  /** Short label for the @-mention list. */
  label: string;
  description: string;
  group: "search" | "browser" | "terminal" | "files";
}

/**
 * The tools a user can name with @[tool]. Kept in step with the real
 * definitions in electron/tools.ts by a self-test, so this can't silently
 * drift into offering tools that don't exist.
 */
export const TOOL_CATALOG: ToolInfo[] = [
  {
    name: "web_search",
    label: "Search the web",
    description: "Run a real search and read the results page",
    group: "search"
  },
  {
    name: "quiet_search",
    label: "Search quietly",
    description: "Search without opening the browser panel",
    group: "search"
  },
  {
    name: "fetch_url",
    label: "Read a page quietly",
    description: "Read a page's text without opening the browser",
    group: "search"
  },
  {
    name: "browser_navigate",
    label: "Open a URL",
    description: "Load a specific address in the built-in browser",
    group: "browser"
  },
  {
    name: "browser_read_page",
    label: "Read this page",
    description: "Read the text of whatever the browser is showing",
    group: "browser"
  },
  {
    name: "browser_click",
    label: "Click a link",
    description: "Click a link or button by its visible text",
    group: "browser"
  },
  {
    name: "browser_find_links",
    label: "Find links",
    description: "List links on the current page matching a query",
    group: "browser"
  },
  {
    name: "browser_open_tab",
    label: "Open a tab",
    description: "Open a URL in a new background tab",
    group: "browser"
  },
  {
    name: "browser_list_tabs",
    label: "List tabs",
    description: "See which tabs are open",
    group: "browser"
  },
  {
    name: "browser_switch_tab",
    label: "Switch tab",
    description: "Make another open tab active",
    group: "browser"
  },
  {
    name: "browser_close_tab",
    label: "Close a tab",
    description: "Close a tab that's no longer needed",
    group: "browser"
  },
  {
    name: "browser_go_back",
    label: "Go back",
    description: "Step back one page in the browser",
    group: "browser"
  },
  {
    name: "run_command",
    label: "Run a command",
    description: "Run a shell command in the terminal pane",
    group: "terminal"
  },
  {
    name: "read_file",
    label: "Read a file",
    description: "Read a text file from disk",
    group: "files"
  },
  {
    name: "list_dir",
    label: "List a folder",
    description: "See what's in a directory",
    group: "files"
  },
  {
    name: "write_file",
    label: "Write a file",
    description: "Create or replace a file, with your approval",
    group: "files"
  },
  {
    name: "edit_file",
    label: "Edit a file",
    description: "Change part of a file, with your approval",
    group: "files"
  }
];

export const TOOL_NAMES: string[] = TOOL_CATALOG.map((t) => t.name);

/** "https://duckduckgo.com/?q=x" -> "duckduckgo.com" */
export function hostOf(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return s.replace(/^[a-z]+:\/\//i, "").replace(/^www\./, "").split(/[/?#]/)[0] || s;
  }
}

/** Last path segment, so a card reads "Edited store.ts" not the whole path. */
export function baseName(raw: string): string {
  const s = (raw ?? "").trim().replace(/[\\/]+$/, "");
  if (!s) return "a file";
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function quote(s: string, max = 60): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return `“${t.length > max ? `${t.slice(0, max)}…` : t}”`;
}

/**
 * The one-line summary shown on a tool card, e.g. "Navigated to duckduckgo.com".
 */
export function describeToolEvent(e: ToolEvent): string {
  const target = e.url || e.summary || "";
  if (!e.ok) {
    const what: Record<string, string> = {
      web_search: "Search failed",
      browser_navigate: "Couldn't open the page",
      browser_read_page: "Couldn't read the page",
      browser_click: "Couldn't click that",
      browser_find_links: "Couldn't list links",
      browser_go_back: "Couldn't go back",
      browser_open_tab: "Couldn't open that tab",
      browser_list_tabs: "Couldn't list tabs",
      browser_switch_tab: "Couldn't switch tabs",
      browser_close_tab: "Couldn't close that tab",
      fetch_url: "Couldn't read that page",
      quiet_search: "Search failed",
      run_command: "Command failed",
      read_file: "Couldn't read that file",
      list_dir: "Couldn't list that folder",
      write_file: "Didn't write that file",
      edit_file: "Didn't edit that file"
    };
    return what[e.name] ?? `${e.name} failed`;
  }
  switch (e.name) {
    case "web_search":
      return `Searched for ${quote(e.summary)}`;
    case "browser_navigate":
      return `Navigated to ${hostOf(target)}`;
    case "browser_read_page":
      return `Read ${hostOf(target) || "the current page"}`;
    case "browser_click":
      return `Clicked ${quote(e.summary)}`;
    case "browser_find_links":
      return `Found links for ${quote(e.summary)}`;
    case "browser_go_back":
      return `Went back to ${hostOf(target)}`;
    case "browser_open_tab":
      return `Opened ${hostOf(target)} in a new tab`;
    case "browser_list_tabs":
      return `Listed tabs (${e.summary})`;
    case "browser_switch_tab":
      return `Switched to ${hostOf(target)}`;
    case "browser_close_tab":
      return "Closed a tab";
    case "fetch_url":
      return `Read ${hostOf(target)}`;
    case "quiet_search":
      return `Searched for ${quote(e.summary)}`;
    case "run_command":
      return `Ran ${quote(e.summary, 48)}`;
    case "read_file":
      return `Read ${baseName(e.path || e.summary)}`;
    case "list_dir":
      return `Listed ${baseName(e.path || e.summary)}`;
    case "write_file":
    case "edit_file": {
      const where = baseName(e.path || e.summary);
      if (!e.wrote) return `No change to ${where}`;
      const stat = e.diff ? countDiff(e.diff) : null;
      return stat ? `Edited ${where} (+${stat.added} -${stat.removed})` : `Edited ${where}`;
    }
    default:
      return e.summary ? `${e.name}: ${e.summary}` : e.name;
  }
}

/**
 * Pull @[tool] / @tool mentions out of a prompt. Only names in `known` count,
 * so an email address or a casual "@someone" is left alone.
 */
export function parseForcedTools(text: string, known: string[] = TOOL_NAMES): string[] {
  const found: string[] = [];
  // The @ has to start a word. Without that, "bob@web_search.com" reads as a
  // request to force web_search.
  const re = /(?:^|\s)@(?:\[([a-z0-9_]+)\]|([a-z0-9_]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? "")) !== null) {
    const name = (m[1] ?? m[2] ?? "").toLowerCase();
    if (known.includes(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Break a prompt into plain runs and @mention runs so a mention can be drawn
 * as a token rather than left as raw punctuation. Brackets are still accepted
 * on the way in — older messages have `@[web_search]` in them — but nothing
 * writes that form any more.
 */
export function splitMentions(text: string, known: string[] = TOOL_NAMES): { text: string; mention: boolean }[] {
  const out: { text: string; mention: boolean }[] = [];
  const re = /(^|\s)@(?:\[([a-z0-9_]+)\]|([a-z0-9_]+))/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? "")) !== null) {
    const name = (m[2] ?? m[3] ?? "").toLowerCase();
    if (!known.includes(name)) continue;
    const start = m.index + (m[1] ?? "").length; // the "@" itself
    const end = m.index + m[0].length;
    if (start > last) out.push({ text: text.slice(last, start), mention: false });
    out.push({ text: text.slice(start, end), mention: true });
    last = end;
  }
  if (last < (text ?? "").length) out.push({ text: text.slice(last), mention: false });
  return out;
}

/**
 * Pull reasoning out of a reply.
 *
 * Reasoning models (DeepSeek-R1, QwQ, and most of the thinking variants served
 * through Ollama) wrap their scratch work in <think> tags inline with the
 * answer. Left alone it renders as the reply; split out, it can go in its own
 * collapsible block. An unclosed tag means the model is still thinking, which
 * is what drives the live indicator.
 */
export function splitThinking(content: string): { thinking: string; answer: string; thinkingOpen: boolean } {
  const text = content ?? "";
  const open = /<think(?:ing)?>/i;
  const close = /<\/think(?:ing)?>/i;

  const thoughts: string[] = [];
  let answer = "";
  let rest = text;
  let thinkingOpen = false;

  for (;;) {
    const start = rest.search(open);
    if (start === -1) {
      answer += rest;
      break;
    }
    answer += rest.slice(0, start);
    const afterOpen = rest.slice(start).replace(open, "");
    const end = afterOpen.search(close);
    if (end === -1) {
      // Still streaming inside the tag.
      thoughts.push(afterOpen);
      thinkingOpen = true;
      break;
    }
    thoughts.push(afterOpen.slice(0, end));
    rest = afterOpen.slice(end).replace(close, "");
  }

  return { thinking: thoughts.join("\n\n").trim(), answer: answer.trim(), thinkingOpen };
}

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "tool"; event: ToolEvent; key: number };

/** A segment list with consecutive same-group tool calls folded together. */
export type GroupedSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; group: ToolGroup; events: ToolEvent[]; key: number };

/**
 * Interleave a message's text with the tool cards, using the offset recorded
 * when each tool ran. Events with no offset (older saved chats) sort to the
 * front, which is exactly where they used to render.
 */
export function splitByToolEvents(content: string, events: ToolEvent[] | undefined): MessageSegment[] {
  const list = events ?? [];
  if (list.length === 0) return content ? [{ kind: "text", text: content }] : [];

  const ordered = list
    .map((event, key) => ({ event, key, at: Math.max(0, Math.min(content.length, event.at ?? 0)) }))
    .sort((a, b) => a.at - b.at || a.key - b.key);

  const out: MessageSegment[] = [];
  let cursor = 0;
  for (const { event, key, at } of ordered) {
    if (at > cursor) {
      const slice = content.slice(cursor, at);
      if (slice.trim()) out.push({ kind: "text", text: slice });
      cursor = at;
    }
    out.push({ kind: "tool", event, key });
  }
  const tail = content.slice(cursor);
  if (tail.trim()) out.push({ kind: "text", text: tail });
  return out;
}

/**
 * Which bucket a tool call belongs in when the transcript groups them.
 *
 * A long agentic turn can make thirty calls, and thirty stacked cards is a
 * page of scrolling between the question and the answer. Grouping by what the
 * model was *doing* keeps the shape of the work visible — "searched the web 7
 * times, edited 3 files" — with the individual calls one click away.
 */
export type ToolGroup = "web" | "browser" | "terminal" | "files" | "desktop" | "other";

const GROUP_OF: Record<string, ToolGroup> = {
  web_search: "web",
  quiet_search: "web",
  fetch_url: "web",
  browser_navigate: "browser",
  browser_read_page: "browser",
  browser_click: "browser",
  browser_find_links: "browser",
  browser_go_back: "browser",
  browser_close_tab: "browser",
  browser_switch_tab: "browser",
  browser_list_tabs: "browser",
  browser_open_tab: "browser",
  run_command: "terminal",
  read_file: "files",
  list_dir: "files",
  write_file: "files",
  edit_file: "files",
  desktop_list_windows: "desktop",
  desktop_screenshot: "desktop",
  desktop_click: "desktop",
  desktop_type: "desktop",
  desktop_key: "desktop"
};

export function groupOf(name: string): ToolGroup {
  return GROUP_OF[name] ?? "other";
}

const GROUP_VERB: Record<ToolGroup, string> = {
  web: "Searched the web",
  browser: "Used the browser",
  terminal: "Ran commands",
  files: "Worked on files",
  desktop: "Used the desktop",
  other: "Used tools"
};

/** "Searched the web 7 times" / "Ran a command". Plain counting, no jargon. */
export function describeGroup(group: ToolGroup, count: number, failures: number): string {
  const singular: Record<ToolGroup, string> = {
    web: "Searched the web",
    browser: "Used the browser",
    terminal: "Ran a command",
    files: "Worked on a file",
    desktop: "Used the desktop",
    other: "Used a tool"
  };
  const base = count === 1 ? singular[group] : `${GROUP_VERB[group]} ${count} times`;
  return failures > 0 ? `${base} · ${failures} failed` : base;
}

export interface ToolRun {
  group: ToolGroup;
  events: ToolEvent[];
}

/**
 * Collapses a message's tool events into consecutive same-group runs.
 *
 * Consecutive rather than global: the order the model worked in is itself
 * information — search, then edit, then search again reads differently from
 * one lump of searches and one lump of edits — so a group breaks when the
 * model switches activity and starts again if it switches back.
 */
export function groupToolEvents(events: ToolEvent[]): ToolRun[] {
  const runs: ToolRun[] = [];
  for (const e of events) {
    const group = groupOf(e.name);
    const last = runs[runs.length - 1];
    if (last && last.group === group) last.events.push(e);
    else runs.push({ group, events: [e] });
  }
  return runs;
}

/**
 * Folds a segment list so the transcript shows activity rather than a wall of
 * individual calls. Text between two runs of the same kind still splits them,
 * because the model said something in between and that ordering is real.
 */
export function groupSegments(segments: MessageSegment[]): GroupedSegment[] {
  const out: GroupedSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      out.push(seg);
      continue;
    }
    const group = groupOf(seg.event.name);
    const last = out[out.length - 1];
    if (last && last.kind === "tools" && last.group === group) last.events.push(seg.event);
    else out.push({ kind: "tools", group, events: [seg.event], key: seg.key });
  }
  return out;
}
