import { create } from "zustand";
import { nanoid } from "nanoid";
import type {
  AppSettings,
  ChatAttachment,
  ChatMessage,
  Conversation,
  Project,
  ProviderConfig,
  ProviderKind,
  QueuedMessage
} from "../../shared/types";
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from "../../shared/types";
import { parseForcedTools } from "../../shared/toolCatalog";
import { childrenOf } from "../../shared/branching";
import { buildEnvironmentPrompt, type SystemInfo } from "../../shared/environment";
import { useTerminalStore } from "./terminalStore";

interface StreamState {
  conversationId: string;
  assistantMessageId: string;
}

export interface ModelFetchStatus {
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

interface AtlaStore {
  hydrated: boolean;
  hydrationError: string | null;
  conversations: Conversation[];
  projects: Project[];
  settings: AppSettings;
  providers: ProviderConfig[];
  activeConversationId: string | null;
  streaming: Record<string, StreamState>; // requestId -> stream target
  queue: Record<string, QueuedMessage[]>; // conversationId -> waiting messages
  modelFetchStatus: Record<string, ModelFetchStatus>; // providerId -> status
  /** The machine, as described to the model. Read once; it doesn't change. */
  systemInfo: SystemInfo | null;
  /** The terminal's directory at hydration, refreshed after each command. */
  systemCwd: string;

  hydrate: () => Promise<void>;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  moveToProject: (id: string, projectId: string | null) => void;
  createProject: (name: string) => void;
  deleteProject: (id: string) => void;

  updateSettings: (patch: Partial<AppSettings>) => void;

  addProvider: (kind: ProviderKind) => string;
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  fetchModelsForProvider: (id: string) => Promise<void>;

  setConversationModel: (conversationId: string, providerId: string, model: string) => void;
  setConversationFlag: (
    conversationId: string,
    flag: "webSearch" | "browserTools" | "terminalTool" | "fileTools",
    value: boolean
  ) => void;

  sendMessage: (conversationId: string, text: string, attachments: ChatAttachment[]) => void;
  stopStreaming: (conversationId: string) => void;
  regenerate: (conversationId: string) => void;
  /** Resume an answer the user stopped, appending to what was already written. */
  continueMessage: (conversationId: string, messageId: string) => void;

  removeQueued: (conversationId: string, id: string) => void;
  moveQueued: (conversationId: string, id: string, dir: -1 | 1) => void;
  /** Pull a queued message back out for editing; returns what it held. */
  editQueued: (conversationId: string, id: string) => QueuedMessage | null;
  sendNextQueued: (conversationId: string) => void;

  toggleFeedback: (conversationId: string, messageId: string, kind: "like" | "dislike") => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  /** Drop this message and everything after it; returns the prompt to restore. */
  rewindTo: (conversationId: string, messageId: string) => string | null;
  /** Splits a new chat off at a message, carrying that message and all before it. */
  branchFrom: (conversationId: string, messageId: string) => string | null;
  /** The chat shown in the second pane, or null when it's closed. */
  splitConversationId: string | null;
  openSplit: (conversationId: string) => void;
  closeSplit: () => void;
  clearAllData: () => void;
}

/** How many branches already came off this chat, so the next gets the next number. */
function childCount(conversations: Conversation[], id: string): number {
  return childrenOf(conversations, id).length;
}

/**
 * Streaming deltas, held briefly before being applied.
 *
 * A provider emits a chunk per token, and each one used to be its own store
 * update — so the transcript re-rendered, and the growing message re-parsed
 * its markdown, tens of times a second. Parsing a long answer costs more than
 * a frame budget on its own, so that alone guaranteed dropped frames.
 *
 * Coalescing on an animation frame means at most one update per frame no
 * matter how fast tokens arrive. Text still appears continuously — the eye
 * cannot resolve 60 Hz from 200 Hz — while the parsing work drops to whatever
 * the display can actually show.
 */
const pendingDeltas = new Map<string, string>();
let flushHandle: number | null = null;

/**
 * Applies every buffered delta in one store write.
 *
 * Called on the frame tick, and eagerly before anything that reads the message
 * text — a tool offset, a revision, the final done — since those would
 * otherwise measure against text that hasn't landed yet.
 */
function flushDeltas(set: (fn: (s: AtlaStore) => Partial<AtlaStore>) => void) {
  if (pendingDeltas.size === 0) return;
  const batch = new Map(pendingDeltas);
  pendingDeltas.clear();
  set((st) => {
    const targets = new Map<string, string>();
    for (const [requestId, delta] of batch) {
      const target = st.streaming[requestId];
      if (target) targets.set(target.assistantMessageId, (targets.get(target.assistantMessageId) ?? "") + delta);
    }
    if (targets.size === 0) return {};
    return {
      conversations: st.conversations.map((c) => {
        if (!c.messages.some((m) => targets.has(m.id))) return c;
        return {
          ...c,
          messages: c.messages.map((m) => {
            const delta = targets.get(m.id);
            return delta === undefined ? m : { ...m, content: m.content + delta };
          })
        };
      })
    };
  });
}

let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveState(get: () => AtlaStore) {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    const s = get();
    void window.atla.store.saveState({
      conversations: s.conversations,
      projects: s.projects,
      settings: s.settings
    });
  }, 350);
}

function saveProviders(providers: ProviderConfig[]) {
  void window.atla.store.saveProviders(providers);
}

/**
 * Without this, models assume their browser tools are hypothetical: they call
 * the tool, get real page text back, and still reply "I opened it in a
 * simulated browser, click this link yourself". Spell out that the browser is
 * real, shared, and already showing the user what the model just did.
 */
const BROWSER_CAPABILITY_PROMPT = `You have a real web browser built into this app. It is not a simulation and not hypothetical.

- The browser is a live Chromium window open next to this chat. The user is looking at it right now and sees every page you open.
- When a browser tool returns text, that is the actual content of the real page that actually loaded. Trust it and answer from it.
- Never describe the browser as "simulated", "virtual", or "pretend". Never tell the user to open a link, search, or visit a site themselves — you have the browser, so do it for them.
- To look something up, call web_search. Do not call browser_navigate on a search engine's home page; that only loads an empty search box.
- After a tool returns a page, actually read it and answer the user's question from what it says. If the answer isn't there, search again with better terms or use browser_click to open a promising result.
- Chain tools when you need to: search, then click a result, then read it. You may call several tools before replying.

Two of your tools don't touch that window at all, and for research they are the ones to reach for:

- quiet_search and fetch_url read pages directly. They are much faster, they don't disturb whatever the user has open, and you can call them many times in a row without hammering a site into rate-limiting you.
- Default to quiet_search + fetch_url when you are gathering information. Reading six pages that way costs less than opening two in the browser.
- Use the visible browser when the page needs JavaScript or a login, when you must click through something, or when the user should actually see the page. Those are the cases fetch_url cannot cover.`;

/**
 * Same lesson the browser taught: without this, models narrate what a command
 * "would" do instead of running it, or apologise that they can't reach the
 * filesystem while holding a tool that does exactly that.
 */
const TERMINAL_CAPABILITY_PROMPT = [
  "You have a real shell on the user's machine, through the run_command tool. It is not a sandbox and not a simulation.",
  "",
  "- Commands really execute. What comes back is real output from the user's system.",
  "- The user watches every command in a terminal pane and may be asked to approve each one. If they decline, accept it and ask what they'd prefer — never rerun it or work around the refusal.",
  "- The working directory persists between calls. Use `cd` to move around, and check where you are before running anything path-dependent.",
  "- There is no TTY. Never start REPLs, watchers, servers that don't exit, pagers, or anything that waits on input — they will hang until they time out. Pass non-interactive flags where a command might prompt.",
  "- Prefer reading over writing. Before anything destructive or irreversible, say what you're about to do and why."
].join("\n");

/**
 * The edit-vs-rewrite distinction is the one models get wrong most often: given
 * only write_file they will happily reconstruct a file from memory and drop
 * everything they didn't read. Saying it plainly is cheaper than repairing it.
 */
const FILE_CAPABILITY_PROMPT = [
  "You can read and change real files on the user's disk, through read_file, list_dir, write_file, and edit_file.",
  "",
  "- Always read a file before editing it. edit_file matches text character for character, so guessing at what a line says will fail.",
  "- Use edit_file for changes to an existing file. Use write_file only to create a new file or when you genuinely intend to replace the whole thing — rewriting from memory silently deletes anything you didn't read.",
  "- Relative paths resolve against the terminal's current directory, which `cd` changes.",
  "- The user sees a diff of every write and may decline. If they do, accept it and ask what they'd prefer.",
  "- Make the smallest change that does the job. Don't reformat, reorder, or 'tidy' code you weren't asked to touch."
].join("\n");

/**
 * Read fresh on every send. Capturing this once at startup would leave a
 * session that has been open overnight telling the model it is still
 * yesterday — the exact failure this block exists to prevent.
 */
function environmentBlock(info: SystemInfo | null, cwd: string): string {
  return buildEnvironmentPrompt({
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    info,
    cwd
  });
}

/**
 * The same lesson as the browser and the terminal, which this shipped without:
 * a model holding these tools will tell the user to take a screenshot, as if
 * desktop_screenshot were something they invoke rather than something it does.
 */
const DESKTOP_CAPABILITY_PROMPT = [
  "You can see and control the user's actual desktop, through desktop_screenshot, desktop_list_windows, desktop_click, desktop_type, and desktop_key. These are yours to call. The user does not run them for you, and you never ask them to.",
  "",
  "- If the user asks whether you can see their screen, the answer is yes: call desktop_screenshot and look. Don't describe the tool to them.",
  "",
  "Use the GUI last, not first. Clicking is slow, costs a screenshot and a click per step, and misses more often than a command. Before reaching for the mouse, ask whether a shell command or a file tool does the same job in one step:",
  "- Launching an app, opening a file or a URL: run it from the shell. Don't hunt for a desktop icon.",
  "- Moving, copying, renaming, deleting, or listing files: use the terminal or the file tools. A file manager window is the slowest possible way to do any of them.",
  "- Reading what is on disk: read_file and list_dir, not a screenshot of a folder.",
  "- The GUI is for what genuinely has no other route: an app with no command line, a dialog already on screen, something only visible as pixels.",
  "- A reasonable pattern is to do the work in the shell and then take one screenshot to confirm it landed, rather than doing the work through the screen.",
  "- A screenshot is a still, not a live feed. Take a fresh one after anything that changes the screen — acting on a stale image clicks whatever has since moved into that spot.",
  "- Coordinates come from the screenshot you were just given, and the tool maps them onto the real screen for you. Don't try to convert them yourself.",
  "- Say what you are clicking in `target`, using the control's visible label. It is what the user sees in the confirmation, and it is how anything irreversible gets caught.",
  "- Work may be limited to certain apps, and the user may be asked to confirm. A refusal is final: accept it and ask what they'd prefer, never retry or route around it."
].join("\n");

function buildSystemPrompt(
  settings: AppSettings,
  caps: {
    webSearch: boolean;
    browserTools: boolean;
    terminalTool?: boolean;
    fileTools?: boolean;
    desktopTools?: boolean;
    forcedTools?: string[];
    systemInfo?: SystemInfo | null;
    cwd?: string;
  }
): string {
  const override = settings.systemPromptOverride?.trim();
  const base =
    override ||
    "You are Atla, a helpful, direct AI assistant running as a desktop app. Keep answers clear and concise, use markdown formatting (code blocks, lists, tables) when it helps, and avoid unnecessary filler.";
  const name =
    settings.profileName?.trim() && settings.profileName !== "You"
      ? ` The user's name is ${settings.profileName.trim()}.`
      : "";
  // Capability description is functional, so it applies even with a custom persona.
  const browser = caps.browserTools || caps.webSearch ? `\n\n${BROWSER_CAPABILITY_PROMPT}` : "";
  const terminal = caps.terminalTool ? `\n\n${TERMINAL_CAPABILITY_PROMPT}` : "";
  const files = caps.fileTools ? `\n\n${FILE_CAPABILITY_PROMPT}` : "";
  const desktop = caps.desktopTools ? `\n\n${DESKTOP_CAPABILITY_PROMPT}` : "";
  const custom = settings.customInstructions?.trim()
    ? `\n\nAdditional instructions from the user:\n${settings.customInstructions.trim()}`
    : "";
  // tool_choice pins the first call, but not every provider honours it (Ollama
  // ignores it entirely), so say it in words as well.
  const forced =
    caps.forcedTools && caps.forcedTools.length > 0
      ? `\n\nFor this message the user explicitly asked you to use ${caps.forcedTools
          .map((t) => `\`${t}\``)
          .join(" and ")}. Call ${
          caps.forcedTools.length > 1 ? "each of them" : "it"
        } before answering, even if you think you already know the answer.`
      : "";
  const env = environmentBlock(caps.systemInfo ?? null, caps.cwd ?? "");
  return `${env}\n\n${base}${name}${browser}${terminal}${files}${desktop}${forced}${custom}`.trim();
}

/**
 * Flatten a message's attachments into what the model actually receives:
 * text files get inlined into the prompt, images ride along as data URLs.
 * Without this, attachments show in the UI but never reach the model.
 */
function toWireMessage(m: ChatMessage) {
  const textParts: string[] = [];
  const imageDataUrls: string[] = [];

  for (const a of m.attachments ?? []) {
    if (a.type.startsWith("image/") && a.dataUrl?.startsWith("data:")) {
      imageDataUrls.push(a.dataUrl);
    } else if (a.text) {
      textParts.push(`--- Attached file: ${a.name} (${a.type || "text"}) ---\n${a.text}\n--- end of ${a.name} ---`);
    } else {
      textParts.push(`[Attached file "${a.name}" (${a.type || "unknown"}) — binary content not readable as text.]`);
    }
  }

  const content = textParts.length > 0 ? `${m.content}\n\n${textParts.join("\n\n")}`.trim() : m.content;
  return { role: m.role, content, imageDataUrls: imageDataUrls.length > 0 ? imageDataUrls : undefined };
}

/** What the reviewer is told the user asked. Falls back to the last prompt. */
function lastUserText(history: ChatMessage[], extra?: string): string {
  if (extra) return extra;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return "";
}

export const useStore = create<AtlaStore>((set, get) => {
  let unsubscribeEvents: (() => void) | null = null;

  /** Shared by sendMessage and regenerate. */
  const startStream = (
    conversationId: string,
    assistantMessageId: string,
    provider: ProviderConfig,
    model: string,
    history: ChatMessage[],
    opts: { forcedTools?: string[]; extraWire?: { role: "user"; content: string } } = {}
  ) => {
    const { settings, conversations } = get();
    const conv = conversations.find((c) => c.id === conversationId);
    const requestId = nanoid();
    const webSearch = conv?.webSearch ?? settings.webSearchEnabled;
    const browserTools = conv?.browserTools ?? settings.browserToolsEnabled;
    const terminalTool = conv?.terminalTool ?? settings.terminalToolEnabled;
    const fileTools = conv?.fileTools ?? settings.fileToolsEnabled;
    const forcedTools = opts.forcedTools ?? [];
    set((st) => ({ streaming: { ...st.streaming, [requestId]: { conversationId, assistantMessageId } } }));

    const wire = history.map(toWireMessage);
    if (opts.extraWire) wire.push({ ...opts.extraWire, imageDataUrls: undefined });

    window.atla.chat.start({
      requestId,
      providerId: provider.id,
      model,
      system: buildSystemPrompt(settings, {
        webSearch,
        browserTools,
        terminalTool,
        fileTools,
        desktopTools: settings.desktopEnabled,
        forcedTools,
        systemInfo: get().systemInfo,
        // The terminal store is the live one — the model can cd itself, and
        // the hydration value only stands in before the pane has been opened.
        cwd: useTerminalStore.getState().cwd || get().systemCwd
      }),
      messages: wire,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      webSearch,
      browserTools,
      terminalTool,
      approveCommands: settings.commandApproval,
      fileTools,
      approveWrites: settings.fileWriteApproval,
      desktop: settings.desktopEnabled
        ? {
            enabled: true,
            scope: settings.desktopScope,
            allowlist: settings.desktopAllowlist,
            confirmEvery: settings.desktopConfirmEvery
          }
        : undefined,
      critic: settings.criticEnabled
        ? {
            // An empty reviewer provider means self-review, which still helps:
            // a model re-reading its own answer against a checklist catches
            // more than a model writing it in one pass.
            providerId: settings.criticProviderId || provider.id,
            model: settings.criticModel || model,
            rounds: settings.criticRounds,
            minChars: settings.criticMinChars,
            prompt: lastUserText(history, opts.extraWire?.content)
          }
        : undefined,
      maxToolIterations: settings.maxToolIterations,
      searchEngineUrl: settings.searchEngineUrl,
      forcedTools
    });
  };

  /**
   * Ask the model to name the chat after its first complete exchange. Runs
   * once per conversation and never blocks the UI — on any failure the
   * provisional truncated title just stays.
   */
  const maybeAutoTitle = async (conversationId: string) => {
    const s = get();
    if (!s.settings.autoTitle) return;
    const conv = s.conversations.find((c) => c.id === conversationId);
    if (!conv || conv.autoTitled) return;

    const firstUser = conv.messages.find((m) => m.role === "user");
    const firstAssistant = conv.messages.find((m) => m.role === "assistant" && m.content && !m.error);
    if (!firstUser || !firstAssistant) return;

    const provider = s.providers.find((p) => p.id === conv.providerId);
    const model = conv.model || provider?.defaultModel;
    if (!provider || !model) return;

    // Claim it up front so a second stream finishing can't double-fire.
    set((st) => ({
      conversations: st.conversations.map((c) => (c.id === conversationId ? { ...c, autoTitled: true } : c))
    }));

    const transcript = `User: ${firstUser.content.slice(0, 1500)}\n\nAssistant: ${firstAssistant.content.slice(0, 1500)}`;
    const res = await window.atla.provider.generateTitle({ providerId: provider.id, model, transcript });
    if (res.ok && res.title) {
      set((st) => ({
        conversations: st.conversations.map((c) => (c.id === conversationId ? { ...c, title: res.title! } : c))
      }));
      scheduleSaveState(get);
    }
  };

  /** Resolve which provider/model a conversation should use. */
  const resolveModel = (conv: Conversation) => {
    const s = get();
    const providerId = conv.providerId ?? s.settings.defaultProviderId ?? s.providers[0]?.id;
    const provider = s.providers.find((p) => p.id === providerId) ?? s.providers[0];
    if (!provider) return null;
    const model =
      conv.model ||
      (provider.id === s.settings.defaultProviderId ? s.settings.defaultModel : undefined) ||
      provider.defaultModel ||
      provider.models[0] ||
      "";
    return { provider, model };
  };

  /**
   * Put a turn on screen and start streaming it. Shared by a direct send and
   * by the queue drain, so both take exactly the same path.
   */
  const deliver = (conversationId: string, text: string, attachments: ChatAttachment[]) => {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const resolved = resolveModel(conv);
    if (!resolved) return;
    const { provider, model } = resolved;

    const userMsg: ChatMessage = {
      id: nanoid(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined
    };
    const assistantMsg: ChatMessage = {
      id: nanoid(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      providerId: provider.id,
      model
    };

    // Provisional title so the sidebar isn't blank; if auto-naming is on the
    // model replaces this once the first exchange finishes.
    const isFirstTurn = conv.messages.filter((m) => m.role === "user").length === 0 && conv.title === "New Chat";
    const title = isFirstTurn ? text.slice(0, 40) || "New Chat" : conv.title;

    set((st) => ({
      conversations: st.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title,
              providerId: provider.id,
              model,
              messages: [...c.messages, userMsg, assistantMsg],
              updatedAt: Date.now()
            }
          : c
      )
    }));
    scheduleSaveState(get);

    startStream(conversationId, assistantMsg.id, provider, model, [...conv.messages, userMsg], {
      forcedTools: parseForcedTools(text)
    });
  };

  return {
    hydrated: false,
    hydrationError: null,
    conversations: [],
    projects: [],
    settings: { ...DEFAULT_SETTINGS },
    providers: [],
    activeConversationId: null,
    streaming: {},
    queue: {},
    modelFetchStatus: {},
    splitConversationId: null,
    systemInfo: null,
    systemCwd: "",

    hydrate: async () => {
      if (!window.atla) {
        set({
          hydrationError:
            "The app's preload bridge (window.atla) didn't load, so nothing can be saved or sent to a provider. This usually means the preload script failed to load — check the Electron console (View > Toggle Developer Tools) for a [preload] error."
        });
        return;
      }
      let data;
      try {
        data = await window.atla.store.load();
      } catch (err) {
        set({ hydrationError: err instanceof Error ? err.message : String(err) });
        return;
      }
      let conversations = data.state.conversations;
      if (conversations.length === 0) {
        conversations = [{ id: nanoid(), title: "New Chat", messages: [], updatedAt: Date.now(), projectId: null }];
      }
      // Migrations run in order and each stamps only its own version, so an
      // install several versions behind picks up every step rather than being
      // fast-forwarded past the ones in between. Note that a genuinely *new*
      // key needs no step here — the spread already gives it its default. Only
      // a changed default for an existing key does, because a saved value
      // always wins.
      const settings = { ...DEFAULT_SETTINGS, ...data.state.settings };
      const from = data.state.settings?.settingsVersion ?? 0;
      if (from < 1) {
        // These used to default off, and a saved `false` would otherwise
        // outlive the change forever. Availability, not compulsion — the model
        // still decides whether a tool is worth reaching for.
        settings.webSearchEnabled = true;
        settings.browserToolsEnabled = true;
      }
      if (from < 3) {
        // An existing install has an app that already works, so dropping the
        // owner into a first-run flow would be a regression, not a welcome.
        settings.onboarded = true;
      }
      settings.settingsVersion = SETTINGS_VERSION;

      // Best effort: an older bridge without this channel just means the
      // model gets the clock but no machine details, which is still better
      // than it inventing both.
      let systemInfo: SystemInfo | null = null;
      let systemCwd = "";
      try {
        systemInfo = (await window.atla.system?.info()) ?? null;
        systemCwd = (await window.atla.terminal?.cwd()) ?? "";
      } catch {
        systemInfo = null;
      }

      // The updater starts enabled and learns the real preference here, since
      // main has no view of settings.
      void window.atla?.update?.setEnabled(settings.autoUpdate);
      void window.atla?.update?.setChannel(settings.updateChannel);

      set({
        systemInfo,
        systemCwd,
        conversations,
        projects: data.state.projects,
        settings,
        providers: data.providers,
        activeConversationId: conversations[0].id,
        hydrated: true,
        hydrationError: null
      });

      if (!unsubscribeEvents) {
        unsubscribeEvents = window.atla.chat.onEvent((evt) => {
          const streamState = get().streaming[evt.requestId];
          if (!streamState) return;
          const patchMessage = (fn: (m: ChatMessage) => ChatMessage) =>
            set((s) => ({
              conversations: s.conversations.map((c) =>
                c.id !== streamState.conversationId
                  ? c
                  : { ...c, messages: c.messages.map((m) => (m.id === streamState.assistantMessageId ? fn(m) : m)) }
              )
            }));

          if (evt.type === "chunk") {
            // Buffered, not applied. The flush below owns the store write.
            pendingDeltas.set(evt.requestId, (pendingDeltas.get(evt.requestId) ?? "") + evt.delta);
            if (flushHandle === null) {
              flushHandle = requestAnimationFrame(() => {
                flushHandle = null;
                flushDeltas(set);
              });
            }
          } else if (evt.type === "tool") {
            // Stamp where in the text this happened so the card can render in
            // place instead of every card stacking above the message.
            flushDeltas(set);
            patchMessage((m) => ({
              ...m,
              toolEvents: [...(m.toolEvents ?? []), { ...evt.event, at: m.content.length }]
            }));
          } else if (evt.type === "reviewing") {
            flushDeltas(set);
            patchMessage((m) => ({ ...m, reviewing: true }));
          } else if (evt.type === "revising") {
            // The body is about to be cleared for the revision; any delta
            // still buffered belongs to the text being replaced.
            flushDeltas(set);
            // The revision streams into a cleared body. The first answer moves
            // to `original` rather than being dropped, so a revision that turns
            // out worse is still recoverable by the user.
            patchMessage((m) => ({
              ...m,
              reviewing: false,
              critique: evt.critique,
              original: m.original ?? m.content,
              content: ""
            }));
          } else if (evt.type === "done" || evt.type === "error") {
            // The last tokens usually arrive in the same frame as `done`, so
            // without this the tail of every reply would be silently dropped.
            flushDeltas(set);
            set((s) => {
              const { [evt.requestId]: _drop, ...rest } = s.streaming;
              return {
                streaming: rest,
                conversations: s.conversations.map((c) =>
                  c.id !== streamState.conversationId
                    ? c
                    : {
                        ...c,
                        updatedAt: Date.now(),
                        messages: c.messages.map((m) => {
                          if (m.id !== streamState.assistantMessageId) return m;
                          if (evt.type === "error") {
                            return { ...m, content: m.content || `⚠️ ${evt.message}`, error: true };
                          }
                          if (evt.aborted) return { ...m, reviewing: false, interrupted: true };
                          // A review that approved leaves no critique; clear
                          // the spinner either way so it can't stick on.
                          return { ...m, reviewing: false, critique: evt.critique ?? m.critique };
                        })
                      }
                )
              };
            });
            scheduleSaveState(get);
            if (evt.type === "done" && !evt.aborted) {
              // The title is the useful part of the notification: which chat
              // finished, not that something did.
              if (get().settings.notifyOnFinish) {
                const conv = get().conversations.find((c) => c.id === streamState.conversationId);
                const reply = conv?.messages.find((m) => m.id === streamState.assistantMessageId);
                void window.atla?.notify?.send(
                  conv?.title || "Atla",
                  (reply?.content ?? "").trim().slice(0, 200) || "Finished."
                );
              }
              void maybeAutoTitle(streamState.conversationId);
              // Only a clean finish pulls the next queued message. A stop or an
              // error leaves the queue parked so it can't stampede.
              setTimeout(() => get().sendNextQueued(streamState.conversationId), 0);
            }
          }
        });
      }
    },

    newConversation: () => {
      const id = nanoid();
      const { settings, providers } = get();
      const provider = providers.find((p) => p.id === settings.defaultProviderId);
      const conv: Conversation = {
        id,
        title: "New Chat",
        messages: [],
        updatedAt: Date.now(),
        projectId: null,
        providerId: provider?.id,
        model: provider ? settings.defaultModel || provider.defaultModel : undefined
      };
      set((s) => ({ conversations: [conv, ...s.conversations], activeConversationId: id }));
      scheduleSaveState(get);
      return id;
    },

    selectConversation: (id) => set({ activeConversationId: id }),

    deleteConversation: (id) => {
      set((s) => {
        const remaining = s.conversations.filter((c) => c.id !== id);
        let active = s.activeConversationId;
        let list = remaining;
        if (active === id) {
          if (list.length === 0) {
            const conv: Conversation = {
              id: nanoid(),
              title: "New Chat",
              messages: [],
              updatedAt: Date.now(),
              projectId: null
            };
            list = [conv];
            active = conv.id;
          } else {
            active = list[0].id;
          }
        }
        const { [id]: _dropQueue, ...queue } = s.queue;
        // A split pane pointing at a deleted chat would render nothing and
        // leave no way to close it, so it goes with the chat.
        const splitConversationId = s.splitConversationId === id ? null : s.splitConversationId;
        return { conversations: list, activeConversationId: active, queue, splitConversationId };
      });
      scheduleSaveState(get);
    },

    renameConversation: (id, title) => {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, title: title.slice(0, 60), updatedAt: Date.now() } : c
        )
      }));
      scheduleSaveState(get);
    },

    moveToProject: (id, projectId) => {
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, projectId, updatedAt: Date.now() } : c))
      }));
      scheduleSaveState(get);
    },

    createProject: (name) => {
      const colors = ["#e93323", "#e432b7", "#2227f5", "#53b5f9", "#75f94c", "#efb63f", "#8762f6"];
      const project: Project = {
        id: nanoid(),
        name: name.slice(0, 30),
        color: colors[Math.floor(Math.random() * colors.length)]
      };
      set((s) => ({ projects: [...s.projects, project] }));
      scheduleSaveState(get);
    },

    deleteProject: (id) => {
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        conversations: s.conversations.map((c) => (c.projectId === id ? { ...c, projectId: null } : c))
      }));
      scheduleSaveState(get);
    },

    updateSettings: (patch) => {
      if (patch.autoUpdate !== undefined) void window.atla?.update?.setEnabled(patch.autoUpdate);
      if (patch.updateChannel !== undefined) void window.atla?.update?.setChannel(patch.updateChannel);
      set((s) => ({ settings: { ...s.settings, ...patch } }));
      scheduleSaveState(get);
    },

    addProvider: (kind) => {
      const id = nanoid();
      const provider: ProviderConfig = {
        id,
        kind,
        label: kind,
        apiKey: "",
        baseUrl: kind === "ollama" ? "http://localhost:11434" : undefined,
        defaultModel: "",
        models: [],
        createdAt: Date.now()
      };
      set((s) => ({ providers: [...s.providers, provider] }));
      saveProviders(get().providers);
      // Ollama's base URL is already usable (no key needed) — pull its
      // installed models right away instead of waiting on user input.
      if (kind === "ollama") void get().fetchModelsForProvider(id);
      return id;
    },

    updateProvider: (id, patch) => {
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
      saveProviders(get().providers);
    },

    removeProvider: (id) => {
      set((s) => ({
        providers: s.providers.filter((p) => p.id !== id),
        settings:
          s.settings.defaultProviderId === id
            ? { ...s.settings, defaultProviderId: undefined, defaultModel: undefined }
            : s.settings
      }));
      saveProviders(get().providers);
      scheduleSaveState(get);
    },

    fetchModelsForProvider: async (id) => {
      const cfg = get().providers.find((p) => p.id === id);
      if (!cfg) return;
      set((s) => ({
        modelFetchStatus: {
          ...s.modelFetchStatus,
          [id]: { loading: true, error: null, fetchedAt: s.modelFetchStatus[id]?.fetchedAt ?? null }
        }
      }));
      const res = await window.atla.provider.fetchModels(cfg);
      if (res.ok && res.models) {
        const models = res.models;
        const current = get().providers.find((p) => p.id === id);
        if (current) {
          const defaultModel =
            current.defaultModel && models.includes(current.defaultModel) ? current.defaultModel : models[0] ?? "";
          set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, models, defaultModel } : p)) }));
          saveProviders(get().providers);
        }
        set((s) => ({
          modelFetchStatus: { ...s.modelFetchStatus, [id]: { loading: false, error: null, fetchedAt: Date.now() } }
        }));
      } else {
        set((s) => ({
          modelFetchStatus: {
            ...s.modelFetchStatus,
            [id]: {
              loading: false,
              error: res.error ?? "Failed to fetch models",
              fetchedAt: s.modelFetchStatus[id]?.fetchedAt ?? null
            }
          }
        }));
      }
    },

    setConversationModel: (conversationId, providerId, model) => {
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, providerId, model } : c))
      }));
      scheduleSaveState(get);
    },

    setConversationFlag: (conversationId, flag, value) => {
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, [flag]: value } : c))
      }));
      scheduleSaveState(get);
    },

    sendMessage: (conversationId, text, attachments) => {
      const s = get();
      // Busy: park it rather than dropping it or interleaving two streams.
      const busy = Object.values(s.streaming).some((v) => v.conversationId === conversationId);
      if (busy) {
        const item: QueuedMessage = { id: nanoid(), text, attachments };
        set((st) => ({ queue: { ...st.queue, [conversationId]: [...(st.queue[conversationId] ?? []), item] } }));
        return;
      }
      deliver(conversationId, text, attachments);
    },

    removeQueued: (conversationId, id) => {
      set((s) => ({
        queue: { ...s.queue, [conversationId]: (s.queue[conversationId] ?? []).filter((q) => q.id !== id) }
      }));
    },

    moveQueued: (conversationId, id, dir) => {
      set((s) => {
        const list = [...(s.queue[conversationId] ?? [])];
        const i = list.findIndex((q) => q.id === id);
        const j = i + dir;
        if (i === -1 || j < 0 || j >= list.length) return {};
        [list[i], list[j]] = [list[j], list[i]];
        return { queue: { ...s.queue, [conversationId]: list } };
      });
    },

    editQueued: (conversationId, id) => {
      const item = (get().queue[conversationId] ?? []).find((q) => q.id === id) ?? null;
      if (item) get().removeQueued(conversationId, id);
      return item;
    },

    sendNextQueued: (conversationId) => {
      const s = get();
      if (Object.values(s.streaming).some((v) => v.conversationId === conversationId)) return;
      const [next, ...rest] = s.queue[conversationId] ?? [];
      if (!next) return;
      set((st) => ({ queue: { ...st.queue, [conversationId]: rest } }));
      deliver(conversationId, next.text, next.attachments);
    },

    continueMessage: (conversationId, messageId) => {
      const s = get();
      const conv = s.conversations.find((c) => c.id === conversationId);
      if (!conv) return;
      const idx = conv.messages.findIndex((m) => m.id === messageId);
      if (idx === -1 || conv.messages[idx].role !== "assistant") return;
      const resolved = resolveModel(conv);
      if (!resolved) return;

      // Prefilling the partial and asking for a continuation works on every
      // provider; assistant-prefill continuation does not (OpenAI restarts the
      // turn instead of extending it). The nudge is wire-only — it never shows
      // in the transcript.
      const history = conv.messages.slice(0, idx + 1);
      set((st) => ({
        conversations: st.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, interrupted: false } : m)) }
            : c
        )
      }));
      startStream(conversationId, messageId, resolved.provider, resolved.model, history, {
        extraWire: {
          role: "user",
          content:
            "Continue your previous answer from exactly where it stopped. Do not repeat anything you already wrote, and do not restart or re-introduce the answer."
        }
      });
    },

    stopStreaming: (conversationId) => {
      const entry = Object.entries(get().streaming).find(([, v]) => v.conversationId === conversationId);
      if (entry) window.atla.chat.cancel(entry[0]);
    },

    regenerate: (conversationId) => {
      const s = get();
      const conv = s.conversations.find((c) => c.id === conversationId);
      if (!conv) return;
      const lastAssistantIdx = [...conv.messages].reverse().findIndex((m) => m.role === "assistant");
      if (lastAssistantIdx === -1) return;
      const idx = conv.messages.length - 1 - lastAssistantIdx;
      const resolved = resolveModel(conv);
      if (!resolved) return;
      const { provider, model } = resolved;

      const history = conv.messages.slice(0, idx);
      const newAssistant: ChatMessage = {
        id: nanoid(),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        providerId: provider.id,
        model
      };
      const newMessages = [...history, newAssistant, ...conv.messages.slice(idx + 1)];

      set((st) => ({
        conversations: st.conversations.map((c) =>
          c.id === conversationId ? { ...c, messages: newMessages, updatedAt: Date.now() } : c
        )
      }));

      startStream(conversationId, newAssistant.id, provider, model, history);
    },

    deleteMessage: (conversationId, messageId) => {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: c.messages.filter((m) => m.id !== messageId), updatedAt: Date.now() }
            : c
        )
      }));
      scheduleSaveState(get);
    },

    branchFrom: (conversationId, messageId) => {
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (!conv) return null;
      const idx = conv.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return null;

      // The branch keeps the chosen message. Branching at an assistant reply
      // means "carry on from this answer"; branching at a prompt means "keep
      // the question, take the answer again" — both read the same way from the
      // message the user clicked.
      const carried = conv.messages.slice(0, idx + 1).map((m) => ({ ...m, id: nanoid() }));
      const id = nanoid();
      const branch: Conversation = {
        id,
        // Numbered rather than "Copy of": these are siblings, not duplicates.
        title: `${conv.title} · branch ${childCount(get().conversations, conversationId) + 1}`,
        messages: carried,
        updatedAt: Date.now(),
        projectId: conv.projectId,
        providerId: conv.providerId,
        model: conv.model,
        // Deliberately not autoTitled: the branch has its own direction to go
        // in, so the next exchange gets to name it.
        webSearch: conv.webSearch,
        browserTools: conv.browserTools,
        terminalTool: conv.terminalTool,
        fileTools: conv.fileTools,
        branchedFrom: { conversationId, messageId, title: conv.title, at: Date.now() }
      };

      set((s) => ({ conversations: [branch, ...s.conversations], activeConversationId: id }));
      scheduleSaveState(get);
      return id;
    },

    openSplit: (conversationId) =>
      set((s) => (s.activeConversationId === conversationId ? s : { splitConversationId: conversationId })),

    closeSplit: () => set({ splitConversationId: null }),

    rewindTo: (conversationId, messageId) => {
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (!conv) return null;
      const idx = conv.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return null;

      // Rewinding an assistant reply should also take back the prompt that
      // caused it, so the user lands where they were before that turn.
      let cut = idx;
      if (conv.messages[idx].role === "assistant") {
        for (let i = idx - 1; i >= 0; i--) {
          if (conv.messages[i].role === "user") {
            cut = i;
            break;
          }
        }
      }
      const restored = conv.messages[cut].role === "user" ? conv.messages[cut].content : null;

      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, messages: c.messages.slice(0, cut), updatedAt: Date.now() } : c
        )
      }));
      scheduleSaveState(get);
      return restored;
    },

    toggleFeedback: (conversationId, messageId, kind) => {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id !== conversationId
            ? c
            : {
                ...c,
                messages: c.messages.map((m) => {
                  if (m.id !== messageId) return m;
                  if (kind === "like") return { ...m, liked: !m.liked, disliked: false };
                  return { ...m, disliked: !m.disliked, liked: false };
                })
              }
        )
      }));
      scheduleSaveState(get);
    },

    clearAllData: () => {
      const conv: Conversation = {
        id: nanoid(),
        title: "New Chat",
        messages: [],
        updatedAt: Date.now(),
        projectId: null
      };
      set({
        conversations: [conv],
        projects: [],
        activeConversationId: conv.id,
        splitConversationId: null,
        queue: {},
        settings: { ...DEFAULT_SETTINGS }
      });
      scheduleSaveState(get);
    }
  };
});
