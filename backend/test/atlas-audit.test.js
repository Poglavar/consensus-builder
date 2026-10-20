// Source-evidence safeguards: summarized/conditional Atlas values must not silently become exact rules.
import { describe, expect, it } from 'vitest';
import { atlasInventory, auditAtlasCollection, inspectNumericConstraint } from '../planning/atlas-audit.js';

const numeric = (value, method) => inspectNumericConstraint({ cap: value, cap_method: method }, 'cap');
const collection = properties => ({ type: 'FeatureCollection', features: properties.map(p => ({ type: 'Feature', geometry: null, properties: p })) });
const directDimensions = () => Object.fromEntries(['frontsetbackft', 'sidesetbackft', 'rearsetbackft', 'maxheightft']
    .flatMap(suffix => [[`family1_${suffix}`, 10], [`family1_${suffix}_method`, 'direct_number']]));

describe('numeric source evidence', () => {
    it('preserves a real zero instead of confusing it with missing evidence', () => {
        expect(numeric(0, 'direct_number')).toEqual({ status: 'direct', value: 0 });
        expect(numeric(null, 'direct_number')).toEqual({ status: 'missing' });
        expect(inspectNumericConstraint({}, 'cap')).toEqual({ status: 'absent' });
    });
    it('keeps estimation, indeterminate and not-applicable distinct', () => {
        expect(numeric(27, 'estimation')).toEqual({ status: 'estimated', value: 27 });
        expect(numeric(-1, 'indeterminate')).toEqual({ status: 'indeterminate' });
        expect(numeric(null, 'not_applicable')).toEqual({ status: 'not_applicable' });
    });
    it.each([
        [-1, 'direct_number', 'invalid'], [10, 'indeterminate', 'inconsistent'],
        [0, 'not_applicable', 'inconsistent'], [null, 'indeterminate', 'inconsistent'],
        [10, 'new_method', 'unsupported_method'], ['10', 'direct_number', 'invalid'],
        [Infinity, 'direct_number', 'invalid'], [NaN, 'estimation', 'invalid'],
        [false, 'direct_number', 'invalid'], [10, null, 'method_missing']
    ])('does not accept %s with %s as direct evidence', (value, method, status) => {
        expect(numeric(value, method)).toEqual({ status });
    });
    it('does not assume that a missing method means direct', () => {
        expect(inspectNumericConstraint({ cap: 10 }, 'cap')).toEqual({ status: 'method_missing' });
    });
    it.each(['45/arterial; 35/collector; 25/local', '27; 35/public hearing', '135% of base', '650; 750/elderly'])('retains an unresolved expression: %s', expression => {
        expect(inspectNumericConstraint({ cap: expression }, 'cap', { product: 'districts' })).toEqual({ status: 'unparsed_expression' });
    });
    it('recognizes a district numeric literal without claiming its context is resolved', () => {
        expect(inspectNumericConstraint({ cap: '2.5' }, 'cap', { product: 'districts' })).toEqual({ status: 'literal', value: 2.5 });
        expect(inspectNumericConstraint({ cap: false }, 'cap', { product: 'districts' })).toEqual({ status: 'invalid' });
        expect(inspectNumericConstraint({ cap: '9'.repeat(400) }, 'cap', { product: 'districts' }).status).toBe('unparsed_expression');
    });
});

describe('collection audit', () => {
    it('detects unknown schema keys and distinguishes absence from null', () => {
        const result = auditAtlasCollection(collection([{ family1_maxheightft: null, new_rule: 12, ...JSON.parse('{"__proto__": 1}') }, {}]));
        expect({ ...result.unknownFields }).toEqual({ new_rule: 1, ...JSON.parse('{"__proto__": 1}') });
        expect(result.fields.family1_maxheightft).toEqual({ present: 1, absent: 1, null: 1 });
        expect(result.absentFromAllFeatures).toContain('affordable_treatment');
        expect(result.numericEvidence.family1_maxheightft).toEqual({ method_missing: 1, absent: 1 });
        expect(JSON.stringify(result)).not.toContain('"new_rule":12');
    });
    it('does not mistake hearing, overlay, nomention, absent use or estimated dimensions for a by-right dimensional match', () => {
        const rows = ['allowed', 'hearing', 'overlay', 'nomention', 'prohibited', undefined].map(treatment => ({ ...directDimensions(), ...(treatment ? { family1_treatment: treatment } : {}) }));
        rows.push({ ...directDimensions(), family1_treatment: 'allowed', family1_maxheightft_method: 'estimation' });
        const result = auditAtlasCollection(collection(rows));
        expect(result.family1DimensionalScreen.directDimensions).toBe(6);
        expect(result.family1DimensionalScreen.allowedWithDirectDimensions).toBe(1);
        expect(result.numericEvidence.family1_maxheightft).toEqual({ direct: 6, estimated: 1 });
        expect(result.treatmentCounts.family1_treatment).toEqual({ allowed: 2, hearing: 1, overlay: 1, nomention: 1, prohibited: 1 });
        expect(result.family1DimensionalScreen).not.toHaveProperty('legal');
    });
    it('does not treat district strings as normalized slice measurements', () => {
        const result = auditAtlasCollection(collection([{ family1_frontsetbackft: '25/local; 45/arterial' }]), { product: 'districts' });
        expect(result.observedDocumentedFieldCount).toBe(1);
        expect(result).not.toHaveProperty('family1DimensionalScreen');
    });
    it('rejects an unsupported product or malformed feature collection', () => {
        expect(() => auditAtlasCollection(collection([]), { product: 'unknown' })).toThrow('Unknown Atlas product');
        expect(() => auditAtlasCollection(collection([]), { product: '__proto__' })).toThrow('Unknown Atlas product');
        expect(() => auditAtlasCollection([])).toThrow('FeatureCollection');
        expect(() => auditAtlasCollection({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: null }] })).toThrow('Feature 0');
    });
    it('covers both complete dictionary snapshots without duplicate field names', () => {
        expect(atlasInventory.products.districts.fields).toHaveLength(126);
        expect(atlasInventory.products.slices.fields).toHaveLength(185);
        for (const { fields } of Object.values(atlasInventory.products)) {
            expect(new Set(fields.map(entry => entry.field)).size).toBe(fields.length);
            expect(new Set(fields.map(entry => entry.family)).size).toBeGreaterThan(20);
        }
    });
});
