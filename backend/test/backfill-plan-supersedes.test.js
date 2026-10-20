// The ens_plan.supersedes backfill (scripts/backfill-plan-supersedes.mjs): the Borovje version chain
// is the importer's own, and a link is written only where none is recorded, never over another.
import { describe, expect, it } from 'vitest';
import { parseArgs, planBackfill, supersessionLinks } from '../scripts/backfill-plan-supersedes.mjs';
import { PLANS } from '../../restatements/upu-borovje/name-plans.mjs';

describe('the Borovje version chain', () => {
    it('is the one the importer names the plans with: v2 supersedes v1 and v3 supersedes v2, for both plans', () => {
        expect(supersessionLinks(PLANS)).toEqual([
            { slug: 'upu-borovje-v2', supersedes: 'upu-borovje' },
            { slug: 'borovje-urbani-blokovi-v2', supersedes: 'borovje-urbani-blokovi' },
            { slug: 'upu-borovje-v3', supersedes: 'upu-borovje-v2' },
            { slug: 'borovje-urbani-blokovi-v3', supersedes: 'borovje-urbani-blokovi-v2' }
        ]);
    });
});

describe('planBackfill', () => {
    const links = [
        { slug: 'a-v2', supersedes: 'a' }, { slug: 'a-v3', supersedes: 'a-v2' },
        { slug: 'b-v2', supersedes: 'b' }, { slug: 'c-v2', supersedes: 'c' }, { slug: 'd-v2', supersedes: 'd' }
    ];
    const rows = [
        { slug: 'a', supersedes: null }, { slug: 'a-v2', supersedes: null }, { slug: 'a-v3', supersedes: 'a-v2' },
        { slug: 'b', supersedes: null }, { slug: 'b-v2', supersedes: 'a' },
        { slug: 'c-v2', supersedes: null }
    ];

    it('writes a missing link, keeps a recorded one, never overwrites another, and skips plans this database lacks', () => {
        const steps = planBackfill(links, rows);
        expect(steps.map(step => [step.slug, step.action])).toEqual([
            ['a-v2', 'set'], ['a-v3', 'ok'], ['b-v2', 'conflict'], ['c-v2', 'missing'], ['d-v2', 'missing']
        ]);
        expect(steps[2].recorded).toBe('a');
        expect(steps[3].reason).toBe('no plan c');
        expect(steps[4].reason).toBe('no plan d-v2');
    });

    it('has nothing left to write once applied', () => {
        const applied = rows.map(row => (row.slug === 'a-v2' ? { ...row, supersedes: 'a' } : row));
        expect(planBackfill(links, applied).filter(step => step.action === 'set')).toEqual([]);
    });
});

describe('parseArgs', () => {
    it('explains itself without a mode and refuses an ambiguous one', () => {
        expect(parseArgs([])).toMatchObject({ help: true, apply: false, dryRun: false });
        expect(parseArgs(['--dry-run'])).toMatchObject({ help: false, apply: false, dryRun: true });
        expect(parseArgs(['--apply'])).toMatchObject({ help: false, apply: true, dryRun: false });
        expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(/exclude each other/);
        expect(() => parseArgs(['--force'])).toThrow(/unknown argument --force/);
    });
});
