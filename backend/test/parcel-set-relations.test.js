import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    classifyParcelSetRelation,
    findParcelSetRelations,
    normalizeParcelIds,
    proposalIdsForParcelSet
} = require('../../frontend/js/proposals/parcel-set-relations.js');

const proposal = (proposalId, parcelIds, setHash = null) => ({
    proposalId,
    cadastreParcelIds: parcelIds,
    ...(setHash ? { parcelSet: { parcelIds, setHash } } : {})
});

describe('proposal parcel-set relations', () => {
    it('lists every proposal over one canonical set hash and nothing for a missing hash', () => {
        const proposals = [proposal('a', ['1', '2'], 'sha256:x'), proposal('b', ['2', '1'], 'sha256:x'), proposal('c', ['1'], 'sha256:y'), proposal('d', ['1', '2'])];
        expect(proposalIdsForParcelSet(proposals, 'sha256:x')).toEqual(['a', 'b']);
        expect(proposalIdsForParcelSet(proposals, '')).toEqual([]);
        expect(proposalIdsForParcelSet(null, 'sha256:x')).toEqual([]);
    });

    it('normalizes legacy cadastral ids without mutating the proposal', () => {
        const source = proposal('a', ['HR-3', 'HR-1', 'HR-3']);
        expect(normalizeParcelIds(source)).toEqual(['HR-1', 'HR-3']);
        expect(source.cadastreParcelIds).toEqual(['HR-3', 'HR-1', 'HR-3']);
    });

    it('recognizes exact canonical sets independent of parcel order', () => {
        const relation = classifyParcelSetRelation(
            proposal('a', ['HR-1', 'HR-2']),
            proposal('b', ['HR-2', 'HR-1'])
        );
        expect(relation).toMatchObject({ kind: 'same', sharedCount: 2, unionCount: 2, overlapRatio: 1 });
    });

    it('does not relate identical local ids across different jurisdictions', () => {
        const zagreb = { ...proposal('a', ['123/4']), city: 'zagreb' };
        const split = { ...proposal('b', ['123/4']), city: 'split' };
        expect(classifyParcelSetRelation(zagreb, split)).toBeNull();
    });

    it('distinguishes containing, contained and partial overlaps', () => {
        const target = proposal('target', ['1', '2', '3']);
        expect(classifyParcelSetRelation(target, proposal('larger', ['1', '2', '3', '4'])).kind)
            .toBe('contains-target');
        expect(classifyParcelSetRelation(target, proposal('smaller', ['1', '2'])).kind)
            .toBe('inside-target');
        expect(classifyParcelSetRelation(target, proposal('crossing', ['2', '3', '4'])).kind)
            .toBe('overlap');
        expect(classifyParcelSetRelation(target, proposal('elsewhere', ['9']))).toBeNull();
    });

    it('groups exact competitors first, then ranks overlaps by shared land', () => {
        const target = proposal('target', ['1', '2', '3']);
        const result = findParcelSetRelations(target, [
            proposal('partial-one', ['3', '8']),
            proposal('exact', ['3', '2', '1']),
            proposal('partial-two', ['2', '3', '9'])
        ]);
        expect(result.map(item => item.proposalId)).toEqual(['exact', 'partial-two', 'partial-one']);
    });

    it.each(['en', 'hr', 'sr', 'es'])('ships the parcel-set comparison vocabulary in %s', locale => {
        const dictionary = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${locale}.json`, import.meta.url), 'utf8'));
        expect(dictionary.panel.proposal.parcelSet).toMatchObject({
            eyebrow: expect.any(String), title: expect.any(String), summary: expect.stringContaining('{{count}}'),
            relationSame: expect.any(String), relationOverlap: expect.any(String), sharedCount: expect.any(String)
        });
    });
});
