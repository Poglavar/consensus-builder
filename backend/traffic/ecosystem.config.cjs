// Dedicated read-only simulator service; credentials stay in the server-local environment file.
const { resolve } = require('node:path');
const project = resolve(__dirname, '../..');

module.exports = {
    apps: [{
        name: 'zagreb-traffic-simulator',
        cwd: project,
        script: process.execPath,
        interpreter: 'none',
        args: [resolve(project, 'backend/scripts/serve-traffic-simulator.mjs'),
            '--env-file', '/etc/traffic-simulator/database.env'],
        autorestart: true,
        watch: false,
        max_memory_restart: '700M',
        time: true,
        env: {
            NODE_ENV: 'production',
            TRAFFIC_PORT: 8192,
            TRAFFIC_TOPOLOGY_ROOT: resolve(project, 'topology'),
            TRAFFIC_ROADS_API: 'http://127.0.0.1:3001/api'
        }
    }]
};
