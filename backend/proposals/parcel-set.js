import { createHash } from 'node:crypto';

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function cadastralAuthority(parcelIds = []) {
    if (parcelIds.length && parcelIds.every(id => String(id).startsWith('HR-'))) {
        return 'Croatian State Geodetic Administration';
    }
    return 'declared cadastral authority';
}

/** Stable identity for proposals that reference the same canonical cadastral land. */
export function buildParcelSet({
    parcelIds = [], jurisdiction = 'unknown', authority = null,
    referenceAt = null, geometryHash = null
} = {}) {
    const canonicalIds = Array.from(new Set(parcelIds.map(String).filter(Boolean))).sort();
    const resolvedAuthority = authority || cadastralAuthority(canonicalIds);
    const identity = { jurisdiction: jurisdiction || 'unknown', authority: resolvedAuthority, parcelIds: canonicalIds };
    return {
        ...identity,
        parcelCount: canonicalIds.length,
        referenceAt: referenceAt || null,
        geometryHash: geometryHash || null,
        setHash: `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
    };
}

export { canonicalJson };

