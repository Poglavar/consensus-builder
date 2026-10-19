// Dedicated mobile review service; mutable imagery and labels live outside the code release.
module.exports = {
  apps: [{
    name: 'autokatastar-review',
    cwd: __dirname,
    script: './server.mjs',
    node_args: '--env-file=/srv/autokatastar/secret.env',
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
