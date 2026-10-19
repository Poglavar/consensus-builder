// Proposed dedicated service; verify the port and routing before first deployment.
module.exports = {
  apps: [{
    name: 'groundwork-review',
    cwd: __dirname,
    script: './server.mjs',
    node_args: '--env-file=/srv/groundwork/secret.env',
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: 10000,
    env: {
      ANNOTATION_BUNDLE: '/srv/groundwork/bundles/commute-review-v1',
      ANNOTATION_DATA: '/srv/groundwork/reviews/commute-review-v1',
      ANNOTATION_BASE_PATH: '/plot-review/',
      ANNOTATION_ORIGIN: 'https://zagreb.lol',
      ANNOTATION_PORT: '8791',
    },
  }],
};
