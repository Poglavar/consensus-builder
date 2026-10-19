// The control-vocabulary ratchets (docs/design-language.md, backend/test/helpers/ui-vocabulary.mjs).
//
// What they guard: only the canonical classes may paint a button; only the known families float a
// full-screen layer; z-index comes from the ladder; the link look comes from cb-link, never a bare
// `a` colour; no href="#"; every target="_blank" carries rel=noopener; the ↗ mark is CSS, not text;
// "selected" is an ARIA state, never a class; nothing calls the browser's own confirm / alert /
// prompt; no inline style on a button or link. Each list is compared with a baseline that may only
// shrink: an entry that is gone stays gone, and nothing new may appear. After removing entries rerun
// `node backend/test/helpers/ui-vocabulary.mjs --write` so the baseline follows.
import { describe, it, expect } from 'vitest';
import { auditNow, readBaseline } from './helpers/ui-vocabulary.mjs';

const baseline = readBaseline();
const now = auditNow();

describe('control vocabulary ratchets (may only shrink; rerun ui-vocabulary.mjs --write after lowering)', () => {
    it('has a baseline', () => {
        expect(baseline).toBeTruthy();
    });

    it.each(Object.keys(now))('%s adds nothing the baseline does not list', (key) => {
        const allowed = new Set((baseline && baseline[key]) || []);
        const fresh = now[key].filter(entry => !allowed.has(entry));
        expect(fresh).toEqual([]);
    });
});
