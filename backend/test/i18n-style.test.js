// Copy rules from docs/design-language.md, enforced on frontend/i18n/en.json (the source of truth)
// and the three translations.
//
// Sentence case, one ellipsis character, no duplicate strings: the legacy surfaces were Title Case
// and the new shell sentence case, which produced 45 exact case conflicts ("Create Proposal" ×5 next
// to "Create proposal" ×2) and 320 groups of duplicated values that drift apart. The counts here are
// ratchets against backend/test/fixtures/design-baselines.json: they may only go down. The three-dot
// ellipsis is a hard zero. Translation completeness is a hard rule: every en key exists in hr, es, sr.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND, auditNow, readBaseline, flattenJson, titleCaseLabels, caseConflicts, threeDotValues } from './helpers/design-audit.mjs';

const baseline = readBaseline();
const now = auditNow();
const read = lang => flattenJson(JSON.parse(readFileSync(path.join(FRONTEND, 'i18n', `${lang}.json`), 'utf8')));
const en = read('en');

describe('en.json copy rules', () => {
    it('has a baseline', () => {
        expect(baseline && baseline.i18n).toBeTruthy();
    });

    it('uses the ellipsis character, never three dots', () => {
        expect(threeDotValues(en)).toEqual([]);
    });

    it('does not add Title Case labels', () => {
        const ceiling = baseline ? baseline.i18n.titleCaseLabels : 0;
        const list = titleCaseLabels(en);
        expect({ titleCaseLabels: list.length, ceiling, sample: list.length > ceiling ? list.slice(0, 15) : [] })
            .toEqual({ titleCaseLabels: Math.min(list.length, ceiling), ceiling, sample: [] });
    });

    it('does not add case conflicts (the same words with different capitals)', () => {
        const ceiling = baseline ? baseline.i18n.caseConflicts : 0;
        const list = caseConflicts(en);
        expect({ caseConflicts: list.length, ceiling, sample: list.length > ceiling ? list.slice(0, 15) : [] })
            .toEqual({ caseConflicts: Math.min(list.length, ceiling), ceiling, sample: [] });
    });

    it('does not add duplicate value groups', () => {
        const ceiling = baseline ? baseline.i18n.duplicateGroups : 0;
        expect(now.i18n.duplicateGroups).toBeLessThanOrEqual(ceiling);
    });
});

describe('translations are complete', () => {
    it.each(['hr', 'es', 'sr'])('%s.json has every en key', (lang) => {
        const other = read(lang);
        const missing = Object.keys(en).filter(k => !(k in other));
        expect(missing).toEqual([]);
    });
});
