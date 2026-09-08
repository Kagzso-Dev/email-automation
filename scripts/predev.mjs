// Runs automatically before `npm run dev` (npm's "pre" hook).
//
// Guards against starting a second dev stack on top of one that is already
// running. Without this, a repeat `npm run dev`:
//   - Vite finds :5173 busy and silently moves to :5174 (wrong origin), and
//   - the API cannot move and crashes with `EADDRINUSE` mid-startup,
// leaving a half-broken app and two competing process trees.
//
// If :4000 (API) or :5173 (web) is already listening, stop here with a clear
// message instead. No ports, secrets, or config are touched.

import net from "node:net";

const TARGETS = [
  { port: 4000, who: "API        (dev:api)" },
  { port: 5173, who: "web / Vite  (dev:web)" },
];

/** Resolve true if something accepts a TCP connection on host:port. */
function probe(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => resolve(false));
  });
}

async function isBusy(port) {
  const [v4, v6] = await Promise.all([
    probe(port, "127.0.0.1"),
    probe(port, "::1"),
  ]);
  return v4 || v6;
}

const busy = [];
for (const t of TARGETS) {
  if (await isBusy(t.port)) busy.push(t);
}

if (busy.length > 0) {
  const isWindows = process.platform === "win32";
  const freeCmd = isWindows
    ? "npm run dev:kill"
    : "lsof -ti :4000,:5173 | xargs kill";
  console.error(
    [
      "",
      "  ✖  Cannot start `npm run dev` — a dev stack is already running:",
      "",
      ...busy.map((t) => `       port ${t.port} in use  →  ${t.who}`),
      "",
      "  Use the terminal that already has it running, or free the ports first:",
      "",
      `       ${freeCmd}`,
      "",
      "  Then run `npm run dev` again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
