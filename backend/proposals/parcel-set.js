// Declared parcel-reference identity; source scope is explicit and never inferred from IDs.
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

/** Normalize the provider identity that qualifies declared parcel references. */
export function normalizeParcelSource(value) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('parcelSource must be an object or null');
    }
    if (Object.keys(value).some(key => !['sourceId', 'snapshotId'].includes(key))) {
        throw new TypeError('parcelSource may contain only sourceId and snapshotId');
    }
    const sourceId = optionalText(value.sourceId, 'parcelSource.sourceId');
    if (!sourceId) throw new TypeError('parcelSource.sourceId must be a nonempty string');
    const snapshotId = value.snapshotId === null || value.snapshotId === undefined
        ? null : optionalText(value.snapshotId, 'parcelSource.snapshotId');
    if (value.snapshotId !== null && value.snapshotId !== undefined && !snapshotId) {
        throw new TypeError('parcelSource.snapshotId must be a nonempty string or null');
    }
    return { sourceId, snapshotId };
}

/** Stable identity for the declared references and their explicitly supplied scope. */
export function buildParcelSet({
    parcelIds = [], jurisdiction = null, authority = null, parcelSource = null
} = {}) {
    const canonicalIds = Array.from(new Set(parcelIds.map(String).filter(Boolean))).sort();
    const normalizedSource = normalizeParcelSource(parcelSource);
    const normalizedJurisdiction = optionalText(jurisdiction, 'jurisdiction');
    const normalizedAuthority = optionalText(authority, 'authority');
    const identity = { parcelSource: normalizedSource, parcelIds: canonicalIds };
    return {
        ...identity,
        jurisdiction: normalizedJurisdiction,
        authority: normalizedAuthority,
        parcelCount: canonicalIds.length,
        setHash: `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
    };
}

export { canonicalJson };

