// Launches the app with ATLA_SELFTEST=1, which runs the browser/tool-loop
// checks in electron/selftest.ts and exits with a non-zero code on failure.
// (Set as a node script so the env var works the same on Windows and POSIX.)
import { spawn } from "node:child_process";

const electronBin = process.platform === "win32" ? "electron.cmd" : "electron";
const child = spawn(electronBin, ["."], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ATLA_SELFTEST: "1" }
});
child.on("exit", (code) => process.exit(code ?? 0));
