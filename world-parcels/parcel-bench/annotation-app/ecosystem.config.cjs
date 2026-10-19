// Dedicated mobile review service; mutable imagery and labels live outside the code release.
module.exports = {
  apps: [{
    name: 'autokatastar-review',
    cwd: __dirname,
    // PM2's ESM import wrapper does not set argv[1] to the app; launch the CLI directly.
    script: process.execPath,
    interpreter: 'none',
    args: ['--env-file=/srv/autokatastar/secret.env', './server.mjs'],
    node_args: [],
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: 10000,
    env: {
      ANNOTATION_BUNDLE: '/srv/autokatastar/bundles/commute-review-v1',
      ANNOTATION_DATA: '/srv/autokatastar/reviews/commute-review-v1',
      ANNOTATION_BASE_PATH: '/autokatastar/pregled/',
      ANNOTATION_ORIGIN: 'https://zagreb.lol',
      ANNOTATION_PORT: '8791',
    },
  }],
};
