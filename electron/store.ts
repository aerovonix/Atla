import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppState, PersistedData, ProviderConfig } from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

function dataDir(): string {
  return app.getPath("userData");
}

function statePath(): string {
  return path.join(dataDir(), "atla-state.json");
}

function providersPath(): string {
  return path.join(dataDir(), "atla-providers.json");
}

const DEFAULT_STATE: AppState = {
  conversations: [],
  projects: [],
  settings: { ...DEFAULT_SETTINGS }
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The app was renamed Nova -> Atla. Electron derives userData from the app
 * name, so both the directory AND the filenames moved. Carry the old data
 * across on first run rather than silently starting empty.
 */
export async function migrateFromNova(): Promise<void> {
  const candidates: { state: string; providers: string }[] = [
    // Same directory, old filenames (rename only changed the file prefix).
    { state: path.join(dataDir(), "nova-state.json"), providers: path.join(dataDir(), "nova-providers.json") },
    // Old userData directory, old filenames.
    {
      state: path.join(path.dirname(dataDir()), "nova", "nova-state.json"),
      providers: path.join(path.dirname(dataDir()), "nova", "nova-providers.json")
    },
    {
      state: path.join(path.dirname(dataDir()), "Nova", "nova-state.json"),
      providers: path.join(path.dirname(dataDir()), "Nova", "nova-providers.json")
    }
  ];

  if (!(await exists(statePath()))) {
    for (const c of candidates) {
      if (await exists(c.state)) {
        await fs.mkdir(dataDir(), { recursive: true });
        await fs.copyFile(c.state, statePath());
        break;
      }
    }
  }
  if (!(await exists(providersPath()))) {
    for (const c of candidates) {
      if (await exists(c.providers)) {
        await fs.mkdir(dataDir(), { recursive: true });
        await fs.copyFile(c.providers, providersPath());
        break;
      }
    }
  }
}

interface StoredProviderConfig extends Omit<ProviderConfig, "apiKey"> {
  /** base64 of the OS-encrypted key blob, or plain text if encryption is unavailable */
  apiKeyEnc?: string;
  apiKeyPlain?: string;
}

function encryptKey(key: string): Pick<StoredProviderConfig, "apiKeyEnc" | "apiKeyPlain"> {
  if (!key) return {};
  if (safeStorage.isEncryptionAvailable()) {
    return { apiKeyEnc: safeStorage.encryptString(key).toString("base64") };
  }
  return { apiKeyPlain: key };
}

function decryptKey(stored: StoredProviderConfig): string | undefined {
  if (stored.apiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, "base64"));
    } catch {
      return undefined;
    }
  }
  return stored.apiKeyPlain;
}

export async function loadState(): Promise<AppState> {
  const state = await readJson<AppState>(statePath(), DEFAULT_STATE);
  return {
    ...DEFAULT_STATE,
    ...state,
    // Fill in any settings added since this file was last written.
    settings: { ...DEFAULT_SETTINGS, ...state.settings }
  };
}

export async function saveState(state: AppState): Promise<void> {
  await writeJson(statePath(), state);
}

export async function loadProviders(): Promise<ProviderConfig[]> {
  const stored = await readJson<StoredProviderConfig[]>(providersPath(), []);
  return stored.map((s) => ({ ...s, apiKey: decryptKey(s) }));
}

export async function saveProviders(providers: ProviderConfig[]): Promise<void> {
  const toStore: StoredProviderConfig[] = providers.map((p) => {
    const { apiKey, ...rest } = p;
    return { ...rest, ...encryptKey(apiKey ?? "") };
  });
  await writeJson(providersPath(), toStore);
}

export async function loadAll(): Promise<PersistedData> {
  const [state, providers] = await Promise.all([loadState(), loadProviders()]);
  return { state, providers };
}

/**
 * Flags the main process needs *before* the app is ready, written to their own
 * tiny file.
 *
 * The GPU decision is fixed by Chromium at startup and ignored afterwards, so
 * it has to be read synchronously before anything else happens — and the main
 * state file is far too large for that: it carries the entire conversation
 * history, and reading it at launch measured 101 ms of delay to fetch a single
 * boolean. This stays a few dozen bytes however big the history gets.
 */
export async function saveStartupFlags(settings: { hardwareAcceleration?: boolean }): Promise<void> {
  const target = path.join(dataDir(), "atla-startup.json");
  try {
    await fs.writeFile(
      target,
      JSON.stringify({ hardwareAcceleration: settings.hardwareAcceleration !== false }),
      "utf-8"
    );
  } catch {
    // Losing this only means acceleration stays at its default next launch,
    // which is not worth failing a save over.
  }
}
