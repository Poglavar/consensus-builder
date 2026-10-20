// Pure aggregation for the ownership evidence used by road-drawing statistics.
// Owner-list entries are source entries, not verified people or unique parties.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RoadOwnershipModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const CATEGORIES = Object.freeze(['individual', 'company', 'government', 'institution', 'mixed']);

    function propertiesOf(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
        return input.type === 'Feature' && input.properties && typeof input.properties === 'object'
            ? input.properties
            : input;
    }

    function knownCategoryOf(value) {
        if (typeof value !== 'string') return null;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'mixed') return 'mixed';
        if (['individual', 'private individual', 'private', 'person'].includes(normalized)) return 'individual';
        if (['company', 'business', 'corporation'].includes(normalized)) return 'company';
        if (['government', 'governmental', 'city', 'state', 'public', 'public body'].includes(normalized)) return 'government';
        if (['institution', 'university', 'school', 'hospital', 'church'].includes(normalized)) return 'institution';

        return null;
    }

    function classifyConcreteOwnerLabel(value) {
        if (typeof value !== 'string') return null;
        const normalized = value.trim().toLowerCase();
        if (!normalized) return null;
        const known = knownCategoryOf(normalized);
        if (known) return known;
        // Match the road editor's existing category keywords for concrete owner labels. A
        // nonempty owner entry that has
        // no recognized organization marker follows the editor's existing individual default.
        if (normalized.includes('gov') || normalized.includes('state') || normalized.includes('city')
            || normalized.includes('municip')) return 'government';
        if (normalized.includes('institution') || normalized.includes('university') || normalized.includes('school')
            || normalized.includes('hospital') || normalized.includes('church')) return 'institution';
        if (normalized.includes('company') || normalized.includes('business') || normalized.includes('corp')
            || normalized.includes('llc') || normalized.includes('gmbh') || normalized.includes('d.o.o')
            || normalized.includes('d.d') || normalized.includes('inc') || normalized.includes(' sa')
            || normalized.includes('spa')) return 'company';
        return 'individual';
    }

    function ownerLabel(entry) {
        if (typeof entry === 'string') return entry.trim();
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
        const label = typeof entry.ownerLabel === 'string' ? entry.ownerLabel
            : (typeof entry.name === 'string' ? entry.name : '');
        return label.trim();
    }

    function classifyParcel(input, classifyOwnerLabel) {
        const properties = propertiesOf(input);
        const explicitCategory = knownCategoryOf(properties.ownershipType);
        const hasOwnerList = Array.isArray(properties.ownershipList);
        const entries = hasOwnerList ? properties.ownershipList : null;
        const entryCategories = hasOwnerList
            ? entries.map(entry => {
                const label = ownerLabel(entry);
                if (!label) return null;
                const classified = typeof classifyOwnerLabel === 'function'
                    ? classifyOwnerLabel(label)
                    : classifyConcreteOwnerLabel(label);
                return knownCategoryOf(typeof classified === 'string' ? classified : '');
            })
            : null;

        let category = explicitCategory;
        let categorySource = explicitCategory ? 'ownershipType' : null;
        if (!category && entryCategories && entryCategories.length > 0
            && entryCategories.every(value => value !== null)) {
            const distinct = Array.from(new Set(entryCategories));
            category = distinct.length === 1 ? distinct[0] : 'mixed';
            categorySource = 'ownershipList';
        }

        return {
            category,
            categorySource,
            ownerEntryCount: hasOwnerList ? entries.length : null,
            ownerEntryCategories: entryCategories,
            ownershipEvidence: hasOwnerList ? 'listed' : 'missing'
        };
    }

    function summarize(parcels, classifyOwnerLabel) {
        const list = Array.isArray(parcels) ? parcels : [];
        const categoryCounts = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
        let unknownParcelCount = 0;
        let knownOwnerEntryCount = 0;
        let missingOwnerEvidenceParcelCount = 0;
        let allOwnerListsPresent = true;

        list.forEach(parcel => {
            const result = classifyParcel(parcel, classifyOwnerLabel);
            if (result.category) categoryCounts[result.category] += 1;
            else unknownParcelCount += 1;
            if (result.ownerEntryCount === null) {
                allOwnerListsPresent = false;
                missingOwnerEvidenceParcelCount += 1;
            } else {
                knownOwnerEntryCount += result.ownerEntryCount;
            }
        });

        return {
            parcelCount: list.length,
            categoryCounts,
            unknownParcelCount,
            knownOwnerEntryCount,
            missingOwnerEvidenceParcelCount,
            totalOwnerEntryCount: allOwnerListsPresent ? knownOwnerEntryCount : null
        };
    }

    return Object.freeze({ CATEGORIES, classifyParcel, summarize });
});
