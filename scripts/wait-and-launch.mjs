import { spawn } from "node:child_process";
import waitOn from "wait-on";

async function main() {
  // Compile the Electron main/preload TS first so dist-electron/ exists.
  await run("npm", ["run", "build:electron"]);

  await waitOn({ resources: ["http://localhost:5173"], timeout: 30000 });

  const electronBin = process.platform === "win32" ? "electron.cmd" : "electron";
  const child = spawn(electronBin, ["."], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ATLA_DEV: "1" }
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
