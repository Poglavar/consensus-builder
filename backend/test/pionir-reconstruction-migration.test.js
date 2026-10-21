// Verifies that the complete Pionir/Paron archive becomes one deterministic,
// self-checking migration bundle without carrying environment-specific row ids.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    EXPECTED_PROJECT_KEYS,
    buildArchiveBundle,
    parseArgs,
    validateBundle
} = require('../scripts/migrate-pionir-reconstruction-archive.cjs');

describe('Pionir reconstruction archive migration', () => {
    it('requires explicit production confirmation for a production write', () => {
        expect(() => parseArgs([
            '--apply-bundle', '/tmp/pionir.json', '--target', 'production'
        ])).toThrow('confirm-production');
        expect(parseArgs([
            '--apply-bundle', '/tmp/pionir.json', '--target', 'production', '--confirm-production'
        ])).toMatchObject({ action: 'apply-bundle', target: 'production', confirmProduction: true });
    });

    // Named plans are gone (plan-design-agreement.md M2): a project is its proposals, in order.
    it('builds all archived projects with stable ids, without named plans', async () => {
        const bundle = await buildArchiveBundle();
        const summary = validateBundle(bundle);
        expect(bundle.projects.map(project => project.key)).toEqual([...EXPECTED_PROJECT_KEYS]);
        expect(summary).toEqual({ projectCount: 12, proposalCount: 25, checksum: expect.any(String) });
        expect(bundle.projects.some(project => 'plan' in project)).toBe(false);
        expect(bundle.projects.every(project => project.proposals.at(-1).buildingProposal)).toBe(true);
        expect(JSON.stringify(bundle)).not.toContain('storedId');
    });

    it('detects any mutation after the bundle checksum is created', async () => {
        const bundle = await buildArchiveBundle();
        bundle.projects[0].proposals[0].title = 'tampered';
        expect(() => validateBundle(bundle)).toThrow('checksum');
    });
});
