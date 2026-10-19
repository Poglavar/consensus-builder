import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('frontend release identity', () => {
    it('ships a valid deployment-stamped manifest template', () => {
        const manifest = JSON.parse(read('../../frontend/release.json'));
        expect(manifest).toMatchObject({
            version: 1,
            component: 'urbangametheory-frontend',
            commit: '__RELEASE_COMMIT__',
            buildId: '__BUILD_ID__'
        });
    });

    it('stamps commit and build identity into the public release file', () => {
        const deploy = read('../../frontend/deploy-frontend.sh');
        expect(deploy).toContain('frontend/release.json');
        expect(deploy).toContain("'__RELEASE_COMMIT__': sys.argv[7]");
        expect(deploy).toContain('COMMIT=$(git rev-parse HEAD)');
    });
});
