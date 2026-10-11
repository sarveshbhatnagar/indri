const path = require('node:path');
module.exports = {
  apps: [{
    name: 'indri',
    cwd: __dirname,
    script: 'src/server.js',
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    wait_ready: true,
    listen_timeout: 10000,
    kill_timeout: 5000,
    restart_delay: 1000,
    max_memory_restart: '256M',
    time: true,
    env: { NODE_ENV: 'production', PORT: process.env.PORT || '4317',
      INDRI_DB_PATH: process.env.INDRI_DB_PATH || path.join(__dirname, 'data/indri.sqlite') },
  }],
};
