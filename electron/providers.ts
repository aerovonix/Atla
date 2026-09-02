import type { ChatStreamRequest, ProviderConfig, ProviderKind, ToolEvent } from "../shared/types.js";
import { NATIVE_WEB_SEARCH, PROVIDER_LABELS, SUPPORTS_TOOL_CALLS } from "../shared/types.js";
import { collectTools, executeTool, type ToolContext, type ToolDef } from "./tools.js";
import { requestApproval } from "./approvals.js";
import { getCwd } from "./terminal.js";

export interface StreamHandlers {
  onChunk: (delta: string) => void;
  onToolEvent: (evt: ToolEvent) => void;
}

interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as streamed; parsed lazily. */
  argsText: string;
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Pin the model to a tool the user named with @[tool].
 *
 * Only on the first pass: once the tool has run, the model has to be free to
 * stop calling tools and actually answer. Leaving the choice pinned makes it
 * call the same tool until maxToolIterations runs out.
 */
function forcedChoice(
  req: ChatStreamRequest,
  iteration: number,
  toolCount: number,
  style: "anthropic" | "openai" | "google"
): Record<string, unknown> {
  const forced = req.forcedTools ?? [];
  if (iteration !== 0 || forced.length === 0 || toolCount === 0) return {};
  const only = forced.length === 1 ? forced[0] : null;
  if (style === "anthropic") {
    return { tool_choice: only ? { type: "tool", name: only } : { type: "any" } };
  }
  if (style === "google") {
    return { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: forced } } };
  }
  return { tool_choice: only ? { type: "function", function: { name: only } } : "required" };
}

/**
 * Approval is asked for per command. With the gate switched off the tool runs
 * straight away — that's the user's call to make, and it's off by choice.
 */
function toolContext(req: ChatStreamRequest): ToolContext {
  return {
    searchEngineUrl: req.searchEngineUrl,
    approveCommand: (command, cwd) =>
      req.approveCommands
        ? requestApproval({ kind: "command", title: "Run this command?", detail: command, context: cwd })
        : Promise.resolve(true),
    approveWrite: (target, diff) =>
      req.approveWrites
        ? requestApproval({
            kind: "write",
            title: "Apply this change?",
            detail: target,
            context: getCwd(),
            diff
          })
        : Promise.resolve(true),
    desktop: req.desktop,
    approveDesktop: (summary, reason) =>
      requestApproval({ kind: "desktop", title: "Let Atla do this?", detail: summary, context: reason })
  };
}

function dataUrlToBase64(dataUrl: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return { mediaType: "image/png", data: dataUrl };
  return { mediaType: m[1], data: m[2] };
}

async function readSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
  signal: AbortSignal
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        onEvent(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readNDJSON(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
  signal: AbortSignal
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onEvent(line);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function assertOk(res: Response) {
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function anthropicTools(defs: ToolDef[], nativeSearch: boolean): unknown[] {
  const tools: unknown[] = defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
  if (nativeSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
  return tools;
}

async function streamAnthropic(
  cfg: ProviderConfig,
  req: ChatStreamRequest,
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<string> {
  const baseUrl = cfg.baseUrl?.trim() || "https://api.anthropic.com";
  const nativeSearch = req.webSearch && NATIVE_WEB_SEARCH.anthropic;
  const localTools = collectTools({
    webSearch: req.webSearch && !nativeSearch,
    browserTools: req.browserTools,
    terminal: req.terminalTool,
    files: req.fileTools,
    desktop: Boolean(req.desktop?.enabled),
    forced: req.forcedTools
  });
  const tools = anthropicTools(localTools, nativeSearch);

  const messages: unknown[] = req.messages.map((m) => {
    if (m.role === "user" && m.imageDataUrls && m.imageDataUrls.length > 0) {
      return {
        role: "user",
        content: [
          ...m.imageDataUrls.map((url) => {
            const { mediaType, data } = dataUrlToBase64(url);
            return { type: "image", source: { type: "base64", media_type: mediaType, data } };
          }),
          { type: "text", text: m.content }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  let full = "";

  for (let iteration = 0; iteration <= req.maxToolIterations; iteration++) {
    if (signal.aborted) return full;

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: req.model,
        system: req.system || undefined,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...forcedChoice(req, iteration, tools.length, "anthropic"),
        messages
      })
    });
    await assertOk(res);

    const toolCalls: ToolCall[] = [];
    const blocks = new Map<number, { type: string; toolIndex?: number }>();
    let stopReason: string | null = null;
    let iterationText = "";

    await readSSE(
      res.body!,
      (data) => {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(data);
        } catch {
          return;
        }
        const type = evt.type as string;
        if (type === "content_block_start") {
          const idx = evt.index as number;
          const block = evt.content_block as { type: string; id?: string; name?: string };
          if (block.type === "tool_use") {
            toolCalls.push({ id: block.id ?? "", name: block.name ?? "", argsText: "" });
            blocks.set(idx, { type: "tool_use", toolIndex: toolCalls.length - 1 });
          } else {
            blocks.set(idx, { type: block.type });
          }
        } else if (type === "content_block_delta") {
          const idx = evt.index as number;
          const delta = evt.delta as { type: string; text?: string; partial_json?: string };
          if (delta.type === "text_delta" && delta.text) {
            iterationText += delta.text;
            full += delta.text;
            handlers.onChunk(delta.text);
          } else if (delta.type === "input_json_delta") {
            const info = blocks.get(idx);
            if (info?.toolIndex !== undefined) toolCalls[info.toolIndex].argsText += delta.partial_json ?? "";
          }
        } else if (type === "message_delta") {
          const delta = evt.delta as { stop_reason?: string };
          if (delta?.stop_reason) stopReason = delta.stop_reason;
        } else if (type === "error") {
          const e = evt.error as { message?: string } | undefined;
          throw new Error(e?.message ?? "Anthropic stream error");
        }
      },
      signal
    );

    if (stopReason !== "tool_use" || toolCalls.length === 0) return full;

    // Echo the assistant turn back, then answer each tool call.
    messages.push({
      role: "assistant",
      content: [
        ...(iterationText ? [{ type: "text", text: iterationText }] : []),
        ...toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: parseArgs(tc.argsText) }))
      ]
    });

    const results: unknown[] = [];
    for (const tc of toolCalls) {
      const result = await executeTool(tc.name, parseArgs(tc.argsText), toolContext(req));
      handlers.onToolEvent(result.event);
      results.push({ type: "tool_result", tool_use_id: tc.id, content: result.content, is_error: !result.event.ok });
    }
    messages.push({ role: "user", content: results });
  }

  return full;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, OpenRouter, LM Studio, vLLM, …)
// ---------------------------------------------------------------------------

function openAITools(defs: ToolDef[]): unknown[] {
  return defs.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

async function streamOpenAIStyle(
  cfg: ProviderConfig,
  req: ChatStreamRequest,
  handlers: StreamHandlers,
  signal: AbortSignal,
  opts: { baseUrl: string; extraHeaders?: Record<string, string>; nativeSearch?: boolean }
): Promise<string> {
  const localTools = collectTools({
    webSearch: req.webSearch && !opts.nativeSearch,
    browserTools: req.browserTools,
    terminal: req.terminalTool,
    files: req.fileTools,
    desktop: Boolean(req.desktop?.enabled),
    forced: req.forcedTools
  });
  const tools = openAITools(localTools);

  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "user" && m.imageDataUrls && m.imageDataUrls.length > 0) {
      messages.push({
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...m.imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))
        ]
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  let full = "";

  for (let iteration = 0; iteration <= req.maxToolIterations; iteration++) {
    if (signal.aborted) return full;

    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...opts.extraHeaders
      },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        ...(tools.length > 0 ? { tools } : {}),
        ...forcedChoice(req, iteration, tools.length, "openai"),
        ...(opts.nativeSearch ? { plugins: [{ id: "web" }] } : {}),
        messages
      })
    });
    await assertOk(res);

    const toolCalls: ToolCall[] = [];
    let iterationText = "";

    await readSSE(
      res.body!,
      (data) => {
        let evt: {
          choices?: {
            delta?: {
              content?: string;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
          error?: { message?: string };
        };
        try {
          evt = JSON.parse(data);
        } catch {
          return;
        }
        if (evt.error) throw new Error(evt.error.message ?? "Provider stream error");
        const delta = evt.choices?.[0]?.delta;
        if (!delta) return;
        if (delta.content) {
          iterationText += delta.content;
          full += delta.content;
          handlers.onChunk(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          while (toolCalls.length <= idx) toolCalls.push({ id: "", name: "", argsText: "" });
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].argsText += tc.function.arguments;
        }
      },
      signal
    );

    const realCalls = toolCalls.filter((t) => t.name);
    if (realCalls.length === 0) return full;

    messages.push({
      role: "assistant",
      content: iterationText || null,
      tool_calls: realCalls.map((tc, i) => ({
        id: tc.id || `call_${iteration}_${i}`,
        type: "function",
        function: { name: tc.name, arguments: tc.argsText || "{}" }
      }))
    });

    for (const [i, tc] of realCalls.entries()) {
      const result = await executeTool(tc.name, parseArgs(tc.argsText), toolContext(req));
      handlers.onToolEvent(result.event);
      messages.push({
        role: "tool",
        tool_call_id: tc.id || `call_${iteration}_${i}`,
        content: result.content
      });
    }
  }

  return full;
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

/**
 * Gemini's schema wants uppercase type names, and rejects an OBJECT with no
 * properties — so a no-argument tool has to declare no parameters at all.
 */
function googleSchema(p: ToolDef["parameters"]): Record<string, unknown> | undefined {
  const entries = Object.entries(p.properties ?? {});
  if (entries.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    properties[key] = { type: value.type.toUpperCase(), description: value.description };
  }
  return {
    type: "OBJECT",
    properties,
    ...(p.required && p.required.length > 0 ? { required: p.required } : {})
  };
}

function googleTools(defs: ToolDef[]): unknown[] {
  return [
    {
      functionDeclarations: defs.map((t) => {
        const parameters = googleSchema(t.parameters);
        return { name: t.name, description: t.description, ...(parameters ? { parameters } : {}) };
      })
    }
  ];
}

interface GooglePart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  /**
   * Gemini 3 signs each function call and rejects the follow-up request if the
   * signature isn't echoed back with it. Both spellings appear depending on
   * the endpoint, so read either and send back whichever we got.
   */
  thoughtSignature?: string;
  thought_signature?: string;
}

async function streamGoogle(
  cfg: ProviderConfig,
  req: ChatStreamRequest,
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<string> {
  const baseUrl = cfg.baseUrl?.trim() || "https://generativelanguage.googleapis.com";

  // Gemini won't accept the built-in google_search grounding tool alongside
  // function declarations in the same request, so it has to be one or the
  // other. Grounding is the better search here, so it wins when search is all
  // that was asked for; anything else means function calling, and our own
  // web_search still searches (through the browser).
  const needsFunctions =
    req.browserTools || req.terminalTool || req.fileTools || Boolean(req.desktop?.enabled) || (req.forcedTools?.length ?? 0) > 0;
  const localTools = needsFunctions
    ? collectTools({
        webSearch: req.webSearch,
        browserTools: req.browserTools,
        terminal: req.terminalTool,
        files: req.fileTools,
        desktop: Boolean(req.desktop?.enabled),
        forced: req.forcedTools
      })
    : [];
  const useGrounding = !needsFunctions && req.webSearch;
  const tools = localTools.length > 0 ? googleTools(localTools) : useGrounding ? [{ google_search: {} }] : undefined;

  const contents: Record<string, unknown>[] = req.messages.map((m) => {
    const parts: unknown[] = [{ text: m.content }];
    for (const url of m.imageDataUrls ?? []) {
      const { mediaType, data } = dataUrlToBase64(url);
      parts.push({ inlineData: { mimeType: mediaType, data } });
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });

  const url = `${baseUrl.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(
    req.model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey ?? "")}`;

  let full = "";
  let announcedSearch = false;

  for (let iteration = 0; iteration <= req.maxToolIterations; iteration++) {
    if (signal.aborted) return full;

    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens },
        ...(tools ? { tools } : {}),
        ...forcedChoice(req, iteration, localTools.length, "google")
      })
    });
    await assertOk(res);

    const calls: { name: string; args: unknown; signature?: string }[] = [];
    let iterationText = "";

    await readSSE(
      res.body!,
      (data) => {
        let evt: {
          candidates?: {
            content?: { parts?: GooglePart[] };
            groundingMetadata?: { webSearchQueries?: string[] };
          }[];
        };
        try {
          evt = JSON.parse(data);
        } catch {
          return;
        }
        const candidate = evt.candidates?.[0];
        const queries = candidate?.groundingMetadata?.webSearchQueries;
        if (queries?.length && !announcedSearch) {
          announcedSearch = true;
          handlers.onToolEvent({ name: "web_search", summary: queries.join(", "), ok: true });
        }
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall?.name) {
            calls.push({
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              signature: part.thoughtSignature ?? part.thought_signature
            });
          } else if (part.text) {
            iterationText += part.text;
            full += part.text;
            handlers.onChunk(part.text);
          }
        }
      },
      signal
    );

    if (calls.length === 0) return full;

    // Echo the turn back verbatim — Gemini needs to see its own functionCall
    // parts before it will accept the matching functionResponse parts.
    const modelParts: unknown[] = [];
    if (iterationText) modelParts.push({ text: iterationText });
    for (const c of calls) {
      // The signature rides alongside the call, not inside it.
      modelParts.push(
        c.signature
          ? { functionCall: { name: c.name, args: c.args }, thoughtSignature: c.signature }
          : { functionCall: { name: c.name, args: c.args } }
      );
    }
    contents.push({ role: "model", parts: modelParts });

    const responseParts: unknown[] = [];
    for (const c of calls) {
      if (signal.aborted) return full;
      const result = await executeTool(c.name, c.args, toolContext(req));
      handlers.onToolEvent(result.event);
      responseParts.push({ functionResponse: { name: c.name, response: { result: result.content } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return full;
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function streamOllama(
  cfg: ProviderConfig,
  req: ChatStreamRequest,
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<string> {
  const baseUrl = cfg.baseUrl?.trim() || "http://localhost:11434";
  const localTools = collectTools({
    webSearch: req.webSearch,
    browserTools: req.browserTools,
    terminal: req.terminalTool,
    files: req.fileTools,
    desktop: Boolean(req.desktop?.enabled),
    forced: req.forcedTools
  });
  const tools = openAITools(localTools);

  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    // Ollama takes raw base64 (no data: prefix) in a sibling `images` array —
    // it does NOT use OpenAI's content-parts shape.
    const images = (m.imageDataUrls ?? []).map((url) => dataUrlToBase64(url).data);
    messages.push({
      role: m.role,
      content: m.content,
      ...(images.length > 0 ? { images } : {})
    });
  }

  let full = "";

  for (let iteration = 0; iteration <= req.maxToolIterations; iteration++) {
    if (signal.aborted) return full;

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        options: { temperature: req.temperature, num_predict: req.maxTokens },
        ...(tools.length > 0 ? { tools } : {}),
        messages
      })
    });
    await assertOk(res);

    const toolCalls: { name: string; args: unknown }[] = [];
    let iterationText = "";

    await readNDJSON(
      res.body!,
      (line) => {
        let evt: {
          message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
          error?: string;
        };
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }
        if (evt.error) throw new Error(evt.error);
        const delta = evt.message?.content;
        if (delta) {
          iterationText += delta;
          full += delta;
          handlers.onChunk(delta);
        }
        for (const tc of evt.message?.tool_calls ?? []) {
          if (tc.function?.name) toolCalls.push({ name: tc.function.name, args: tc.function.arguments ?? {} });
        }
      },
      signal
    );

    if (toolCalls.length === 0) return full;

    messages.push({
      role: "assistant",
      content: iterationText,
      tool_calls: toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } }))
    });

    for (const tc of toolCalls) {
      const args = typeof tc.args === "string" ? parseArgs(tc.args) : tc.args;
      const result = await executeTool(tc.name, args, toolContext(req));
      handlers.onToolEvent(result.event);
      // `tool_name` is what lets Ollama's chat template bind this result back
      // to the call the model made. Without it many templates render the
      // result as an anonymous blob (or drop it), and the model answers as if
      // the tool never ran.
      messages.push({ role: "tool", tool_name: tc.name, content: result.content });
    }
  }

  return full;
}

// ---------------------------------------------------------------------------

const OPENAI_BASE: Record<Extract<ProviderKind, "openai" | "openrouter">, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1"
};

/** Models love to answer with "Sure! Here's a title: **"Foo"**." — strip all that. */
export function sanitizeTitle(raw: string): string {
  let t = (raw ?? "").trim();
  // Drop <think> blocks that reasoning models emit before the answer.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Take the last non-empty line: preamble tends to come first.
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  t = lines.length > 0 ? lines[lines.length - 1] : "";
  t = t.replace(/^(title|chat title)\s*[:\-–]\s*/i, "");
  t = t.replace(/[*_`#]/g, "");
  // Quotes and trailing punctuation can wrap each other (`"Title".`), so peel
  // both until nothing more comes off rather than stripping once in a fixed
  // order and leaving a stray quote behind.
  let prev: string;
  do {
    prev = t;
    t = t.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "");
    t = t.replace(/[.!?,;:]+$/, "");
  } while (t !== prev);
  t = t.replace(/\s+/g, " ").trim();
  return t.slice(0, 60);
}

/**
 * One short, tool-free completion asking the model to name the conversation.
 * Reuses the normal adapters so it works on every provider.
 */
export async function generateTitle(
  cfg: ProviderConfig,
  model: string,
  transcript: string,
  signal: AbortSignal
): Promise<string> {
  const req: ChatStreamRequest = {
    requestId: "title",
    providerId: cfg.id,
    model,
    system:
      "You name chat conversations. Reply with ONLY the title: 3 to 6 words, plain text, no quotes, no surrounding punctuation, no explanation, no preamble.",
    messages: [{ role: "user", content: `Name this conversation.\n\n${transcript}` }],
    temperature: 0.3,
    maxTokens: 32,
    webSearch: false,
    browserTools: false,
    maxToolIterations: 0,
    searchEngineUrl: "",
    forcedTools: [],
    terminalTool: false,
    approveCommands: true,
    fileTools: false,
    approveWrites: true
  };
  let out = "";
  await streamChat(cfg, req, { onChunk: (d) => (out += d), onToolEvent: () => {} }, signal);
  return sanitizeTitle(out);
}

export async function streamChat(
  cfg: ProviderConfig,
  req: ChatStreamRequest,
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<string> {
  // Tools are available by default, so a provider that can't do tool calls has
  // to quietly go without them — otherwise every message to it would fail.
  // An @[tool] is different: the user asked for that tool by name, so the
  // reason it can't run needs to be said out loud.
  if (!SUPPORTS_TOOL_CALLS[cfg.kind]) {
    const forced = req.forcedTools ?? [];
    if (forced.length > 0) {
      throw new Error(
        `${PROVIDER_LABELS[cfg.kind]} doesn't support tool calls, so @${forced[0]} can't run here. Switch this chat to a provider that does.`
      );
    }
    req = {
      ...req,
      browserTools: false,
      webSearch: req.webSearch && NATIVE_WEB_SEARCH[cfg.kind],
      forcedTools: []
    };
  }

  switch (cfg.kind) {
    case "anthropic":
      return streamAnthropic(cfg, req, handlers, signal);
    case "google":
      return streamGoogle(cfg, req, handlers, signal);
    case "ollama":
      return streamOllama(cfg, req, handlers, signal);
    case "openai":
      return streamOpenAIStyle(cfg, req, handlers, signal, {
        baseUrl: cfg.baseUrl?.trim() || OPENAI_BASE.openai
      });
    case "openrouter":
      return streamOpenAIStyle(cfg, req, handlers, signal, {
        baseUrl: cfg.baseUrl?.trim() || OPENAI_BASE.openrouter,
        extraHeaders: { "HTTP-Referer": "https://atla.app", "X-Title": "Atla" },
        nativeSearch: req.webSearch
      });
    case "openai-compatible":
      if (!cfg.baseUrl) throw new Error("This provider needs a base URL.");
      return streamOpenAIStyle(cfg, req, handlers, signal, { baseUrl: cfg.baseUrl });
    default:
      throw new Error(`Unknown provider kind: ${cfg.kind}`);
  }
}
