// Public catalogue only. This process never starts or schedules an archive worker.
const path = require('node:path');
const os = require('node:os');
module.exports = { apps: [{
    name: 'novogradnje-web',
    cwd: path.resolve(__dirname, '..'),
    script: 'scripts/novogradnje-server.mjs',
    interpreter: process.execPath,
    env: { NODE_ENV: 'production', NOVOGRADNJE_PORT: '8490',
        FLOOR_PLAN_ARCHIVE_DIR: path.join(os.homedir(), 'code/consensus-builder/data/floor-plan-downloads') },
    autorestart: true, watch: false, time: true, max_memory_restart: '400M',
}] };
