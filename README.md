# Atla

A desktop AI chat client with a built-in adblocking browser the model can drive. Bring your own model: **Claude (Anthropic), OpenAI, Google Gemini, OpenRouter, Ollama**, or any **OpenAI-compatible** endpoint (LM Studio, vLLM, Groq, Together, …) — one UI, your own API keys.

Built with Electron + React + TypeScript + Tailwind. No account, no telemetry, no server — conversations, settings, and encrypted API keys all live in your OS user-data folder.

> Formerly "Nova". Existing data is migrated automatically on first launch.

## Run it

```bash
npm install
npm run dev
```

Production build / installer:

```bash
npm run build && npm start
npm run package
```

## Tests

```bash
npm test
```

Runs typecheck, the adblock matcher tests (`scripts/test-adblock.mjs`), and an end-to-end self-test (`electron/selftest.ts`) that drives the real browser panel through the same RPC the model uses and runs the tool-calling loop against a mock provider.

## Providers and models

Settings → **Providers** → Add provider. Paste a key (not needed for Ollama or a local OpenAI-compatible server) and Atla pulls the model list live from the provider's own API — nothing is hardcoded, so the list never goes stale. Auto-detection fires when you finish entering a key or base URL, and there's a Refresh button. You can still type model ids by hand.

Keys are encrypted at rest with Electron's `safeStorage` (OS keychain / DPAPI / libsecret) and only ever travel from the main process to the provider you configured.

Set a global **default model** in Settings → Model; every new chat starts there, and you can still switch per conversation from the header.

## What the model knows about your machine

Every message carries a short environment block: the current date, time, timezone and UTC offset, the OS and its version, the shell `run_command` uses, and the terminal'''s working directory. The clock is read fresh on each send, so a window left open overnight doesn'''t report yesterday.

This exists because a model with no clock answers from its training data and is completely confident doing it — a Mistral build will insist it is still 2024. The block says outright that it overrides what the model thinks it knows.

## Tools: web search, browser, terminal, files

All four are **on by default**. That makes them *available* — the model decides per message whether reaching for one is worth it, rather than searching every time. Toggle them per chat in the composer's **+** menu, or globally in Settings → Model.

- **Claude, Gemini, OpenRouter** use their provider's own server-side search.
- **Everything else — including local Ollama models — searches through Atla's built-in browser**, so web search works even fully offline-hosted, as long as the machine has network.

### Forcing a tool with @

Type `@` in the composer to pick a tool from a list; it inserts as `@web_search` and renders as a highlighted token while you type, then bold in the sent message. Any tool named that way is made available for that turn **even if its toggle is off**, and the model is pinned to call it before answering. The pin is released after the first round trip, so it still answers instead of looping on the tool.

The older `@[web_search]` bracket form is still parsed so existing chats keep working, but nothing writes it any more.

### Tool calls in the transcript

Each call renders as a card at the point in the answer where it ran — `Navigated to duckduckgo.com` — with **Open** (loads that page in the built-in browser) and **View details** (the exact arguments and what came back). Failures show in red with the error.

## Terminal

The `>_` button in the chat header (beside the browser globe) opens a terminal pane along the bottom.

It's a **command runner, not a TTY**: each command gets its own shell, and `cd` is handled in-process so the working directory carries across commands. Output streams live, exit codes show on failure, up/down walks history, and Ctrl+C (or **Stop**) kills a running command along with its children. Interactive programs — REPLs, anything wanting a real terminal — won't behave, which is the trade for needing no native modules: `node-pty` would mean per-platform rebuilds and a much heavier package.

Windows runs `powershell.exe -NoProfile -NonInteractive -Command`; everything else uses `$SHELL -lc`.

With **Terminal** on (the `+` menu, or Settings → Model), the model can run commands here itself through `run_command`. Every command raises an approval showing the exact command line and the directory it would run in: **Deny**, **Run once**, or **Allow commands this session**. Anything that goes wrong on the way — no window, a dismissed prompt, a cancelled reply — resolves to *denied*, so a bug here fails towards not running.

Turning **Approve every command** off in Settings lets the model run commands without asking. That is the one switch in Atla with no undo behind it.

## Files

With **Files** on (the `+` menu, or Settings → Model), the model gets four tools: `read_file`, `list_dir`, `write_file`, and
`edit_file`. Paths are arbitrary and system-wide — relative ones resolve against the terminal's current directory, so `cd` moves
the model's file operations too.

Reads are never gated; nothing on disk changes. **Every write and edit raises an approval showing the actual unified diff**, not
just a filename — approving a change means seeing the change. A write whose content matches what's already there raises no prompt
at all, because a prompt for a no-op is how people learn to click through prompts without reading them.

`edit_file` replaces one exact stretch of text and refuses two ways: if `old_text` isn't found, and if it appears more than once.
Silently editing the first of several matches is the worst thing a tool like this can do, so both cases come back as an error the
model has to fix rather than a guess.

Under the reply, an **Edited N files** chip expands to the diff of everything that turn changed.

"Allow for this session" is scoped per kind — approving commands does not also pre-approve file writes, and vice versa. They are
different decisions and one click should not stand in for both.

## Canvas

Files open beside the chat in an editable pane — from **Show more** on the *Edited N files* chip, or **Open** on any file tool card. Tabs are keyed by absolute path, so the model editing a file you already have open lands in the same tab rather than a second copy of it.

The model's diff sits alongside the text rather than over it, so you can read what changed while editing what it changed. Ctrl/Cmd+S saves; a dot on the tab marks unsaved edits.

Your saves are **not** gated. The approval prompt exists to tell you what the model is about to do, and asking you to approve your own click is how people learn to dismiss the prompt that matters. The model's writes still go through the gate.

A file too large to load whole is opened read-only — saving back a truncated read would delete everything past the cut.

## First run

A short setup flow: pick a provider, paste a key, choose a name and a theme. Every step is skippable and nothing in it
is a decision you can't change in Settings — which the flow says out loud, because implying otherwise is the fastest way
to make someone abandon a setup screen.

Connecting is tested by actually listing the provider's models. A key that can't list models can't chat either, so it
fails there rather than on your first message.

## Branching

**Branch from here** on any message copies the chat up to that point into a new one and carries on separately. It's a
copy, not a pointer: editing or deleting a message in one side never reaches into the other.

The branch icon in the header shows the tree this chat belongs to, and appears only when there's more than one node.
Any other branch can be opened **beside** the current one in a split pane. Deleting a parent leaves working orphans
rather than dangling references — the tree is derived from each chat's own record of where it came from, not stored.

## Review before answering

Off by default. With it on, a second model reads each reply and, if something is actually wrong, the first model
revises it. The revision replaces the answer; **Revised after review** expands to show what the reviewer asked for and
what the reply said before.

The hard part is approval, not criticism: a model asked to critique will almost always find something, because finding
nothing feels like failing the task. So the reviewer is told approval is the normal outcome, given a one-word way to
say it, forbidden from raising wording or tone, and read by a parser that treats anything ambiguous as approval. A
false approval costs nothing — the original answer ships. A false rejection spends a round trip and usually pads the
answer.

Reviews run only on a clean finish, never on a cancelled or half-streamed reply, and any failure keeps the original.

## Desktop control

Off by default, and turning it on still grants nothing until you name an app.

The model can list windows, screenshot the screen, and click and type in other applications. **Allowed apps** (the
default) limits it to windows whose titles match your list; **Anywhere** removes that limit and is a deliberate choice.
An unidentifiable window is denied rather than prompted — asking you to approve a click on something neither of us can
name isn't consent.

Clicks that look irreversible — delete, send, buy, confirm, empty trash — are always confirmed, even in Anywhere mode,
and there is no "allow for this session" for desktop actions: a yes given on one screen doesn't cover a delete on the
next. **Stop desktop control now** in Settings cuts everything off immediately, and is re-checked before each action so
it lands even mid-sequence.

No native modules. Actuation goes through what each platform already ships — PowerShell and user32 on Windows,
AppleScript on macOS, xdotool on Linux. The trade: Linux needs `xdotool` installed and macOS needs Accessibility
permission, both of which fail with a message saying so.

## Web dash

Off by default. Starting it serves a small page on your local network so a phone can read your chats and send messages.

Pairing needs an 8-character code, regenerated every start, drawn from an alphabet with no confusable glyphs (no 0/O,
1/I/L, 8/B, 5/S, 2/Z). Five wrong attempts lock pairing for five minutes — the code's entropy isn't what stops guessing,
the lockout is. Sessions are tokens held in memory and die with the app.

**It is unencrypted HTTP on your LAN.** Anything on that network can read the traffic. That's stated in the UI rather
than papered over, and it's why the transport sits behind its own seam: a tunnel with TLS is the fix, and it drops in
there.

The dash reaches exactly four operations — list chats, open one, send a message, stop a stream. Not "whatever the store
exposes"; adding to that surface is a deliberate edit to one file.

## Built-in browser

Click the globe in the chat header. It's a real Chromium view with back/forward/reload, an address bar that accepts URLs or search terms, and an ad/tracker blocker on by default (Settings → Browser, including your own rules in Adblock syntax).

Two-way with the model:

- **You → model**: "Send page to chat" attaches the current page's text to your next message.
- **Model → browser**: with **Browser control** on, the model gets tools to navigate, read the page, list links, click by text, and go back. It drives the same window you're looking at, and every action shows as a card inline in the reply.

Browser tool calls need a provider that supports tool/function calling — Claude, OpenAI, Gemini, OpenRouter, Ollama, and OpenAI-compatible endpoints all qualify. On a provider that can't do tool calls at all, tools are dropped silently rather than failing the message — unless you named one with `@`, which errors and says why.

Gemini has one quirk of its own: the API refuses its built-in `google_search` grounding and function declarations in the same request, so it is one or the other. Grounding wins when search is all that's switched on, since it's the better search; the moment browser, terminal, or file access is on, Atla sends function declarations instead and `web_search` runs through the built-in browser like everywhere else.

The embedded browser runs in its own sandboxed, isolated session with no access to Node or Atla's internals.

## While the model is working

- **Stop** halts generation and keeps the partial answer, marked *Stopped*. It stays in the transcript as context, and **Continue** picks up from where it broke off.
- **Typing while it's busy queues the message** instead of dropping it. Queued messages sit above the composer, send in order as each turn finishes, and can be reordered, removed, or clicked to pull back into the composer for editing. A stop or an error parks the queue rather than letting it stampede — **Send next** resumes it.

## Per-message actions

Copy, thumbs up/down, regenerate, and a **···** menu with:

- **Rewind to here** — on an assistant reply this takes back the whole turn including the prompt that caused it, and puts that prompt back in the composer to edit and resend.
- **Delete message** — removes just that one.

## Other settings

Temperature, max tokens, system-prompt override, message density, font size, Enter vs Ctrl/⌘+Enter to send, auto-naming chats, showing the model name on replies, max tool steps per reply, homepage, search engine, and JSON export.

## Themes

Three, in Settings → Interface, plus **System** (which follows the OS between Light and Dark):

| | Ground | For |
|---|---|---|
| **Light** | `#ffffff` | Daylight |
| **Dark** | `#151412` | The default. A near-black carrying a trace of the brand warmth at ~5% saturation — neutral to the eye, but it does not go inert under the orange accent. |
| **Midnight** | `#000000` | OLED panels, where an unlit pixel costs nothing. |

The two dark themes share one block of tokens and override only the grounds, but each class still stands alone — a partial palette would show up as unreadable text rather than as an error, so the self-test asserts both declare a full set.

## Typography

PT Serif carries the reading surface — messages, headings, chat titles, the greeting. Inter takes metadata and anything at 13px or smaller, where a serif starts to break down. Code stays monospace. Both faces are expected to be installed locally; there's nothing fetched at runtime, and each falls back to a stack in `src/styles/index.css`.

## Branding

The logo lives at `src/public/logo.svg` (used for the in-app mark and favicon); `build/atla-logo.svg` keeps the untouched original. Brand colors `#f27229` / `#e73e26` drive the accent tokens in `src/styles/index.css`.

```bash
npm run icons
```

Regenerates `build/icon.ico` (9 sizes, 16–256) and `build/icon.png` (512) from the SVG by rendering through Chromium — no native image dependency. It auto-crops to the artwork's real ink bounds, so the mark fills the square instead of floating inside the source's wide canvas. Run it after changing the logo, then `npm run package`.

Light mode uses a deeper `#c2410c` for accent *text* since the raw brand orange is only ~2.9:1 on white; the gradient keeps the true logo colors and is used behind icons and bold text only.

## Project layout

- `electron/` — main process: window + IPC (`main.ts`), persistence and Nova→Atla migration (`store.ts`), provider adapters, streaming, and the tool loop (`providers.ts`), model discovery (`modelList.ts`), adblock (`adblock.ts`), browser RPC (`browserBridge.ts`), tool definitions (`tools.ts`), the command runner (`terminal.ts`), filesystem access (`files.ts`), the approval gate (`approvals.ts`), e2e checks (`selftest.ts`)
- `shared/types.ts` — types shared between main and renderer; `shared/toolCatalog.ts` — the `@`-mention catalog plus the pure helpers that label tool cards and place them inline; `shared/diff.ts` — the unified diff shown before a write (all covered by the self-test)
- `shared/branching.ts`, `shared/critic.ts`, `shared/desktopPolicy.ts`, `shared/dashProtocol.ts` — the pure logic behind branch trees, review verdicts, the desktop allowlist, and dash pairing. All four are covered by the self-test, because all four fail quietly if they fail at all
- `src/` — the React UI
- `src/assets/fonts/` — PT Serif and Inter, bundled (SIL OFL) because neither ships with a stock macOS or Linux install

## Known limitations

- No syntax highlighting in code blocks yet (plain monospace).
- No token/usage counters.
- The adblock list is a compact built-in set (~150 domains/patterns), not full EasyList. It catches most ads and trackers; add your own rules for anything it misses.
- Model-driven browsing reads text and clicks by visible text; it can't fill arbitrary forms or solve captchas.
- Attachments: images go to vision-capable models, text files are inlined into the prompt, and other binaries are mentioned by name only.
- No auto-update wiring for the packaged app.
- The message queue lives in memory only — quitting mid-queue loses anything still waiting.
- The terminal has no TTY, so interactive programs (REPLs, `top`, prompts for input) won't work.
- Gemini can't combine its native search grounding with function calling in one request; Atla picks one per message (see **Built-in browser**).
- File reads are capped at 512KB and skip anything that looks binary. `edit_file` needs an exact, unique match.
- Approvals are per-run and per-kind; "Allow for this session" is never persisted, so a restart puts the gate back.
