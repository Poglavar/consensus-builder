// Two co-loaded stylesheets that define the same selector with different values are a bug in waiting:
// whichever loads later wins, invisibly, for every surface using that selector. That is how
// css/game.css (loaded after css/modals.css) reverted the restyled agent dialog, wallet and logout
// buttons and user label to the old look: 78 declarations on 27 selectors, nobody noticed for months.
//
// This test parses every stylesheet index.html loads, finds (media, selector) pairs that two files
// both declare with a different value for the same property, and compares the set against the
// baseline in backend/test/fixtures/design-baselines.json. A NEW conflict fails; removing one is
// progress (rerun `node backend/test/helpers/design-audit.mjs --write` to record it).

import { describe, it, expect } from 'vitest';
import { auditNow, readBaseline } from './helpers/design-audit.mjs';

const baseline = readBaseline();
const now = auditNow();

describe('co-loaded stylesheets do not fight over a selector', () => {
    it('has a baseline', () => {
        expect(baseline && Array.isArray(baseline.conflicts)).toBe(true);
    });

    it('adds no new conflicting (selector, file pair, property)', () => {
        const known = new Set(baseline ? baseline.conflicts : []);
        const fresh = now.conflicts.filter(c => !known.has(c));
        expect(fresh).toEqual([]);
    });
});
