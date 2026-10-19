// Declared parcel-reference identity; source authority and survey dates are never inferred from IDs.
import { createHash } from 'node:crypto';

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function optionalText(value, field) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`);
    return value.trim() || null;
}

/** Stable identity for the declared references and their explicitly supplied scope. */
export function buildParcelSet({
    parcelIds = [], jurisdiction = null, authority = null
} = {}) {
    const canonicalIds = Array.from(new Set(parcelIds.map(String).filter(Boolean))).sort();
    const identity = { jurisdiction: optionalText(jurisdiction, 'jurisdiction'), authority: optionalText(authority, 'authority'), parcelIds: canonicalIds };
    return {
        ...identity,
        parcelCount: canonicalIds.length,
        setHash: `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
    };
}

export { canonicalJson };

