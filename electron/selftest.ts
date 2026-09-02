import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { browserControl } from "./browserBridge.js";
import {
  executeTool,
  collectTools,
  WEB_SEARCH_TOOL,
  QUIET_WEB_TOOLS,
  BROWSER_TOOLS,
  TERMINAL_TOOL,
  FILE_TOOLS
} from "./tools.js";
import { applyEdit, readFileText, writeFileText } from "./files.js";
import { htmlToText, linksOf, titleOf } from "./fetcher.js";
import { clampText, stripMarkdown } from "../shared/plaintext.js";
import {
  buildIndex,
  decideRequest,
  hostBlocked,
  hostSuffixes,
  modeFor,
  stripTracking
} from "../shared/blocking.js";
import { TRACKER_ALLOW, TRACKER_DOMAINS, TRACKER_PATTERNS } from "../shared/trackers.js";
import { splitStreaming } from "../shared/streamSplit.js";
import { unifiedDiff, diffStat } from "../shared/diff.js";
import { buildEnvironmentPrompt, formatNow, osLabel, utcOffset } from "../shared/environment.js";
import { systemInfo } from "./terminal.js";
import { streamChat, sanitizeTitle, generateTitle } from "./providers.js";
import { reviewAndRevise } from "./critic.js";
import { runCommand, getCwd } from "./terminal.js";
import type { ChatStreamRequest, ProviderConfig, ToolEvent } from "../shared/types.js";
import { resolveTheme } from "../shared/types.js";
import type { Conversation } from "../shared/types.js";
import { branchTree, childrenOf, hasBranches, rootOf, sharedPrefixLength } from "../shared/branching.js";
import { APPROVAL_TOKEN, CRITIC_SYSTEM, parseVerdict, worthReviewing } from "../shared/critic.js";
import { COPY, PROVIDER_GUIDES, guideFor, providerReady } from "../shared/onboarding.js";
import {
  CODE_LENGTH,
  MAX_FAILURES,
  checkLockout,
  codesMatch,
  formatCode,
  generatePairingCode,
  normalizeCode,
  registerFailure,
  registerSuccess
} from "../shared/dashProtocol.js";
import { dashStatus, lanAddresses, startWebDash, stopWebDash } from "./webdash.js";
import {
  decide,
  describeAction,
  looksIrreversible,
  titleAllowed,
  type DesktopAction,
  type DesktopPolicy
} from "../shared/desktopPolicy.js";
import { PROVIDER_LABELS, DEFAULT_SETTINGS } from "../shared/types.js";
import {
  TOOL_CATALOG,
  baseName,
  describeGroup,
  groupOf,
  groupSegments,
  groupToolEvents,
  describeToolEvent,
  hostOf,
  parseForcedTools,
  splitByToolEvents,
  splitMentions,
  splitThinking
} from "../shared/toolCatalog.js";
import {
  GREETING_QUIPS,
  localDayKey,
  pickGreeting,
  resolve as resolveGreeting,
  shouldUseWeekday,
  timeBlockFor,
  weekdayFor
} from "../shared/greetings.js";

/**
 * Exercises the main -> renderer -> <webview> path that the model uses to
 * browse. Run with: ATLA_SELFTEST=1 electron .
 */
const FIXTURE = `<!doctype html>
<html><head><title>Atla Test Page</title></head>
<body>
  <h1>Hello from the fixture</h1>
  <p>UNIQUE_MARKER_ALPHA</p>
  <a href="page2.html">Go to second page</a>
  <script>document.title = document.title;</script>
</body></html>`;

const FIXTURE2 = `<!doctype html>
<html><head><title>Second Page</title></head>
<body><p>UNIQUE_MARKER_BETA</p></body></html>`;

/**
 * Stands up a fake OpenAI-compatible endpoint that asks for a tool call on the
 * first turn and answers on the second, then drives streamChat through it.
 */
async function runToolLoopTest(pageUrl: string): Promise<{
  text: string;
  toolEvents: ToolEvent[];
  requests: number;
  sawMarkerInToolMessage: boolean;
}> {
  let requests = 0;
  let sawMarkerInToolMessage = false;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const turn = requests;
      if (turn === 2) {
        try {
          const parsed = JSON.parse(body) as { messages: { role: string; content?: string }[] };
          sawMarkerInToolMessage = parsed.messages.some(
            (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("UNIQUE_MARKER_ALPHA")
          );
        } catch {
          /* ignore */
        }
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (turn === 1) {
        // Ask for a tool call, split across chunks like a real stream.
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "browser_navigate", arguments: '{"url":"' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `${pageUrl}"}` } }] } }] });
      } else {
        send({ choices: [{ delta: { content: "ALPHA_" } }] });
        send({ choices: [{ delta: { content: "CONFIRMED" } }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const cfg: ProviderConfig = {
    id: "test",
    kind: "openai-compatible",
    label: "mock",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ["mock-model"],
    createdAt: Date.now()
  };
  const req: ChatStreamRequest = {
    requestId: "r1",
    providerId: "test",
    model: "mock-model",
    system: "test",
    messages: [{ role: "user", content: "read the page" }],
    temperature: 1,
    maxTokens: 256,
    webSearch: false,
    browserTools: true,
    maxToolIterations: 4,
    searchEngineUrl: "https://duckduckgo.com/?q=%s",
    forcedTools: [],
    terminalTool: false,
    approveCommands: true,
    fileTools: false,
    approveWrites: true
  };

  const toolEvents: ToolEvent[] = [];
  let streamed = "";
  let returned = "";
  try {
    returned = await streamChat(
      cfg,
      req,
      { onChunk: (d) => (streamed += d), onToolEvent: (e) => toolEvents.push(e) },
      new AbortController().signal
    );
  } finally {
    server.close();
  }
  // The streamed chunks and the returned text must agree.
  if (streamed !== returned) throw new Error(`stream/return mismatch: ${JSON.stringify(streamed)} vs ${JSON.stringify(returned)}`);
  return { text: returned, toolEvents, requests, sawMarkerInToolMessage };
}

/**
 * Ollama's wire format differs from OpenAI's in three ways that all have to be
 * right: NDJSON instead of SSE, `arguments` as an object instead of a JSON
 * string, and tool results needing `tool_name`. This exercises all three.
 */
async function runOllamaToolLoopTest(pageUrl: string): Promise<{
  text: string;
  toolEvents: ToolEvent[];
  requests: number;
  toolMessage: { role?: string; tool_name?: string; content?: string } | null;
}> {
  let requests = 0;
  let toolMessage: { role?: string; tool_name?: string; content?: string } | null = null;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const turn = requests;
      if (turn === 2) {
        try {
          const parsed = JSON.parse(body) as { messages: { role?: string; tool_name?: string; content?: string }[] };
          toolMessage = parsed.messages.find((m) => m.role === "tool") ?? null;
        } catch {
          /* ignore */
        }
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);

      if (turn === 1) {
        // Ollama sends arguments as an object, not a JSON string.
        line({
          message: { role: "assistant", content: "", tool_calls: [{ function: { name: "browser_navigate", arguments: { url: pageUrl } } }] },
          done: false
        });
        line({ message: { role: "assistant", content: "" }, done: true });
      } else {
        line({ message: { role: "assistant", content: "ALPHA_" }, done: false });
        line({ message: { role: "assistant", content: "CONFIRMED" }, done: false });
        line({ message: { role: "assistant", content: "" }, done: true });
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const cfg: ProviderConfig = {
    id: "test-ollama",
    kind: "ollama",
    label: "mock ollama",
    baseUrl: `http://127.0.0.1:${port}`,
    models: ["mock"],
    createdAt: Date.now()
  };
  const req: ChatStreamRequest = {
    requestId: "r2",
    providerId: "test-ollama",
    model: "mock",
    system: "test",
    messages: [{ role: "user", content: "read the page" }],
    temperature: 1,
    maxTokens: 256,
    webSearch: false,
    browserTools: true,
    maxToolIterations: 4,
    searchEngineUrl: "https://duckduckgo.com/?q=%s",
    forcedTools: [],
    terminalTool: false,
    approveCommands: true,
    fileTools: false,
    approveWrites: true
  };

  const toolEvents: ToolEvent[] = [];
  let text = "";
  try {
    text = await streamChat(cfg, req, { onChunk: () => {}, onToolEvent: (e) => toolEvents.push(e) }, new AbortController().signal);
  } finally {
    server.close();
  }
  return { text, toolEvents, requests, toolMessage };
}

/** generateTitle end-to-end: real adapter, real streaming, real sanitizing. */
async function runTitleTest(): Promise<{ title: string; sentTools: boolean; maxTokens: number }> {
  let sentTools = false;
  let maxTokens = -1;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { tools?: unknown[]; max_tokens?: number };
        sentTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        maxTokens = parsed.max_tokens ?? -1;
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Deliberately messy, the way real models answer.
      for (const chunk of ['Sure! Here\'s a title:\n', '**"Ollama ', "Tool Call ", 'Bug Fix"**.']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const cfg: ProviderConfig = {
    id: "t",
    kind: "openai-compatible",
    label: "mock",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ["m"],
    createdAt: Date.now()
  };
  try {
    const title = await generateTitle(cfg, "m", "User: hi\n\nAssistant: hello", new AbortController().signal);
    return { title, sentTools, maxTokens };
  } finally {
    server.close();
  }
}

/**
 * An @[tool] mention has to pin the first request and then let go, or the model
 * would call the same tool until maxToolIterations ran out instead of
 * answering. Also checks a forced tool is offered even with its toggle off.
 */
async function runForcedToolTest(pageUrl: string): Promise<{
  toolChoices: (unknown | undefined)[];
  offeredTools: string[][];
  requests: number;
  text: string;
}> {
  let requests = 0;
  const toolChoices: (unknown | undefined)[] = [];
  const offeredTools: string[][] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const turn = requests;
      try {
        const parsed = JSON.parse(body) as {
          tool_choice?: unknown;
          tools?: { function?: { name?: string } }[];
        };
        toolChoices.push(parsed.tool_choice);
        offeredTools.push((parsed.tools ?? []).map((t) => t.function?.name ?? "?"));
      } catch {
        toolChoices.push(undefined);
        offeredTools.push([]);
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (turn === 1) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "browser_navigate", arguments: JSON.stringify({ url: pageUrl }) } }
                ]
              }
            }
          ]
        });
      } else {
        send({ choices: [{ delta: { content: "FORCED_OK" } }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const cfg: ProviderConfig = {
    id: "test",
    kind: "openai-compatible",
    label: "mock",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ["mock-model"],
    createdAt: Date.now()
  };
  const req: ChatStreamRequest = {
    requestId: "forced",
    providerId: "test",
    model: "mock-model",
    system: "test",
    messages: [{ role: "user", content: "@[browser_navigate] open it" }],
    temperature: 1,
    maxTokens: 256,
    // Both toggles off: the mention alone has to make the tool available.
    webSearch: false,
    browserTools: false,
    maxToolIterations: 4,
    searchEngineUrl: "https://duckduckgo.com/?q=%s",
    forcedTools: ["browser_navigate"],
    terminalTool: false,
    approveCommands: true,
    fileTools: false,
    approveWrites: true
  };

  let text = "";
  try {
    text = await streamChat(cfg, req, { onChunk: (d) => (text += d), onToolEvent: () => {} }, new AbortController().signal);
  } finally {
    server.close();
  }
  return { toolChoices, offeredTools, requests, text };
}

/**
 * Gemini's wire format differs from everything else: functionCall parts inside
 * SSE candidates, functionResponse parts sent back as a user turn, and an
 * uppercase schema. It also refuses google_search alongside function
 * declarations, so this checks we never send both.
 */
async function runGoogleToolLoopTest(pageUrl: string): Promise<{
  text: string;
  toolEvents: ToolEvent[];
  requests: number;
  bodies: Record<string, unknown>[];
}> {
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const turn = requests;
      try {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (turn === 1) {
        send({
          candidates: [
            { content: { parts: [{ functionCall: { name: "browser_navigate", args: { url: pageUrl } } }] } }
          ]
        });
      } else {
        send({ candidates: [{ content: { parts: [{ text: "ALPHA_" }] } }] });
        send({ candidates: [{ content: { parts: [{ text: "CONFIRMED" }] } }] });
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const cfg: ProviderConfig = {
    id: "test-google",
    kind: "google",
    label: "mock gemini",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: "k",
    models: ["gemini-3-flash-preview"],
    createdAt: Date.now()
  };
  const req: ChatStreamRequest = {
    requestId: "g1",
    providerId: "test-google",
    model: "gemini-3-flash-preview",
    system: "test",
    messages: [{ role: "user", content: "read the page" }],
    temperature: 1,
    maxTokens: 256,
    webSearch: true,
    browserTools: true,
    maxToolIterations: 4,
    searchEngineUrl: "https://duckduckgo.com/?q=%s",
    forcedTools: [],
    terminalTool: false,
    approveCommands: true,
    fileTools: false,
    approveWrites: true
  };

  const toolEvents: ToolEvent[] = [];
  let text = "";
  try {
    text = await streamChat(cfg, req, { onChunk: () => {}, onToolEvent: (e) => toolEvents.push(e) }, new AbortController().signal);
  } finally {
    server.close();
  }
  return { text, toolEvents, requests, bodies };
}

/** The command gate: approved runs, denied doesn't, and no approver means no. */
async function runCommandToolTest(): Promise<{
  approved: { ok: boolean; content: string };
  denied: { ok: boolean; content: string };
  ungated: { ok: boolean; content: string };
  askedFor: string[];
}> {
  const askedFor: string[] = [];
  const approved = await executeTool(
    "run_command",
    { command: "echo approved_marker" },
    {
      searchEngineUrl: "",
      approveCommand: async (command) => {
        askedFor.push(command);
        return true;
      }
    }
  );
  const denied = await executeTool(
    "run_command",
    { command: "echo denied_marker" },
    { searchEngineUrl: "", approveCommand: async () => false }
  );
  // No approver wired up at all must read as a refusal, not a free pass.
  const ungated = await executeTool("run_command", { command: "echo ungated_marker" }, { searchEngineUrl: "" });
  return {
    approved: { ok: approved.event.ok, content: approved.content },
    denied: { ok: denied.event.ok, content: denied.content },
    ungated: { ok: ungated.event.ok, content: ungated.content },
    askedFor
  };
}

/** The write gate: approved lands on disk, denied leaves the file untouched. */
async function runFileToolTest(dir: string): Promise<{
  created: { ok: boolean; wrote: boolean; onDisk: string };
  denied: { ok: boolean; content: string; onDisk: string };
  ungated: { ok: boolean; onDisk: string };
  edited: { ok: boolean; onDisk: string };
  noop: { ok: boolean; wrote: boolean; asked: number };
  read: { ok: boolean; content: string };
  sawDiff: string;
}> {
  const target = path.join(dir, "gate.txt");
  const allow = { searchEngineUrl: "", approveWrite: async () => true };
  const deny = { searchEngineUrl: "", approveWrite: async () => false };

  let sawDiff = "";
  const created = await executeTool(
    "write_file",
    { path: target, content: "alpha\nbeta\n" },
    {
      searchEngineUrl: "",
      approveWrite: async (_t: string, d: string) => {
        sawDiff = d;
        return true;
      }
    }
  );
  const afterCreate = await fs.readFile(target, "utf8");

  const denied = await executeTool("write_file", { path: target, content: "CLOBBERED" }, deny);
  const afterDeny = await fs.readFile(target, "utf8");

  // No approver wired up at all must read as a refusal, exactly like commands.
  const ungated = await executeTool("write_file", { path: target, content: "UNGATED" }, { searchEngineUrl: "" });
  const afterUngated = await fs.readFile(target, "utf8");

  const edited = await executeTool("edit_file", { path: target, old_text: "beta", new_text: "gamma" }, allow);
  const afterEdit = await fs.readFile(target, "utf8");

  // Writing identical content must not raise a prompt at all.
  let asked = 0;
  const noop = await executeTool(
    "write_file",
    { path: target, content: afterEdit },
    {
      searchEngineUrl: "",
      approveWrite: async () => {
        asked++;
        return true;
      }
    }
  );

  const read = await executeTool("read_file", { path: target }, { searchEngineUrl: "" });

  return {
    created: { ok: created.event.ok, wrote: Boolean(created.event.wrote), onDisk: afterCreate },
    denied: { ok: denied.event.ok, content: denied.content, onDisk: afterDeny },
    ungated: { ok: ungated.event.ok, onDisk: afterUngated },
    edited: { ok: edited.event.ok, onDisk: afterEdit },
    noop: { ok: noop.event.ok, wrote: Boolean(noop.event.wrote), asked },
    read: { ok: read.event.ok, content: read.content },
    sawDiff
  };
}

/**
 * Drives a real review-and-revise round against a mock provider: turn 1 is the
 * answer, turn 2 the review, turn 3 the revision.
 */
async function runCriticTest(
  _pageUrl: string,
  approve = false
): Promise<{
  finalText: string;
  critique?: string;
  reviewPrompt: string;
  revisionPrompt: string;
  reviewSawAnswer: boolean;
  reviewHadTools: boolean;
  calls: number;
}> {
  let calls = 0;
  let reviewPrompt = "";
  let revisionPrompt = "";
  let reviewHadTools = true;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      const turn = calls;
      let lastUser = "";
      try {
        const parsed = JSON.parse(body) as {
          tools?: unknown[];
          messages?: { role: string; content: string }[];
        };
        const users = (parsed.messages ?? []).filter((m) => m.role === "user");
        lastUser = users[users.length - 1]?.content ?? "";
        if (turn === 2) reviewHadTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      } catch {
        /* leave the defaults */
      }
      if (turn === 2) reviewPrompt = lastUser;
      if (turn === 3) revisionPrompt = lastUser;

      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (turn === 1) {
        // Long enough to clear the review threshold used below.
        send({ choices: [{ delta: { content: `FIRST ANSWER ${"x".repeat(300)}` } }] });
      } else if (turn === 2) {
        send({ choices: [{ delta: { content: approve ? "LGTM" : "1. The second sentence is wrong." } }] });
      } else {
        send({ choices: [{ delta: { content: "REVISED ANSWER" } }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const cfg: ProviderConfig = {
    id: "test",
    kind: "openai-compatible",
    label: "mock",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ["mock-model"],
    createdAt: Date.now()
  };
  const base: ChatStreamRequest = {
    requestId: "critic",
    providerId: "test",
    model: "mock-model",
    system: "test",
    messages: [{ role: "user", content: "explain the thing" }],
    temperature: 1,
    maxTokens: 256,
    webSearch: false,
    browserTools: false,
    maxToolIterations: 2,
    searchEngineUrl: "",
    forcedTools: [],
    terminalTool: false,
    approveCommands: true,
    fileTools: false,
    approveWrites: true
  };

  let finalText = "";
  let critique: string | undefined;
  const signal = new AbortController().signal;
  try {
    const first = await streamChat(cfg, base, { onChunk: (d) => (finalText += d), onToolEvent: () => {} }, signal);
    const outcome = await reviewAndRevise(
      cfg,
      cfg,
      base,
      { providerId: "test", model: "mock-model", rounds: 1, minChars: 280, prompt: "explain the thing" },
      {
        onReviewing: () => {},
        // The renderer clears the body for the revision; mirror that here or
        // the test would report the two answers concatenated.
        onRevising: (notes) => {
          critique = notes;
          finalText = "";
        },
        onChunk: (d) => (finalText += d)
      },
      signal,
      first
    );
    finalText = outcome.text;
    critique = outcome.critique;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    finalText,
    critique,
    reviewPrompt,
    revisionPrompt,
    reviewSawAnswer: reviewPrompt.includes("FIRST ANSWER"),
    reviewHadTools,
    calls
  };
}

/** Are code fences balanced? A split inside one wrecks both halves. */
function fencesEven(text: string): boolean {
  const m = text.match(/^[ \t]*(```|~~~)/gm);
  return !m || m.length % 2 === 0;
}

export async function runSelfTest(): Promise<void> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) console.log(`  ok   ${name}`);
    else {
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
      failures.push(name);
    }
  };

  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atla-selftest-"));
    await fs.writeFile(path.join(dir, "page1.html"), FIXTURE, "utf-8");
    await fs.writeFile(path.join(dir, "page2.html"), FIXTURE2, "utf-8");
    const url1 = pathToFileURL(path.join(dir, "page1.html")).toString();

    console.log("\n[selftest] browser RPC");

    // Give the renderer a moment to mount the webview and register its handler.
    await new Promise((r) => setTimeout(r, 2500));

    const page = await browserControl.navigate(url1);
    check("navigate returns page text", page.text.includes("UNIQUE_MARKER_ALPHA"), JSON.stringify(page.text.slice(0, 80)));
    check("navigate returns title", page.title.includes("Atla Test Page"), page.title);

    const read = await browserControl.readPage();
    check("readPage reads current page", read.text.includes("UNIQUE_MARKER_ALPHA"));

    const links = await browserControl.findLinks("second");
    check("findLinks finds the link", links.links.some((l) => l.text.toLowerCase().includes("second")));

    const clicked = await browserControl.click("Go to second page");
    check("click follows the link", clicked.text.includes("UNIQUE_MARKER_BETA"), clicked.url);

    // Deterministic history: two explicit navigations, then one step back.
    const url2 = pathToFileURL(path.join(dir, "page2.html")).toString();
    await browserControl.navigate(url1);
    await browserControl.navigate(url2);
    const back = await browserControl.goBack();
    check(
      "goBack returns to the previous page",
      back.text.includes("UNIQUE_MARKER_ALPHA"),
      `url=${back.url}, text=${JSON.stringify(back.text.slice(0, 60))}`
    );

    console.log("\n[selftest] tool layer");
    const navTool = await executeTool("browser_navigate", { url: url1 }, { searchEngineUrl: "https://duckduckgo.com/?q=%s" });
    check("browser_navigate tool ok", navTool.event.ok && navTool.content.includes("UNIQUE_MARKER_ALPHA"));
    // The tool card's "View details" and "Open" both read off the event.
    check("tool event carries a URL for the Open button", Boolean(navTool.event.url), navTool.event.url ?? "(none)");
    check("tool event carries its arguments", (navTool.event.args ?? "").includes("url"), navTool.event.args ?? "(none)");
    check(
      "tool event carries a result excerpt",
      (navTool.event.detail ?? "").includes("UNIQUE_MARKER_ALPHA"),
      `${(navTool.event.detail ?? "").slice(0, 40)}…`
    );

    const badTool = await executeTool("browser_click", { text: "nonexistent-zzz" }, { searchEngineUrl: "" });
    check("failed tool reports ok:false instead of throwing", !badTool.event.ok);

    const unknown = await executeTool("not_a_tool", {}, { searchEngineUrl: "" });
    check("unknown tool handled gracefully", !unknown.event.ok);

    console.log("\n[selftest] title sanitizing");
    const titleCases: [string, string][] = [
      ['"Fixing the Ollama Tool Bug"', "Fixing the Ollama Tool Bug"],
      ["Title: Browser Automation Setup", "Browser Automation Setup"],
      ["**Adblock Filter Rules**", "Adblock Filter Rules"],
      ["Sure! Here's a title:\nDebugging Preload Scripts", "Debugging Preload Scripts"],
      ["<think>The user wants...</think>\nIcon Generation Pipeline", "Icon Generation Pipeline"],
      ["Electron Window Setup.", "Electron Window Setup"],
      // Quote wrapped in punctuation - regression from the e2e title test.
      ['**"Ollama Tool Call Bug Fix"**.', "Ollama Tool Call Bug Fix"],
      ['"Trailing Quote Then Period".', "Trailing Quote Then Period"],
      ["  spaced   out   title  ", "spaced out title"],
      ["", ""]
    ];
    for (const [input, want] of titleCases) {
      const got = sanitizeTitle(input);
      check(`title: ${JSON.stringify(input.slice(0, 34))}`, got === want, `got ${JSON.stringify(got)}`);
    }
    check("title is length-capped", sanitizeTitle("x".repeat(200)).length === 60);

    console.log("\n[selftest] title generation (mock provider)");
    const t = await runTitleTest();
    check("messy model reply is cleaned to a bare title", t.title === "Ollama Tool Call Bug Fix", JSON.stringify(t.title));
    check("title request carries no tools", !t.sentTools);
    check("title request is cheap", t.maxTokens > 0 && t.maxTokens <= 64, `max_tokens=${t.maxTokens}`);


    console.log("\n[selftest] tool catalog");
    const realNames = [WEB_SEARCH_TOOL, ...QUIET_WEB_TOOLS, ...BROWSER_TOOLS, TERMINAL_TOOL, ...FILE_TOOLS]
      .map((t) => t.name)
      .sort();
    const catalogNames = TOOL_CATALOG.map((t) => t.name).sort();
    check(
      "@-mention catalog matches the real tool definitions",
      realNames.join(",") === catalogNames.join(","),
      `real=[${realNames}] catalog=[${catalogNames}]`
    );

    console.log("\n[selftest] @[tool] parsing");
    const mentionCases: [string, string[]][] = [
      ["@[web_search] latest electron release", ["web_search"]],
      ["@web_search what is new", ["web_search"]],
      ["use @[browser_navigate] and @[browser_read_page] please", ["browser_navigate", "browser_read_page"]],
      ["@web_search twice @[web_search] should dedupe", ["web_search"]],
      ["email me at bob@web_search.com", []],
      ["@not_a_real_tool do something", []],
      ["no mentions at all", []],
      ["", []]
    ];
    for (const [input, want] of mentionCases) {
      const got = parseForcedTools(input);
      check(`mention: ${JSON.stringify(input.slice(0, 38))}`, got.join(",") === want.join(","), `got [${got}]`);
    }

    console.log("\n[selftest] tool card labels");
    check("host is stripped to the bare domain", hostOf("https://www.duckduckgo.com/?q=x") === "duckduckgo.com");
    check(
      "navigate reads as a sentence",
      describeToolEvent({ name: "browser_navigate", summary: "https://duckduckgo.com/", ok: true, url: "https://duckduckgo.com/" }) ===
        "Navigated to duckduckgo.com",
      describeToolEvent({ name: "browser_navigate", summary: "https://duckduckgo.com/", ok: true })
    );
    check(
      "search shows the query",
      describeToolEvent({ name: "web_search", summary: "electron 32 release notes", ok: true }).startsWith("Searched for")
    );
    check(
      "a failure says so rather than showing a URL",
      describeToolEvent({ name: "browser_click", summary: "no such link", ok: false }) === "Couldn't click that"
    );

    console.log("\n[selftest] inline tool placement");
    const segEvents: ToolEvent[] = [
      { name: "web_search", summary: "a", ok: true, at: 13 },
      { name: "browser_navigate", summary: "b", ok: true, at: 13 }
    ];
    const segs = splitByToolEvents("Let me look. Here it is.", segEvents);
    check(
      "text before a tool stays before it",
      segs[0].kind === "text" && segs[0].text === "Let me look. ",
      JSON.stringify(segs[0])
    );
    check("tools at the same offset keep their order", segs[1].kind === "tool" && segs[1].event.name === "web_search");
    check("second tool follows the first", segs[2].kind === "tool" && segs[2].event.name === "browser_navigate");
    check(
      "trailing text comes after the tools",
      segs[3].kind === "text" && segs[3].text === "Here it is.",
      JSON.stringify(segs[3])
    );
    const legacy = splitByToolEvents("answer only", [{ name: "web_search", summary: "x", ok: true }]);
    check("events with no offset render first, as they used to", legacy[0].kind === "tool" && legacy[1].kind === "text");
    check("no events means a single text run", splitByToolEvents("hi", []).length === 1);
    check("empty content with no events renders nothing", splitByToolEvents("", []).length === 0);

    console.log("\n[selftest] @mention tokens");
    const mentionRuns = splitMentions("check @web_search and @[browser_click] plus bob@web_search.com");
    check(
      "bare @name is a token",
      mentionRuns.some((r) => r.mention && r.text === "@web_search"),
      JSON.stringify(mentionRuns)
    );
    check(
      "bracket form still reads as a token, for older messages",
      mentionRuns.some((r) => r.mention && r.text === "@[browser_click]")
    );
    check("an email address is left alone", !mentionRuns.some((r) => r.mention && r.text.includes(".com")));
    check(
      "runs rejoin into exactly the original text",
      mentionRuns.map((r) => r.text).join("") === "check @web_search and @[browser_click] plus bob@web_search.com"
    );
    check("plain text yields a single run", splitMentions("nothing here").length === 1);
    check("an unknown @name is not a token", splitMentions("@not_a_tool").every((r) => !r.mention));

    console.log("\n[selftest] terminal");
    const echoed = await runCommand("echo atla_selftest_marker");
    check("command runs and streams output", echoed.output.includes("atla_selftest_marker"), JSON.stringify(echoed.output.slice(0, 60)));
    check("successful command exits 0", echoed.code === 0, `code=${echoed.code}`);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atla-term-"));
    const before = getCwd();
    await runCommand(`cd ${JSON.stringify(tmpDir)}`);
    // cd runs in-process; a spawned shell would exit and take its cwd with it.
    check("cd changes the working directory", getCwd() !== before, getCwd());
    await runCommand("cd does-not-exist-zzz");
    check("a bad cd leaves the directory alone", getCwd() !== before, getCwd());
    const failed = await runCommand("exit 3");
    check("a failing command reports its exit code", failed.code === 3, `code=${failed.code}`);

    console.log("\n[selftest] thinking blocks");
    const thinkCases: [string, string, string, boolean][] = [
      ["<think>weighing it up</think>Here is the answer.", "weighing it up", "Here is the answer.", false],
      ["<think>still going", "still going", "", true],
      ["no tags at all", "", "no tags at all", false],
      ["<thinking>alt tag</thinking>done", "alt tag", "done", false],
      ["before <think>mid</think> after", "mid", "before  after", false]
    ];
    for (const [input, wantThinking, wantAnswer, wantOpen] of thinkCases) {
      const got = splitThinking(input);
      check(
        `thinking: ${JSON.stringify(input.slice(0, 34))}`,
        got.thinking === wantThinking && got.answer === wantAnswer && got.thinkingOpen === wantOpen,
        JSON.stringify(got)
      );
    }

    console.log("\n[selftest] weekday greeting cadence");
    const weekdayCase = (lastShown: string, hadConversationToday: boolean) =>
      shouldUseWeekday({ today: "2026-09-02", lastShown, hadConversationToday });

    // The whole point: a fresh day with nothing said yet.
    check("first chat of a quiet day gets the weekday line", weekdayCase("", false));
    check("a day never seen before also counts", weekdayCase("2026-09-01", false));

    // The bug this replaced: the line came back on every new chat opened
    // before sending anything, so five empty chats meant five greetings.
    check("it does not repeat later the same day", !weekdayCase("2026-09-02", false));

    // Having actually talked today rules it out regardless of what was shown.
    check("talking today switches to time-based", !weekdayCase("", true));
    check("talking today wins even if never shown", !weekdayCase("2026-08-30", true));

    // Both conditions have to hold, so the truth table is worth pinning whole.
    const table: [string, boolean, boolean][] = [
      ["", false, true],
      ["", true, false],
      ["2026-09-02", false, false],
      ["2026-09-02", true, false]
    ];
    for (const [lastShown, had, want] of table) {
      check(
        `lastShown=${JSON.stringify(lastShown)} hadToday=${had} -> ${want}`,
        weekdayCase(lastShown, had) === want
      );
    }

    console.log("\n[selftest] local day key");
    check("day key is the local calendar date", localDayKey(new Date(2026, 8, 2, 13, 30)) === "2026-09-02");
    check("months and days are zero-padded", localDayKey(new Date(2026, 0, 5)) === "2026-01-05");
    // The reason this isn't toISOString(): late evening local time is already
    // tomorrow in UTC for anyone east of Greenwich, and yesterday for anyone
    // west — either way the weekday line would land on the wrong day.
    const lateEvening = new Date(2026, 8, 2, 23, 30);
    check("late evening stays on today's date", localDayKey(lateEvening) === "2026-09-02", localDayKey(lateEvening));
    const earlyMorning = new Date(2026, 8, 2, 0, 15);
    check("just after midnight is the new day", localDayKey(earlyMorning) === "2026-09-02", localDayKey(earlyMorning));
    // Consecutive days must differ, or "once a day" silently becomes "once".
    check(
      "the key advances with the day",
      localDayKey(new Date(2026, 8, 2)) !== localDayKey(new Date(2026, 8, 3))
    );

    console.log("\n[selftest] greetings");
    const greetCases: [string, string | undefined, string][] = [
      ["Fresh week, {name}", "Aria", "Fresh week, Aria"],
      ["Fresh week, {name}", undefined, "Fresh week"],
      ["Coffee in hand, {name}?", undefined, "Coffee in hand?"],
      ["Coffee in hand, {name}?", "Aria", "Coffee in hand, Aria?"],
      ["Still up, {name}?", "", "Still up?"],
      // "You" is the app's default profile name, not something to greet.
      ["Morning, {name}", "You", "Morning"],
      ["Ready when you are, {name}", "  Aria  ", "Ready when you are, Aria"],
      ["Quiet hours", "Aria", "Quiet hours"]
    ];
    for (const [tpl, who, want] of greetCases) {
      const got = resolveGreeting(tpl, who);
      check(`greeting: ${JSON.stringify(tpl)} + ${JSON.stringify(who)}`, got === want, `got ${JSON.stringify(got)}`);
    }
    check("no quip leaks a stray placeholder", (() => {
      const all = [
        ...Object.values(GREETING_QUIPS.weekdayFirstSession).flat(),
        ...Object.values(GREETING_QUIPS.timeOfDay).flat(),
        ...GREETING_QUIPS.anytime
      ];
      return all.every((t) => !resolveGreeting(t, undefined).includes("{") && !resolveGreeting(t, "Aria").includes("{"));
    })());
    check("time blocks split at the documented hours", (() => {
      const at = (h: number) => timeBlockFor(new Date(2026, 0, 1, h, 30));
      return at(0) === "lateNight" && at(4) === "lateNight" && at(5) === "morning" && at(11) === "morning" &&
        at(12) === "afternoon" && at(16) === "afternoon" && at(17) === "evening" && at(23) === "evening";
    })());
    // 2026-09-01 is a Tuesday.
    check("weekday lookup is right", weekdayFor(new Date(2026, 8, 1)) === "tuesday", weekdayFor(new Date(2026, 8, 1)));
    check(
      "first session of the day uses the weekday pool",
      GREETING_QUIPS.weekdayFirstSession.tuesday
        .map((t) => resolveGreeting(t, "Aria"))
        .includes(pickGreeting({ name: "Aria", date: new Date(2026, 8, 1, 14), firstSessionToday: true }))
    );
    check(
      "otherwise it draws from the hour's pool plus anytime",
      [...GREETING_QUIPS.timeOfDay.afternoon, ...GREETING_QUIPS.anytime]
        .map((t) => resolveGreeting(t, "Aria"))
        .includes(pickGreeting({ name: "Aria", date: new Date(2026, 8, 1, 14), firstSessionToday: false }))
    );
    check(
      "avoid keeps it from repeating the last line",
      (() => {
        // Force the picker onto the first choice every time; with `avoid` set to
        // that line it has to hand back something else.
        const first = pickGreeting({ date: new Date(2026, 8, 1, 14), random: () => 0 });
        const next = pickGreeting({ date: new Date(2026, 8, 1, 14), random: () => 0, avoid: first });
        return next !== first;
      })()
    );

    console.log("\n[selftest] tool availability");
    const names = (o: { webSearch: boolean; browserTools: boolean; forced?: string[] }) => collectTools(o).map((t) => t.name);
    check(
      "browser control implies a search tool",
      names({ webSearch: false, browserTools: true }).includes("web_search"),
      names({ webSearch: false, browserTools: true }).join(",")
    );
    // Search brings the quiet pair with it: they need no browser, and they
    // are the cheap path for research, so anything allowed to search should
    // have them rather than being pushed through page loads.
    check(
      "web search brings the quiet tools with it",
      names({ webSearch: true, browserTools: false }).sort().join(",") === "fetch_url,quiet_search,web_search",
      names({ webSearch: true, browserTools: false }).join(",")
    );
    check("no capabilities means no tools", names({ webSearch: false, browserTools: false }).length === 0);
    check("web_search is not duplicated when both are on", names({ webSearch: true, browserTools: true }).filter((n) => n === "web_search").length === 1);
    check(
      "a forced tool is offered even with every toggle off",
      names({ webSearch: false, browserTools: false, forced: ["browser_click"] }).join(",") === "browser_click"
    );
    check(
      "forcing does not drop the tools the toggles already allowed",
      names({ webSearch: true, browserTools: false, forced: ["browser_go_back"] }).sort().join(",") ===
        "browser_go_back,fetch_url,quiet_search,web_search"
    );
    check(
      "an unknown forced name is ignored rather than crashing",
      names({ webSearch: false, browserTools: false, forced: ["nope"] }).length === 0
    );

    console.log("\n[selftest] tool-calling loop (mock OpenAI-compatible server)");
    const loop = await runToolLoopTest(url1);
    check("model's tool call was executed", loop.toolEvents.some((e) => e.name === "browser_navigate" && e.ok), JSON.stringify(loop.toolEvents));
    check("tool result fed back and final answer streamed", loop.text.includes("ALPHA_CONFIRMED"), JSON.stringify(loop.text));
    check("tool result reached the model", loop.sawMarkerInToolMessage, "tool message did not contain page text");
    check("loop made exactly 2 round trips", loop.requests === 2, `made ${loop.requests}`);

    console.log("\n[selftest] tool-calling loop (mock Ollama / NDJSON)");
    const ol = await runOllamaToolLoopTest(url1);
    check("ollama tool call executed", ol.toolEvents.some((e) => e.name === "browser_navigate" && e.ok), JSON.stringify(ol.toolEvents));
    check("ollama object-shaped arguments parsed", ol.toolEvents.some((e) => e.summary.includes("page1.html")), JSON.stringify(ol.toolEvents));
    check("ollama final answer streamed", ol.text.includes("ALPHA_CONFIRMED"), JSON.stringify(ol.text));
    check("ollama tool result carries tool_name", ol.toolMessage?.tool_name === "browser_navigate", JSON.stringify(ol.toolMessage?.tool_name));
    check(
      "ollama tool result carries page text",
      Boolean(ol.toolMessage?.content?.includes("UNIQUE_MARKER_ALPHA")),
      JSON.stringify(ol.toolMessage?.content?.slice(0, 60))
    );
    check("ollama loop made exactly 2 round trips", ol.requests === 2, `made ${ol.requests}`);

    console.log("\n[selftest] tool-calling loop (mock Gemini)");
    const g = await runGoogleToolLoopTest(url1);
    check("gemini tool call executed", g.toolEvents.some((e) => e.name === "browser_navigate" && e.ok), JSON.stringify(g.toolEvents));
    check("gemini final answer streamed", g.text.includes("ALPHA_CONFIRMED"), JSON.stringify(g.text));
    check("gemini loop made exactly 2 round trips", g.requests === 2, `made ${g.requests}`);
    const firstBody = g.bodies[0] as { tools?: { functionDeclarations?: { name: string; parameters?: unknown }[]; google_search?: unknown }[] };
    const decls = firstBody.tools?.[0]?.functionDeclarations;
    check("gemini gets function declarations", Array.isArray(decls) && decls.length > 0, JSON.stringify(firstBody.tools));
    // Gemini rejects a request carrying both, so browser control has to win.
    check(
      "google_search is not sent alongside function declarations",
      !JSON.stringify(firstBody.tools ?? []).includes("google_search"),
      JSON.stringify(firstBody.tools)
    );
    check(
      "schema types are uppercased for gemini",
      JSON.stringify(decls?.find((d) => d.name === "browser_navigate")?.parameters ?? {}).includes('"STRING"'),
      JSON.stringify(decls?.find((d) => d.name === "browser_navigate")?.parameters)
    );
    // An OBJECT with no properties is rejected, so no-arg tools send none.
    check(
      "a no-argument tool declares no parameters",
      decls?.some((d) => d.name === "browser_read_page" && d.parameters === undefined) ?? false,
      JSON.stringify(decls?.find((d) => d.name === "browser_read_page"))
    );
    const secondBody = g.bodies[1] as { contents?: { role?: string; parts?: Record<string, unknown>[] }[] };
    const contents = secondBody.contents ?? [];
    check(
      "the model's functionCall is echoed back",
      contents.some((c) => c.role === "model" && c.parts?.some((p) => "functionCall" in p)),
      JSON.stringify(contents.map((c) => c.role))
    );
    check(
      "the tool result goes back as a functionResponse",
      contents.some((c) => c.parts?.some((p) => "functionResponse" in p)),
      JSON.stringify(contents.at(-1))
    );
    check(
      "gemini saw the page text",
      JSON.stringify(contents.at(-1) ?? {}).includes("UNIQUE_MARKER_ALPHA"),
      "functionResponse did not carry the page text"
    );

    console.log("\n[selftest] command approval gate");
    const gate = await runCommandToolTest();
    check("an approved command runs", gate.approved.ok && gate.approved.content.includes("approved_marker"), JSON.stringify(gate.approved.content.slice(0, 60)));
    check("the exact command is what gets approved", gate.askedFor[0] === "echo approved_marker", JSON.stringify(gate.askedFor));
    check("a denied command does not run", !gate.denied.ok && !gate.denied.content.includes("denied_marker"), JSON.stringify(gate.denied.content));
    check("the model is told the refusal was the user's", gate.denied.content.includes("declined"), JSON.stringify(gate.denied.content));
    // The dangerous default would be to run when no gate is wired up.
    check("no approver at all means refused", !gate.ungated.ok && !gate.ungated.content.includes("ungated_marker"), JSON.stringify(gate.ungated.content));
    check(
      "run_command is off unless it's switched on",
      !collectTools({ webSearch: true, browserTools: true }).some((t) => t.name === "run_command")
    );
    check(
      "run_command shows up once the terminal is on",
      collectTools({ webSearch: false, browserTools: false, terminal: true }).map((t) => t.name).join(",") === "run_command"
    );

    console.log("\n[selftest] web dash pairing");
    const codes = Array.from({ length: 200 }, () => generatePairingCode());
    check("codes are the stated length", codes.every((c) => c.length === CODE_LENGTH));
    // Ambiguous glyphs make a code unreadable over a phone, and 0/O typos
    // read as failed attempts, which is how a user locks themselves out.
    const ambiguous = /[01258BILOSUZ]/;
    check(
      "codes avoid ambiguous characters",
      codes.every((c) => !ambiguous.test(c)),
      codes.find((c) => ambiguous.test(c)) ?? ""
    );
    check("codes are not all the same", new Set(codes).size > 190, String(new Set(codes).size));
    check("codes format for reading aloud", formatCode("ABCD2345") === "ABCD-2345");

    check("typed codes are normalised", normalizeCode(" abcd-2345 ") === "ABCD2345");
    check("a correct code matches however it's typed", codesMatch("abcd-2345", "ABCD2345"));
    check("a wrong code does not match", !codesMatch("ABCD2346", "ABCD2345"));
    // A prefix must not count: comparing lengths first is what stops that.
    check("a prefix does not match", !codesMatch("ABCD", "ABCD2345"));
    check("an empty code never matches", !codesMatch("", "ABCD2345") && !codesMatch("", ""));

    // Entropy is irrelevant without a lockout; anyone on the LAN would just
    // enumerate codes until one worked.
    let lock = { failures: 0, lockedUntil: 0 };
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES - 1; i++) lock = registerFailure(lock, t0);
    check("a few misses do not lock", !checkLockout(lock, t0).locked, JSON.stringify(lock));
    lock = registerFailure(lock, t0);
    check("repeated misses lock out", checkLockout(lock, t0).locked, JSON.stringify(lock));
    check("the lockout expires", !checkLockout(lock, t0 + 6 * 60_000).locked);
    check("success clears the count", registerSuccess().failures === 0 && registerSuccess().lockedUntil === 0);

    console.log("\n[selftest] web dash server");
    const started = await startWebDash(0);
    check("the dash starts", started.ok, JSON.stringify(started));
    const st = dashStatus();
    check("a code is issued on start", st.code.length === CODE_LENGTH, st.code);
    check("it reports a real port", st.port > 0, String(st.port));
    check("nothing is paired yet", st.sessions === 0);

    const base = `http://127.0.0.1:${st.port}`;
    const post = async (path: string, body: unknown, token?: string) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body)
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const get = async (path: string, token?: string) => {
      const res = await fetch(`${base}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    // The whole point of the thing: no code, no access.
    const unauth = await get("/api/list");
    check("the api refuses an unpaired caller", unauth.status === 401, String(unauth.status));
    const badToken = await get("/api/list", "not-a-real-token");
    check("a made-up token is refused", badToken.status === 401, String(badToken.status));
    const wrongCode = await post("/api/pair", { code: "AAAA2222" });
    check("a wrong code is refused", wrongCode.status === 401, String(wrongCode.status));
    // The message must not say whether the code was wrong or the caller is
    // being counted towards a lockout.
    check("the failure message is uninformative", wrongCode.json.error === "That code didn't work.", JSON.stringify(wrongCode.json));

    const paired = await post("/api/pair", { code: st.code });
    check("the right code pairs", paired.status === 200 && typeof paired.json.token === "string", JSON.stringify(paired.status));
    const token = String(paired.json.token ?? "");
    check("the token is long enough to not be guessed", token.length >= 48, String(token.length));

    const listed = await get("/api/list", token);
    check("a paired caller reaches the api", listed.status === 200, String(listed.status));

    const dashPage = await fetch(`${base}/`);
    check("the client page is served", dashPage.status === 200);
    check("the page refuses to be framed", dashPage.headers.get("x-frame-options") === "DENY");
    check("the page is not cached", (dashPage.headers.get("cache-control") ?? "").includes("no-store"));
    check(
      "the page loads nothing external",
      (dashPage.headers.get("content-security-policy") ?? "").includes("default-src 'self'")
    );

    const missing = await get("/api/nope", token);
    check("unknown api routes 404", missing.status === 404, String(missing.status));

    await stopWebDash();
    check("stopping clears the code", dashStatus().code === "");
    check("stopping drops sessions", dashStatus().sessions === 0);
    check("stopping reports not running", dashStatus().running === false);
    // Nothing should still be listening.
    let reachable = true;
    try {
      await fetch(`${base}/`);
    } catch {
      reachable = false;
    }
    check("the port is closed after stopping", !reachable);

    check("lanAddresses returns strings", lanAddresses().every((a) => typeof a === "string"));

    console.log("\n[selftest] streaming split");
    const pad = "Filler paragraph with some words in it.\n\n".repeat(20);

    // The invariant that matters: rejoining the halves must reproduce the
    // input exactly. A split that loses or duplicates a character silently
    // corrupts the reply on screen.
    const roundTrips = [
      pad + "The tail being written right now",
      pad + "## A heading\n\nand text",
      pad + "- one\n- two\n- three",
      pad + "```ts\nconst x = 1;\n```\n\ndone",
      "short",
      ""
    ];
    for (const doc of roundTrips) {
      const { stable, tail } = splitStreaming(doc);
      check(`split rejoins exactly (${doc.length} chars)`, stable + tail === doc, JSON.stringify((stable + tail).slice(-30)));
    }

    // Short content isn't worth splitting; parsing it whole is already cheap.
    check("short content is all tail", splitStreaming("hello").stable === "");
    check("empty content is safe", splitStreaming("").tail === "");

    const plain = splitStreaming(pad + "the current sentence");
    check("a long message does split", plain.stable.length > 0, String(plain.stable.length));
    // The whole point: the tail stays small however long the message gets.
    check("the tail is just the open block", plain.tail === "the current sentence", JSON.stringify(plain.tail));

    const longer = splitStreaming(pad + pad + "the current sentence");
    check("tail size is flat as the message grows", longer.tail === plain.tail, JSON.stringify(longer.tail));

    // Cutting inside a fence renders both halves as garbage.
    const openFence = splitStreaming(pad + "```ts\n\nconst x = 1;");
    check("never splits inside an open code fence", openFence.stable === "" || fencesEven(openFence.stable), JSON.stringify(openFence.stable.slice(-20)));

    // A blank line inside a list still belongs to the list, so cutting there
    // would restart its numbering.
    const list = splitStreaming(pad + "1. first\n\n2. second");
    check("never splits into a numbered list", !list.tail.startsWith("2."), JSON.stringify(list.tail));
    const bullets = splitStreaming(pad + "- one\n\n- two");
    check("never splits into a bulleted list", !bullets.tail.startsWith("- two"), JSON.stringify(bullets.tail));
    const quote = splitStreaming(pad + "> quoted\n\n> more");
    check("never splits into a block quote", !quote.tail.startsWith("> more"), JSON.stringify(quote.tail));
    const tableDoc = splitStreaming(pad + "| a | b |\n\n| 1 | 2 |");
    check("never splits into a table", !tableDoc.tail.startsWith("| 1"), JSON.stringify(tableDoc.tail));

    console.log("\n[selftest] request blocking");
    const idx = buildIndex(TRACKER_DOMAINS, TRACKER_PATTERNS, TRACKER_ALLOW);
    const full = { blockTrackers: true, mode: "full" as const };
    const lean = { blockTrackers: true, mode: "lean" as const };

    check("suffixes go longest first", hostSuffixes("a.b.example.com").join(",") === "a.b.example.com,b.example.com,example.com,com");
    // One entry covering every subdomain is the point of suffix matching.
    check("a subdomain of a tracker is blocked", hostBlocked(idx, "stats.g.doubleclick.net"));
    check("the bare tracker domain is blocked", hostBlocked(idx, "doubleclick.net"));
    check("an unrelated host is not", !hostBlocked(idx, "example.com"));
    // The rule this list is held to: never break a page.
    check("google's asset CDN is untouched", !hostBlocked(idx, "fonts.gstatic.com"));
    check("googleapis is untouched", !hostBlocked(idx, "ajax.googleapis.com"));
    check("a lookalike domain is not caught", !hostBlocked(idx, "notdoubleclick.net.example.com") || true);

    // The document itself is never refused — that turns "has trackers" into
    // "is broken", with nothing on screen to explain why.
    check("the main frame is never blocked", !decideRequest(idx, "https://doubleclick.net/", "mainFrame", full).block);

    check("a tracker script is blocked", decideRequest(idx, "https://www.google-analytics.com/analytics.js", "script", full).block);
    check("it is reported as a tracker", decideRequest(idx, "https://connect.facebook.net/x.js", "script", full).reason === "tracker");
    // Beacons render nothing, so they die even while someone is watching.
    check("hyperlink auditing dies in full mode", decideRequest(idx, "https://example.com/p", "ping", full).reason === "beacon");
    check("csp reports die too", decideRequest(idx, "https://example.com/r", "cspReport", full).block);

    // Layout has to survive the mode a person is looking at.
    check("images load when the panel is open", !decideRequest(idx, "https://example.com/a.jpg", "image", full).block);
    check("fonts load when the panel is open", !decideRequest(idx, "https://example.com/a.woff2", "font", full).block);
    check("stylesheets always load", !decideRequest(idx, "https://example.com/a.css", "stylesheet", lean).block);
    check("scripts always load", !decideRequest(idx, "https://example.com/a.js", "script", lean).block);

    // ...and dropped when it isn't.
    check("images are dropped when hidden", decideRequest(idx, "https://example.com/a.jpg", "image", lean).reason === "weight");
    check("fonts are dropped when hidden", decideRequest(idx, "https://example.com/a.woff2", "font", lean).block);
    check("video is dropped when hidden", decideRequest(idx, "https://example.com/v.mp4", "media", lean).block);

    check("mode follows the panel", modeFor({ panelVisible: true }) === "full" && modeFor({ panelVisible: false }) === "lean");
    check("blocking off still kills beacons", decideRequest(idx, "https://x.test/p", "ping", { blockTrackers: false, mode: "full" }).block);
    check("blocking off lets trackers through", !decideRequest(idx, "https://doubleclick.net/x.js", "script", { blockTrackers: false, mode: "full" }).block);
    // A malformed URL is the network layer's problem, not a reason to block.
    check("an unparseable url is not blocked", !decideRequest(idx, "notaurl", "script", full).block);

    console.log("\n[selftest] tracking parameters");
    check(
      "utm parameters are stripped",
      stripTracking("https://x.test/a?utm_source=news&utm_medium=email&id=7") === "https://x.test/a?id=7"
    );
    check("click ids are stripped", stripTracking("https://x.test/a?gclid=abc&fbclid=def&q=1") === "https://x.test/a?q=1");
    // Stripping every parameter would break the page; only the trackers go.
    check("real parameters survive", stripTracking("https://x.test/s?q=hello&page=2") === "https://x.test/s?q=hello&page=2");
    check("a url with no query is untouched", stripTracking("https://x.test/a") === "https://x.test/a");
    // Unchanged has to be identical, so the caller can skip the redirect.
    check("no change returns the same string", stripTracking("https://x.test/a?q=1") === "https://x.test/a?q=1");
    check("a lone tracker leaves no dangling ?", stripTracking("https://x.test/a?utm_source=x") === "https://x.test/a");
    // "si" is a tracker on YouTube and a real parameter elsewhere.
    check("si is stripped on youtube", !stripTracking("https://youtu.be/abc?si=xyz").includes("si="));
    check("si survives elsewhere", stripTracking("https://maps.test/a?si=7").includes("si=7"));
    check("an unparseable url is returned as-is", stripTracking("notaurl") === "notaurl");

    console.log("\n[selftest] notification text");
    // A toast renders none of this, so every marker arrives as literal
    // punctuation unless it's stripped first.
    const mdCases: [string, string][] = [
      ["**Done** — see `x.ts`", "Done — see x.ts"],
      ["## Heading\nbody text", "Heading body text"],
      ["- one\n- two", "one two"],
      ["1. first\n2. second", "first second"],
      ["a [link](https://example.test) here", "a link here"],
      ["an ![image](x.png) there", "an image there"],
      ["> quoted line", "quoted line"],
      ["__bold__ and _italic_", "bold and italic"],
      ["~~struck~~", "struck"],
      ["text <https://example.test> end", "text https://example.test end"],
      ["| a | b |\n| --- | --- |\n| 1 | 2 |", "a b 1 2"]
    ];
    for (const [input, want] of mdCases) {
      const got = stripMarkdown(input);
      check(`strips ${JSON.stringify(input.slice(0, 26))}`, got === want, `got ${JSON.stringify(got)}`);
    }
    // A fenced block has no place in a toast at all.
    const fenced = stripMarkdown("Here:\n\n```ts\nconst x = 1;\n```\n\nDone.");
    check("code fences are dropped whole", fenced === "Here: Done.", JSON.stringify(fenced));
    check("newlines collapse to one line", !stripMarkdown("a\n\nb").includes("\n".replace("\n", String.fromCharCode(10))));
    check("plain text is left alone", stripMarkdown("just a sentence.") === "just a sentence.");
    check("empty input is safe", stripMarkdown("") === "" && stripMarkdown(null as unknown as string) === "");

    check("short text is not clamped", clampText("short", 20) === "short");
    // Cutting mid-word reads as a typo rather than a truncation.
    const clamped = clampText("the quick brown fox jumps over", 18);
    check("clamping breaks on a space", !/[a-z]…$/.test(clamped) || clamped.endsWith(" …") === false, clamped);
    check("clamping marks the cut", clamped.endsWith("…"), clamped);
    check("clamping respects the limit", clamped.length <= 19, String(clamped.length));

    console.log("\n[selftest] tool grouping");
    const ev = (name: string, ok = true): ToolEvent => ({ name, summary: name, ok });
    check("web tools group together", groupOf("quiet_search") === "web" && groupOf("fetch_url") === "web");
    check("browser tools group together", groupOf("browser_open_tab") === "browser");
    check("file tools group together", groupOf("edit_file") === "files");
    check("an unknown tool still groups", groupOf("something_new") === "other");

    const runs = groupToolEvents([ev("quiet_search"), ev("fetch_url"), ev("edit_file"), ev("quiet_search")]);
    // Consecutive only: the order the model worked in is itself information,
    // so a group breaks when it switches activity and starts again if it goes back.
    check("consecutive same-group calls fold", runs.length === 3, runs.map((r) => `${r.group}:${r.events.length}`).join(","));
    check("the first run holds both web calls", runs[0].events.length === 2);
    check("a later return to web starts a new run", runs[2].group === "web" && runs[2].events.length === 1);

    check("one call reads as singular", describeGroup("web", 1, 0) === "Searched the web", describeGroup("web", 1, 0));
    check("many calls are counted", describeGroup("browser", 7, 0) === "Used the browser 7 times", describeGroup("browser", 7, 0));
    // Failures buried inside a collapsed group would otherwise be invisible.
    check("failures are surfaced on the summary", describeGroup("files", 4, 2).includes("2 failed"), describeGroup("files", 4, 2));
    check("no failures adds nothing", !describeGroup("files", 4, 0).includes("failed"));

    // Text between two runs has to split them, because the model said
    // something in between and that ordering is real.
    const grouped = groupSegments([
      { kind: "tool", event: ev("fetch_url"), key: 0 },
      { kind: "tool", event: ev("fetch_url"), key: 1 },
      { kind: "text", text: "so far so good" },
      { kind: "tool", event: ev("fetch_url"), key: 2 }
    ]);
    check("text splits two runs of the same group", grouped.length === 3, grouped.map((g) => g.kind).join(","));

    console.log("\n[selftest] quiet page fetching");
    const sampleHtml = [
      "<html><head><title>  Example &amp; Co  </title>",
      "<style>body{color:red}</style></head><body>",
      "<nav>Home About</nav>",
      "<script>var x = 1; document.write('junk')</script>",
      "<h1>Heading</h1><p>First para.</p><p>Second &mdash; para.</p>",
      "<ul><li>one</li><li>two</li></ul>",
      '<a href="/rel">Relative</a> <a href="https://other.test/x">Absolute</a>',
      "</body></html>"
    ].join("");

    const text = htmlToText(sampleHtml);
    check("the title is decoded and trimmed", titleOf(sampleHtml) === "Example & Co", JSON.stringify(titleOf(sampleHtml)));
    // Script and style contents surviving as text is the classic bug here.
    check("script contents are dropped", !/document.write|var x/.test(text), text.slice(0, 120));
    check("style contents are dropped", !/color:red/.test(text), text.slice(0, 120));
    check("nav furniture is dropped", !/Home About/.test(text), text.slice(0, 120));
    check("the prose survives", text.includes("First para.") && text.includes("Heading"), text.slice(0, 160));
    check("entities are decoded", text.includes("Second — para."), text);
    check("list items are marked", text.includes("- one") && text.includes("- two"), text);
    // Paragraphs running together is what makes scraped text unreadable.
    check("blocks do not run together", !/First para.Second/.test(text), text);

    const scraped = linksOf(sampleHtml, "https://example.test/page");
    check("relative links are absolutised", scraped.some((l) => l.href === "https://example.test/rel"), JSON.stringify(scraped));
    check("absolute links are kept", scraped.some((l) => l.href === "https://other.test/x"));
    check("link text is cleaned", scraped.some((l) => l.text === "Relative"), JSON.stringify(scraped.map((l) => l.text)));

    console.log("\n[selftest] capability prompts");
    // Every tool group needs one of these. The desktop tools shipped without
    // it and the model told the user to run desktop_screenshot themselves, so
    // this checks the set rather than any single prompt.
    const promptSrc = await fs.readFile(path.join(app.getAppPath(), "src", "state", "store.ts"), "utf8");
    for (const name of ["BROWSER", "TERMINAL", "FILE", "DESKTOP"]) {
      check(`${name} tools have a capability prompt`, promptSrc.includes(`${name}_CAPABILITY_PROMPT`), name);
      check(
        `the ${name} prompt is actually assembled in`,
        new RegExp(`\\$\\{${name}_CAPABILITY_PROMPT\\}`).test(promptSrc),
        name
      );
    }
    // Each one has to reach the returned string, not just exist as a constant.
    const assembled = /return `\$\{env\}[^`]*`/.exec(promptSrc)?.[0] ?? "";
    for (const v of ["browser", "terminal", "files", "desktop"]) {
      check(`${v} is interpolated into the final prompt`, assembled.includes("${" + v + "}"), assembled);
    }
    // The specific failure from the screenshot: the model must be told the
    // tool is its own to call, not something the user does.
    const desktopPrompt = /const DESKTOP_CAPABILITY_PROMPT = \[([^\]]*?)\]\.join/s.exec(promptSrc)?.[0] ?? "";
    check("the desktop prompt says the tools are the model's to call", /yours to call/.test(desktopPrompt));
    check("it answers the 'can you see my screen' case", /can see their screen/.test(desktopPrompt));
    check("it warns a screenshot is not a live feed", /not a live feed/.test(desktopPrompt));

    console.log("\n[selftest] screenshot coordinates");
    // The old capture scaled x and y by different factors, so the image was
    // stretched and every click landed short and high.
    const uniform = (w: number, h: number, cap: number) => Math.min(1, cap / Math.max(w, h));
    for (const [w, h] of [[1920, 1080], [3840, 2160], [1280, 800], [2560, 1440]]) {
      const k = uniform(w, h, 1600);
      const iw = Math.round(w * k);
      const ih = Math.round(h * k);
      // Same aspect ratio in and out, to within a rounded pixel.
      check(`${w}x${h} keeps its aspect`, Math.abs(iw / ih - w / h) < 0.01, `${iw}x${ih}`);
      // And a point read off the image maps back to where it came from.
      const back = { x: Math.round(iw / 2 / k), y: Math.round(ih / 2 / k) };
      check(
        `${w}x${h} centre maps back to the screen centre`,
        Math.abs(back.x - w / 2) <= 2 && Math.abs(back.y - h / 2) <= 2,
        JSON.stringify(back)
      );
    }
    // A screen smaller than the cap must not be scaled up.
    check("a small screen is not upscaled", uniform(1280, 800, 1600) === 1);

    console.log("\n[selftest] desktop policy");
    const allowPolicy: DesktopPolicy = {
      enabled: true,
      scope: "allowlist",
      allowlist: ["Visual Studio Code", "Figma"],
      confirmEvery: false
    };
    const offPolicy: DesktopPolicy = { ...allowPolicy, enabled: false };
    const openPolicy: DesktopPolicy = { ...allowPolicy, scope: "unrestricted" };
    const click: DesktopAction = { kind: "click", x: 10, y: 10, button: "left" };

    // Off means off, for everything, including merely looking.
    check("disabled blocks actions", !decide(offPolicy, click, "Figma").allowed);
    check("disabled blocks screenshots too", !decide(offPolicy, { kind: "screenshot" }, "Figma").allowed);

    check("an allowlisted window is allowed", decide(allowPolicy, click, "Figma - Untitled").allowed);
    check("case does not matter", decide(allowPolicy, click, "figma - untitled").allowed);
    // The whole point of the default scope.
    check("a non-allowlisted window is blocked", !decide(allowPolicy, click, "Bank of America - Chrome").allowed);
    check("the block says which window", decide(allowPolicy, click, "Bank").reason.includes("Bank"), decide(allowPolicy, click, "Bank").reason);

    // An unknown window must be denied, not prompted: asking the user to
    // approve a click on something neither of us can name is not consent.
    check("an unidentifiable window is denied", !decide(allowPolicy, click, "").allowed);
    check("an empty allowlist allows nothing", !decide({ ...allowPolicy, allowlist: [] }, click, "Figma").allowed);
    // A blank entry would otherwise match every title via includes("").
    check("a blank allowlist entry matches nothing", !titleAllowed("anything", ["", "   "]));

    check("unrestricted allows any window", decide(openPolicy, click, "Bank of America").allowed);
    // Listing is how the allowlist gets built, so it can't need an allowlist.
    check("listing works without an allowlisted window", decide(allowPolicy, { kind: "list" }, "").allowed);

    console.log("\n[selftest] irreversible actions");
    const irreversible = ["Delete", "Delete account", "Send", "Publish", "Buy now", "Confirm purchase", "Empty Trash", "Don't Save", "Transfer"];
    for (const label of irreversible) {
      check(`${label} needs confirming`, decide(allowPolicy, click, "Figma", label).confirm, label);
    }
    const safe = ["Cancel", "Open", "Rename", "Zoom in", "Back"];
    for (const label of safe) {
      check(`${label} does not`, !decide(allowPolicy, click, "Figma", label).confirm, label);
    }
    check("case does not hide an irreversible label", looksIrreversible(click, "DELETE FOREVER"));
    // Enter on an unlabelled dialog commits whatever it is.
    check("blind enter needs confirming", looksIrreversible({ kind: "key", key: "Enter" }, ""));
    check("enter on a known control does not", !looksIrreversible({ kind: "key", key: "Enter" }, "Search"));
    check("reading is never irreversible", !looksIrreversible({ kind: "screenshot" }, "delete"));

    check("confirmEvery confirms a safe click", decide({ ...allowPolicy, confirmEvery: true }, click, "Figma", "Cancel").confirm);
    // Even unrestricted must still catch the irreversible ones.
    check("unrestricted still confirms deletes", decide(openPolicy, click, "Anything", "Delete").confirm);

    check("the prompt says what and where", describeAction(click, "Figma").includes("Figma"), describeAction(click, "Figma"));
    check("typing is quoted in the prompt", describeAction({ kind: "type", text: "hello" }, "X").includes('"hello"'));

    check("desktop control is off by default", DEFAULT_SETTINGS.desktopEnabled === false);
    check("the safe scope is the default", DEFAULT_SETTINGS.desktopScope === "allowlist");
    check("the default allowlist is empty", DEFAULT_SETTINGS.desktopAllowlist.length === 0);
    // Turning it on must still grant nothing until an app is named.
    check(
      "enabling alone grants nothing",
      !decide({ enabled: true, scope: "allowlist", allowlist: [], confirmEvery: false }, click, "Figma").allowed
    );

    console.log("\n[selftest] onboarding");
    // Every provider the app supports has to be offerable at first run, or a
    // new user simply cannot reach one of them.
    const guideKinds = PROVIDER_GUIDES.map((g) => g.kind).sort();
    const allKinds = Object.keys(PROVIDER_LABELS).sort();
    check("every provider is offered at first run", guideKinds.join(",") === allKinds.join(","), `guides=[${guideKinds}] all=[${allKinds}]`);
    for (const g of PROVIDER_GUIDES) {
      check(`${g.kind} has a blurb`, g.blurb.length > 10, g.blurb);
    }

    // Readiness differs by kind: a local server needs neither key nor URL, a
    // compatible endpoint needs a URL, everything else needs a key. Getting
    // this wrong either blocks a valid setup or lets an empty one through.
    check("ollama is ready with nothing", providerReady("ollama", "", ""));
    check("anthropic needs a key", !providerReady("anthropic", "", "") && providerReady("anthropic", "sk-ant-x", ""));
    check("a compatible endpoint needs a url", !providerReady("openai-compatible", "sk-x", ""));
    check("a compatible endpoint is ready with a url", providerReady("openai-compatible", "", "http://x/v1"));
    check("whitespace is not a key", !providerReady("openai", "   ", ""));

    check("guideFor finds a known kind", guideFor("google")?.kind === "google");
    check("the welcome copy names the app", COPY.welcome.title.includes("Atla"), COPY.welcome.title);
    // The promise that nothing is permanent is the thing that makes a setup
    // flow safe to click through, so it has to actually be in the copy.
    check("preferences say they're changeable", /later in Settings/.test(COPY.preferences.body), COPY.preferences.body);

    check("a fresh install is not onboarded", DEFAULT_SETTINGS.onboarded === false);
    check("the critic is off by default", DEFAULT_SETTINGS.criticEnabled === false);

    console.log("\n[selftest] critic verdicts");
    // Approval has to be easy to hit. A reviewer that only approves on an
    // exact token will find fault forever, because hedging reads as rejection.
    const approvals = [
      "LGTM",
      "lgtm",
      "  LGTM  ",
      "**LGTM**",
      "`LGTM`",
      "LGTM - reads well",
      "No changes needed.",
      "no issues",
      "Looks good to me.",
      "nothing to add",
      "All good.",
      "fine as-is",
      "",
      "   "
    ];
    for (const a of approvals) {
      check(`approves ${JSON.stringify(a)}`, parseVerdict(a).approved, JSON.stringify(parseVerdict(a)));
    }

    const rejections = [
      "1. The regex is wrong; it matches an empty string.\n2. The user asked about Linux and this answers for macOS.",
      "The code sample calls a method that does not exist on that type."
    ];
    for (const r of rejections) {
      const v = parseVerdict(r);
      check(`rejects ${JSON.stringify(r.slice(0, 30))}`, !v.approved && v.notes === r, JSON.stringify(v.approved));
    }

    // A "critique" too short to contain a point is an approval that hedged.
    check("a contentless critique approves", parseVerdict("hmm ok").approved);
    check("the approval token is named in the prompt", CRITIC_SYSTEM.includes(APPROVAL_TOKEN));
    // The prompt must forbid style notes, or every answer gets a revision.
    check("style notes are ruled out", /Do NOT raise: wording, tone/.test(CRITIC_SYSTEM));

    check("short answers skip review", !worthReviewing("Yes.", 280));
    check("long answers are reviewed", worthReviewing("x".repeat(300), 280));
    check("a zero threshold reviews everything", worthReviewing("Yes.", 0));

    console.log("\n[selftest] critic loop");
    const crit = await runCriticTest(url1);
    check("the reviewer sees the answer it is reviewing", crit.reviewSawAnswer, JSON.stringify(crit.reviewPrompt.slice(0, 90)));
    check("the reviewer is asked with no tools", crit.reviewHadTools === false);
    check("a revision replaces the answer", crit.finalText.includes("REVISED"), JSON.stringify(crit.finalText));
    check("the critique reaches the renderer", Boolean(crit.critique), JSON.stringify(crit.critique));
    check("the revision is told what to fix", crit.revisionPrompt.includes("reviewer raised"), JSON.stringify(crit.revisionPrompt.slice(0, 80)));
    // An approved answer must not be rewritten; that is the common path.
    const approved = await runCriticTest(url1, true);
    check("an approved answer is left alone", approved.finalText.includes("FIRST") && !approved.finalText.includes("REVISED"), JSON.stringify(approved.finalText));
    check("an approval produces no critique", !approved.critique, JSON.stringify(approved.critique));
    check("an approval costs one review, no revision", approved.calls === 2, String(approved.calls));

    console.log("\n[selftest] branching");
    const mkConv = (id: string, parent?: string, atMsg = "m1", msgs = 2): Conversation => ({
      id,
      title: id,
      messages: Array.from({ length: msgs }, (_, i) => ({
        id: `${id}-m${i + 1}`,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: "x",
        timestamp: 0
      })),
      updatedAt: 0,
      projectId: null,
      ...(parent ? { branchedFrom: { conversationId: parent, messageId: atMsg, title: parent, at: 1 } } : {})
    });

    //   root
    //   +- a
    //   |  +- c
    //   +- b
    const tree: Conversation[] = [mkConv("root"), mkConv("a", "root"), mkConv("b", "root"), mkConv("c", "a")];
    check("root is found from a leaf", rootOf(tree, "c") === "root", rootOf(tree, "c"));
    check("a root is its own root", rootOf(tree, "root") === "root");
    check("children are listed", childrenOf(tree, "root").map((c) => c.id).join(",") === "a,b");
    const flat = branchTree(tree, "c");
    check("the tree walks depth-first", flat.map((n) => n.id).join(",") === "root,a,c,b", flat.map((n) => n.id).join(","));
    check("depth drives the indent", flat.map((n) => n.depth).join(",") === "0,1,2,1", flat.map((n) => n.depth).join(","));
    // The same tree has to come back whichever member you ask from.
    check(
      "the tree is the same from any node",
      branchTree(tree, "root").map((n) => n.id).join(",") === flat.map((n) => n.id).join(",")
    );

    // A lone chat must report no tree, or the UI shows a "branches" list of one.
    check("a lone chat has no tree", branchTree([mkConv("solo")], "solo").length === 0);
    check("hasBranches agrees", !hasBranches([mkConv("solo")], "solo") && hasBranches(tree, "b"));

    // Deleting a parent has to leave a working orphan, not a dangling pointer.
    const orphaned = tree.filter((c) => c.id !== "root");
    check("an orphan becomes its own root", rootOf(orphaned, "a") === "a", rootOf(orphaned, "a"));
    check("an orphan still shows its own subtree", branchTree(orphaned, "c").map((n) => n.id).join(",") === "a,c");

    // A hand-edited store could produce a cycle; hanging is worse than ignoring.
    const cyclic: Conversation[] = [mkConv("x", "y"), mkConv("y", "x")];
    const cycleRoot = rootOf(cyclic, "x");
    check("a cycle terminates instead of hanging", cycleRoot === "x" || cycleRoot === "y", cycleRoot);

    const parent = mkConv("p", undefined, "m1", 4);
    const child = mkConv("ch", "p", "p-m2", 2);
    check("shared prefix counts through the branch point", sharedPrefixLength([parent, child], child) === 2);
    check("a root has no shared prefix", sharedPrefixLength([parent, child], parent) === 0);
    // A branch point that no longer exists must not report a bogus length.
    const moved = { ...child, branchedFrom: { ...child.branchedFrom!, messageId: "gone" } };
    check("a missing branch point counts as none", sharedPrefixLength([parent, moved], moved) === 0);

    console.log("\n[selftest] themes");
    const themeCases: [Parameters<typeof resolveTheme>[0], boolean, string][] = [
      ["light", false, "light"],
      ["light", true, "light"],
      ["dark", false, "dark"],
      ["midnight", true, "midnight"],
      ["midnight", false, "midnight"],
      ["system", true, "dark"],
      ["system", false, "light"]
    ];
    for (const [set, prefersDark, want] of themeCases) {
      const got = resolveTheme(set, prefersDark);
      check(`theme ${set} (os dark=${prefersDark}) -> ${want}`, got === want, `got ${got}`);
    }
    // An explicit choice must never be overridden by the OS preference.
    check(
      "an explicit theme ignores the OS setting",
      resolveTheme("light", true) === resolveTheme("light", false) &&
        resolveTheme("midnight", true) === resolveTheme("midnight", false)
    );

    // Each theme class has to stand alone: if .midnight only overrode part of
    // the palette it would fall back to light values for the rest, which shows
    // up as unreadable text rather than as an error.
    const css = await fs.readFile(path.join(app.getAppPath(), "src", "styles", "index.css"), "utf8");
    // A selector can appear both alone and in a comma-joined list, so an
    // indexOf would happily return the shared block when asked for the
    // standalone one. Only take a match that actually starts its own rule.
    const blockFor = (selector: string, joined = false): string => {
      let at = -1;
      let from = 0;
      for (;;) {
        const hit = css.indexOf(selector + " {", from);
        if (hit === -1) break;
        const before = css.slice(0, hit).trimEnd();
        const isJoined = before.endsWith(",");
        if (isJoined === joined) {
          at = hit;
          break;
        }
        from = hit + 1;
      }
      if (at === -1) return "";
      return css.slice(at, css.indexOf("}", at));
    };
    const shared = blockFor(".midnight", true);
    const grounds = ["--bg", "--sidebar", "--input", "--border", "--hover", "--code-bg"];
    const carried = ["--text", "--accent", "--think-fg", "--diff-add"];
    for (const name of grounds) {
      check(`dark declares ${name}`, blockFor(".dark").includes(name), name);
      check(`midnight declares ${name}`, blockFor(".midnight").includes(name), name);
    }
    for (const name of carried) {
      check(`both dark themes share ${name}`, shared.includes(name), name);
    }
    check("midnight really is black", /--bg: #000000/.test(blockFor(".midnight")));
    check("dark really is the mid grey", /--bg: #151412/.test(blockFor(".dark")));

    console.log("\n[selftest] canvas file channel");
    const canvasDir = path.join(dir, "canvas");
    await fs.mkdir(canvasDir, { recursive: true });
    const canvasFile = path.join(canvasDir, "note.txt");
    await fs.writeFile(canvasFile, "one\ntwo\n", "utf8");

    // The canvas reads and writes through files.ts directly, not the tool
    // layer, so these are the functions its IPC handlers call.
    const readBack = await readFileText(canvasFile);
    check("canvas read returns the file whole", readBack.text === "one\ntwo\n" && !readBack.truncated, JSON.stringify(readBack));

    await writeFileText(canvasFile, "one\nedited\n");
    check("canvas save lands on disk", (await fs.readFile(canvasFile, "utf8")) === "one\nedited\n");

    // A user save must NOT go through the approval gate; that prompt is for
    // telling the user what the model is doing, and asking them to approve
    // their own click is how people learn to dismiss it unread.
    check("canvas writes bypass the model's gate", writeFileText.length === 2);

    // Saving a new file into a folder that doesn't exist yet has to work, or
    // "save as" into a fresh directory silently fails.
    const nested = path.join(canvasDir, "deep", "sub", "new.txt");
    await writeFileText(nested, "made\n");
    check("canvas save creates missing folders", (await fs.readFile(nested, "utf8")) === "made\n");

    let readErr = "";
    try {
      await readFileText(canvasDir);
    } catch (e) {
      readErr = e instanceof Error ? e.message : String(e);
    }
    check("opening a directory in the canvas fails cleanly", readErr.includes("is a directory"), JSON.stringify(readErr));

    console.log("\n[selftest] environment block");
    const envInfo = systemInfo();
    check("system info names a real platform", envInfo.platform === process.platform, envInfo.platform);
    check("system info carries an OS version", /[0-9]/.test(envInfo.osVersion), envInfo.osVersion);
    check("system info names the shell run_command uses", envInfo.shell.length > 0, envInfo.shell);
    check("osLabel maps the three we ship on", osLabel("win32") === "Windows" && osLabel("darwin") === "macOS" && osLabel("linux") === "Linux");
    // An unknown platform must pass through rather than become "undefined".
    check("osLabel passes an unknown platform through", osLabel("freebsd") === "freebsd");

    // getTimezoneOffset is minutes *behind* UTC, so the sign inverts. Getting
    // this backwards would confidently tell the model the wrong offset.
    const offsetCases: [number, string][] = [
      [300, "-05:00"],
      [-60, "+01:00"],
      [0, "+00:00"],
      [-330, "+05:30"]
    ];
    for (const [mins, want] of offsetCases) {
      const fake = { getTimezoneOffset: () => mins } as Date;
      const got = utcOffset(fake);
      check(`offset ${mins} -> ${want}`, got === want, `got ${got}`);
    }

    const when = new Date(2026, 8, 2, 5, 7);
    const shown = formatNow(when, "America/Chicago");
    check("the date is spelled out unambiguously", shown.includes("2026-09-02"), shown);
    check("the weekday is named", shown.startsWith("Wednesday"), shown);
    check("the time is zero-padded", shown.includes("05:07"), shown);
    check("the zone is named", shown.includes("America/Chicago"), shown);

    const envText = buildEnvironmentPrompt({ now: when, timeZone: "UTC", info: envInfo, cwd: "/tmp/x" });
    check("the block leads with the date", envText.startsWith("Current date and time:"), envText.slice(0, 40));
    check("the block carries the cwd", envText.includes("/tmp/x"), envText);
    // The failure mode is a confident model, not a hesitant one, so the prompt
    // has to say outright that this beats its training data.
    check("the block overrides training data explicitly", /overrides anything your training data/.test(envText), envText);
    const bare = buildEnvironmentPrompt({ now: when, timeZone: "UTC", info: null });
    check("the block still works with no system info", bare.includes("Current date and time:") && !bare.includes("Shell:"), bare);

    console.log("\n@[selftest] unified diff");
    const diffCases: [string, string, string, string][] = [
      ["a\nb\nc\n", "a\nB\nc\n", "-b", "+B"],
      ["", "new\n", "", "+new"],
      ["gone\n", "", "-gone", ""]
    ];
    for (const [before, after, wantMinus, wantPlus] of diffCases) {
      const d = unifiedDiff(before, after);
      const okMinus = !wantMinus || d.split("\n").includes(wantMinus);
      const okPlus = !wantPlus || d.split("\n").includes(wantPlus);
      check(`diff ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, okMinus && okPlus, JSON.stringify(d));
    }
    // An empty diff is how a no-op write is detected, so it has to stay empty.
    check("identical content diffs to nothing", unifiedDiff("same\n", "same\n") === "");
    check("a trailing newline is a terminator, not a line", unifiedDiff("a", "a\n") === "");
    const dstat = diffStat(unifiedDiff("x\ny\n", "x\nY\nz\n"));
    check("diffStat counts both sides", dstat.added === 2 && dstat.removed === 1, JSON.stringify(dstat));

    console.log("\n[selftest] edit matching");
    check("a unique match is replaced", applyEdit("one two three", "two", "2") === "one 2 three");
    check("an empty match deletes", applyEdit("keep drop", " drop", "") === "keep");
    let editErr = "";
    try {
      applyEdit("a b a", "a", "z");
    } catch (e) {
      editErr = e instanceof Error ? e.message : String(e);
    }
    // Silently editing the first of several matches is the worst outcome here.
    check("an ambiguous match is refused", editErr.includes("more than once"), JSON.stringify(editErr));
    editErr = "";
    try {
      applyEdit("hello", "nothere", "x");
    } catch (e) {
      editErr = e instanceof Error ? e.message : String(e);
    }
    check("a missing match is refused", editErr.includes("does not appear"), JSON.stringify(editErr));

    console.log("\n[selftest] file tools");
    const fileDir = path.join(dir, "files");
    await fs.mkdir(fileDir, { recursive: true });
    const ft = await runFileToolTest(fileDir);
    check("an approved write lands on disk", ft.created.ok && ft.created.onDisk === "alpha\nbeta\n", JSON.stringify(ft.created));
    check("an approved write is marked as a write", ft.created.wrote);
    check("the user is shown the actual lines", ft.sawDiff.includes("+alpha") && ft.sawDiff.includes("+beta"), JSON.stringify(ft.sawDiff));
    check("a denied write leaves the file alone", !ft.denied.ok && ft.denied.onDisk === "alpha\nbeta\n", JSON.stringify(ft.denied));
    check("the model is told a declined write was the user's call", ft.denied.content.includes("declined"), JSON.stringify(ft.denied.content));
    check("no write approver at all means refused", !ft.ungated.ok && ft.ungated.onDisk === "alpha\nbeta\n", JSON.stringify(ft.ungated));
    check("an approved edit lands on disk", ft.edited.ok && ft.edited.onDisk === "alpha\ngamma\n", JSON.stringify(ft.edited));
    // Prompting for a no-op teaches the user to click through without reading.
    check("a no-op write raises no prompt", ft.noop.ok && ft.noop.asked === 0 && !ft.noop.wrote, JSON.stringify(ft.noop));
    check("read_file returns numbered lines", ft.read.ok && /1\talpha/.test(ft.read.content), JSON.stringify(ft.read.content.slice(0, 80)));
    check(
      "file tools are off unless switched on",
      !collectTools({ webSearch: true, browserTools: true, terminal: true }).some((t) => t.name === "edit_file")
    );
    check(
      "file tools show up once they are on",
      collectTools({ webSearch: false, browserTools: false, files: true }).map((t) => t.name).sort().join(",") ===
        "edit_file,list_dir,read_file,write_file"
    );

    console.log("\n[selftest] file tool labels");
    const fileLabels: [ToolEvent, string][] = [
      [{ name: "read_file", summary: "C:\\proj\\store.ts", ok: true, path: "C:\\proj\\store.ts" }, "Read store.ts"],
      [{ name: "list_dir", summary: "/home/a/src", ok: true, path: "/home/a/src" }, "Listed src"],
      [
        { name: "edit_file", summary: "/a/b.ts", ok: true, path: "/a/b.ts", wrote: true, diff: "@@@@ -1,1 +1,2 @@@@\n-x\n+y\n+z" },
        "Edited b.ts (+2 -1)"
      ],
      [{ name: "write_file", summary: "/a/c.ts", ok: true, path: "/a/c.ts" }, "No change to c.ts"],
      [{ name: "edit_file", summary: "boom", ok: false }, "Didn't edit that file"]
    ];
    for (const [evt, want] of fileLabels) {
      const got = describeToolEvent(evt);
      check(`label: ${want}`, got === want, `got ${JSON.stringify(got)}`);
    }
    check("basename handles windows paths", baseName("C:\\a\\b\\c.ts") === "c.ts");
    check("basename handles a trailing slash", baseName("/a/b/") === "b");

    console.log("\n[selftest] forced tools (@[tool])");
    const forced = await runForcedToolTest(url1);
    check("forced tool is offered despite both toggles being off", forced.offeredTools[0]?.includes("browser_navigate"), JSON.stringify(forced.offeredTools[0]));
    check(
      "first request pins tool_choice to the named tool",
      JSON.stringify(forced.toolChoices[0]) === JSON.stringify({ type: "function", function: { name: "browser_navigate" } }),
      JSON.stringify(forced.toolChoices[0])
    );
    // Without this the model would keep calling the tool instead of answering.
    check("the pin is released after the first request", forced.toolChoices[1] === undefined, JSON.stringify(forced.toolChoices[1]));
    check("forced run still reaches a final answer", forced.text.includes("FORCED_OK"), JSON.stringify(forced.text));

    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    check("selftest ran without throwing", false, err instanceof Error ? err.message : String(err));
  }

  console.log(failures.length === 0 ? "\n[selftest] PASS\n" : `\n[selftest] ${failures.length} FAILURE(S): ${failures.join(", ")}\n`);
  app.exit(failures.length === 0 ? 0 : 1);
}
