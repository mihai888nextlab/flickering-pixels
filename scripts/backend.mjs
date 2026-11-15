#!/usr/bin/env node
// Cross-platform helper for the Python SPHEREx backend (Windows, macOS, Linux).
//   node scripts/backend.mjs setup   create spherex-blink-demo/.venv and install requirements
//   node scripts/backend.mjs dev     run the API on http://127.0.0.1:8000 with auto-reload
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const backendDir = path.join(root, "spherex-blink-demo");
const venvDir = path.join(backendDir, ".venv");
export const venvPython = path.join(venvDir, isWin ? "Scripts/python.exe" : "bin/python");
const MIN = [3, 10];

/** First Python ≥ 3.10 on PATH: `py` launcher on Windows, python3 elsewhere. */
function findPython() {
  const candidates = isWin
    ? [["py", "-3.12"], ["py", "-3"], ["python"], ["python3"]]
    : [["python3.12"], ["python3"], ["python"]];
  for (const [cmd, ...args] of candidates) {
    const r = spawnSync(cmd, [...args, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], {
      encoding: "utf8",
    });
    if (r.status !== 0 || !r.stdout) continue;
    const [major, minor] = r.stdout.trim().split(/\s+/).map(Number);
    if (major > MIN[0] || (major === MIN[0] && minor >= MIN[1])) return { cmd, args, version: `${major}.${minor}` };
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ Failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function setup() {
  if (!existsSync(venvPython)) {
    const py = findPython();
    if (!py) {
      console.error(
        `✖ Python ${MIN.join(".")}+ not found. Install Python 3.12 from https://www.python.org/downloads/` +
          (isWin ? ' (tick "Add python.exe to PATH")' : "") +
          " and run this again.",
      );
      process.exit(1);
    }
    // A .venv made on another OS (e.g. Windows vs WSL sharing a folder) has no usable python here.
    const rebuild = existsSync(venvDir);
    console.log(
      `${rebuild ? "Rebuilding" : "Creating"} ${path.relative(root, venvDir)} with Python ${py.version}…` +
        (rebuild ? " (the existing one was made on another system)" : ""),
    );
    run(py.cmd, [...py.args, "-m", "venv", ...(rebuild ? ["--clear"] : []), venvDir]);
  }
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: backendDir });
  console.log("\n✔ Backend ready. Start everything with: npm run dev:all");
}

/** Spawn the API; returns the child process (used by scripts/dev.mjs too). */
export function startBackend(stdio = "inherit") {
  if (!existsSync(venvPython)) {
    console.error("✖ Python backend isn't set up yet. Run: npm run setup");
    process.exit(1);
  }
  return spawn(
    venvPython,
    ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", process.env.SPHEREX_PORT || "8000", "--reload"],
    { cwd: backendDir, stdio, env: { ...process.env, PYTHONUNBUFFERED: "1" } },
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "setup") setup();
  else if (cmd === "dev") {
    const child = startBackend();
    child.on("exit", (code) => process.exit(code ?? 0));
    // Pass a stop signal on to uvicorn (and its reload worker) instead of orphaning it.
    const stop = (signal) => {
      if (child.exitCode !== null) return;
      if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill(signal);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
  } else {
    console.error("Usage: node scripts/backend.mjs <setup|dev>");
    process.exit(1);
  }
}
