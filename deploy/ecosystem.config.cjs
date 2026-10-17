// PM2 config for this app ONLY. Process names are prefixed "kagzso_orchestrator"
// (the name already used on the Vultr server) so they can never collide with
// other projects there.
//
//   pm2 start deploy/ecosystem.config.cjs      # start / add only these two
//   pm2 restart deploy/ecosystem.config.cjs    # restart only these two
//
// Never run `pm2 restart all`, `pm2 delete all`, `pm2 kill` or `pm2 update`
// on a shared server - those hit every project.
//
// Run from the repo root: the API loads ./.env from its working directory.
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

const common = {
  cwd: root,
  script: tsx,
  interpreter: "none",
  env: { NODE_ENV: "production" },
  autorestart: true,
  max_restarts: 10,
  restart_delay: 5000,
  max_memory_restart: "600M",
  time: true,
};

module.exports = {
  apps: [
    { ...common, name: "kagzso_orchestrator", args: "apps/api/src/index.ts" },
    // Exactly one worker: the scheduler assumes a single instance.
    { ...common, name: "kagzso_orchestrator_worker", args: "apps/api/src/worker.ts", instances: 1 },
  ],
};
