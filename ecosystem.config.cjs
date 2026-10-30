// pm2 config — keeps the server + crew running continuously on a VPS:
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
// (Railway/Render/Fly restart crashed processes themselves; this is for bare servers.)
module.exports = {
  apps: [{
    name: "buildpad",
    script: "server.js",
    instances: 1,            // keep 1: the worker loop + JSON store are single-process
    autorestart: true,
    max_restarts: 50,
    restart_delay: 2000,
    max_memory_restart: "300M",
    env: { NODE_ENV: "production" }
  }]
};
