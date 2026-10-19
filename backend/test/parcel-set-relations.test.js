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

    it('normalizes the current cadastral declaration without mutating the proposal', () => {
        const source = proposal('a', ['HR-3', 'HR-1', 'HR-3']);
        expect(normalizeParcelIds(source)).toEqual(['HR-1', 'HR-3']);
        expect(source.cadastreParcelIds).toEqual(['HR-3', 'HR-1', 'HR-3']);
    });

    it('does not let stale parcel-set metadata replace the authored declaration', () => {
        const source = { ...proposal('a', ['current-1']), parcelSet: { parcelIds: ['stale-1'] } };
        expect(normalizeParcelIds(source)).toEqual(['current-1']);
        expect(normalizeParcelIds({ parcelSet: source.parcelSet })).toEqual([]);
        expect(classifyParcelSetRelation(source, proposal('b', ['stale-1']))).toBeNull();
    });

    it('classifies by declared references even when supplied hashes disagree with them', () => {
        expect(classifyParcelSetRelation(proposal('a', ['1', '2'], 'sha256:x'), proposal('b', ['1'], 'sha256:x')))
            .toMatchObject({ kind: 'inside-target', sharedCount: 1, targetCount: 2 });
        expect(classifyParcelSetRelation(proposal('a', ['1', '2'], 'sha256:x'), proposal('b', ['2', '1'], 'sha256:y')))
            .toMatchObject({ kind: 'same', sharedCount: 2, targetCount: 2 });
    });

    it('rejects an explicitly different authority even for equal declared IDs and hashes', () => {
        const a = proposal('a', ['1'], 'sha256:x'), b = proposal('b', ['1'], 'sha256:x');
        a.parcelSet.authority = 'register-a'; b.parcelSet.authority = 'register-b';
        expect(classifyParcelSetRelation(a, b)).toBeNull();
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

    it('groups equal declarations first, then ranks by shared reference count', () => {
        const target = proposal('target', ['1', '2', '3']);
        const result = findParcelSetRelations(target, [
            proposal('partial-one', ['3', '8']),
            proposal('exact', ['3', '2', '1']),
            proposal('partial-two', ['2', '3', '9'])
        ]);
        expect(result.map(item => item.proposalId)).toEqual(['exact', 'partial-two', 'partial-one']);
    });

    it('returns all loaded matches unless a display limit is explicitly requested', () => {
        const target = proposal('target', ['1']);
        const candidates = Array.from({ length: 15 }, (_, i) => proposal(`related-${i}`, ['1']));
        expect(findParcelSetRelations(target, candidates)).toHaveLength(15);
        expect(findParcelSetRelations(target, candidates, { limit: 12 })).toHaveLength(12);
    });

    it.each(['en', 'hr', 'sr', 'es'])('ships the parcel-set comparison vocabulary in %s', locale => {
        const dictionary = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${locale}.json`, import.meta.url), 'utf8'));
        expect(dictionary.panel.proposal.parcelSet).toMatchObject({
            eyebrow: expect.any(String), title: expect.any(String), summary: expect.stringContaining('{{count}}'),
            relationSame: expect.any(String), relationOverlap: expect.any(String), sharedCount: expect.any(String)
        });
    });
});
