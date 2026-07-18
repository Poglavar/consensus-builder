// proposals/core.js — shared low-level helpers used across the proposals subsystem:
// cloning, escaping, formatting, color, URL/base helpers, parcel-feature cache, small predicates.
// Extracted from proposals.js (pure relocation).

function isLocalProposalId(value) {
    if (value === undefined || value === null) return false;
    const str = String(value);
    return str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop');
}

function parseOwnerShareFraction(shareText = '') {
    const raw = (shareText || '').trim();
    if (!raw) return 1;
    if (raw.endsWith('%')) {
        const pct = parseFloat(raw.slice(0, -1));
        if (Number.isFinite(pct)) return Math.max(0, pct) / 100;
    }
    if (raw.includes('/')) {
        const [a, b] = raw.split('/').map(v => parseFloat(v.trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
            return Math.max(0, a / b);
        }
    }
    const num = parseFloat(raw);
    if (Number.isFinite(num)) {
        // Treat 0-1 as fraction, >1 as already a ratio of 1 (e.g., "100" means 100x, clamp to 1)
        if (num > 1) {
            return num > 100 ? 1 : num / 100;
        }
        return Math.max(0, num);
    }
    return 1;
}

function normalizeFeature(feature) {
    if (!feature || typeof feature !== 'object') return feature;
    ensureParcelIdOnFeature(feature);
    return feature;
}

function setParcelInfoPanelTitle(titleText, options = {}) {
    const panel = document.getElementById('parcel-info-panel');
    if (!panel) return;
    const titleEl = panel.querySelector('h3');
    if (!titleEl) return;
    const { i18nKey = null, i18nParams = null } = options;
    if (i18nKey) {
        titleEl.setAttribute('data-i18n-key', i18nKey);
        if (i18nParams) {
            titleEl.setAttribute('data-i18n-params', JSON.stringify(i18nParams));
        } else {
            titleEl.removeAttribute('data-i18n-params');
        }
    } else {
        titleEl.removeAttribute('data-i18n-key');
        titleEl.removeAttribute('data-i18n-params');
    }
    titleEl.textContent = titleText;
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
        try { window.i18n.applyTranslations(titleEl); } catch (_) { /* ignore */ }
    }
}

function tParcelMulti(key, params = {}, fallback = '') {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    // simple template replacement for fallback
    return String(fallback || key || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (params && k in params) ? params[k] : m);
}

function flattenObject(node, prefix = '', out = {}) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
    Object.entries(node).forEach(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenObject(value, path, out);
        } else {
            out[path] = value;
        }
    });
    return out;
}

function showProposalAlertMessage(key, fallback, params = {}, alertOptions = {}) {
    const translate = getProposalI18nHelper();
    const message = translate(`alerts.messages.${key}`, fallback, params);
    if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
        window.showStyledAlert(message, alertOptions);
    } else {
        alert(message);
    }
    return message;
}

// Does at least one replacement slice of this parent actually exist ON THIS DEVICE?
//
// Slice ids are derived from the parent (`<parent>#p-<proposalId>-N`, legacy `<parent>_N`), so a
// live child is a key in the parcel-layer index carrying one of those prefixes.
function hasLiveReplacementSlice(idStr) {
    const layerIndex = (typeof window !== 'undefined' && window.parcelLayerById instanceof Map)
        ? window.parcelLayerById
        : null;
    // Cannot verify (index not up yet) — keep the pre-guard behaviour and treat it as replaced.
    if (!layerIndex) return true;

    const derivedPrefix = idStr + '#p-';
    const legacyPrefix = idStr + '_';
    for (const key of layerIndex.keys()) {
        if (typeof key === 'string' && (key.startsWith(derivedPrefix) || key.startsWith(legacyPrefix))) {
            return true;
        }
    }
    return false;
}

function isParcelReplacedByChildren(parcelId) {
    if (!parcelId) return false;
    const idStr = String(parcelId);

    // Descendant parcels (carrying ancestorProposal) are themselves never hidden — they
    // are the result of a previous apply and must remain visible.
    const record = readPersistedParcelRecord(idStr);
    if (record && record.properties && record.properties.ancestorProposal) {
        return false;
    }

    if (typeof proposalStorage === 'undefined') return false;
    if (!proposalStorage.isParcelAncestorOfAppliedProposal(idStr)) return false;

    // A parent is only really replaced once a replacement slice actually exists here. Slice ids
    // drift between devices, and a shared proposal arrives already marked applied with the
    // SENDER's childParcelIds — so on a receiving browser this predicate would otherwise report
    // "replaced" for a parent whose children were never (re)generated locally. Every consumer
    // then drops that parent: the shared-link fetcher skips fetching it, the recovery paths
    // refuse to rebuild it, ingest leaves it off the map. The proposal still draws (its visuals
    // are interactive:false and come from proposal data), leaving a parcel-shaped hole with
    // nothing to click — "visible but not clickable".
    //
    // This check used to live in ingest.js alone, which desynchronised the call sites: ingest kept
    // the parent while every other consumer still dropped it. It belongs in the predicate, so all
    // of them agree on one answer.
    return hasLiveReplacementSlice(idStr);
}

function getProposalAreaMap(proposal) {
    if (!proposal) return { areaMap: new Map(), totalArea: 0 };

    const cacheKey = getProposalKey(proposal) || proposal.proposalId || JSON.stringify(proposal.parentParcelIds || []);
    if (cacheKey && proposalAreaCache.has(cacheKey)) {
        return proposalAreaCache.get(cacheKey);
    }

    const areaMap = new Map();
    let totalArea = 0;
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];

    parcelIds.forEach(id => {
        const key = id?.toString ? id.toString() : String(id || '');
        if (!key) return;

        let area = 0;

        // Prefer cached proposal feature data (no map hydration)
        const cached = getCachedParcelFeature(key, proposal);
        const props = cached?.properties;
        if (props) {
            area = Number(props.calculatedArea || props.area || props.parcelArea || 0) || 0;
        }

        // Fallback to persisted properties
        if (!area) {
            try {
                const record = readPersistedParcelRecord(key);
                const storedProps = record?.properties || null;
                if (storedProps) {
                    area = Number(storedProps.calculatedArea || storedProps.area || storedProps.parcelArea || 0) || 0;
                }
            } catch (_) { }
        }

        // Final fallback: treat as unit area to avoid zero totals
        if (!area) {
            area = 1;
        }

        areaMap.set(key, area);
        totalArea += area;
    });

    const result = { areaMap, totalArea };
    if (cacheKey) {
        proposalAreaCache.set(cacheKey, result);
    }
    return result;
}

function resolveProposalIdKey(idOrHash) {
    if (idOrHash === undefined || idOrHash === null || typeof proposalStorage === 'undefined') {
        return null;
    }
    if (typeof proposalStorage._resolveProposalId === 'function') {
        const resolved = proposalStorage._resolveProposalId(idOrHash);
        if (resolved !== null && resolved !== undefined) {
            return resolved;
        }
    }
    return String(idOrHash);
}

function updateParcelNumberFilterForProposal(ids) {
    proposalHighlightState.activeParcelIds = ids ? new Set(Array.from(ids)) : new Set();
    if (typeof setParcelNumberLabelFilter === 'function') {
        if (proposalHighlightState.activeParcelIds.size > 0) {
            setParcelNumberLabelFilter(proposalHighlightState.activeParcelIds);
        } else {
            setParcelNumberLabelFilter(null);
        }
    }
}

function isCameraMovementSuppressed() {
    try { return !!(window && window.suppressCameraMoves); } catch (_) { return false; }
}

function getProposalFeatureCacheKey(proposal) {
    if (!proposal) return null;
    if (typeof getProposalKey === 'function') {
        const key = getProposalKey(proposal);
        if (key) return key;
    }
    return proposal.proposalId || null;
}

function buildProposalFeatureCache(proposal) {
    if (!proposal) return null;
    const cacheKey = getProposalFeatureCacheKey(proposal);
    if (cacheKey && proposalFeatureCache.has(cacheKey)) {
        const existing = proposalFeatureCache.get(cacheKey);
        // Check if parentParcelIds changed (not parentFeatures - we don't cache those)
        const existingParentIds = Array.isArray(existing?.parentParcelIds) ? existing.parentParcelIds : [];
        const currentParentIds = Array.isArray(proposal?.roadProposal?.parentParcelIds) ? proposal.roadProposal.parentParcelIds : [];
        const parentIdsChanged = existingParentIds.length !== currentParentIds.length ||
            !existingParentIds.every((id, i) => String(id) === String(currentParentIds[i]));
        if (!parentIdsChanged) {
            return existing;
        }
        proposalFeatureCache.delete(cacheKey);
    }

    const parcelsById = new Map();
    const parentFeatures = [];

    const addFeaturesToCache = (features, targetList, defaultSource) => {
        if (!Array.isArray(features)) return;
        features.forEach(feature => {
            const normalised = normaliseToFeature(feature, defaultSource ? { source: defaultSource } : {});
            if (!normalised || !normalised.geometry) return;
            const parcelId = getParcelIdFromFeature(normalised);
            if (parcelId) {
                parcelsById.set(parcelId.toString(), normalised);
            }
            targetList.push(normalised);
        });
    };

    // Prefer proposal-provided road assets (parent features)
    const roadAssets = loadRoadAssetsForCache(proposal);
    addFeaturesToCache(roadAssets.parentFeatures, parentFeatures, 'road-parent');

    // Cache any other parcels listed on the proposal (e.g., building proposals)
    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    parcelIds.forEach(parcelId => {
        const key = parcelId && parcelId.toString ? parcelId.toString() : (parcelId ? String(parcelId) : null);
        if (!key || parcelsById.has(key)) {
            return;
        }
        // Only index placeholders here; actual feature resolution happens lazily
        parcelsById.set(key, parcelsById.get(key) || null);
    });

    const cacheValue = { parcelsById, parentFeatures, childFeatures: [] };
    if (cacheKey) {
        proposalFeatureCache.set(cacheKey, cacheValue);
    }
    return cacheValue;
}

function getCachedParcelFeature(parcelId, proposal) {
    if (!parcelId || !proposal) return null;
    const cache = buildProposalFeatureCache(proposal);
    if (!cache || !cache.parcelsById) return null;
    const key = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
    const cached = cache.parcelsById.get(key);
    if (cached && cached.geometry) {
        const clone = cloneGeoJSONFeature(cached);
        return clone || cached;
    }
    return null;
}

function resolveProposalParcelsInViewport(proposalIdSet /* , proposal */) {
    const out = [];
    forEachProposalParcelInViewport(proposalIdSet, (layer) => {
        if (!layer || typeof layer.toGeoJSON !== 'function') return;
        try {
            const feature = layer.toGeoJSON();
            if (feature) out.push(feature);
        } catch (_) { /* ignore */ }
    });
    return out;
}

function getFeatureByParcelId(features, parcelId) {
    if (!Array.isArray(features) || !parcelId) return null;
    const target = parcelId.toString();
    return features.find(f => {
        const id = getParcelIdFromFeature(f);
        return id && id.toString() === target;
    }) || null;
}

function getProposalColor(hash) {
    // Simple hash to color mapping
    let sum = 0;
    for (let i = 0; i < hash.length; i++) sum += hash.charCodeAt(i);
    return PROPOSAL_COLORS[sum % PROPOSAL_COLORS.length];
}

function blendColors(colors) {
    // Simple average RGB blend
    if (colors.length === 1) return colors[0];
    let r = 0, g = 0, b = 0;
    colors.forEach(hex => {
        const c = hex.replace('#', '');
        r += parseInt(c.substring(0, 2), 16);
        g += parseInt(c.substring(2, 4), 16);
        b += parseInt(c.substring(4, 6), 16);
    });
    r = Math.floor(r / colors.length);
    g = Math.floor(g / colors.length);
    b = Math.floor(b / colors.length);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function openProposalFromList(proposalIdOrHash, options = {}) {
    if (!proposalIdOrHash || typeof proposalStorage === 'undefined') {
        return false;
    }

    const normalized = options && typeof options === 'object' ? options : {};
    const proposal = normalized.proposal || getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        updateStatus('Proposal not found');
        return false;
    }

    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    const fallbackParcel = normalized.parcelId
        || getFirstSelectableParcel(proposal)
        || (parcelIds.length > 0 ? parcelIds[0] : null);

    if (normalized.closeAgentDialog !== false && typeof closeAgentDialog === 'function') {
        closeAgentDialog();
    }

    if (normalized.closeParcelInfo !== false && typeof hideParcelInfoPanel === 'function') {
        hideParcelInfoPanel();
    }

    if (normalized.closeProposalList !== false) {
        closeProposalList({ clearHighlights: false });
    }

    if (normalized.collapseSidebar) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
            try { toggleSidebar(); } catch (_) { }
        }
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);

    focusProposalDetails(proposalKey, {
        parcelId: fallbackParcel,
        centerOnProposal: normalized.centerOnProposal !== false,
        showDetails: normalized.showDetails !== false
    });

    return true;
}

function resolveProposalActionTypeKey(proposal, fallbackProposal) {
    return resolveProposalGoalKey(proposal, fallbackProposal);
}

function getCorrectClickHandler() {
    // Always allow normal parcel clicking; proposals display should never block interactions
    // Fallback to the global handler if the original has not been captured yet
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    // Ensure we always return a function to avoid Leaflet listener errors
    return (typeof originalOnParcelClick === 'function')
        ? originalOnParcelClick
        : (typeof window !== 'undefined' && typeof window.onParcelClick === 'function'
            ? window.onParcelClick
            : function () { });
}

function focusParcelInMap(parcelId) {
    if (!parcelId || typeof map === 'undefined' || !map) return;
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection.findParcelById) return;

    try {
        const layer = multiParcelSelection.findParcelById(parcelId);
        if (!layer) return;

        if (!isCameraMovementSuppressed() && typeof layer.getBounds === 'function') {
            const bounds = layer.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
                return;
            }
        }

        if (!isCameraMovementSuppressed() && typeof layer.getLatLng === 'function') {
            map.panTo(layer.getLatLng());
        }
    } catch (error) {
        console.warn('focusParcelInMap: unable to focus parcel', parcelId, error);
    }
}

function normalizeGoalKey(value) {
    const raw = (value || '').toString().trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('building')) return 'single';
    if (raw === 'road track') return 'road-track';
    if (raw === 'ownership transfer to me' || raw === 'ownership-transfer-to-me') return 'ownership-transfer-to-me';
    if (raw === 'ownership transfer from me' || raw === 'ownership-transfer-from-me') return 'ownership-transfer-from-me';
    if (raw === 'ownership transfer' || raw === 'ownership-transfer') return 'ownership-transfer';
    return raw;
}

function getProposalGoalBadge(goalKey) {
    const normalizedKey = normalizeGoalKey(goalKey);
    const iconConfig = PROPOSAL_GOAL_ICON_MAP[normalizedKey];
    if (!iconConfig) return null;
    return {
        text: iconConfig.icon,
        label: iconConfig.label
    };
}

function getStoredProposalById(proposalId) {
    if (!proposalId || typeof proposalStorage === 'undefined') return null;
    if (typeof proposalStorage.getProposal === 'function') {
        const found = proposalStorage.getProposal(proposalId);
        if (found) return found;
    }
    if (proposalStorage.proposals && typeof proposalStorage.proposals.get === 'function') {
        return proposalStorage.proposals.get(proposalId) || null;
    }
    return null;
}

function getBackendBaseUrl() {
    try {
        if (typeof window.getBackendBase === 'function') {
            const base = window.getBackendBase();
            if (base) return base.replace(/\/$/, '');
        }
    } catch (_) { }
    if (typeof window !== 'undefined' && window.location) {
        return `${window.location.protocol}//${window.location.host}`.replace(/\/$/, '');
    }
    return '';
}

function facetModeLabel(name, value) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    const radio = input ? input.closest('.proposal-radio') : null;
    const span = radio ? radio.querySelector('span') : null;
    return span ? span.textContent.trim() : value;
}

function setProposalParcelsMode(mode, { lock = false, unlock = false, reason = '' } = {}) {
    // The active parcel model has two states: keep boundaries, or run land readjustment.
    // Legacy callers asking for the removed merge mode safely resolve to no boundary change.
    const normalized = mode === 'readjust' ? 'readjust' : 'as-is';
    proposalFacetState.parcels = normalized;
    applyFacetLockUI('proposalParcelsGroup', 'proposalParcelsStatic', 'proposalParcelsMode', normalized, lock, reason);
}

function showProposalPerSliceOption(show) {
    const el = document.querySelector('.proposal-ownership-perslice');
    if (el) el.style.display = show ? '' : 'none';
}

function onProposalParcelsChange() {
    const sel = document.querySelector('input[name="proposalParcelsMode"]:checked');
    proposalFacetState.parcels = sel ? sel.value : 'as-is';
    if (proposalFacetState.parcels === 'readjust') {
        showProposalPerSliceOption(true);
        setProposalOwnershipMode('per-slice', { lock: true, reason: facetModeLabel('proposalParcelsMode', 'readjust') }); // slices carry their owners
    } else {
        showProposalPerSliceOption(false);
        const next = (proposalFacetState.ownership === 'per-slice') ? 'no-change' : proposalFacetState.ownership;
        setProposalOwnershipMode(next, { unlock: true });
    }
    syncProposalFacets();
}

function deriveProposalGoalKey() {
    const { landUse, parcels, ownership } = proposalFacetState;
    if (landUse === 'urban-rule') return 'urban-rule';
    if (parcels === 'readjust') return 'reparcellization';
    if (landUse && landUse !== 'as-is') return landUse; // park/square/lake/single/road-track
    if (ownership && ownership !== 'no-change') return 'ownership-transfer';
    return null; // as-is / as-is / no-change: nothing to propose yet
}

function updateProposalDescription(proposalType, forceUpdate = false) {
    // Legacy function - redirect to new function
    updateProposalNameAndDescription(proposalType, forceUpdate);
}

function readEnvLikeValue(key) {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !key) return null;
    const sources = [
        globalScope,
        globalScope.process && globalScope.process.env,
        globalScope.ENV,
        globalScope.env,
        globalScope.CONFIG,
        globalScope.config
    ];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
            const value = source[key];
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) return trimmed;
            } else {
                return String(value);
            }
        }
    }
    return null;
}

function formatRemainingTime(ms) {
    if (ms <= 0) return '00h:00m:00s';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}h:${String(minutes).padStart(2, '0')}m:${String(seconds).padStart(2, '0')}s`;
}

function _randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateStructureName(kind) {
    const adj = ['Green', 'Sunny', 'Central', 'Liberty', 'Unity', 'Riverside', 'Grand', 'Heritage', 'Harmony', 'Oak'];
    const nounPark = ['Park', 'Garden', 'Commons', 'Meadow', 'Grove'];
    const nounSquare = ['Square', 'Plaza', 'Forum', 'Court', 'Terrace'];
    const nounLake = ['Lake', 'Lagoon', 'Harbor', 'Bay', 'Pond'];
    const noun = kind === 'square' ? nounSquare : (kind === 'lake' ? nounLake : nounPark);
    return `${_randomFrom(adj)} ${_randomFrom(noun)}`;
}

function normalizeCityCodeForApi(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    if (!raw) return 'city';
    if (raw === 'zg' || raw === 'zgb') return 'zagreb';
    if (raw === 'bg') return 'belgrade';
    if (raw === 'ba' || raw === 'caba' || raw === 'ar-ba') return 'buenos_aires';
    return raw;
}

async function handleProposalDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    if (!button) return;

    const proposalId = button.getAttribute('data-server-id') || button.getAttribute('data-proposal-id');
    if (!proposalId) return;

    const cardKey = button.getAttribute('data-proposal-id') || proposalId;

    const t = getProposalI18nHelper();
    const originalLabel = button.textContent || '';
    button.disabled = true;
    button.textContent = `${originalLabel}…`;

    try {
        const proposal = await fetchServerProposalById(proposalId, resolveCurrentCityCode());
        // preserveStatus: false → resets `Applied` to `Active` (Executed stays Executed) and nested
        // road/building/structure/reparcel statuses to `unapplied`. Prevents the parcelDataLoaded
        // auto-apply from immediately re-applying a freshly downloaded server proposal.
        const imported = proposalStorage.importProposal(proposal, { overwrite: true, preserveStatus: false });
        if (!imported) {
            throw new Error('Unable to store proposal locally');
        }
        updateShowProposalsButton();

        // Surgical DOM update — no full rerender, so the user's scroll position and selection stay
        // exactly where they are. We only update what actually changed for this card:
        //   - the Download button becomes "Downloaded" disabled
        //   - the thumbnail upgrades from placeholder to the local image (if any)
        //   - the source-toggle Local count goes up by one
        const downloadedLabel = t('modal.roadWidth.proposalList.actions.downloaded', 'Downloaded');
        button.textContent = downloadedLabel;
        button.disabled = true;

        const thumbImage = imported.screenshotUrl
            || (imported.onchain && imported.onchain.imageUrl)
            || (imported.onchainData && imported.onchainData.imageUrl)
            || imported.screenshotDataUrl
            || null;
        if (thumbImage) {
            try {
                document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                    detail: {
                        proposalId: cardKey,
                        screenshotUrl: imported.screenshotUrl
                            || (imported.onchain && imported.onchain.imageUrl)
                            || (imported.onchainData && imported.onchainData.imageUrl)
                            || null,
                        screenshotDataUrl: imported.screenshotDataUrl || null
                    }
                }));
            } catch (_) { }
        }

        const localToggleBtn = document.querySelector('.proposal-source-btn[data-source="local"]');
        if (localToggleBtn && typeof proposalStorage.getAllProposals === 'function') {
            const newLocalCount = proposalStorage.getAllProposals().length;
            const localBaseLabel = t('modal.roadWidth.proposalList.sources.local', 'Local');
            localToggleBtn.textContent = `${localBaseLabel} (${newLocalCount})`;
        }
    } catch (error) {
        console.error('Failed to download proposal', proposalId, error);
        button.disabled = false;
        button.textContent = originalLabel;
        const message = t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal');
        try {
            updateStatus(message);
        } catch (_) {
            alert(message);
        }
    }
}

function getLocalizedProposalSortOptions() {
    const t = getProposalI18nHelper();
    return PROPOSAL_SORT_OPTIONS.map(option => {
        const i18nKey = PROPOSAL_SORT_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.sort.${i18nKey}`, option.label)
        };
    });
}

function getLocalizedProposalGoalFilters() {
    const t = getProposalI18nHelper();
    return PROPOSAL_GOAL_FILTERS.map(option => {
        const i18nKey = PROPOSAL_GOAL_FILTER_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.filters.goals.${i18nKey}`, option.label)
        };
    });
}

function getProposalGoalLabel(goalKey) {
    const t = getProposalI18nHelper();
    const normalizedKey = normalizeProposalGoalKey(goalKey) || 'other';
    const fallback = PROPOSAL_GOAL_LABELS[normalizedKey]
        || (normalizedKey ? normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1) : '');
    return t(`modal.roadWidth.proposalList.goalLabels.${normalizedKey}`, fallback);
}

function getProposalTypeLabel(typeKey) {
    return getProposalGoalLabel(typeKey);
}

function formatProposalTypeLabel(typeKey) {
    return getProposalTypeLabel(typeKey);
}

function isGenericProposalDisplayText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return true;
    const lower = text.toLowerCase();
    if (lower === 'proposal' || lower === 'minted proposal from blockchain' || lower === 'minted proposal from solana') {
        return true;
    }
    return /^proposal(?:\s+#?[a-z0-9._:-]+)?$/i.test(text);
}

function formatAreaMetric(area) {
    if (!Number.isFinite(area) || area <= 0) {
        return '—';
    }
    return `${Math.round(area).toLocaleString('hr-HR')} m²`;
}

function showProposalDownloadConfirm() {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.textContent = t('modal.roadWidth.proposalList.downloadConfirm', 'Proposal is not in local storage yet. Download?');

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = t('common.cancel', 'Cancel');

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'btn btn-action';
        downloadBtn.textContent = t('common.download', 'Download');

        function cleanup(result) {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        downloadBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) cleanup(false);
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(downloadBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

function isProposalUIActive() {
    try {
        const list = document.querySelector('.proposal-list-modal');
        const listOpen = !!(list && list.style && list.style.display === 'block');
        if (listOpen) return true;
        const detailsPanel = document.getElementById('proposal-details-panel');
        if (detailsPanel && detailsPanel.classList.contains('visible')) {
            return true;
        }
        const panel = document.getElementById('parcel-info-panel');
        if (panel && panel.classList.contains('visible')) {
            const titleEl = panel.querySelector('h3');
            const title = titleEl ? titleEl.textContent : '';
            if (title && title.trim() === 'Proposal Details') return true;
        }
    } catch (_) { }
    return false;
}

function getShareI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.share';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function sortProposalIdsForShare(ids) {
    return ids.slice().sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        const aNum = Number.isFinite(na);
        const bNum = Number.isFinite(nb);
        if (aNum && bNum) return na - nb;
        if (aNum && !bNum) return -1;
        if (!aNum && bNum) return 1;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
}

// deepClone, deepCloneArray, ensureArrayOfStrings and escapeHtml live in js/shared-utils.js and
// are used here as globals.

function computeSharedBoundingBoxFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return null;
    }

    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;

    features.forEach(feature => {
        if (!feature) return;
        const geometry = feature.type === 'Feature' ? feature.geometry : feature;
        collectCoordinatesFromGeometry(geometry, (lng, lat) => {
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            if (lng < west) west = lng;
            if (lng > east) east = lng;
            if (lat < south) south = lat;
            if (lat > north) north = lat;
        });
    });

    if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
        return null;
    }

    const padding = 0.0005;
    return {
        west: west - padding,
        south: south - padding,
        east: east + padding,
        north: north + padding
    };
}

function resolveBackendBaseUrl() {
    if (typeof global !== 'undefined' && typeof global.getBackendBase === 'function') {
        return global.getBackendBase();
    }
    if (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') {
        return window.getBackendBase();
    }
    const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname)
        ? window.location.hostname.toLowerCase()
        : '';
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return 'http://localhost:3000';
    }
    return 'https://api.urbangametheory.xyz';
}

function resolveFrontendBaseUrl() {
    if (typeof window === 'undefined' || !window.location) {
        return 'https://urbangametheory.xyz';
    }
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return `${window.location.protocol}//${window.location.host}`;
    }
    return 'https://urbangametheory.xyz';
}

function is3DModeRequestedFromUrl(params) {
    try {
        const p = params || new URLSearchParams(window.location.search || '');
        // Realistic (photoreal) mode is a sub-mode of 3D, so any realistic request also requests 3D.
        return isTruthyUrlFlag(p, 'mode3d') || isTruthyUrlFlag(p, '3d') || isRealisticModeRequestedFromUrl(p);
    } catch (_) {
        return false;
    }
}

// Realistic (Google Photorealistic 3D Tiles) mode. Aliases: ?real / ?rl / ?rw.
function isRealisticModeRequestedFromUrl(params) {
    try {
        const p = params || new URLSearchParams(window.location.search || '');
        return isTruthyUrlFlag(p, 'real') || isTruthyUrlFlag(p, 'rl') || isTruthyUrlFlag(p, 'rw');
    } catch (_) {
        return false;
    }
}

function tryEnterRealisticMode(options) {
    try {
        if (typeof window !== 'undefined' && window.PhotorealMode && typeof window.PhotorealMode.activate === 'function') {
            window.PhotorealMode.activate(options || {});
            return true;
        }
    } catch (err) {
        console.warn('[realistic] failed to enter realistic mode', err);
    }
    return false;
}

// URL-driven view entry: enter 3D (framing the just-loaded proposal), then overlay realistic mode
// when requested — framing the whole proposal from the top, tilted ~45°, with a gentle auto-rotate.
function enterUrlDrivenView(focusProposalIds) {
    const entered = tryEnterThreeMode({ fromUrl: true, focusProposalIds: focusProposalIds });
    if (entered && isRealisticModeRequestedFromUrl()) {
        tryEnterRealisticMode({ frameProposal: true, pitchDeg: -45, autoRotate: true });
    }
    return entered;
}

function roughlyEqualLatLng(a, b, eps = 1e-12) {
    try {
        if (!a || !b) return false;
        return Math.abs(a.lat - b.lat) <= eps && Math.abs(a.lng - b.lng) <= eps;
    } catch (_) {
        return false;
    }
}

function tryEnterThreeMode(options = {}) {
    try {
        if (typeof window !== 'undefined' && typeof window.enterThreeMode === 'function') {
            window.enterThreeMode(options);
            return true;
        }
    } catch (_) { }
    return false;
}

async function stageSharedProposalDependencies(parcelIds, options = {}) {
    const ids = ensureArrayOfStrings(parcelIds);
    if (!ids.length) {
        return;
    }
    const suppressStatus = options && options.suppressStatus === true;
    const label = (options && options.label) ? options.label : 'shared proposal';
    const updateStageStatus = (message) => {
        if (options && typeof options.onStatusUpdate === 'function') {
            options.onStatusUpdate(message);
        } else if (!suppressStatus && typeof updateStatus === 'function' && message) {
            updateStatus(message);
        }
    };

    updateStageStatus(`Fetching parent parcels for ${label}…`);
    await ensureParentParcelsLoaded(ids, {
        preloadOwners: false,
        forceRefreshParcels: !!(options && options.forceRefreshParcels),
        onProgress: (current, total) => {
            updateStageStatus(`Fetching parent parcels for ${label} (${current}/${total})…`);
        }
    });
    await waitForParcelLayersReady(ids, {
        timeoutMs: options && Number.isFinite(options.renderTimeoutMs) ? options.renderTimeoutMs : undefined
    });

    updateStageStatus(`Fetching parcel owners for ${label}…`);
    await preloadProposalParcelOwners(ids, { forceRefresh: !!(options && options.forceOwnerRefresh) });

    updateStageStatus(`Parents ready for ${label}.`);
}

function cleanSharedQuery(params) {
    try {
        const entries = params.toString();
        const newUrl = `${window.location.origin}${window.location.pathname}${entries ? `?${entries}` : ''}${window.location.hash || ''}`;
        if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState({}, document.title, newUrl);
        }
    } catch (error) {
        console.warn('Failed to clean shared query params', error);
    }
}

function computeRequiredParentIdsForSharedProposal(sp) {
    if (!sp || typeof sp !== 'object') return [];
    if (sp.reparcellization && Array.isArray(sp.reparcellization.polygons) && sp.reparcellization.polygons.length > 0) {
        // Reparcellization plans render their own geometry and do not depend on ancestor parcels being present locally.
        return [];
    }
    if (sp.roadProposal && Array.isArray(sp.roadProposal.parentParcelIds) && sp.roadProposal.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.roadProposal.parentParcelIds);
    }
    if (sp.buildingProposal && Array.isArray(sp.buildingProposal.parentParcelIds) && sp.buildingProposal.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.buildingProposal.parentParcelIds);
    }
    if (Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.parentParcelIds);
    }
    return [];
}

function gatherParentParcelIdsFromSharedProposals(proposals) {
    // Only use the explicit parentParcelIds field from each proposal
    const ids = new Set();
    proposals.forEach(p => {
        const list = Array.isArray(p.parentParcelIds) ? p.parentParcelIds : [];
        ensureArrayOfStrings(list).forEach(id => ids.add(id));
    });
    return ids;
}

function ensureRoadParentParcelIds(sharedProposal, normalized, parentIds) {
    if (!normalized.roadProposal) return true;

    // Prefer explicit parentParcelIds from shared payload; fallback to ancestor/parcel ids
    let candidateIds = [];
    const explicitParents = sharedProposal.roadProposal && Array.isArray(sharedProposal.roadProposal.parentParcelIds)
        ? ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        : [];
    if (explicitParents.length > 0) {
        candidateIds = explicitParents;
    }
    if (candidateIds.length === 0) {
        candidateIds = parentIds.length > 0 ? parentIds : [];
    }

    if (candidateIds.length === 0) {
        console.warn('No parent parcel IDs found for road proposal', sharedProposal.proposalId);
        return false;
    }

    // Just store the IDs - geometries will be fetched when needed
    normalized.roadProposal.parentParcelIds = candidateIds;
    return true;
}

function sameStringArrays(left, right) {
    const a = ensureArrayOfStrings(left);
    const b = ensureArrayOfStrings(right);
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

function syncCanonicalSharedProposalState(existing, normalized) {
    if (!existing || !normalized) return false;

    let changed = false;
    const syncArrayField = (target, field, value) => {
        const canonical = ensureArrayOfStrings(value);
        if (!canonical.length) return;
        if (!sameStringArrays(target[field], canonical)) {
            target[field] = canonical.slice();
            changed = true;
        }
    };

    syncArrayField(existing, 'parentParcelIds', normalized.parentParcelIds);
    syncArrayField(existing, 'childParcelIds', normalized.childParcelIds);

    if (normalized.roadProposal) {
        existing.roadProposal = existing.roadProposal || {};
        syncArrayField(existing.roadProposal, 'parentParcelIds', normalized.roadProposal.parentParcelIds);
        syncArrayField(existing.roadProposal, 'childParcelIds', normalized.roadProposal.childParcelIds);
    }

    if (normalized.decideLaterProposal) {
        existing.decideLaterProposal = existing.decideLaterProposal || {};
        syncArrayField(existing.decideLaterProposal, 'parentParcelIds', normalized.decideLaterProposal.parentParcelIds);
        syncArrayField(existing.decideLaterProposal, 'childParcelIds', normalized.decideLaterProposal.childParcelIds);
    }

    if (normalized.reparcellization) {
        existing.reparcellization = existing.reparcellization || {};
        syncArrayField(existing.reparcellization, 'parcelIds', normalized.reparcellization.parcelIds);
        syncArrayField(existing.reparcellization, 'childParcelIds', normalized.reparcellization.childParcelIds);
    }

    return changed;
}

function ensureProposalLoadOverlay() {
    if (proposalLoadOverlay) return proposalLoadOverlay;

    const styleId = 'proposal-load-overlay-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            @keyframes proposal-load-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            .proposal-load-spinner { width: 28px; height: 28px; border: 3px solid #d0d7de; border-top-color: #0d3b66; border-radius: 50%; animation: proposal-load-spin 0.9s linear infinite; margin-bottom: 12px; }
        `;
        document.head.appendChild(style);
    }

    proposalLoadOverlay = document.createElement('div');
    proposalLoadOverlay.style.position = 'fixed';
    proposalLoadOverlay.style.inset = '0';
    proposalLoadOverlay.style.background = 'rgba(0,0,0,0.35)';
    proposalLoadOverlay.style.zIndex = '12050';
    proposalLoadOverlay.style.display = 'none';
    proposalLoadOverlay.style.alignItems = 'center';
    proposalLoadOverlay.style.justifyContent = 'center';

    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.borderRadius = '12px';
    card.style.padding = '20px 22px';
    card.style.width = '320px';
    card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
    card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    card.style.textAlign = 'center';

    proposalLoadTitleEl = document.createElement('div');
    const initialTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    proposalLoadTitleEl.textContent = initialTitle;
    proposalLoadTitleEl.style.fontWeight = '700';
    proposalLoadTitleEl.style.fontSize = '16px';
    proposalLoadTitleEl.style.marginBottom = '6px';

    const spinner = document.createElement('div');
    spinner.className = 'proposal-load-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    proposalLoadStatusEl = document.createElement('div');
    proposalLoadStatusEl.style.fontSize = '13px';
    proposalLoadStatusEl.style.color = '#334155';
    proposalLoadStatusEl.style.marginBottom = '6px';
    proposalLoadStatusEl.textContent = 'Preparing…';

    proposalLoadBytesEl = document.createElement('div');
    proposalLoadBytesEl.style.fontSize = '12px';
    proposalLoadBytesEl.style.color = '#64748b';
    proposalLoadBytesEl.textContent = '0.00 MB';

    proposalLoadProgressTextEl = document.createElement('div');
    proposalLoadProgressTextEl.style.fontSize = '12px';
    proposalLoadProgressTextEl.style.color = '#334155';
    proposalLoadProgressTextEl.style.marginTop = '8px';
    proposalLoadProgressTextEl.textContent = '';

    const progressBar = document.createElement('div');
    progressBar.style.position = 'relative';
    progressBar.style.height = '8px';
    progressBar.style.background = '#e5e7eb';
    progressBar.style.borderRadius = '999px';
    progressBar.style.overflow = 'hidden';
    progressBar.style.marginTop = '6px';
    progressBar.style.display = 'none';

    const progressFill = document.createElement('div');
    progressFill.style.position = 'absolute';
    progressFill.style.left = '0';
    progressFill.style.top = '0';
    progressFill.style.height = '100%';
    progressFill.style.width = '0%';
    progressFill.style.background = '#0d3b66';
    progressFill.style.transition = 'width 0.2s ease';

    progressBar.appendChild(progressFill);
    proposalLoadProgressBarEl = progressBar;
    proposalLoadProgressFillEl = progressFill;

    card.appendChild(proposalLoadTitleEl);
    card.appendChild(spinner);
    card.appendChild(proposalLoadStatusEl);
    card.appendChild(proposalLoadBytesEl);
    card.appendChild(proposalLoadProgressTextEl);
    card.appendChild(progressBar);
    proposalLoadOverlay.appendChild(card);
    document.body.appendChild(proposalLoadOverlay);

    return proposalLoadOverlay;
}

function showProposalLoadOverlay(status, options = {}) {
    ensureProposalLoadOverlay();
    const defaultTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    const titleText = (options && typeof options.title === 'string' && options.title.trim())
        ? options.title.trim()
        : defaultTitle;
    if (proposalLoadTitleEl) proposalLoadTitleEl.textContent = titleText;
    proposalLoadBytes = 0;
    if (proposalLoadStatusEl) proposalLoadStatusEl.textContent = status || 'Loading…';
    if (proposalLoadBytesEl) proposalLoadBytesEl.textContent = '0.00 MB';
    const total = (options && Number.isFinite(Number(options.total))) ? Number(options.total) : 0;
    proposalLoadProgressTotal = total > 0 ? total : 0;
    proposalLoadProgressDone = 0;
    renderProposalLoadProgress();
    if (proposalLoadOverlay) proposalLoadOverlay.style.display = 'flex';
}

function updateProposalLoadOverlay(options = {}) {
    if (!proposalLoadOverlay) return;
    if (options.status && proposalLoadStatusEl) {
        proposalLoadStatusEl.textContent = options.status;
    }
    if (Number.isFinite(options.bytesDelta) && options.bytesDelta > 0) {
        proposalLoadBytes += options.bytesDelta;
        if (proposalLoadBytesEl) {
            proposalLoadBytesEl.textContent = `${(proposalLoadBytes / (1024 * 1024)).toFixed(2)} MB`;
        }
    }
    if (options.progress) {
        if (Number.isFinite(options.progress.total)) {
            proposalLoadProgressTotal = Math.max(0, Number(options.progress.total));
        }
        if (Number.isFinite(options.progress.done)) {
            proposalLoadProgressDone = Math.max(0, Number(options.progress.done));
        }
        renderProposalLoadProgress();
    }
}

function hideProposalLoadOverlay(finalStatus) {
    if (proposalLoadOverlay) {
        proposalLoadOverlay.style.display = 'none';
    }
    if (finalStatus && typeof updateStatus === 'function') {
        updateStatus(finalStatus);
    }
}

async function addResponseBytes(response) {
    if (!response) return;
    try {
        const lenHeader = response.headers ? response.headers.get('content-length') : null;
        if (lenHeader && Number.isFinite(Number(lenHeader))) {
            updateProposalLoadOverlay({ bytesDelta: Number(lenHeader) });
            return;
        }
        const clone = response.clone();
        const buf = await clone.arrayBuffer();
        updateProposalLoadOverlay({ bytesDelta: buf.byteLength });
    } catch (_) { /* ignore */ }
}

function formatSharedProposalLabel(proposal, fallbackId) {
    const title = proposal && proposal.title ? String(proposal.title) : '';
    const pid = proposal && proposal.proposalId
        ? String(proposal.proposalId)
        : (fallbackId !== undefined && fallbackId !== null ? String(fallbackId) : '');
    if (title && pid) return `${title} (#${pid})`;
    if (title) return title;
    if (pid) return `#${pid}`;
    return 'proposal';
}

function formatSharedProposalTypeLabel(proposal) {
    try {
        if (!proposal) return '';
        return resolveProposalGoalKey(proposal, null);
    } catch (_) {
        return '';
    }
}

async function handleProposalRouteFromUrl(attempt = 0) {
    try {
        const pathname = window.location.pathname || '';
        const isProposalPath = pathname.startsWith('/proposals/');

        // Ignore non-proposal routes entirely
        if (!isProposalPath) {
            return;
        }

        // Handle bare /proposals/ route (no ids) by opening the appropriate dialog
        const isBareProposalsRoute = /^\/proposals\/?$/.test(pathname);
        if (isBareProposalsRoute) {
            const wm = typeof window !== 'undefined' ? window.walletManager : null;
            const walletState = wm && typeof wm.getState === 'function' ? wm.getState() : null;
            const walletConnected = Boolean(
                walletState &&
                walletState.status === 'connected' &&
                Array.isArray(walletState.accounts) &&
                walletState.accounts.length > 0
            );

            if (walletConnected && typeof window.openMintedProposalsModal === 'function') {
                console.debug('[handleProposalRouteFromUrl] Opening minted proposals modal for /proposals/');
                window.openMintedProposalsModal();
            } else if (typeof showAllProposalsModal === 'function') {
                console.debug('[handleProposalRouteFromUrl] Opening local proposals list for /proposals/');
                showAllProposalsModal();
            }
            return;
        }

        // On-chain proposal location: /proposals/<chainType>/<chainId>:<contract>:<tokenId>.
        // Only the LOCATION is in the URL — reconstruct the proposal from the NFT + its metadata.
        const chainRef = (window.ChainProposalRef && typeof window.ChainProposalRef.parseChainProposalRef === 'function')
            ? window.ChainProposalRef.parseChainProposalRef(pathname)
            : null;
        if (chainRef) {
            await handleChainProposalRoute(chainRef);
            return;
        }

        // Check if URL matches /proposals/:id or comma-separated ids
        const pathMatch = pathname.match(/^\/proposals\/([0-9,]+)$/);
        if (!pathMatch) {
            console.debug('[handleProposalRouteFromUrl] Proposal path did not match expected pattern:', pathname);
            return;
        }
        console.log('[handleProposalRouteFromUrl] Matched path:', pathMatch[1], 'attempt:', attempt);

        const idSegment = pathMatch[1];
        const idParts = idSegment.split(',').map(v => v.trim()).filter(Boolean);
        if (idParts.length === 0) {
            console.log('[handleProposalRouteFromUrl] No valid ID parts found');
            return;
        }

        // Single proposal is just an array of one - use the same handler
        console.log('[handleProposalRouteFromUrl] Delegating to handleSharedPlanRoute:', idParts);
        await handleSharedPlanRoute(idParts);
    } catch (error) {
        console.error('handleProposalRouteFromUrl failed:', error);
    }
}

// Open a proposal from its on-chain location: reconstruct it from the NFT (wallet-gated read via the
// connected wallet's provider), add it to local storage, and focus it. Never touches the server.
async function handleChainProposalRoute(ref) {
    const loader = window.ChainProposalLoader;
    if (!loader || typeof loader.loadChainProposalFromRef !== 'function') {
        if (typeof updateStatus === 'function') updateStatus('On-chain proposals are unavailable.');
        return;
    }
    const result = await loader.loadChainProposalFromRef(ref);
    if (result && result.ok && result.proposal) {
        const key = (typeof getProposalKey === 'function' && getProposalKey(result.proposal)) || result.proposal.proposalId;
        if (key && typeof selectAndHighlightProposal === 'function') {
            selectAndHighlightProposal(key, null, true);
        }
        return;
    }
    // Canton proposals are private to their parties: a non-party (or no identity) can't see them.
    if (result && result.reason === 'canton-private') {
        if (typeof updateStatus === 'function') {
            updateStatus('This is a private Canton proposal — you can only see it if you are logged in as a party to it.');
        }
        return;
    }
    // No wallet connected → the read can't run; prompt to connect. Other failures get a generic note.
    if (result && result.reason === 'chain-unavailable') {
        if (typeof updateStatus === 'function') updateStatus('Connect a wallet to open this on-chain proposal.');
    } else if (typeof updateStatus === 'function') {
        updateStatus('Could not load the on-chain proposal.');
    }
}

function selectProposalFromList(proposalIdOrHash, parcelId) {
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalIdOrHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    selectAndHighlightProposal(getProposalKey(proposal) || proposalIdOrHash, parcelId, true);
}

async function handleUserAcceptProposal(proposalId, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_accept_proposals', 'You must be logged in to accept proposals.');
        return;
    }

    // Get the proposal to check stored owner acceptance data
    const proposal = proposalStorage.getProposal(proposalId);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const normalizedParcelId = normalizeParcelId(parcelId);
    if (!normalizedParcelId) {
        showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
        return;
    }

    // Ensure owner acceptance entry exists and get owner slots
    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
    if (!entry) {
        showProposalAlertMessage('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
        return;
    }

    // Determine the effective owner key
    let effectiveOwnerKey = ownerKey;
    let targetSlot = null;

    if (effectiveOwnerKey) {
        // If ownerKey is provided, check if it exists in the proposal's stored owner data
        if (entry.owners[effectiveOwnerKey]) {
            // Found in stored data, try to find in current slots for display, but use stored data if not found
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey) || entry.owners[effectiveOwnerKey];
        } else if (entry.ownerOrder.includes(effectiveOwnerKey)) {
            // Key exists in ownerOrder but not in owners, use it anyway
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey) || { key: effectiveOwnerKey };
        } else {
            // Key not found in stored data, try to find in current slots
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey);
            if (targetSlot) {
                // Found in current slots, add to stored data
                entry.owners[effectiveOwnerKey] = {
                    key: targetSlot.key,
                    displayName: targetSlot.displayName || `Owner`,
                    shareText: targetSlot.shareText || '',
                    shareDetail: targetSlot.shareDetail || '',
                    type: targetSlot.type || 'unknown',
                    agentId: targetSlot.agentId || null
                };
            }
        }
    } else if (ownerSlots.length === 1) {
        // No ownerKey provided, but only one slot available
        targetSlot = ownerSlots[0];
        effectiveOwnerKey = targetSlot.key;
    } else if (entry.ownerOrder.length === 1) {
        // No ownerKey provided, but only one owner in stored data
        effectiveOwnerKey = entry.ownerOrder[0];
        targetSlot = entry.owners[effectiveOwnerKey] || ownerSlots.find(slot => slot.key === effectiveOwnerKey) || { key: effectiveOwnerKey };
    }

    if (!targetSlot || !effectiveOwnerKey) {
        showProposalAlertMessage('please_choose_which_owner_share_you_are_accepting_for', 'Please choose which owner share you are accepting for.');
        return;
    }

    // Validate ownership for agent-type slots
    if (targetSlot.type === 'agent' && targetSlot.agentId && targetSlot.agentId !== userAgent.id) {
        showProposalAlertMessage('you_can_only_accept_proposals_for_parcels_you_own', 'You can only accept proposals for parcels you own.');
        return;
    }

    // A vote proposal (no ownership/parcel change) collects non-binding yes-votes instead of
    // binding acceptances: on-chain it calls castVote, and it never executes or transfers.
    const isVote = typeof isVoteProposal === 'function' && isVoteProposal(proposal);

    // Check if this proposal is minted on-chain — if so, submit on-chain first
    const nftInfo = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
    const bridge = window.ProposalChainBridge;
    const bridgeMethod = isVote ? 'castVote' : 'acceptProposal';
    const isOnChain = nftInfo && bridge && typeof bridge[bridgeMethod] === 'function';

    if (isOnChain) {
        try {
            if (typeof updateStatus === 'function') {
                updateStatus(isVote ? 'Submitting vote on chain...' : 'Submitting acceptance on chain...');
            }
            await bridge[bridgeMethod]({
                proposalId: nftInfo.tokenId,
                parcelId: normalizedParcelId,
                chainId: nftInfo.chain,
                contractAddress: nftInfo.contract
            });
        } catch (onchainErr) {
            console.warn(isVote ? 'On-chain vote failed:' : 'On-chain acceptance failed:', onchainErr);
            const friendlyMessage = parseOnChainErrorMessage(onchainErr);
            showProposalAlertMessage(isVote ? 'on_chain_vote_failed' : 'on_chain_acceptance_failed', friendlyMessage);
            return;
        }
    }

    // On-chain succeeded (or not on-chain) — now record locally
    const result = acceptProposal(proposalId, parcelId, effectiveOwnerKey, {
        acceptedByAgentId: userAgent.id,
        acceptedByName: userAgent.name
    });

    if (!result) {
        return;
    }

    if (isOnChain && typeof updateStatus === 'function') {
        updateStatus(isVote ? 'Vote recorded on chain.' : 'Acceptance recorded on chain.');
    }

    const ownerLabel = targetSlot.shareText
        ? `${targetSlot.displayName} (${targetSlot.shareText})`
        : targetSlot.displayName;

    const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
        ? proposalStorage.getProposal(proposalId)
        : null;
    const proposalIdForLog = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
        ? String(storedProposal.proposalId)
        : String(proposalId);
    const proposalIdAttr = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
        ? String(storedProposal.proposalId)
        : String(proposalId);
    const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;

    if (result.proposalExecuted) {
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> executed proposal ${proposalLinkHtml} after confirming acceptance for ${ownerLabel}.`);
        }
        if (!userAgent.proposalsExecuted) {
            userAgent.proposalsExecuted = [];
        }
        if (!userAgent.proposalsExecuted.includes(proposalId)) {
            userAgent.proposalsExecuted.push(proposalId);
            agentStorage.updateAgent(userAgent.id, { proposalsExecuted: userAgent.proposalsExecuted });
        }
    } else {
        if (typeof addUserActionToGameLog === 'function') {
            const logMsg = isVote
                ? `<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> voted yes as ${ownerLabel} on proposal ${proposalLinkHtml}.`
                : `<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> recorded acceptance from ${ownerLabel} for parcel ${result.parcelNumber || parcelId} (${proposalLinkHtml}).`;
            addUserActionToGameLog(logMsg);
        }
        if (!userAgent.proposalsAccepted) {
            userAgent.proposalsAccepted = [];
        }
        if (!userAgent.proposalsAccepted.includes(proposalId)) {
            userAgent.proposalsAccepted.push(proposalId);
            agentStorage.updateAgent(userAgent.id, { proposalsAccepted: userAgent.proposalsAccepted });
        }
    }

    // Preserve exact scroll/anchor position BEFORE any updates
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    const scrollTop = panelBody ? panelBody.scrollTop : 0;
    const anchorKey = effectiveOwnerKey || targetSlot.key || ownerKey || null;
    let anchorOffset = null;
    if (panelBody && anchorKey) {
        const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
        if (ownerRow) {
            const bodyRect = panelBody.getBoundingClientRect();
            const rowRect = ownerRow.getBoundingClientRect();
            anchorOffset = rowRect.top - bodyRect.top;
        }
    }

    const updatedProposal = proposalStorage.getProposal(proposalId);
    if (updatedProposal) {
        const preserveState = {
            scrollTop,
            anchorKey,
            anchorOffset,
            parcelId: normalizedParcelId
        };

        if (typeof updateAgentDialogAfterAcceptance === 'function') {
            updateAgentDialogAfterAcceptance(proposalId);
        }

        refreshProposalOwnerAcceptanceUI(updatedProposal, parcelId);
        restoreProposalDetailsScroll(preserveState);

        if (typeof renderProposalListModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                renderProposalListModal();
            }
        }

        if (typeof refreshProposalsLayer === 'function') {
            refreshProposalsLayer();
        }
    }
}

function isEditableElement(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return target.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || tagName === 'OPTION';
}

// Proposal Info hover overlay helpers

function clearProposalInfoHoverOverlay() {
    try {
        clearProposalHoverLayers();
    } catch (error) {
        console.warn('clearProposalInfoHoverOverlay failed', error);
    }
}
