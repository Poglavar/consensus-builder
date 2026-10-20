// Inspect Atlas schema coverage and numeric evidence without converting zoning areas into parcels
// or treating a summarized value as an executable planning rule. This module never imports proposals.
import { readFileSync } from 'node:fs';

export const atlasInventory = JSON.parse(readFileSync(new URL('./atlas-field-inventory.json', import.meta.url), 'utf8'));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const methods = new Set(['direct_number', 'estimation', 'indeterminate', 'not_applicable']);
const treatments = new Set(['allowed', 'hearing', 'prohibited', 'overlay', 'nomention']);

// District strings can contain conditions/formulas. Parsing a numeric prefix loses the rule.
function literalNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return null;
    const number = Number(value.trim());
    return Number.isFinite(number) ? number : null;
}

export function inspectNumericConstraint(properties, field, { product = 'slices' } = {}) {
    if (!['districts', 'slices'].includes(product)) throw new Error(`Unknown Atlas product: ${product}`);
    if (!own(properties, field)) return { status: 'absent' };
    const raw = properties[field];
    if (product === 'districts') {
        if (raw === null || raw === '') return { status: 'missing' };
        const value = literalNumber(raw);
        if (value !== null && value >= 0) return { status: 'literal', value };
        return { status: typeof raw === 'string' ? 'unparsed_expression' : 'invalid' };
    }
    const method = properties[`${field}_method`];
    if (!own(properties, `${field}_method`) || method === null) return { status: 'method_missing' };
    if (!methods.has(method)) return { status: 'unsupported_method' };
    if (method === 'not_applicable') return { status: raw === null ? 'not_applicable' : 'inconsistent' };
    if (method === 'indeterminate') return { status: raw === -1 ? 'indeterminate' : 'inconsistent' };
    if (raw === null) return { status: 'missing' };
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return { status: 'invalid' };
    return { status: method === 'direct_number' ? 'direct' : 'estimated', value: raw };
}

function increment(counts, key) {
    counts[key] = (counts[key] || 0) + 1;
}

export function auditAtlasCollection(collection, { product = 'slices' } = {}) {
    const schema = own(atlasInventory.products, product) ? atlasInventory.products[product] : null;
    if (!schema) throw new Error(`Unknown Atlas product: ${product}`);
    if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error('Expected an Atlas GeoJSON FeatureCollection');
    }
    const known = new Set(schema.fields.map(entry => entry.field));
    const numericFields = schema.fields.filter(entry => entry.field.endsWith('_method')).map(entry => entry.field.slice(0, -7));
    const fields = Object.fromEntries(schema.fields.map(({ field }) => [field, { present: 0, absent: 0, null: 0 }]));
    const families = {};
    for (const entry of schema.fields) increment(families, entry.family);
    const unknownFields = Object.create(null);
    const numericEvidence = {};
    const methodCounts = {};
    const treatmentCounts = {};
    const dimensions = ['frontsetbackft', 'sidesetbackft', 'rearsetbackft', 'maxheightft'].map(suffix => `family1_${suffix}`);
    let directDimensions = 0;
    let allowedWithDirectDimensions = 0;
    for (const [index, feature] of collection.features.entries()) {
        const p = feature?.properties;
        if (feature?.type !== 'Feature' || !p || typeof p !== 'object' || Array.isArray(p)) {
            throw new Error(`Feature ${index} has no properties object`);
        }
        for (const field of Object.keys(p)) {
            if (!known.has(field)) increment(unknownFields, field);
        }
        for (const { field } of schema.fields) {
            if (!own(p, field)) fields[field].absent++;
            else {
                fields[field].present++;
                if (p[field] === null) fields[field].null++;
                if (field.endsWith('_method')) increment(methodCounts, methods.has(p[field]) ? p[field] : 'unknown');
                if (field.endsWith('_treatment')) {
                    treatmentCounts[field] ||= {};
                    increment(treatmentCounts[field], treatments.has(p[field]) ? p[field] : p[field] === null ? 'null' : 'unknown');
                }
            }
        }
        for (const field of numericFields) {
            numericEvidence[field] ||= {};
            increment(numericEvidence[field], inspectNumericConstraint(p, field).status);
        }
        if (product === 'slices' && dimensions.every(field => inspectNumericConstraint(p, field).status === 'direct')) {
            directDimensions++;
            if (p.family1_treatment === 'allowed') allowedWithDirectDimensions++;
        }
    }
    return {
        schemaVersion: 1,
        purpose: 'Schema and source-evidence audit only; no parcel, geometry or legal-compliance certification.',
        product,
        dictionaryUrl: schema.dictionaryUrl,
        dictionaryHtmlSha256: schema.htmlSha256,
        featureCount: collection.features.length,
        documentedFieldCount: schema.fields.length,
        observedDocumentedFieldCount: Object.values(fields).filter(field => field.present > 0).length,
        absentFromAllFeatures: schema.fields.filter(({ field }) => fields[field].present === 0).map(({ field }) => field),
        unknownFields,
        families,
        fields,
        methodCounts,
        treatmentCounts,
        numericEvidence,
        ...(product === 'slices' ? { family1DimensionalScreen: {
            fields: dimensions,
            directDimensions,
            allowedWithDirectDimensions,
            limitation: 'Even a match needs parcel boundaries, classified edges, applicable source rules and other constraints before envelope generation.'
        } } : {})
    };
}
