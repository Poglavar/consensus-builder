// Parcel-identity helpers extracted from proposal-manager.js. Still browser globals
// (classic script — top-level `function` declarations), required directly in node tests.

function _buildSyntheticToken(value, fallback = 'proposal') {
    const base = (value !== undefined && value !== null) ? String(value) : String(fallback || 'proposal');
    const sanitize = (raw) => String(raw || '')
        .trim()
        .replace(/#/g, '') // avoid colliding with the delimiter
        .replace(/\s+/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '');

    const sanitized = sanitize(base);
    const fallbackSanitized = sanitize(fallback || 'proposal') || 'proposal';
    return sanitized || fallbackSanitized;
}

function _composeSyntheticParcelNumber(rootNumber, token, index) {
    const rawRoot = (rootNumber !== undefined && rootNumber !== null && String(rootNumber).trim().length)
        ? String(rootNumber).trim()
        : null;
    const safeIndex = Number(index) || 1;
    return rawRoot ? `${rawRoot}#${token}-${safeIndex}` : `${token}-${safeIndex}`;
}

function _composeSyntheticParcelId(rootParcelId, token, index) {
    const rawRoot = (rootParcelId !== undefined && rootParcelId !== null && String(rootParcelId).trim().length)
        ? String(rootParcelId).trim()
        : null;
    const safeIndex = Number(index) || 1;
    return rawRoot ? `${rawRoot}#${token}-${safeIndex}` : `${token}-${safeIndex}`;
}

// NOTE: child parcel ids are assigned solely by the id subsystem (_assignSyntheticChildIdentities /
// getNextIdentity) from the current rules — deterministically derived from (proposalId → token,
// root parcel, running index). A proposal never carries a canonical id list to reproduce: if the
// geometry or the id rules change, children simply get different ids, and that is fine. The
// consensus layer (acceptance / sale / ownership transfer) is entirely parent-keyed, so child-id
// identity is a local concern of whichever apply produced them, not something to recreate.

function _normalizeParcelId(value) {
    if (value === undefined || value === null) return null;
    try {
        return value.toString();
    } catch (_) {
        return String(value);
    }
}

function _getParcelIdFromProperties(props) {
    if (!props) return null;
    const candidates = [props.parcelId, props.parcel_id, props.id];
    for (const value of candidates) {
        try {
            const normalized = _normalizeParcelId(value);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return null;
}

function _getParcelIdFromFeature(feature) {
    if (!feature) return null;
    return _getParcelIdFromProperties(feature.properties);
}

function _ensureParcelIdOnProperties(props, parcelId) {
    if (!props) return null;
    const resolved = _normalizeParcelId(parcelId) || _getParcelIdFromProperties(props);
    if (!resolved) return null;
    props.parcelId = resolved;
    return resolved;
}

// In the browser these are top-level globals resolved by sibling classic scripts. Under node they
// are only module-scoped, so publish them onto globalThis to mirror the browser — this is how the
// still-in-proposal-manager.js ProposalManager literal and methods see them by their bare names.
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, {
        _buildSyntheticToken,
        _composeSyntheticParcelNumber,
        _composeSyntheticParcelId,
        _normalizeParcelId,
        _getParcelIdFromProperties,
        _getParcelIdFromFeature,
        _ensureParcelIdOnProperties
    });
    module.exports = { _buildSyntheticToken, _composeSyntheticParcelId, _composeSyntheticParcelNumber };
}
