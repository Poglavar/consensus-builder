// Contract tests for the production deploy scripts: they target the production branch, keep the
// laptop-generated frontend config live through the docroot sync, reload ugt-mcp with the API, and
// fail unless the public release reports the deployed commit.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const frontend = read('../../frontend/deploy-frontend.sh');
const backend = read('../deploy-backend.sh');

describe('deploy scripts', () => {
    it('default to the production branch and refuse a local HEAD that is not origin/BRANCH', () => {
        for (const script of [frontend, backend]) {
            expect(script).toContain('BRANCH="${BRANCH:-colosseum-worlds-fair}"');
            expect(script).toContain('if [[ "${LOCAL_HEAD}" != "${REMOTE_HEAD}" ]]; then');
        }
        // The frontend guard runs before anything is generated or uploaded.
        expect(frontend.indexOf('LOCAL_HEAD="$(git')).toBeLessThan(frontend.indexOf('build-carto-config.py'));
    });

    it('uploads frontend config before the HTML pass and protects it from --delete', () => {
        const upload = frontend.indexOf('scp "$SCRIPT_DIR/carto-config.js" "$SCRIPT_DIR/rpc-config.js"');
        const remote = frontend.indexOf("bash -s\" <<'REMOTE'");
        const move = frontend.indexOf('mv -f "$CONFIG_INCOMING/$config_file" "$DOCROOT/$config_file"');
        const htmlPass = frontend.indexOf('rsync -a --delete');
        expect(upload).toBeGreaterThan(-1);
        expect(upload).toBeLessThan(remote);
        expect(move).toBeGreaterThan(remote);
        expect(move).toBeLessThan(htmlPass);
        const rsyncs = frontend.match(/rsync -a [^]*?"\$STAGING_DIR\/" "\$DOCROOT\/"/g);
        expect(rsyncs).toHaveLength(2);
        for (const pass of rsyncs) {
            expect(pass).toContain("--exclude='/carto-config.js'");
            expect(pass).toContain("--exclude='/rpc-config.js'");
        }
        // Nothing is copied into the docroot after the remote block any more.
        expect(frontend.slice(frontend.lastIndexOf('\nREMOTE\n'))).not.toContain('scp ');
    });

    it('fails the frontend deploy without a purge and verifies the public release.json commit', () => {
        const missingKeys = frontend.slice(frontend.indexOf('CF_ZONE_ID / CF_API_KEY not set'));
        expect(missingKeys.slice(0, 400)).toContain('exit 1');
        const verify = frontend.indexOf('${SITE_URL}/release.json?verify=');
        expect(verify).toBeGreaterThan(-1);
        expect(frontend.indexOf('if [[ "$LIVE_COMMIT" != "$LOCAL_HEAD" ]]; then')).toBeGreaterThan(verify);
        expect(verify).toBeLessThan(frontend.indexOf('Frontend deployment completed'));
    });

    it('reloads ugt-mcp after the API and verifies the running backend commit', () => {
        const api = backend.indexOf('pm2 startOrReload ecosystem.config.cjs --only "${PM2_APP}" --update-env');
        const mcp = backend.indexOf('pm2 startOrReload ecosystem.config.cjs --only ugt-mcp --update-env');
        expect(api).toBeGreaterThan(-1);
        expect(mcp).toBeGreaterThan(api);
        expect(mcp).toBeLessThan(backend.indexOf('pm2 save'));
        const verify = backend.indexOf('PROOF_URL="${PUBLIC_API_BASE}/hackathon/proof.json"');
        expect(verify).toBeGreaterThan(backend.indexOf('\nEOF\n'));
        expect(backend).toContain('if [[ "${LIVE_SHA}" != "${LOCAL_HEAD}" ]]; then');
        expect(verify).toBeLessThan(backend.indexOf('Deployment complete!'));
    });
});
