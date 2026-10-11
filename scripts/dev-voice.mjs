// `npm run dev:voice` (part of `npm run dev`): starts kagzso-voice-backend-english
// with auto-reload, on the port in VOICE_BACKEND_URL (default 8002).
//
// Never breaks the rest of the dev stack: if the voice backend folder or its
// .venv is missing, or the port is already taken, it prints why and exits 0.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceDir = path.join(root, "kagzso-voice-backend-english");

function voicePort() {
  try {
    const line = readFileSync(path.join(root, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith("VOICE_BACKEND_URL="));
    const url = new URL(line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, ""));
    if (url.port) return Number(url.port);
  } catch {
    /* no .env / no URL — use the default */
  }
  return 8002;
}

function isBusy(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const skip = (why) => {
  console.log(`[voice] ${why}`);
  process.exit(0);
};

const python = [path.join(voiceDir, ".venv", "Scripts", "python.exe"), path.join(voiceDir, ".venv", "bin", "python")].find(
  existsSync,
);
if (!existsSync(voiceDir)) skip("kagzso-voice-backend-english/ not found — skipping the voice backend.");
if (!python) skip("No .venv in kagzso-voice-backend-english — create it (see its README) to start it with `npm run dev`.");

const port = voicePort();
if (await isBusy(port)) {
  skip(
    `Port ${port} is already in use — leaving the running voice backend alone. ` +
      "Stop it (npm run dev:kill) and rerun `npm run dev` if it's an old process without --reload.",
  );
}

console.log(`[voice] starting on :${port} (auto-reload on app/ changes)`);
const child = spawn(
  python,
  ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", String(port), "--reload", "--reload-dir", "app"],
  { cwd: voiceDir, stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
