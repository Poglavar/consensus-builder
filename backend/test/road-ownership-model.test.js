// Verify parcel categories and source owner-entry counts retain missing-evidence distinctions.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/road-ownership-model.js');
const classifyExistingOwnerLabel = label => {
    const value = String(label || '').toLowerCase();
    if (value.includes('grad') || value.includes('government') || value.includes('state')) return 'government';
    if (value.includes('school') || value.includes('institution')) return 'institution';
    if (value.includes('d.o.o') || value.includes('company')) return 'company';
    return 'private individual';
};

describe('RoadOwnershipModel.classifyParcel', () => {
    it('keeps missing and empty ownership lists distinct without inferring an owner', () => {
        expect(model.classifyParcel({})).toMatchObject({
            category: null, ownerEntryCount: null, ownershipEvidence: 'missing'
        });
        expect(model.classifyParcel({ type: 'Feature', properties: { ownershipList: [] } })).toMatchObject({
            category: null, ownerEntryCount: 0, ownershipEvidence: 'listed'
        });
    });

    it('uses an explicit modeled category even when the owner list is missing', () => {
        expect(model.classifyParcel({ type: 'Feature', properties: { ownershipType: 'government' } }))
            .toMatchObject({ category: 'government', categorySource: 'ownershipType', ownerEntryCount: null });
        expect(model.classifyParcel({ ownershipType: 'unknown' }))
            .toMatchObject({ category: null, categorySource: null });
    });

    it('classifies concrete owner entries through the supplied existing classifier', () => {
        const result = model.classifyParcel({ ownershipList: [
            { ownerLabel: 'Grad Zagreb' }, { name: 'Nekretnine d.o.o.' }
        ] }, classifyExistingOwnerLabel);
        expect(result).toMatchObject({
            category: 'mixed', categorySource: 'ownershipList', ownerEntryCount: 2,
            ownerEntryCategories: ['government', 'company']
        });
    });

    it('does not infer a category from a list containing no concrete labels', () => {
        expect(model.classifyParcel({ ownershipList: [{ ownerLabel: '' }] }))
            .toMatchObject({ category: null, ownerEntryCount: 1, ownerEntryCategories: [null] });
    });
});

describe('RoadOwnershipModel.summarize', () => {
    it('keeps known categories and entry counts while making the total unknown for missing lists', () => {
        const result = model.summarize([
            { ownershipType: 'company', ownershipList: ['Company A', 'Company B'] },
            { ownershipType: 'government' },
            { ownershipList: [] },
            {}
        ]);
        expect(result).toEqual({
            parcelCount: 4,
            categoryCounts: { individual: 0, company: 1, government: 1, institution: 0, mixed: 0 },
            unknownParcelCount: 2,
            knownOwnerEntryCount: 2,
            missingOwnerEvidenceParcelCount: 2,
            totalOwnerEntryCount: null
        });
    });

    it('returns a complete zero total when every source explicitly lists no entries', () => {
        expect(model.summarize([
            { ownershipList: [] },
            { type: 'Feature', properties: { ownershipList: [] } }
        ]))
            .toMatchObject({ knownOwnerEntryCount: 0, missingOwnerEvidenceParcelCount: 0, totalOwnerEntryCount: 0 });
    });
});
