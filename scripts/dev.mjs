#!/usr/bin/env node
// Start the whole app for development on any OS: the Python API (port 8000) and the
// Next.js dev server (port 3000), with prefixed output. Ctrl+C stops both.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBackend } from "./backend.mjs";

const isWin = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = createRequire(path.join(root, "package.json")).resolve("next/dist/bin/next");

const colors = { api: "\x1b[35m", web: "\x1b[36m" };
function pipe(name, stream) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${colors[name]}[${name}]\x1b[0m ${line}\n`);
  });
}

const children = [];
function launch(name, child) {
  pipe(name, child.stdout);
  pipe(name, child.stderr);
  child.on("exit", (code) => {
    console.log(`${colors[name]}[${name}]\x1b[0m exited (${code ?? "signal"})`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // uvicorn --reload runs the server in a child process: kill the whole tree.
    if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGINT");
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launch("api", startBackend("pipe"));
launch(
  "web",
  spawn(process.execPath, [nextBin, "dev"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env }),
);
