// Parcel-identity + ownership helpers extracted from proposal-manager.js. Still browser globals
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
    const safeRoot = rawRoot
        ? (_extractRootParcelNumber(rawRoot) || rawRoot.replace(/\s+/g, ''))
        : null;
    const safeIndex = Number(index) || 1;
    return safeRoot ? `${safeRoot}#${token}-${safeIndex}` : `${token}-${safeIndex}`;
}

function _composeSyntheticParcelId(rootParcelId, token, index) {
    const rawRoot = (rootParcelId !== undefined && rootParcelId !== null && String(rootParcelId).trim().length)
        ? String(rootParcelId).trim()
        : null;
    const safeRoot = rawRoot
        ? (_extractRootParcelId(rawRoot) || rawRoot.replace(/\s+/g, ''))
        : null;
    const safeIndex = Number(index) || 1;
    return safeRoot ? `${safeRoot}#${token}-${safeIndex}` : `${token}-${safeIndex}`;
}

// NOTE: child parcel ids are assigned solely by the id subsystem (_assignSyntheticChildIdentities /
// getNextIdentity) from the current rules — deterministically derived from (proposalId → token,
// root parcel, running index). A proposal never carries a canonical id list to reproduce: if the
// geometry or the id rules change, children simply get different ids, and that is fine. The
// consensus layer (acceptance / sale / ownership transfer) is entirely parent-keyed, so child-id
// identity is a local concern of whichever apply produced them, not something to recreate.

function _escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _parseSyntheticIndexFromIdentifiers(parcelNumber, parcelId, token) {
    const normalizedToken = token ? _buildSyntheticToken(token) : null;

    const tryMatch = (value) => {
        if (!value) return null;
        const str = String(value);

        if (normalizedToken) {
            const escaped = _escapeRegExp(normalizedToken);
            const directMatch = str.match(new RegExp(`#${escaped}-(\\d+)$`));
            if (directMatch) {
                const parsed = Number(directMatch[1]);
                if (Number.isFinite(parsed)) return parsed;
            }
            // Legacy "/token/idx" form for back-compat
            const legacyMatch = str.match(new RegExp(`${escaped}/(\\d+)$`));
            if (legacyMatch) {
                const parsed = Number(legacyMatch[1]);
                if (Number.isFinite(parsed)) return parsed;
            }
            const legacyUnderscore = str.match(new RegExp(`${escaped}_(\\d+)$`));
            if (legacyUnderscore) {
                const parsed = Number(legacyUnderscore[1]);
                if (Number.isFinite(parsed)) return parsed;
            }
        }

        const hashGeneric = str.match(/#([^#]+)-(\d+)$/);
        if (hashGeneric) {
            const parsed = Number(hashGeneric[2]);
            if (Number.isFinite(parsed)) return parsed;
        }

        const tailNumeric = str.match(/(\d+)$/);
        if (tailNumeric) {
            const parsed = Number(tailNumeric[1]);
            if (Number.isFinite(parsed)) return parsed;
        }

        return null;
    };

    return tryMatch(parcelId) ?? tryMatch(parcelNumber);
}

/**
 * Client-generated parcel ids (subdivision, proposal chaining, government-roads splits)
 * must not be requested from the cadastre API. Kept aligned with focusProposalDetails /
 * findMissingParentParcels filtering.
 */
function isSyntheticParcelId(rawId) {
    if (rawId === undefined || rawId === null) return false;
    const id = String(rawId);
    if (!id) return false;
    if (id.includes('#')) return true;
    // Road subdivision token segment (hex), e.g. …_a1b2c3d4_…
    if (/_[0-9a-f]{4,}_/.test(id)) return true;
    // government-roads.js composeSyntheticParcelId: `${safeRoot}_${token}_${index}` — token is often
    // alphabetic (e.g. "proposal"), so the hex pattern above does not match.
    if (/^HR-\d+-\d+_[a-z0-9]+_\d+$/i.test(id)) return true;
    return false;
}

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
    const candidateOrder = [
        () => (typeof ensureParcelId === 'function' ? ensureParcelId({ properties: props }) : null),
        () => props.parcelId,
        () => props.parcel_id,
        () => props.id
    ];
    for (const getter of candidateOrder) {
        try {
            const value = getter();
            const normalized = _normalizeParcelId(value);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return null;
}

function _getParcelIdFromFeature(feature) {
    if (!feature) return null;
    if (typeof ensureParcelId === 'function') {
        try {
            const ensured = ensureParcelId(feature);
            const normalized = _normalizeParcelId(ensured);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return _getParcelIdFromProperties(feature.properties);
}

function _ensureParcelIdOnProperties(props, parcelId) {
    if (!props) return null;
    const resolved = _normalizeParcelId(parcelId) || _getParcelIdFromProperties(props);
    if (!resolved) return null;
    props.parcelId = resolved;
    return resolved;
}

function _normalizeOwnerRecord(owner, index, fallbackName) {
    const baseName = owner?.ownerLabel || owner?.name || owner?.possessorName || fallbackName || `Owner ${index + 1}`;
    const pct = Number.isFinite(owner?.percentageShare)
        ? owner.percentageShare
        : (Number.isFinite(owner?.percentage) ? owner.percentage : null);
    const shareText = owner?.actualShareText
        || owner?.ownership
        || owner?.shareText
        || (pct !== null ? `${pct}%` : '100%');

    return {
        name: baseName,
        ownerLabel: baseName,
        percentageShare: pct !== null ? pct : undefined,
        actualShareText: shareText,
        shareDetail: owner?.shareDetail || owner?.detail || ''
    };
}

function _extractOwnersFromProperties(props) {
    if (!props) return null;
    if (Array.isArray(props?.ownershipDetails?.owners) && props.ownershipDetails.owners.length) {
        return props.ownershipDetails.owners;
    }
    if (Array.isArray(props?.ownershipList) && props.ownershipList.length) {
        return props.ownershipList;
    }
    return null;
}

function _readOwnersFromCache(parcelId) {
    if (!parcelId) return null;
    try {
        const cache = (typeof window !== 'undefined' && window.ParcelsOwnershipUi && window.ParcelsOwnershipUi.parcelOwnerDataCache)
            ? window.ParcelsOwnershipUi.parcelOwnerDataCache
            : null;
        if (cache && typeof cache.get === 'function') {
            const owners = cache.get(parcelId);
            return Array.isArray(owners) && owners.length ? owners : null;
        }
    } catch (_) { /* ignore */ }
    return null;
}

function _getOwnershipTypeForOwners(owners) {
    if (!Array.isArray(owners) || owners.length === 0) return undefined;
    const classify = (typeof getOwnershipType === 'function')
        ? getOwnershipType
        : (typeof window !== 'undefined' && typeof window.getOwnershipType === 'function'
            ? window.getOwnershipType
            : null);
    if (!classify) return undefined;
    const types = owners.map(owner => classify(owner)).filter(Boolean);
    if (!types.length) return undefined;
    const unique = Array.from(new Set(types));
    return unique.length === 1 ? unique[0] : 'mixed';
}

function _assignOwnershipDetails(targetFeature, options = {}) {
    if (!targetFeature || typeof targetFeature !== 'object') return;
    const props = targetFeature.properties || (targetFeature.properties = {});
    const {
        parentFeature = null,
        defaultOwnerName = null,
        forceDefaultOwner = false,
        overwriteExisting = false
    } = options;

    const existingOwners = Array.isArray(props?.ownershipDetails?.owners) ? props.ownershipDetails.owners : null;
    const hasExisting = existingOwners && existingOwners.length > 0;
    if (hasExisting && !overwriteExisting && !forceDefaultOwner) {
        const normalizedOwners = existingOwners.map((owner, index) => _normalizeOwnerRecord(owner, index, defaultOwnerName));
        props.ownershipDetails = Object.assign({}, props.ownershipDetails, { owners: normalizedOwners });
        const existingType = _getOwnershipTypeForOwners(normalizedOwners);
        if (existingType && !props.ownershipType) {
            props.ownershipType = existingType;
        }
        return;
    }

    let ownersSource = null;

    if (!forceDefaultOwner) {
        ownersSource = _extractOwnersFromProperties(props);
        if ((!ownersSource || ownersSource.length === 0) && parentFeature) {
            const parentProps = parentFeature.properties || parentFeature;
            ownersSource = _extractOwnersFromProperties(parentProps);
            if (!ownersSource || ownersSource.length === 0) {
                const parentParcelId = _getParcelIdFromFeature(parentFeature) || _getParcelIdFromProperties(parentProps);
                ownersSource = _readOwnersFromCache(parentParcelId);
            }
        }
    }

    let owners = ownersSource;

    if ((!owners || owners.length === 0) && defaultOwnerName) {
        owners = [{
            name: defaultOwnerName,
            ownerLabel: defaultOwnerName,
            percentageShare: 100,
            actualShareText: '100%'
        }];
    }

    if (!owners || owners.length === 0) return;

    const normalizedOwners = owners.map((owner, index) => _normalizeOwnerRecord(owner, index, defaultOwnerName));
    props.ownershipDetails = Object.assign({}, props.ownershipDetails, { owners: normalizedOwners });

    const ownershipType = _getOwnershipTypeForOwners(normalizedOwners);
    if (ownershipType && !props.ownershipType) {
        props.ownershipType = ownershipType;
    }
}

// In the browser these are top-level globals resolved by sibling classic scripts. Under node they
// are only module-scoped, so publish them onto globalThis to mirror the browser — this is how the
// still-in-proposal-manager.js ProposalManager literal and methods see them by their bare names.
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, {
        _buildSyntheticToken,
        _composeSyntheticParcelNumber,
        _composeSyntheticParcelId,
        _escapeRegExp,
        _parseSyntheticIndexFromIdentifiers,
        isSyntheticParcelId,
        _normalizeParcelId,
        _getParcelIdFromProperties,
        _getParcelIdFromFeature,
        _ensureParcelIdOnProperties,
        _normalizeOwnerRecord,
        _extractOwnersFromProperties,
        _readOwnersFromCache,
        _getOwnershipTypeForOwners,
        _assignOwnershipDetails
    });
    module.exports = { _buildSyntheticToken, _composeSyntheticParcelId, _composeSyntheticParcelNumber };
}
