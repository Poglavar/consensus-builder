// proposals/core.js — shared low-level helpers used across the proposals subsystem:
// cloning, escaping, formatting, color, URL/base helpers, and small predicates.
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
        { const translated = api.t(key, params); if (translated !== key) return translated; }
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
    // The dialog turns this slot into an anchor; translation must not replace it with URL text.
    const values = alertOptions.linkUrl ? { ...params, txLink: '{{txLink}}' } : params;
    let message = translate(`alerts.messages.${key}`, fallback, values);
    if (alertOptions.linkUrl && !message.includes('{{txLink}}')) message += '\n{{txLink}}';
    // The shared dialog (js/ui/dialogs.js via showStyledAlert), never the browser's.
    window.showStyledAlert(message, alertOptions);
    return message;
}

function isParcelReplacedByChildren(parcelId) {
    if (!parcelId) return false;
    const idStr = String(parcelId);
    if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return false;

    // Claims asks the live fabric whether the applied proposal currently has materialized output.
    // Proposal records contain no child list.
    const claims = (typeof window !== 'undefined') ? window.__claims : null;
    return proposalStorage.getAllProposals().some(proposal => {
        if (claims && typeof claims.formationReplacesCadastreParcel === 'function') {
            return claims.formationReplacesCadastreParcel(proposal, idStr, { isApplied });
        }
        return false;
    });
}

function getProposalAreaMap(proposal) {
    const parcelIds = normalizeParcelIdList(proposal?.cadastreParcelIds);
    const repository = window.CadastralParcelRepository;
    const measureGeometry = geometry => {
        try { return window.__siteDraft?.siteAreaM2(geometry) ?? null; }
        catch (error) {
            console.warn('[getProposalAreaMap] Could not measure a source parcel:', error);
            return null;
        }
    };
    // A partial sum cannot be a denominator for owner payout estimates.
    return window.ProposalArea.sourceAreaMap(parcelIds, repository?.peekMany?.(parcelIds) || [], measureGeometry);
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

function resolveProposalParcelsInViewport(proposalIdSet /* , proposal */) {
    const out = [];
    forEachProposalParcelInViewport(proposalIdSet, (layer) => {
        const parcelId = window.ParcelPresenter?.getIdForLayer?.(layer) || null;
        if (!parcelId) return;
        const feature = window.LiveParcelFabric?.get?.(parcelId) || null;
        if (feature) out.push(feature);
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
        const t = getProposalI18nHelper();
        updateStatus(t('status.messages.proposal_not_found', 'Proposal not found'));
        return false;
    }

    const parcelIds = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
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

    if (normalized.closeSheets && window.MapShell) {
        window.MapShell.closeSheets();
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);

    focusProposalDetails(proposalKey, {
        parcelId: fallbackParcel,
        centerOnProposal: normalized.centerOnProposal !== false,
        showDetails: normalized.showDetails !== false,
        presentation: normalized.presentation || 'details'
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
    // The create dialog keeps parcel boundaries as they are: new borders are drawn with Lay out
    // parcels (the parcel-layout design), never chosen here.
    const normalized = 'as-is';
    proposalFacetState.parcels = normalized;
    applyFacetLockUI('proposalParcelsGroup', 'proposalParcelsStatic', 'proposalParcelsMode', normalized, lock, reason);
}

function onProposalParcelsChange() {
    proposalFacetState.parcels = 'as-is';
    syncProposalFacets();
}

function deriveProposalGoalKey() {
    const { landUse, ownership } = proposalFacetState;
    if (landUse === 'urban-rule') return 'urban-rule';
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

// The city id the API files and filters by, for an id or any short code the city config knows
// (CityConfigManager.resolveCityParam: zg, st, ny, ...); an unknown value passes through.
function normalizeCityCodeForApi(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    if (!raw) return 'city';
    const manager = typeof globalThis !== 'undefined' ? globalThis.CityConfigManager : null;
    return (manager && typeof manager.resolveCityParam === 'function' && manager.resolveCityParam(raw)) || raw;
}

// Bring one card in the proposal list up to date with the fact that it is now downloaded.
//
// A surgical DOM update rather than a rerender, so scroll position, the previewing row and the
// user's place in a long list all survive. Three things change and nothing else:
//   - the Download button becomes a disabled "Downloaded"
//   - the thumbnail upgrades from placeholder to the local image, if there is one
//   - the source toggle's Local count goes up by one
//
// Shared, because there are TWO ways to download and only one of them used to do this. The card's
// own Download button did; clicking the ROW — which asks first, then downloads — did not, so a
// proposal fetched that way sat there still offering to be downloaded.
// Give one card the "Local" badge the renderer would have given it. Idempotent: a card that already
// carries one is left alone, so a second download attempt cannot stack badges.
function addLocalBadgeToCard(card, t) {
    if (!card || typeof card.querySelector !== 'function') return;
    if (card.querySelector('.proposal-local-state')) return;
    const mintBadge = card.querySelector('.proposal-mint-state');
    if (!mintBadge || typeof mintBadge.insertAdjacentHTML !== 'function') return;
    const label = t('modal.roadWidth.proposalList.labels.local', 'Local');
    const safe = (typeof escapeHtml === 'function') ? escapeHtml(label) : label;
    mintBadge.insertAdjacentHTML('afterend',
        `<span class="cb-badge cb-badge--neutral proposal-mint-state proposal-mint-state--compact proposal-local-state">${safe}</span>`);
}

function markProposalCardDownloaded(cardKey, imported) {
    if (!imported || typeof document === 'undefined') return;
    const t = getProposalI18nHelper();
    const key = (cardKey === undefined || cardKey === null) ? '' : String(cardKey);

    // Matched by attribute rather than by CSS selector: a parcel-derived proposal id can carry
    // characters (`/`, `#`, `*`) that would need escaping to be selected safely.
    if (key) {
        const button = Array.from(document.querySelectorAll('.proposal-download-btn'))
            .find(candidate => candidate.getAttribute('data-proposal-id') === key
                || candidate.getAttribute('data-cid') === key);
        if (button) {
            button.textContent = t('modal.roadWidth.proposalList.actions.downloaded', 'Downloaded');
            button.disabled = true;
            // The card also gains a "Local" badge, which the renderer would have given it had this
            // been a rerender. Without it the card reads "On server" and nothing says the copy in
            // front of you is now yours — the same half-told state the button had.
            addLocalBadgeToCard(button.closest ? button.closest('.proposal-list-item') : null, t);
        }
    }

    const screenshotUrl = imported.screenshotUrl
        || (imported.onchain && imported.onchain.imageUrl)
        || (imported.onchainData && imported.onchainData.imageUrl)
        || null;
    if (screenshotUrl || imported.screenshotDataUrl) {
        try {
            document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                detail: {
                    proposalId: key,
                    screenshotUrl,
                    screenshotDataUrl: imported.screenshotDataUrl || null
                }
            }));
        } catch (_) { }
    }

    const localToggleBtn = document.querySelector('.proposal-source-btn[data-source="local"]');
    if (localToggleBtn && typeof proposalStorage !== 'undefined'
        && typeof proposalStorage.getAllProposals === 'function') {
        const newLocalCount = proposalStorage.getAllProposals().length;
        const localBaseLabel = t('modal.roadWidth.proposalList.sources.local', 'Local');
        localToggleBtn.textContent = `${localBaseLabel} (${newLocalCount})`;
    }
}

async function handleProposalDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    if (!button) return;

    const cid = button.getAttribute('data-cid');
    if (!cid) return;

    const cardKey = button.getAttribute('data-proposal-id') || cid;

    const t = getProposalI18nHelper();
    const originalLabel = button.textContent || '';
    button.disabled = true;
    button.textContent = `${originalLabel}…`;

    try {
        // The design is imported by its CID and parked (applied: false; list-ui.js
        // importServerProposal). Parking prevents the parcelDataLoaded auto-apply from immediately
        // re-applying a freshly downloaded design.
        const imported = await importServerProposal(cid);
        markProposalCardDownloaded(cardKey, imported);
    } catch (error) {
        console.error('Failed to download proposal', cid, error);
        button.disabled = false;
        button.textContent = originalLabel;
        // another city's proposal is not stored here: say where it belongs
        const message = error?.code === 'proposal-in-other-city'
            ? error.message
            : t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal');
        try {
            updateStatus(message);
        } catch (_) {
            window.CbDialog.alert(message);
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

// A title that names no particular record: empty, or "Proposal" with at most an id after it.
function isGenericProposalDisplayText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return true;
    return /^proposal(?:\s+#?[a-z0-9._:-]+)?$/i.test(text);
}

function formatAreaMetric(area) {
    if (!Number.isFinite(area) || area <= 0) {
        return '—';
    }
    return CbFormat.formatArea(Math.round(area));
}

// Resolves true when the person chose Download (js/ui/dialogs.js confirm).
function showProposalDownloadConfirm() {
    const t = getProposalI18nHelper();
    return window.CbDialog.confirm(
        t('modal.roadWidth.proposalList.downloadConfirm', 'Proposal is not in local storage yet. Download?'),
        { okText: t('common.download', 'Download'), cancelText: t('common.cancel', 'Cancel') }
    );
}

function isProposalUIActive() {
    try {
        if (window.ClickStack?.isOpen() && window.ClickStack.current()?.selectedKind === 'designs') return true;
        const inspector = document.getElementById('planning-inspector');
        if (inspector && !inspector.hidden && window.PlanningViews?.getSelected()?.role === 'proposed') return true;
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

// Abstract 3D "model" view. Canonical: ?model. Back-compat aliases: ?mode3d / ?3d.
function is3DModeRequestedFromUrl(params) {
    try {
        const p = params || new URLSearchParams(window.location.search || '');
        // The "photo" view is a sub-mode of "model", so any photo request also requests model.
        return isTruthyUrlFlag(p, 'model') || isTruthyUrlFlag(p, 'mode3d') || isTruthyUrlFlag(p, '3d')
            || isRealisticModeRequestedFromUrl(p);
    } catch (_) {
        return false;
    }
}

// Photorealistic (Google Photorealistic 3D Tiles) "photo" view. Canonical: ?photo.
// Back-compat aliases: ?real / ?rl / ?rw.
function isRealisticModeRequestedFromUrl(params) {
    try {
        const p = params || new URLSearchParams(window.location.search || '');
        return isTruthyUrlFlag(p, 'photo') || isTruthyUrlFlag(p, 'real')
            || isTruthyUrlFlag(p, 'rl') || isTruthyUrlFlag(p, 'rw');
    } catch (_) {
        return false;
    }
}

function tryEnterRealisticMode(options) {
    if (typeof window.requestMapMode !== 'function') return false;
    window.requestMapMode('photo', options || {});
    return true;
}

// URL entry shares the same cancellable transition as the mode buttons.
function enterUrlDrivenView(focusProposalIds) {
    const arrival = window.MapShare.arrivalOptions(window.location.search);
    const restoreView = arrival.restoreView
        || ((typeof window.getAiSceneRestoreView === 'function') ? window.getAiSceneRestoreView() : null);
    const options = { fromUrl: true, focusProposalIds, restoreView, rotate: arrival.rotate, frameProposal: true };
    return isRealisticModeRequestedFromUrl() ? tryEnterRealisticMode(options) : tryEnterThreeMode(options);
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
    const normalized = (typeof canonicalizeProposalCadastreAnchors === 'function')
        ? canonicalizeProposalCadastreAnchors(sp)
        : sp;
    const claims = (typeof window !== 'undefined') ? window.__claims : null;
    if (!claims || typeof claims.cadastreParcelIdsOf !== 'function') {
        throw new Error('Proposal cadastre claims service is unavailable.');
    }
    return claims.cadastreParcelIdsOf(normalized);
}

function gatherParentParcelIdsFromSharedProposals(proposals) {
    // Shared records expose one normalized, flat declaration of cadastral ground.
    const ids = new Set();
    proposals.forEach(p => {
        const list = computeRequiredParentIdsForSharedProposal(p);
        ensureArrayOfStrings(list).forEach(id => ids.add(id));
    });
    return ids;
}

function roadHasDeclaredCadastre(sharedProposal, normalized, cadastreIds) {
    if (!normalized.roadProposal) return true;
    if (!cadastreIds.length) {
        console.warn('No cadastreParcelIds found for road proposal', sharedProposal.proposalId);
        return false;
    }
    return true;
}

// The progress card for opening shared proposals and plans: it wears the dialog primitive's
// overlay and card (css/primitives.css) on the dialog-over-dialog rung, shown and hidden with the
// `hidden` attribute. Its fixed text slots (css/modals.css .proposal-load-card) keep the card from
// moving as the status lines change.
function ensureProposalLoadOverlay() {
    if (proposalLoadOverlay) return proposalLoadOverlay;

    proposalLoadOverlay = document.createElement('div');
    proposalLoadOverlay.className = 'cb-dialog-overlay cb-dialog-overlay--top proposal-load-overlay';
    proposalLoadOverlay.hidden = true;

    const card = document.createElement('div');
    // A progress message has no resize/dismiss interaction. A mobile sheet handle would insert
    // a seventh child into the six-row grid and stretch the progress bar into an implicit row.
    card.className = 'cb-dialog cb-dialog--sm cb-dialog--message proposal-load-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'proposal-load-title');

    proposalLoadTitleEl = document.createElement('div');
    proposalLoadTitleEl.id = 'proposal-load-title';
    proposalLoadTitleEl.className = 'proposal-load-title';
    const initialTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    proposalLoadTitleEl.textContent = initialTitle;

    const spinner = document.createElement('div');
    spinner.className = 'proposal-load-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    proposalLoadStatusEl = document.createElement('div');
    proposalLoadStatusEl.className = 'proposal-load-status';
    proposalLoadStatusEl.setAttribute('role', 'status');
    proposalLoadStatusEl.textContent = 'Preparing…';

    proposalLoadBytesEl = document.createElement('div');
    proposalLoadBytesEl.className = 'proposal-load-bytes';
    proposalLoadBytesEl.textContent = '0.00 MB';

    proposalLoadProgressTextEl = document.createElement('div');
    proposalLoadProgressTextEl.className = 'proposal-load-progress-text';
    proposalLoadProgressTextEl.textContent = '';

    const progressBar = document.createElement('div');
    progressBar.className = 'proposal-load-progress-bar';
    progressBar.style.visibility = 'hidden';

    const progressFill = document.createElement('div');
    progressFill.className = 'proposal-load-progress-fill';
    progressFill.style.width = '0%';

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
    startProposalLoadByteObserver();
    if (proposalLoadOverlay) proposalLoadOverlay.hidden = false;
}

function updateProposalLoadOverlay(options = {}) {
    if (!proposalLoadOverlay) return;
    if (options.title && proposalLoadTitleEl) {
        proposalLoadTitleEl.textContent = options.title;
    }
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
    stopProposalLoadByteObserver();
    if (proposalLoadOverlay) {
        proposalLoadOverlay.hidden = true;
    }
    if (finalStatus && typeof updateStatus === 'function') {
        updateStatus(finalStatus);
    }
}

// The overlay's MB counter sums EVERY resource the page loads while the
// overlay is visible — parcels, buildings, ownership, proposal JSON, tiles —
// in wire bytes (transferSize; falls back to body sizes for servers without
// Timing-Allow-Origin). The old fetch-level counter measured only the two
// proposal-JSON fetches, in DECODED bytes: it missed ~95% of a plan open's
// traffic while overstating what it did count ~5× against gzip.
let proposalLoadResourceObserver = null;

function startProposalLoadByteObserver() {
    stopProposalLoadByteObserver();
    if (typeof PerformanceObserver === 'undefined') return;
    try {
        proposalLoadResourceObserver = new PerformanceObserver((list) => {
            let delta = 0;
            for (const entry of list.getEntries()) {
                delta += entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0;
            }
            if (delta > 0) updateProposalLoadOverlay({ bytesDelta: delta });
        });
        proposalLoadResourceObserver.observe({ type: 'resource', buffered: false });
    } catch (_) {
        proposalLoadResourceObserver = null;
    }
}

function stopProposalLoadByteObserver() {
    if (!proposalLoadResourceObserver) return;
    try { proposalLoadResourceObserver.disconnect(); } catch (_) { /* ignore */ }
    proposalLoadResourceObserver = null;
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

// A design or agreement link suppresses the boot's viewport parcel fetch while it loads its own
// ground (map-core.js IS_PROPOSAL_DEEP_LINK). Every way such a route ends gives it back — a link that
// does not resolve, a stay in the wrong city, an applied link — and fetches the view once; a route
// that ended without it left the map without parcels until a reload.
function releaseDeepLinkParcelFetch() {
    if (typeof window === 'undefined' || !window.skipParcelFetchUntilProposalLoaded) return;
    window.skipParcelFetchUntilProposalLoaded = false;
    try {
        if (typeof map !== 'undefined' && map && typeof map.fire === 'function') map.fire('moveend');
    } catch (error) {
        console.warn('[proposal-route] could not fetch the view after the route', error);
    }
}

// The app's record routes: /designs/<cid>[,<cid>…] opens shared designs (sharing-routes.js
// handleSharedDesignRoute), /agreements/<cid> a proposed agreement (agreement-sync.js) and /proposals
// the proposal list. Each handler validates its own ids; js/app-routes.js lists the same paths.
async function handleProposalRouteFromUrl() {
    try {
        const pathname = (window.location.pathname || '').replace(/\/$/, '');

        // Design and agreement links load their own ground, so the boot's parcel fetch is given
        // back however their route ends.
        if (pathname === '/designs' && new URLSearchParams(window.location.search).has('draft')) {
            try { await window.DraftPreview.open(); } finally { releaseDeepLinkParcelFetch(); }
            return;
        }
        const designMatch = pathname.match(/^\/designs\/([^/]+)$/);
        const agreementMatch = pathname.match(/^\/agreements\/([^/]+)$/);
        const planMatch = pathname.match(/^\/plans\/([^/]+)$/);
        if (designMatch || agreementMatch || planMatch) {
            try {
                if (planMatch) {
                    await window.NamedPlans.open();
                } else if (designMatch) {
                    const cids = designMatch[1].split(',').map(cid => cid.trim()).filter(Boolean);
                    console.log(`[${new Date().toISOString()}] [handleProposalRouteFromUrl] design link: ${cids.length} design(s)`, cids);
                    await handleSharedDesignRoute(cids);
                } else {
                    console.log(`[${new Date().toISOString()}] [handleProposalRouteFromUrl] agreement link`, agreementMatch[1]);
                    await window.AgreementSync.handleAgreementRoute(agreementMatch[1]);
                }
            } finally {
                releaseDeepLinkParcelFetch();
            }
            return;
        }

        const isProposalPath = pathname === '/proposals' || pathname.startsWith('/proposals/');

        // Ignore non-proposal routes entirely
        if (!isProposalPath) {
            return;
        }

        // The bare /proposals/ route (no ids) opens the proposal list.
        const isBareProposalsRoute = /^\/proposals\/?$/.test(pathname);
        if (isBareProposalsRoute) {
            if (typeof showAllProposalsModal === 'function') {
                console.debug('[handleProposalRouteFromUrl] Opening local proposals list for /proposals/');
                showAllProposalsModal();
            }
            return;
        }

        // Any other /proposals/… path is no route; js/app-routes.js marks it unknown. (Designs are
        // not minted: an agreement is, and its link is /agreements/<cid>.)
        console.warn(`[${new Date().toISOString()}] [handleProposalRouteFromUrl] no proposal route matches ${pathname}`);
    } catch (error) {
        console.error('handleProposalRouteFromUrl failed:', error);
        releaseDeepLinkParcelFetch();
        if (typeof updateStatus === 'function') updateStatus(getShareI18nHelper()(
            'plan.loadFailed', 'The linked plan or proposal could not be loaded. Please try again.'));
        if (typeof showEphemeralMessage === 'function') showEphemeralMessage(getShareI18nHelper()(
            'plan.loadFailed', 'The linked plan or proposal could not be loaded. Please try again.'), 8000, 'error');
    }
}


function selectProposalFromList(proposalIdOrHash, parcelId) {
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalIdOrHash);
        const t = getProposalI18nHelper();
        updateStatus(t('status.messages.error_proposal_not_found', 'Error: Proposal not found'));
        return;
    }

    selectAndHighlightProposal(getProposalKey(proposal) || proposalIdOrHash, parcelId, true);
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
