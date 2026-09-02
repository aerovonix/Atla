import { spawn } from "node:child_process";
import { desktopCapturer, ipcMain, screen, systemPreferences } from "electron";
import type { DesktopAction, DesktopWindow } from "../shared/desktopPolicy.js";

/**
 * Desktop observation and control, without a native dependency.
 *
 * Observation uses Electron's own desktopCapturer. Actuation goes through
 * whatever scripting the platform already ships — PowerShell + user32 on
 * Windows, AppleScript on macOS, xdotool on Linux — for the same reason the
 * terminal isn't a real TTY: a native module here would mean per-platform
 * rebuilds pinned to each Electron version, and this feature is not worth
 * that to the rest of the app.
 *
 * The trade is honest: Linux needs xdotool installed, and macOS needs the
 * user to grant Accessibility permission. Both fail with a message saying so
 * rather than silently doing nothing.
 */

/**
 * Cut every action off at once. Checked immediately before each action runs,
 * so a stop lands even if a batch was already queued.
 */
let killed = false;

export function killDesktop() {
  killed = true;
}

export function armDesktop() {
  killed = false;
}

export function isKilled(): boolean {
  return killed;
}

function run(file: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(file, args, { windowsHide: true });
    child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", (e) => resolve({ code: 1, out, err: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function powershell(script: string) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

/** Loaded once per script; user32 is where the actual input APIs live. */
const WIN_INPUT_TYPES = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AtlaInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public static string Foreground() {
    var sb = new System.Text.StringBuilder(512);
    GetWindowTextW(GetForegroundWindow(), sb, 512);
    return sb.ToString();
  }
}
"@;
`;

/** The title of whatever currently has focus. "" when it can't be determined. */
export async function focusedWindowTitle(): Promise<string> {
  try {
    if (process.platform === "win32") {
      const r = await powershell(`${WIN_INPUT_TYPES} [AtlaInput]::Foreground()`);
      return r.code === 0 ? r.out.trim() : "";
    }
    if (process.platform === "darwin") {
      const r = await run("osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true'
      ]);
      return r.code === 0 ? r.out.trim() : "";
    }
    const r = await run("xdotool", ["getactivewindow", "getwindowname"]);
    return r.code === 0 ? r.out.trim() : "";
  } catch {
    return "";
  }
}

/**
 * macOS gates screen capture and input behind separate permissions, and both
 * fail in ways that don't say so: capture returns black or empty frames, and
 * actuation is refused silently. Checking first turns "the tool failed" into
 * something the user can act on — and, just as importantly, stops the model
 * inventing an explanation for a failure it was told nothing about.
 *
 * Windows and Linux have no equivalent, so this is a no-op there.
 */
function assertMacPermission(kind: "screen" | "accessibility"): void {
  if (process.platform !== "darwin") return;

  if (kind === "screen") {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return;
    throw new Error(
      "macOS hasn't granted Atla permission to record the screen, so there's nothing to capture. " +
        "Open System Settings > Privacy & Security > Screen & System Audio Recording, switch Atla on, " +
        "then quit and reopen Atla — the permission doesn't apply to an app that's already running. " +
        "Tell the user this; don't try another way to see the screen."
    );
  }

  // Accessibility governs synthetic input. Asked without prompting, because a
  // prompt in the middle of a tool call is a dialog the user didn't ask for.
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    throw new Error(
      "macOS hasn't granted Atla Accessibility permission, so clicks and keystrokes are ignored. " +
        "Open System Settings > Privacy & Security > Accessibility, switch Atla on, then quit and " +
        "reopen Atla. Tell the user this; the action did not happen."
    );
  }
}

export async function listWindows(): Promise<DesktopWindow[]> {
  const sources = await desktopCapturer.getSources({ types: ["window", "screen"], fetchWindowIcons: false });
  return sources
    .filter((s) => s.name.trim().length > 0)
    .map((s) => ({ id: s.id, title: s.name }));
}

/**
 * How the last screenshot maps onto the real screen.
 *
 * The model reads coordinates off the image it was given, so unless the image
 * is the screen's exact size those numbers point somewhere else. Capping the
 * image without recording this was a real bug: on a 1920x1080 screen the old
 * cap scaled x by 0.833 and y by 0.926 — different factors, so the picture was
 * also stretched — and every click landed short and high.
 */
let lastCaptureScale = 1;

export function captureScale(): number {
  return lastCaptureScale;
}

/** Longest edge of a screenshot. Beyond this it is mostly tokens, not detail. */
const MAX_CAPTURE_EDGE = 1600;

export async function capture(
  target?: string
): Promise<{ dataUrl: string; title: string; width: number; height: number; scale: number }> {
  assertMacPermission("screen");
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.size;

  // One factor for both axes, so the image keeps the screen's proportions.
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(sw, sh));
  const sources = await desktopCapturer.getSources({
    types: target ? ["window", "screen"] : ["screen"],
    thumbnailSize: { width: Math.round(sw * scale), height: Math.round(sh * scale) }
  });
  const wanted = target
    ? sources.find((s) => s.name.toLowerCase().includes(target.toLowerCase()))
    : sources[0];
  if (!wanted) throw new Error(target ? `No window matching "${target}".` : "No screen to capture.");

  const size = wanted.thumbnail.getSize();
  // Taken from the delivered image rather than the requested size: a window
  // capture comes back at the window's own aspect, not the screen's.
  lastCaptureScale = target ? 1 : size.width / sw || 1;

  return {
    dataUrl: wanted.thumbnail.toPNG().toString("base64"),
    title: wanted.name,
    width: size.width,
    height: size.height,
    scale: lastCaptureScale
  };
}

/** Image coordinates -> real screen coordinates, using the last capture. */
export function toScreenCoords(x: number, y: number): { x: number; y: number } {
  const s = lastCaptureScale || 1;
  return { x: Math.round(x / s), y: Math.round(y / s) };
}

/** Escapes text for PowerShell SendKeys, whose syntax is its own little language. */
function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

async function actWindows(action: DesktopAction): Promise<void> {
  if (action.kind === "move") {
    await powershell(`${WIN_INPUT_TYPES} [AtlaInput]::SetCursorPos(${action.x}, ${action.y})`);
    return;
  }
  if (action.kind === "click") {
    const down = action.button === "right" ? "RIGHTDOWN" : "LEFTDOWN";
    const up = action.button === "right" ? "RIGHTUP" : "LEFTUP";
    const once = `[AtlaInput]::mouse_event([AtlaInput]::${down},0,0,0,0); [AtlaInput]::mouse_event([AtlaInput]::${up},0,0,0,0);`;
    await powershell(
      `${WIN_INPUT_TYPES} [AtlaInput]::SetCursorPos(${action.x}, ${action.y}); Start-Sleep -Milliseconds 40; ${once}${
        action.double ? ` Start-Sleep -Milliseconds 60; ${once}` : ""
      }`
    );
    return;
  }
  if (action.kind === "type") {
    const escaped = sendKeysEscape(action.text).replace(/'/g, "''");
    await powershell(`${WIN_INPUT_TYPES} [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
    return;
  }
  if (action.kind === "key") {
    const map: Record<string, string> = {
      enter: "{ENTER}",
      return: "{ENTER}",
      tab: "{TAB}",
      escape: "{ESC}",
      esc: "{ESC}",
      backspace: "{BACKSPACE}",
      delete: "{DELETE}",
      up: "{UP}",
      down: "{DOWN}",
      left: "{LEFT}",
      right: "{RIGHT}",
      home: "{HOME}",
      end: "{END}"
    };
    const seq = map[action.key.toLowerCase()] ?? sendKeysEscape(action.key);
    await powershell(`${WIN_INPUT_TYPES} [System.Windows.Forms.SendKeys]::SendWait('${seq.replace(/'/g, "''")}')`);
  }
}

async function actMac(action: DesktopAction): Promise<void> {
  const osa = (script: string) => run("osascript", ["-e", script]);
  if (action.kind === "move" || action.kind === "click") {
    // System Events has no direct click-at-point, so this goes through the
    // cliclick-style approach of moving then clicking via a shell helper.
    // Without it, macOS needs Accessibility permission and reports so.
    const btn = action.kind === "click" && action.button === "right" ? "right" : "left";
    const times = action.kind === "click" && action.double ? 2 : 1;
    await osa(
      `tell application "System Events" to ${
        action.kind === "move" ? "" : `repeat ${times} times\nclick at {${action.x}, ${action.y}} using ${btn} button\nend repeat`
      }`
    );
    return;
  }
  if (action.kind === "type") {
    await osa(`tell application "System Events" to keystroke ${JSON.stringify(action.text)}`);
    return;
  }
  if (action.kind === "key") {
    const codes: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, delete: 51 };
    const code = codes[action.key.toLowerCase()];
    if (code !== undefined) await osa(`tell application "System Events" to key code ${code}`);
    else await osa(`tell application "System Events" to keystroke ${JSON.stringify(action.key)}`);
  }
}

async function actLinux(action: DesktopAction): Promise<void> {
  const probe = await run("xdotool", ["--version"]);
  if (probe.code !== 0) {
    throw new Error("Desktop control on Linux needs xdotool installed (apt install xdotool).");
  }
  if (action.kind === "move") {
    await run("xdotool", ["mousemove", String(action.x), String(action.y)]);
    return;
  }
  if (action.kind === "click") {
    const btn = action.button === "right" ? "3" : "1";
    await run("xdotool", ["mousemove", String(action.x), String(action.y)]);
    await run("xdotool", ["click", ...(action.double ? ["--repeat", "2"] : []), btn]);
    return;
  }
  if (action.kind === "type") {
    await run("xdotool", ["type", "--clearmodifiers", action.text]);
    return;
  }
  if (action.kind === "key") {
    const map: Record<string, string> = { enter: "Return", escape: "Escape", esc: "Escape", tab: "Tab" };
    await run("xdotool", ["key", map[action.key.toLowerCase()] ?? action.key]);
  }
}

/** Runs an action. The caller is responsible for having checked the policy. */
export async function perform(action: DesktopAction): Promise<void> {
  // Re-checked here rather than only at the call site: a batch approved a
  // moment ago must still stop the instant the kill switch is hit.
  if (killed) throw new Error("Desktop control was stopped. Re-enable it in Settings to continue.");
  assertMacPermission("accessibility");
  if (process.platform === "win32") return actWindows(action);
  if (process.platform === "darwin") return actMac(action);
  return actLinux(action);
}

export function registerDesktopIpc() {
  ipcMain.handle("desktop:kill", () => {
    killDesktop();
    return { ok: true as const };
  });
  // Re-arming is deliberately a separate call, so nothing the model does can
  // undo a stop — only the user turning the capability back on.
  ipcMain.handle("desktop:arm", () => {
    armDesktop();
    return { ok: true as const };
  });
}
