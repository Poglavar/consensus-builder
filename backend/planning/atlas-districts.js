// Public Atlas releases contain source districts, not the resolved Slices product.
// Only whole numeric literals with known units become dimensional inputs.
import { createHash } from 'node:crypto';
import { inspectNumericConstraint } from './atlas-audit.js';

export const atlasScenarios = ['family1', 'family2', 'family3', 'family4', 'accessory', 'plannedresidential'];
export const atlasDimensions = [
    ['frontsetbackft', 'frontSetback', 'ft', 'minimum'],
    ['sidesetbackft', 'sideSetback', 'ft', 'minimum'],
    ['rearsetbackft', 'rearSetback', 'ft', 'minimum'],
    ['maxheightft', 'height', 'ft', 'maximum'],
    ['minlotacres', 'lotArea', 'acres', 'minimum']
];
const names = ['1-Family', '2-Family', '3-Family', '4+-Family', 'Accessory', 'Planned Residential'];
const encoded = ['1F', '2F', '3F', '4F', 'AD', 'PRD'];
const treatments = { A: 'allowed', AH: 'hearing', P: 'prohibited', N: 'prohibited', O: 'overlay', NM: 'nomention',
    'Allowed/Conditional': 'allowed', 'Allowed': 'allowed', 'Allowed by Public Hearing': 'hearing',
    'Public Hearing': 'hearing', 'Prohibited': 'prohibited', 'Overlay': 'overlay', 'Not Mentioned': 'nomention' };
const labels = { frontsetbackft: 'Front Setback', sidesetbackft: 'Side Setback', rearsetbackft: 'Rear Setback',
    maxheightft: 'Max. Height', minlotacres: 'Min. Lot' };
const pick = (p, fields) => fields.find(field => Object.hasOwn(p, field));
const flag = value => value === true || ['yes', 'true', '1'].includes(String(value).toLowerCase()) ? true
    : value === false || ['no', 'false', '0'].includes(String(value).toLowerCase()) ? false : null;
const overlayOf = p => flag(p.overlay ?? p.Overlay ?? p.O);
const extinctOf = p => flag(p.extinct ?? p['District Mapped But Extinct']);
const knownTreatments = new Set(['allowed', 'hearing', 'prohibited', 'overlay', 'nomention']);

export function districtRecord(properties, featureIndex) {
    const p = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.trim(), value]));
    const jurisdiction = p.jurisdiction ?? p.Jurisdiction ?? p.T;
    const name = p.name ?? p['Full District Name'] ?? p['Full District or Sub-District Name'] ?? p.Z;
    const code = p.abbrvname || p['Abbreviated District Name'] || name;
    if (typeof jurisdiction !== 'string' || !jurisdiction.trim()
        || (!(typeof code === 'string' && code.trim()) && !Number.isSafeInteger(featureIndex))) {
        throw new Error('Invalid Atlas district identity');
    }
    const id = p.id ?? p.OBJECTID ?? createHash('sha256').update(JSON.stringify([jurisdiction, code, featureIndex])).digest('hex').slice(0, 24);
    const values = {}, numericEvidence = {};
    for (const [index, scenario] of atlasScenarios.entries()) {
        const treatment = p[`${scenario}_treatment`] ?? p[`${names[index]} Treatment`] ?? p[encoded[index]];
        values[`${scenario}_treatment`] = Object.hasOwn(treatments, treatment) ? treatments[treatment] : treatment ?? null;
        for (const [suffix, , unit] of atlasDimensions) {
            const canonical = `${scenario}_${suffix}`, label = `${names[index]} ${labels[suffix]}`;
            const legacy = suffix === 'minlotacres' ? `${label} (ACRES)` : `${label} (# of feet)`;
            const field = pick(p, [canonical, legacy, legacy.replace('Max.', 'Max').replace('Min.', 'Min'), label]);
            if (!field) { numericEvidence[canonical] = { status: 'absent' }; continue; }
            const evidence = inspectNumericConstraint(p, field, { product: 'districts' });
            if (field === canonical && p[`${field}_units`] && p[`${field}_units`] !== 'number') {
                numericEvidence[canonical] = { status: 'unparsed_expression', sourceField: field, valueKind: p[`${field}_units`] };
                continue;
            }
            const sourceUnit = field === label ? p[`${label} Units`] : unit;
            const factors = unit === 'ft' ? { ft: 1, feet: 1 } : { acres: 1, acre: 1, 'square feet': 1 / 43560, sqft: 1 / 43560 };
            const unitKey = typeof sourceUnit === 'string' ? sourceUnit.trim().toLowerCase() : '';
            const factor = Object.hasOwn(factors, unitKey) ? factors[unitKey] : undefined;
            numericEvidence[canonical] = { ...evidence, sourceField: field, sourceUnit: sourceUnit ?? null };
            if (evidence.value !== undefined) {
                if (factor === undefined) numericEvidence[canonical] = { status: 'unsupported_unit', sourceField: field, sourceUnit: sourceUnit ?? null };
                else {
                    values[canonical] = evidence.value * factor;
                    numericEvidence[canonical].value = values[canonical];
                }
            }
        }
    }
    return { id, jurisdiction, name, code, values, numericEvidence,
        applicability: { overlay: overlayOf(p), extinct: extinctOf(p), conflicts: [] } };
}

// Geometry and rule tables are two observations of the same district. A join cannot
// erase an overlay/withdrawal flag or choose a permission when the observations conflict.
export function reconcileDistrictRecord(record, geometryProperties, featureIndex) {
    if (!geometryProperties) return record;
    const geometry = districtRecord(geometryProperties, featureIndex);
    const conflicts = [];
    for (const field of ['overlay', 'extinct']) {
        const a = record.applicability[field], b = geometry.applicability[field];
        if (a !== null && b !== null && a !== b) conflicts.push({ field, rules: a, geometry: b });
        record.applicability[field] = a === true || b === true ? true : a ?? b;
    }
    for (const scenario of atlasScenarios) {
        const field = `${scenario}_treatment`, a = record.values[field], b = geometry.values[field];
        if (knownTreatments.has(a) && knownTreatments.has(b) && a !== b) conflicts.push({ field, rules: a, geometry: b });
    }
    record.applicability.conflicts = conflicts;
    return record;
}
