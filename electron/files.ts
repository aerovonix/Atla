import { promises as fs } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { getCwd } from "./terminal.js";

/**
 * The model's filesystem access.
 *
 * Paths are arbitrary and system-wide by design — the user asked for a
 * workspace they can point anywhere — so the safety here is not a sandbox but
 * a gate: every mutation goes through an approval that shows the actual diff.
 * Reads are ungated, since nothing on disk changes.
 */

const MAX_READ_BYTES = 512 * 1024;
const MAX_READ_CHARS = 60000;
const MAX_LIST_ENTRIES = 300;

/** Relative paths resolve against the terminal's cwd, so `cd` and file ops agree. */
export function resolvePath(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) throw new Error("Missing path.");
  const expanded = trimmed.startsWith("~")
    ? path.join(process.env.USERPROFILE || process.env.HOME || "", trimmed.slice(1))
    : trimmed;
  return path.resolve(getCwd(), expanded);
}

/** Null bytes in the first block mean this isn't text; say so instead of returning mojibake. */
function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 4096);
  return window.includes(0);
}

export async function readFileText(target: string): Promise<{ text: string; truncated: boolean }> {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new Error(`${target} is a directory. Use list_dir instead.`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`${target} is ${Math.round(stat.size / 1024)}KB, too large to read in one go.`);
  }
  const buf = await fs.readFile(target);
  if (looksBinary(buf)) throw new Error(`${target} looks like a binary file, not text.`);
  const text = buf.toString("utf8");
  if (text.length > MAX_READ_CHARS) {
    return { text: `${text.slice(0, MAX_READ_CHARS)}\n…[truncated]`, truncated: true };
  }
  return { text, truncated: false };
}

/** Numbered lines, so the model can refer to a location and the user can follow. */
export function numberLines(text: string, from = 1): string {
  const lines = text.split("\n");
  const width = String(from + lines.length - 1).length;
  return lines.map((line, i) => `${String(from + i).padStart(width, " ")}\t${line}`).join("\n");
}

/** "" when the file doesn't exist yet — a create is a write against empty. */
export async function currentContent(target: string): Promise<string> {
  try {
    const buf = await fs.readFile(target);
    if (looksBinary(buf)) throw new Error(`${target} looks like a binary file; refusing to overwrite it blindly.`);
    return buf.toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function writeFileText(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

/**
 * Applies an exact-string edit. Refuses on zero matches (the model guessed at
 * text that isn't there) and on multiple matches (it would silently change the
 * wrong one). Both cases are the model's bug to fix, so the error says how.
 */
export function applyEdit(source: string, oldText: string, newText: string): string {
  if (!oldText) throw new Error("'old_text' cannot be empty. To create or replace a whole file, use write_file.");
  const first = source.indexOf(oldText);
  if (first === -1) {
    throw new Error("'old_text' does not appear in the file. Read the file again and copy the text exactly.");
  }
  if (source.indexOf(oldText, first + 1) !== -1) {
    throw new Error("'old_text' appears more than once. Include surrounding lines to make it unique.");
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

export async function listDir(target: string): Promise<string> {
  const entries = await fs.readdir(target, { withFileTypes: true });
  const rows = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, MAX_LIST_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const more = entries.length > MAX_LIST_ENTRIES ? `\n…and ${entries.length - MAX_LIST_ENTRIES} more` : "";
  return rows.length ? `${rows.join("\n")}${more}` : "(empty)";
}

/**
 * The canvas talks to disk through here rather than through the tool layer.
 *
 * These are the *user's* edits, opened and saved by hand, so they are not
 * gated: an approval prompt exists to tell the user what the model is about
 * to do, and asking them to approve their own click would train them to
 * dismiss the prompt that matters. The model's writes still go through
 * executeTool and its gate.
 */
export function registerFileIpc() {
  ipcMain.handle("files:read", async (_e, target: string) => {
    try {
      const resolved = resolvePath(String(target ?? ""));
      const { text, truncated } = await readFileText(resolved);
      return { ok: true as const, path: resolved, text, truncated };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("files:save", async (_e, args: { path: string; content: string }) => {
    try {
      const resolved = resolvePath(String(args?.path ?? ""));
      await writeFileText(resolved, String(args?.content ?? ""));
      return { ok: true as const, path: resolved };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
