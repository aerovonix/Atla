import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import type { TerminalEvent } from "../shared/types.js";
import { osLabel, type SystemInfo } from "../shared/environment.js";

/**
 * A command runner rather than a TTY.
 *
 * Each command gets its own shell process, so `cd` is handled here to keep the
 * working directory across commands. This means no interactive programs — a
 * REPL or anything that wants a real terminal won't behave — but running a
 * command and reading its output, which is what this is for, works reliably
 * and needs no native modules (node-pty would mean per-platform rebuilds and
 * a much heavier package).
 */

let cwd = os.homedir();
let current: ChildProcess | null = null;
let targetWindow: BrowserWindow | null = null;

/**
 * Suppresses the events a run would otherwise send to the pane.
 *
 * A quiet command still really runs and still goes through the same approval —
 * the only thing withheld is the noise. Routine steps (checking a path,
 * launching something) filled the pane with output nobody wanted, which
 * buried the runs the user did care about.
 */
let quiet = false;

function emit(evt: TerminalEvent) {
  if (quiet) return;
  if (targetWindow && !targetWindow.isDestroyed()) targetWindow.webContents.send("terminal:event", evt);
}

/** `powershell -Command x` on Windows, `$SHELL -lc x` everywhere else. */
function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-lc", command] };
}

/** Strip one layer of matching quotes from a path argument. */
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * `cd` can't run in a child process — the child exits and takes its working
 * directory with it — so it's resolved here against the session's cwd.
 */
async function changeDirectory(rawTarget: string): Promise<string | null> {
  const target = unquote(rawTarget);
  const home = os.homedir();
  let next: string;
  if (!target || target === "~") next = home;
  else if (target.startsWith("~/") || target.startsWith("~\\")) next = path.join(home, target.slice(2));
  else next = path.resolve(cwd, target);

  try {
    const stat = await fs.stat(next);
    if (!stat.isDirectory()) return `cd: not a directory: ${target}`;
  } catch {
    return `cd: no such directory: ${target}`;
  }
  cwd = next;
  return null;
}

export function getCwd(): string {
  return cwd;
}

export function isRunning(): boolean {
  return current !== null;
}

/**
 * Run one command to completion. Resolves with the exit code and the combined
 * output, so a future tool layer can await it; the UI meanwhile follows the
 * streamed events.
 */
export function runCommand(
  command: string,
  silent = false
): Promise<{ code: number | null; output: string }> {
  quiet = silent;
  // Cleared on the way out, not just set on the way in: a throw between the
  // two would otherwise leave the pane muted for every command after it.
  const done = (r: { code: number | null; output: string }) => {
    quiet = false;
    return r;
  };
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const trimmed = command.trim();
    if (!trimmed) {
      resolve(done({ code: 0, output: "" }));
      return;
    }

    emit({ type: "start", command: trimmed, cwd });

    const cd = /^cd(?:\s+(.*))?$/i.exec(trimmed);
    if (cd) {
      void changeDirectory(cd[1] ?? "").then((err) => {
        if (err) emit({ type: "err", data: `${err}\n` });
        emit({ type: "cwd", cwd });
        emit({ type: "exit", code: err ? 1 : 0 });
        resolve(done({ code: err ? 1 : 0, output: err ?? "" }));
      });
      return;
    }

    if (current) {
      emit({ type: "err", data: "A command is already running.\n" });
      emit({ type: "exit", code: 1 });
      resolve(done({ code: 1, output: "A command is already running." }));
      return;
    }

    const { file, args } = shellFor(trimmed);
    let output = "";
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        env: process.env,
        windowsHide: true,
        // POSIX: give the shell its own process group so Stop can signal the
        // whole group. Without it, `a | b` or `a && b` leaves the children
        // running after the shell dies. Windows has no groups to detach into
        // and uses taskkill /t instead, so it stays attached there.
        detached: process.platform !== "win32"
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "err", data: `${message}\n` });
      emit({ type: "exit", code: 1 });
      resolve(done({ code: 1, output: message }));
      return;
    }
    current = child;

    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString();
      output += s;
      emit({ type: "out", data: s });
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = b.toString();
      output += s;
      emit({ type: "err", data: s });
    });
    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      output += message;
      emit({ type: "err", data: `${message}\n` });
    });
    child.on("close", (code) => {
      current = null;
      emit({ type: "exit", code });
      resolve(done({ code, output }));
    });
  });
}

export function killCurrent(): void {
  if (!current?.pid) return;
  if (process.platform === "win32") {
    // Windows has no process groups to signal, so taskkill /t walks the tree.
    spawn("taskkill", ["/pid", String(current.pid), "/f", "/t"], { windowsHide: true });
    return;
  }
  // The negative pid is the point: it signals the whole process group, which
  // the child leads because it was spawned detached. Signalling the pid alone
  // would kill the shell and orphan everything it started.
  try {
    process.kill(-current.pid, "SIGTERM");
  } catch {
    // The group is already gone, or the child never got far enough to lead
    // one. Fall back to the plain signal rather than leaving it running.
    try {
      current.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }
}

export function initTerminal(win: BrowserWindow) {
  targetWindow = win;
}

/** What the model is told about the machine it is running commands on. */
export function systemInfo(): SystemInfo {
  const { file } = shellFor("");
  return {
    platform: process.platform,
    osVersion: `${osLabel(process.platform)} ${os.release()}`,
    arch: process.arch,
    shell: file,
    homeDir: os.homedir()
  };
}

export function registerTerminalIpc() {
  ipcMain.handle("terminal:cwd", () => cwd);
  ipcMain.handle("system:info", () => systemInfo());
  ipcMain.handle("terminal:run", async (_e, command: string) => {
    const { code } = await runCommand(String(command ?? ""));
    return { code };
  });
  ipcMain.on("terminal:kill", () => killCurrent());
}
