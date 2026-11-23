import { createRequire } from "node:module";
import os from "node:os";
import { BrowserWindow, ipcMain } from "electron";
import { nanoid } from "nanoid";

/**
 * Real terminal sessions, one per tab.
 *
 * node-pty is a native module, which this project otherwise avoids — but a
 * pseudo-terminal is the only way to get colours, spinners and interactive
 * programs. Without a TTY on the far end, tools disable colour and prompts
 * never appear, and no amount of environment coaxing fixes it generally:
 * git honours an explicit colour flag, npm ignored FORCE_COLOR entirely.
 *
 * The usual objection to native modules does not apply here. node-pty is built
 * on node-addon-api, so its binary is ABI-stable across Electron versions, and
 * it ships prebuilds for Windows and macOS on both architectures. Only Linux
 * compiles, where a toolchain is a given.
 *
 * Sessions live in the main process rather than a renderer so a terminal keeps
 * running when its pane is popped into another window, or closed and reopened.
 * A shell that dies because a pane was hidden would be its own kind of bug.
 */

// node-pty is CommonJS with a native binding; createRequire is the reliable
// way to reach it from an ES module, and is what was verified to load.
const require = createRequire(import.meta.url);

interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(file: string, args: string[] | string, opts: Record<string, unknown>): PtyProcess;
}

let ptyModule: PtyModule | null = null;
let loadError: string | null = null;

function pty(): PtyModule | null {
  if (ptyModule || loadError) return ptyModule;
  try {
    ptyModule = require("node-pty") as PtyModule;
  } catch (err) {
    // Recorded rather than thrown: the rest of the app should keep working
    // with no terminal, and the pane can say why instead of appearing broken.
    loadError = err instanceof Error ? err.message : String(err);
  }
  return ptyModule;
}

export function ptyUnavailableReason(): string | null {
  pty();
  return loadError;
}

interface Session {
  id: string;
  proc: PtyProcess;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Everything written since the session started, for a reattaching view. */
  scrollback: string;
  exited: boolean;
}

const sessions = new Map<string, Session>();

/** Beyond this, the oldest output is dropped when a view reattaches. */
const SCROLLBACK_LIMIT = 200_000;

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC || "powershell.exe", args: [] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function createSession(opts: { cwd?: string; cols?: number; rows?: number } = {}): string | null {
  const mod = pty();
  if (!mod) return null;

  const { file, args } = defaultShell();
  const cwd = opts.cwd || os.homedir();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const proc = mod.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    // TERM is what makes programs emit colour at all; without it they assume
    // a dumb terminal even with a real TTY attached.
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
  });

  const id = nanoid();
  const session: Session = { id, proc, title: "Terminal", cwd, cols, rows, scrollback: "", exited: false };
  sessions.set(id, session);

  proc.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > SCROLLBACK_LIMIT) {
      session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
    }
    broadcast("pty:data", { id, data });
  });

  proc.onExit(({ exitCode }) => {
    session.exited = true;
    broadcast("pty:exit", { id, code: exitCode });
  });

  return id;
}

export function write(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.proc.write(data);
  return true;
}

export function resize(id: string, cols: number, rows: number): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  // A zero or negative dimension makes the pty throw; a hidden pane measures
  // as zero, so this is reached in normal use rather than only in error.
  if (cols < 1 || rows < 1) return false;
  s.cols = cols;
  s.rows = rows;
  s.proc.resize(cols, rows);
  return true;
}

export function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (!s.exited) {
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
  }
  sessions.delete(id);
  return true;
}

export function killAll() {
  for (const id of [...sessions.keys()]) killSession(id);
}

export function listSessions(): { id: string; title: string; cwd: string; exited: boolean }[] {
  return [...sessions.values()].map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, exited: s.exited }));
}

/** Output so far, so a reopened or popped-out pane shows history rather than a blank pane. */
export function scrollbackFor(id: string): string {
  return sessions.get(id)?.scrollback ?? "";
}

export function registerPtyIpc() {
  ipcMain.handle("pty:create", (_e, opts: { cwd?: string; cols?: number; rows?: number }) => createSession(opts ?? {}));
  ipcMain.handle("pty:write", (_e, id: string, data: string) => write(id, data));
  ipcMain.handle("pty:resize", (_e, id: string, cols: number, rows: number) => resize(id, cols, rows));
  ipcMain.handle("pty:kill", (_e, id: string) => killSession(id));
  ipcMain.handle("pty:list", () => listSessions());
  ipcMain.handle("pty:scrollback", (_e, id: string) => scrollbackFor(id));
  ipcMain.handle("pty:unavailable", () => ptyUnavailableReason());
}
