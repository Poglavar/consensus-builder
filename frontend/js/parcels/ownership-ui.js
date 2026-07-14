(function (global) {
    'use strict';

    const PARCEL_OWNER_VALUE_ELEMENT_ID = 'parcel-owner-value';
    const parcelOwnerErrorCache = new Map(); // Cache for failed requests to avoid repeated warnings
    let parcelOwnerRequestSequence = 0;
    let suppressOwnerAcceptanceRefresh = false;

    function getParcelStore() {
        if (global.ParcelsState && typeof global.ParcelsState.getParcelCache === 'function') {
            return global.ParcelsState.getParcelCache();
        }
        return global.parcelCache;
    }

    function getParcelFeatureFromStore(parcelId, options = {}) {
        const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
        if (!normalizedId) return null;

        const store = getParcelStore();
        if (store && store.byId instanceof Map && store.byId.has(normalizedId)) {
            return store.byId.get(normalizedId);
        }

        const layer = typeof global.resolveParcelLayerById === 'function'
            ? global.resolveParcelLayerById(normalizedId)
            : null;
        if (layer && layer.feature) {
            const feature = layer.feature;
            if (store && store.byId instanceof Map) {
                store.byId.set(normalizedId, feature);
            }
            return feature;
        }

        if (store && store.grid instanceof Map) {
            for (const cell of store.grid.values()) {
                if (!cell || !Array.isArray(cell.features)) continue;
                const found = cell.features.find(f => {
                    const props = f?.properties || {};
                    const fid = props.parcelId ?? props.parcel_id ?? props.id;
                    return fid && fid.toString() === normalizedId;
                });
                if (found) {
                    if (store.byId instanceof Map) {
                        store.byId.set(normalizedId, found);
                    }
                    return found;
                }
            }
        }

        if (options.createIfMissing && store && store.byId instanceof Map) {
            const stub = { type: 'Feature', properties: { parcelId: normalizedId }, geometry: null };
            store.byId.set(normalizedId, stub);
            return stub;
        }

        return null;
    }

    function deriveOwnersFromOwnershipList(list = []) {
        if (!Array.isArray(list) || list.length === 0) return null;
        return list.map((entry, index) => {
            const label = entry?.ownerLabel || entry?.name || entry?.possessorName || `Owner ${index + 1}`;
            const pct = Number.isFinite(entry?.percentage) ? entry.percentage : entry?.percentageShare;
            const shareText = Number.isFinite(pct) ? formatPercentValue(pct) : (entry?.actualShareText || entry?.ownership || entry?.shareText || '');
            return {
                name: label,
                ownerLabel: label,
                ownership: entry?.ownership || '',
                actualShareText: shareText,
                percentageShare: Number.isFinite(pct) ? pct : undefined,
                shareDetail: entry?.shareDetail || entry?.detail || ''
            };
        });
    }

    function normalizeOwnersForStore(owners = []) {
        if (!Array.isArray(owners)) return [];
        return owners.map((owner, index) => {
            const baseName = owner?.name || owner?.ownerLabel || owner?.possessorName || `Owner ${index + 1}`;
            const pct = Number.isFinite(owner?.percentageShare)
                ? owner.percentageShare
                : (Number.isFinite(owner?.percentage) ? owner.percentage : null);
            const shareText = owner?.actualShareText
                || owner?.ownership
                || owner?.shareText
                || (Number.isFinite(pct) ? formatPercentValue(pct) : '');

            return Object.assign({}, owner, {
                name: baseName,
                ownerLabel: owner?.ownerLabel || baseName,
                actualShareText: shareText,
                percentageShare: Number.isFinite(pct) ? pct : owner?.percentageShare,
                shareDetail: owner?.shareDetail || owner?.detail || ''
            });
        });
    }

    function buildOwnershipSummaryFromOwners(owners = []) {
        if (!Array.isArray(owners) || owners.length === 0) return null;
        const ownershipList = owners.map(owner => {
            const label = owner?.ownerLabel || owner?.name || owner?.possessorName || '';
            const pct = Number.isFinite(owner?.percentageShare)
                ? owner.percentageShare
                : (() => {
                    const share = owner?.actualShareText || owner?.ownership || '';
                    if (typeof share !== 'string') return null;
                    const num = Number(share.replace('%', '').trim());
                    return Number.isFinite(num) ? num : null;
                })();
            return {
                ownerLabel: label || '',
                percentage: pct
            };
        });

        const ownerTypes = ownershipList
            .map(entry => entry.ownerLabel)
            .filter(Boolean)
            .map(label => getOwnershipType({ name: label }))
            .filter(Boolean);
        const uniqueTypes = Array.from(new Set(ownerTypes));
        const ownershipType = uniqueTypes.length === 1
            ? uniqueTypes[0]
            : uniqueTypes.length > 1
                ? 'mixed'
                : undefined;

        return {
            ownershipList,
            ownershipType
        };
    }

    function getStoredParcelOwners(parcelId) {
        const feature = getParcelFeatureFromStore(parcelId);
        if (!feature || !feature.properties) return null;

        const details = feature.properties.ownershipDetails || {};
        if (Array.isArray(details.owners) && details.owners.length > 0) {
            return details.owners;
        }

        const ownershipList = Array.isArray(feature.properties.ownershipList)
            ? feature.properties.ownershipList
            : null;
        if (ownershipList && ownershipList.length > 0) {
            const derived = deriveOwnersFromOwnershipList(ownershipList) || [];
            if (derived.length) {
                feature.properties.ownershipDetails = Object.assign({}, details, { owners: derived });
                return derived;
            }
        }

        return null;
    }

    function setStoredParcelOwners(parcelId, owners = [], extras = {}) {
        const feature = getParcelFeatureFromStore(parcelId, { createIfMissing: true });
        if (!feature) return;
        feature.properties = feature.properties || {};
        const details = feature.properties.ownershipDetails || {};
        if (Array.isArray(owners)) {
            details.owners = normalizeOwnersForStore(owners);
        }
        if (extras.possessionSheets) {
            details.possessionSheets = extras.possessionSheets;
        }
        feature.properties.ownershipDetails = details;

        if (!feature.properties.ownershipList && Array.isArray(extras.ownershipList)) {
            feature.properties.ownershipList = extras.ownershipList;
        }
        if (!feature.properties.ownershipType && extras.ownershipType) {
            feature.properties.ownershipType = extras.ownershipType;
        }

        const store = getParcelStore();
        if (store && store.byId instanceof Map) {
            store.byId.set(parcelId.toString(), feature);
        }
    }

    function clearStoredParcelOwners(parcelId) {
        const feature = getParcelFeatureFromStore(parcelId);
        if (feature && feature.properties && feature.properties.ownershipDetails) {
            delete feature.properties.ownershipDetails.owners;
        }
    }

    function clearAllStoredParcelOwners() {
        const store = getParcelStore();
        if (store && store.byId instanceof Map) {
            store.byId.forEach(feature => {
                if (feature && feature.properties && feature.properties.ownershipDetails) {
                    delete feature.properties.ownershipDetails.owners;
                }
            });
        }
    }

    const parcelOwnerDataCache = {
        get(key) {
            return getStoredParcelOwners(key);
        },
        has(key) {
            const owners = getStoredParcelOwners(key);
            return Array.isArray(owners) && owners.length > 0;
        },
        set(key, value) {
            setStoredParcelOwners(key, Array.isArray(value) ? value.slice() : []);
            return this;
        },
        delete(key) {
            clearStoredParcelOwners(key);
            return true;
        },
        clear() {
            clearAllStoredParcelOwners();
            return this;
        }
    };

    function isGameModeActive() {
        return typeof global.gameState !== 'undefined' && global.gameState && !!global.gameState.isRunning;
    }

    function shouldUseRealParcelOwners() {
        if (isGameModeActive()) {
            return false;
        }
        if (typeof global.getCurrentDataSource !== 'function') {
            return false;
        }
        const source = global.getCurrentDataSource();
        return source === 'oss.uredjenazemlja.hr'
            || source === 'localhost'
            || source === 'api.urbangametheory.xyz';
    }

    // The formatters live in frontend/js/parcels/share-format.js (loaded first) so the panel and
    // this file cannot drift. Bind to the shared globals; delegation reads them at IIFE-run time,
    // after that script has run.
    const formatPercentValue = global.formatPercentValue;
    const formatSharePercent = global.formatSharePercent;

    function normalizeOwnerTypeString(raw = '') {
        const value = raw.toString().trim();
        if (!value) return '';

        const classifier = typeof global.classifyOwnershipLabel === 'function'
            ? global.classifyOwnershipLabel
            : null;
        if (classifier) {
            return classifier(value);
        }

        const normalized = value.toLowerCase();
        if (['gov', 'government', 'state', 'city', 'municipal', 'municipality', 'republic'].some(k => normalized.includes(k))) {
            return 'government';
        }
        if (['institution', 'university', 'school', 'hospital', 'church', 'faculty', 'institute'].some(k => normalized.includes(k))) {
            return 'institution';
        }
        if (['company', 'business', 'corp', 'corporation', 'firm', 'enterprise', 'd.o.o', 'd.o.o.', 'd.d', 'd.d.', 'llc', 'inc', 'gmbh', 'sa', 'spa'].some(k => normalized.includes(k))) {
            return 'company';
        }
        return 'private individual';
    }

    function getOwnershipType(owner) {
        if (!owner) {
            return 'private individual';
        }
        const explicitType = normalizeOwnerTypeString(owner.type || owner.ownerType || owner.ownershipType || owner.category || '');
        if (explicitType) {
            return explicitType;
        }
        const name = (typeof owner === 'string'
            ? owner
            : (owner.name || owner.ownerLabel || owner.label || owner.possessorName || '')
        ).toString();
        if (name) {
            const nameType = normalizeOwnerTypeString(name);
            if (nameType) {
                return nameType;
            }
        }
        return 'private individual';
    }

    function extractOwnersFromOwnershipPayload(payload) {
        const sheets = Array.isArray(payload?.possessionSheets) ? payload.possessionSheets : [];
        const result = [];
        const parseFraction = typeof global.parseFraction === 'function' ? global.parseFraction : null;
        const computePortion = typeof global.computeCondominiumSharePortion === 'function'
            ? global.computeCondominiumSharePortion
            : null;

        sheets.forEach(sheet => {
            const possessors = Array.isArray(sheet?.possessors) ? sheet.possessors : [];
            possessors.forEach((possessor, index) => {
                const rawName = (possessor?.name || possessor?.possessorName || '').trim();
                if (!rawName) {
                    return;
                }
                const ownershipRaw = (possessor?.actualShareText
                    || possessor?.ownership
                    || possessor?.condominiumShareOwnership
                    || possessor?.condominiumShareNumber
                    || '').toString().trim();
                const condoShareRaw = (possessor?.condominiumShareOwnership
                    || possessor?.condominiumShareNumber
                    || '').toString().trim();
                const ownershipFraction = parseFraction ? parseFraction(ownershipRaw) : null;
                const condoFraction = parseFraction ? parseFraction(condoShareRaw) : null;

                let actualShareText = ownershipRaw || condoShareRaw || '';
                let shareDetail = '';

                if (computePortion && (ownershipFraction || condoFraction)) {
                    const portion = computePortion(ownershipFraction, condoFraction);
                    if (portion) {
                        if (portion.display) {
                            actualShareText = portion.display;
                        }
                        if (portion.detail) {
                            shareDetail = portion.detail;
                        }
                    }
                } else if (ownershipRaw && condoShareRaw && ownershipRaw !== condoShareRaw) {
                    shareDetail = `${ownershipRaw} of ${condoShareRaw}`;
                }

                const displayShare = formatSharePercent(actualShareText) || actualShareText || ownershipRaw || condoShareRaw || '';

                result.push({
                    name: rawName,
                    ownership: ownershipRaw || condoShareRaw || '',
                    actualShareText: displayShare,
                    shareDetail,
                    condoShareNumber: (possessor?.condominiumShareNumber || '').toString().trim(),
                    address: (possessor?.address || possessor?.place || '').trim(),
                    index
                });
            });
        });

        if (!result.length && Array.isArray(payload?.owners)) {
            return payload.owners.map((owner, idx) => ({
                name: (owner?.name || '').trim() || `Owner ${idx + 1}`,
                ownership: (owner?.ownership || owner?.actualShareText || '').toString().trim(),
                actualShareText: (owner?.actualShareText || owner?.ownership || '').toString().trim(),
                shareDetail: (owner?.shareDetail || '').toString().trim(),
                condoShareNumber: (owner?.condoShareNumber || '').toString().trim(),
                address: (owner?.address || '').toString().trim(),
                index: idx
            }));
        }

        return result;
    }

    function mapOwnerRecordsToSlots(parcelId, owners = []) {
        const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
        if (!normalizedId) {
            return [];
        }
        const list = Array.isArray(owners) ? owners : [];
        const seen = new Set();

        if (!list.length) {
            const fallback = global.tParcel
                ? global.tParcel('panel.parcel.owner.single', {}, 'Single owner')
                : 'Single owner';
            return [{
                key: `parcel:${normalizedId}:owner`,
                displayName: fallback,
                shareText: '100%',
                shareDetail: '',
                type: 'unknown',
                agentId: null,
                placeholder: true
            }];
        }

        return list.map((owner, idx) => {
            const displayName = (owner && owner.name) ? owner.name : `Owner ${idx + 1}`;
            const keyBase = (owner?.address || displayName || `owner-${idx + 1}`)
                .toString()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            let key = `parcel:${normalizedId}:owner:${keyBase || idx + 1}`;
            let suffix = 2;
            while (seen.has(key)) {
                key = `parcel:${normalizedId}:owner:${keyBase || idx + 1}-${suffix++}`;
            }
            seen.add(key);

            const displayShare = formatSharePercent(owner?.actualShareText || owner?.ownership || '');

            return {
                key,
                displayName,
                shareText: displayShare || (owner?.actualShareText || owner?.ownership || '').toString(),
                shareDetail: (owner?.shareDetail || '').toString(),
                type: 'human',
                agentId: owner?.address || null,
                placeholder: false
            };
        });
    }

    function getParcelOwnerSlots(parcelId, options = {}) {
        const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
        if (!normalizedId) {
            return [];
        }
        if (options.forceSimulated) {
            return mapOwnerRecordsToSlots(normalizedId, []);
        }
        const storedOwners = getStoredParcelOwners(normalizedId);
        if (Array.isArray(storedOwners) && storedOwners.length > 0) {
            return mapOwnerRecordsToSlots(normalizedId, storedOwners);
        }
        return mapOwnerRecordsToSlots(normalizedId, []);
    }

    async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                if (response.ok) {
                    return response;
                }
                if (response.status >= 400 && response.status < 500) {
                    lastError = new Error(`Failed to fetch parcel data with client error: ${response.status}`);
                    break;
                }
                lastError = new Error(`Server error: ${response.status}`);
            } catch (error) {
                lastError = error;
            }
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    function buildRealOwnerRowsHtml(owners) {
        const fallbackLabel = global.tParcel
            ? global.tParcel('panel.parcel.owner.single', {}, 'Single owner')
            : 'Single owner';
        const normalizedOwners = Array.isArray(owners) && owners.length > 0
            ? owners
            : [{ name: fallbackLabel, actualShareText: '100%', shareDetail: '', placeholder: true }];

        return normalizedOwners.map(owner => {
            // Handle both name and ownerLabel (backend format)
            const rawName = (owner && owner.name ? owner.name.trim() : '')
                || (owner && owner.ownerLabel ? owner.ownerLabel.trim() : '');
            const isPlaceholder = !!(owner && owner.placeholder);
            const isUnknown = /^unknown owner$/i.test(rawName);
            const name = (isPlaceholder || isUnknown || !rawName)
                ? fallbackLabel
                : rawName;

            // Handle both actualShareText and percentageShare (backend format)
            // Always prefer percentageShare if it exists, as it's the authoritative source from backend
            let share = '';
            if (owner && Number.isFinite(owner.percentageShare)) {
                // Convert percentageShare to formatted string
                // percentageShare is already in 0-100 range, use formatPercentValue directly
                const pctValue = owner.percentageShare;
                // Ensure we're working with the actual numeric value, not a string
                const numValue = typeof pctValue === 'string' ? parseFloat(pctValue) : pctValue;
                if (Number.isFinite(numValue)) {
                    share = formatPercentValue(numValue);
                }
            }
            if (!share && owner && owner.actualShareText) {
                share = owner.actualShareText.trim();
            }

            const shareDetail = owner && owner.shareDetail ? owner.shareDetail.trim() : '';
            const safeName = typeof global.escapeHtml === 'function' ? global.escapeHtml(name) : name;
            const fallbackShare = owner && owner.placeholder ? '100%' : '';
            const safeShare = (share || fallbackShare)
                ? (typeof global.escapeHtml === 'function' ? global.escapeHtml(share || fallbackShare) : (share || fallbackShare))
                : '';
            const safeDetail = shareDetail ? (typeof global.escapeHtml === 'function' ? global.escapeHtml(shareDetail) : shareDetail) : '';
            const shareHtml = safeShare
                ? `<span style="color: #666; font-size: 0.9em;"${safeDetail ? ` title="${safeDetail}"` : ''}>${safeShare}</span>`
                : '';
            return `
            <div class="owner-row" style="display: flex; justify-content: space-between; gap: 8px;">
                <span>${safeName || (global.tParcel ? global.tParcel('common.unknownOwner', {}, 'Unknown owner') : 'Unknown owner')}</span>
                ${shareHtml}
            </div>
        `;
        }).join('');
    }

    async function fetchOwnersFromBackend(parcelId) {
        if (typeof global.getBackendBase !== 'function') {
            throw new Error('Backend base helper unavailable for ownership lookup');
        }
        const backendBase = global.getBackendBase();
        if (!backendBase) {
            throw new Error('Backend base is not configured');
        }

        const normalizedCityId = global.getCurrentCityId ? global.getCurrentCityId() : null;
        let smpForPath = parcelId;

        // For Buenos Aires, strip the "AR-" prefix from parcel IDs
        // Backend expects SMP format like "002-043-022", not "AR-002-043-022"
        if (normalizedCityId === 'buenos_aires') {
            const parcelIdStr = (parcelId || '').toString().trim();
            if (parcelIdStr.startsWith('AR-')) {
                smpForPath = parcelIdStr.substring(3);
            }
        }

        // For Zagreb, use parcelId as-is (don't add or strip HR- prefix)
        const path = normalizedCityId === 'buenos_aires'
            ? `/parcel-ba/${encodeURIComponent(smpForPath)}/ownership`
            : normalizedCityId === 'belgrade'
                ? `/parcel-bg/${encodeURIComponent(parcelId)}/ownership`
                : normalizedCityId === 'colorado'
                    ? `/parcel-co/${encodeURIComponent(parcelId)}/ownership`
                    : normalizedCityId === 'new_york'
                        ? `/parcel-nyc/${encodeURIComponent(parcelId)}/ownership`
                        : `/parcels/${encodeURIComponent(parcelId)}/ownership`;
        const url = `${backendBase.replace(/\/$/, '')}${path}`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const error = new Error(`Backend ownership lookup failed (${response.status})`);
            error.statusCode = response.status;
            throw error;
        }

        const payload = await response.json();
        return extractOwnersFromOwnershipPayload(payload);
    }

    function buildOssOwnershipRequestUrls(parcelId) {
        const normalizedParcelId = (parcelId || '').toString().trim();
        if (!normalizedParcelId) {
            return [];
        }

        const base = new URL(global.OSS_OWNERSHIP_ENDPOINT || 'https://oss.uredjenazemlja.hr/oss/public/cad/parcel-info');
        base.searchParams.set('parcelId', normalizedParcelId);
        if (global.OSS_PUBLIC_ACCESS_TOKEN) {
            base.searchParams.set('token', global.OSS_PUBLIC_ACCESS_TOKEN);
        }
        const fullUrl = base.toString();
        const targets = Array.isArray(global.OSS_OWNERSHIP_PROXY_TARGETS) ? global.OSS_OWNERSHIP_PROXY_TARGETS : ['direct'];

        return targets.map(target => {
            if (target === 'direct') {
                return fullUrl;
            }
            if (target.endsWith('fetch/')) {
                return `${target}${fullUrl}`;
            }
            return `${target}${encodeURIComponent(fullUrl)}`;
        });
    }

    async function fetchOwnersFromOss(parcelId) {
        const candidates = buildOssOwnershipRequestUrls(parcelId);
        if (!candidates.length) {
            return [];
        }

        let payload = null;
        let lastError = null;
        for (const url of candidates) {
            try {
                const response = await fetchWithRetry(url, {
                    headers: {
                        'Accept': 'application/json'
                    }
                }, 1, 500);

                if (!response.ok) {
                    lastError = new Error(`OSS ownership lookup failed (${response.status})`);
                    continue;
                }

                payload = await response.json();
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                console.warn('OSS ownership fetch candidate failed', url, error);
            }
        }

        if (!payload) {
            throw lastError || new Error('OSS ownership lookup failed');
        }

        const fn = global.Parcels?.ownership?.extractOwnersFromOwnershipPayload;
        return typeof fn === 'function' ? fn(payload) : [];
    }

    async function getRealParcelOwners(parcelId) {
        const cacheKey = parcelId ? parcelId.toString() : '';
        if (!cacheKey) {
            return [];
        }

        const storedOwners = getStoredParcelOwners(cacheKey);
        if (Array.isArray(storedOwners) && storedOwners.length > 0) {
            return storedOwners;
        }

        // Synthetic parcel ids (descendants minted by proposal apply, e.g. "HR-X-123#5-2")
        // cannot be looked up on the backend — the cadastre only knows original parcels.
        // Their ownership is inherited from the ancestor at apply time and persisted locally;
        // if we got here without stored owners that means apply did not populate them.
        // Either way, hitting the backend is guaranteed to 404. Return empty and stay silent.
        const isSynthetic = typeof global.ProposalManager !== 'undefined'
            && typeof global.ProposalManager.isSyntheticParcelId === 'function'
            && global.ProposalManager.isSyntheticParcelId(cacheKey);
        if (isSynthetic) {
            setStoredParcelOwners(cacheKey, []);
            return [];
        }

        // Check if we've already failed for this parcel (suppress repeated warnings)
        if (parcelOwnerErrorCache.has(cacheKey)) {
            const errorInfo = parcelOwnerErrorCache.get(cacheKey);
            // For 400 errors, return empty array without logging
            if (errorInfo.statusCode === 400) {
                return [];
            }
        }

        if (!shouldUseRealParcelOwners()) {
            setStoredParcelOwners(cacheKey, []);
            return getStoredParcelOwners(cacheKey) || [];
        }

        let owners;
        try {
            owners = await fetchOwnersFromBackend(cacheKey);
        } catch (backendError) {
            const statusCode = backendError && backendError.statusCode;

            // Cache 400 errors to suppress repeated warnings
            if (statusCode === 400) {
                parcelOwnerErrorCache.set(cacheKey, { statusCode: 400, timestamp: Date.now() });
                owners = [];
                // Don't log 400 errors - they're expected for some parcels
            } else if (statusCode === 404) {
                console.info('Ownership data not found for parcel', cacheKey);
                parcelOwnerErrorCache.set(cacheKey, { statusCode: 404, timestamp: Date.now() });
                owners = [];
            } else if (global.supportsOssOwnership && global.supportsOssOwnership()) {
                // Only log OSS fallback attempt once per parcel
                if (!parcelOwnerErrorCache.has(cacheKey)) {
                    console.warn('Backend ownership lookup failed, attempting OSS fallback', backendError);
                }
                parcelOwnerErrorCache.set(cacheKey, { statusCode: statusCode || 'unknown', timestamp: Date.now() });
                try {
                    owners = await fetchOwnersFromOss(cacheKey);
                    // Clear error cache on success
                    parcelOwnerErrorCache.delete(cacheKey);
                } catch (ossError) {
                    owners = [];
                }
            } else {
                // Only log other errors once per parcel
                if (!parcelOwnerErrorCache.has(cacheKey)) {
                    console.warn('Backend ownership lookup failed and no fallback is available in this city', backendError);
                }
                parcelOwnerErrorCache.set(cacheKey, { statusCode: statusCode || 'unknown', timestamp: Date.now() });
                owners = [];
            }
        }

        // Clear error cache on successful fetch
        if (owners && Array.isArray(owners) && owners.length > 0) {
            parcelOwnerErrorCache.delete(cacheKey);
        }

        let ownersList = Array.isArray(owners) ? owners.slice() : [];

        if (ownersList.length > 1) {
            ownersList = ownersList.map((record, index) => ({
                ...record,
                name: record && record.name ? record.name : `Owner ${index + 1}`,
                address: ''
            }));
        } else {
            const chainAddress = typeof fetchParcelNftOwnerAddress === 'function'
                ? await fetchParcelNftOwnerAddress(cacheKey)
                : null;
            const existing = ownersList[0] || {};
            const baseShare = existing.actualShareText || existing.ownership || existing.condoShare || '100%';
            const displayShare = formatSharePercent(baseShare) || baseShare;
            const tParcelOwner = (typeof global !== 'undefined' && global.i18n && typeof global.i18n.t === 'function')
                ? (fallback => global.i18n.t('panel.parcel.owner.single', fallback))
                : (fallback => fallback);
            const singleOwnerLabel = tParcelOwner('Single owner');
            if (chainAddress) {
                ownersList = [{
                    name: singleOwnerLabel,
                    ownership: '1/1',
                    condoShare: '',
                    actualShareText: displayShare || '100%',
                    shareDetail: existing.shareDetail || '',
                    condoShareNumber: existing.condoShareNumber || '',
                    address: chainAddress
                }];
            } else if (ownersList.length === 1) {
                ownersList = [{
                    ...existing,
                    name: singleOwnerLabel,
                    ownership: existing.ownership || existing.actualShareText || '1/1',
                    actualShareText: formatSharePercent(existing.actualShareText || existing.ownership || '') || existing.actualShareText || existing.ownership || '100%',
                    address: existing.address || ''
                }];
            } else {
                ownersList = [{
                    name: singleOwnerLabel,
                    ownership: '1/1',
                    condoShare: '',
                    actualShareText: '100%',
                    shareDetail: '',
                    condoShareNumber: '',
                    address: chainAddress || ''
                }];
            }
        }

        const summary = buildOwnershipSummaryFromOwners(ownersList) || {};
        setStoredParcelOwners(cacheKey, ownersList, summary);
        return getStoredParcelOwners(cacheKey) || ownersList;
    }

    async function fetchOwnerDataForParcel(parcelId, options = {}) {
        const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
        if (!normalizedId) {
            return { owners: [], slots: [] };
        }

        if (options.forceRefresh) {
            clearStoredParcelOwners(normalizedId);
        }

        const existingOwners = getStoredParcelOwners(normalizedId) || [];

        if (!shouldUseRealParcelOwners()) {
            if (existingOwners.length > 0) {
                const slots = mapOwnerRecordsToSlots(normalizedId, existingOwners);
                return { owners: existingOwners, slots };
            }
            const fallbackSlots = getParcelOwnerSlots(normalizedId, { forceSimulated: true });
            return { owners: [], slots: fallbackSlots };
        }

        try {
            const owners = await getRealParcelOwners(normalizedId);
            const slots = mapOwnerRecordsToSlots(normalizedId, owners);
            return { owners, slots };
        } catch (error) {
            console.warn('fetchOwnerDataForParcel: owner lookup failed', error);
            if (existingOwners.length > 0) {
                const slots = mapOwnerRecordsToSlots(normalizedId, existingOwners);
                return { owners: existingOwners, slots };
            }
            const fallbackSlots = getParcelOwnerSlots(normalizedId, { forceSimulated: true });
            return { owners: [], slots: fallbackSlots };
        }
    }

    async function ensureParcelOwnerSlots(parcelId, options = {}) {
        const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
        if (!normalizedId) {
            return [];
        }

        const forceRefresh = options.forceRefresh === true;
        if (forceRefresh) {
            clearStoredParcelOwners(normalizedId);
        }

        const cachedSlots = getParcelOwnerSlots(normalizedId);
        if (Array.isArray(cachedSlots) && cachedSlots.length && !forceRefresh) {
            return cachedSlots;
        }

        try {
            const { slots } = await fetchOwnerDataForParcel(normalizedId, { forceRefresh });
            if (Array.isArray(slots) && slots.length) {
                return slots;
            }
        } catch (error) {
            console.warn('ensureParcelOwnerSlots: failed to ensure owners for parcel', normalizedId, error);
        }

        return getParcelOwnerSlots(normalizedId, { forceSimulated: true });
    }

    function fetchAndDisplayRealOwners(parcelId, options = {}) {
        const target = document.getElementById(PARCEL_OWNER_VALUE_ELEMENT_ID);
        if (!target || !parcelId) {
            return;
        }

        const fallbackHtml = options.fallbackHtml || '';
        const hasSimulatedOwner = !!options.hasSimulatedOwner;
        const requestId = ++parcelOwnerRequestSequence;

        const updateOwnersCount = (count) => {
            const countElement = document.getElementById('parcel-owners-count');
            if (countElement) {
                countElement.removeAttribute('role');
                countElement.removeAttribute('aria-label');
                countElement.textContent = count !== undefined && count !== null ? count.toString() : '-';
            }
        };

        const updateOwnershipTypeLabel = (owners) => {
            const ownershipTypeLabelEl = document.querySelector('.parcel-ownership-type-label');
            if (!ownershipTypeLabelEl) {
                return;
            }
            if (!Array.isArray(owners) || owners.length === 0) {
                ownershipTypeLabelEl.style.display = 'none';
                return;
            }
            const types = owners.map(owner => getOwnershipType(owner)).filter(Boolean);
            const uniqueTypes = Array.from(new Set(types));
            const tParcel = global.tParcel || (() => '');
            let typeLabel = '';
            let typeForClass = '';

            if (uniqueTypes.length === 1) {
                const type = uniqueTypes[0];
                typeForClass = type;
                typeLabel = tParcel(`panel.parcel.ownershipType.${type}`, {}, type === 'government' ? 'Government' : type === 'institution' ? 'Institution' : type === 'company' ? 'Company' : 'Individual');
            } else if (uniqueTypes.length > 1) {
                typeForClass = 'mixed';
                typeLabel = tParcel('panel.parcel.ownershipType.mixed', {}, 'Mixed');
            }

            if (typeLabel) {
                ownershipTypeLabelEl.textContent = typeLabel;
                ownershipTypeLabelEl.style.display = 'inline-block';

                // Add color class based on ownership type
                // Remove any existing ownership type classes
                ownershipTypeLabelEl.classList.remove(
                    'ownership-type-government',
                    'ownership-type-institution',
                    'ownership-type-company',
                    'ownership-type-mixed',
                    'ownership-type-individual'
                );

                // Normalize and add class
                if (typeForClass) {
                    const normalizedType = typeForClass === 'private individual' ? 'individual' : typeForClass;
                    ownershipTypeLabelEl.classList.add(`ownership-type-${normalizedType}`);
                }
            } else {
                ownershipTypeLabelEl.style.display = 'none';
            }
        };

        getRealParcelOwners(parcelId)
            .then(owners => {
                if (requestId !== parcelOwnerRequestSequence) {
                    return;
                }
                const ownerCount = Array.isArray(owners) ? owners.length : 0;
                if (isGameModeActive()) {
                    target.innerHTML = fallbackHtml || buildRealOwnerRowsHtml([]);
                    updateOwnersCount(0);
                    return;
                }
                target.innerHTML = buildRealOwnerRowsHtml(owners);
                updateOwnersCount(ownerCount);
                updateOwnershipTypeLabel(owners);
                if (!suppressOwnerAcceptanceRefresh && typeof global.refreshParcelOwnerAcceptanceUI === 'function') {
                    global.refreshParcelOwnerAcceptanceUI(parcelId);
                }
                // Refresh owner count labels if visible
                if (typeof global.Parcels?.uiOwnerCounts?.refreshOwnerCountLabelsIfVisible === 'function') {
                    global.Parcels.uiOwnerCounts.refreshOwnerCountLabelsIfVisible();
                } else if (typeof global.refreshOwnerCountLabelsIfVisible === 'function') {
                    global.refreshOwnerCountLabelsIfVisible();
                }
            })
            .catch(error => {
                console.warn('Failed to load real owner data', error);
                if (requestId !== parcelOwnerRequestSequence) {
                    return;
                }
                if (isGameModeActive()) {
                    target.innerHTML = fallbackHtml || buildRealOwnerRowsHtml([]);
                    updateOwnersCount(0);
                    updateOwnershipTypeLabel([]);
                    return;
                }
                const fallbackSection = fallbackHtml
                    ? (hasSimulatedOwner
                        ? `<div class="owner-fallback-label" style="margin-top: 6px; font-size: 0.85em; color: #666;">${global.tParcel ? global.tParcel('panel.parcel.owner.simulated', {}, 'Simulated owner') : 'Simulated owner'}</div>${fallbackHtml}`
                        : `<div style="margin-top: 6px; color: #666;">${fallbackHtml}</div>`)
                    : buildRealOwnerRowsHtml([]);
                target.innerHTML = `<span class="owner-error" style="color: #c0392b;">${global.tParcel ? global.tParcel('panel.parcel.owner.error', {}, 'Unable to load real owner data.') : 'Unable to load real owner data.'}</span>${fallbackSection}`;
                const fallbackCount = fallbackHtml ? 1 : 0;
                updateOwnersCount(fallbackCount);
                updateOwnershipTypeLabel([]);
            });
    }

    const uiParcelPanel = (global.Parcels && global.Parcels.uiParcelPanel) ? global.Parcels.uiParcelPanel : (global.ParcelsUIParcelPanel || {});

    function refreshParcelOwnerAcceptanceUI(parcelId) {
        if (!parcelId) {
            return;
        }
        const activeParcel = global.currentParcel;
        if (activeParcel && activeParcel.id && activeParcel.layer && activeParcel.id.toString() === parcelId.toString()) {
            try {
                suppressOwnerAcceptanceRefresh = true;
                const showParcelInfoPanel = uiParcelPanel.showParcelInfoPanel || global.showParcelInfoPanel;
                if (typeof showParcelInfoPanel === 'function') {
                    showParcelInfoPanel(activeParcel.layer.feature);
                }
            } catch (error) {
                console.warn('refreshParcelOwnerAcceptanceUI: failed to refresh panel', error);
            } finally {
                setTimeout(() => {
                    suppressOwnerAcceptanceRefresh = false;
                }, 0);
            }
        }
    }

    global.fetchAndDisplayRealOwners = fetchAndDisplayRealOwners;
    global.refreshParcelOwnerAcceptanceUI = refreshParcelOwnerAcceptanceUI;
    global.fetchOwnerDataForParcel = fetchOwnerDataForParcel;
    global.ensureParcelOwnerSlots = ensureParcelOwnerSlots;
    global.getParcelOwnerSlots = getParcelOwnerSlots;
    global.mapOwnerRecordsToSlots = mapOwnerRecordsToSlots;
    global.extractOwnersFromOwnershipPayload = extractOwnersFromOwnershipPayload;
    // formatSharePercent / formatPercentValue are owned by share-format.js (loaded first).
    global.getOwnershipType = getOwnershipType;
    global.shouldUseRealParcelOwners = shouldUseRealParcelOwners;

    global.buildRealOwnerRowsHtml = buildRealOwnerRowsHtml;

    global.ParcelsOwnershipUi = {
        fetchAndDisplayRealOwners,
        refreshParcelOwnerAcceptanceUI,
        fetchOwnerDataForParcel,
        ensureParcelOwnerSlots,
        getRealParcelOwners,
        fetchOwnersFromBackend,
        fetchOwnersFromOss,
        buildOssOwnershipRequestUrls,
        getParcelOwnerSlots,
        mapOwnerRecordsToSlots,
        extractOwnersFromOwnershipPayload,
        formatSharePercent,
        formatPercentValue,
        getOwnershipType,
        shouldUseRealParcelOwners,
        buildRealOwnerRowsHtml,
        parcelOwnerDataCache
    };
})(typeof window !== 'undefined' ? window : globalThis);
