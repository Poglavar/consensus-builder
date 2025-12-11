(function (global) {
    'use strict';

    const PARCEL_OWNER_VALUE_ELEMENT_ID = 'parcel-owner-value';
    const parcelOwnerDataCache = new Map();
    let parcelOwnerRequestSequence = 0;
    let suppressOwnerAcceptanceRefresh = false;

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
            const rawName = owner && owner.name ? owner.name.trim() : '';
            const isPlaceholder = !!(owner && owner.placeholder);
            const isUnknown = /^unknown owner$/i.test(rawName);
            const name = (isPlaceholder || isUnknown || !rawName)
                ? fallbackLabel
                : rawName;
            const share = owner && owner.actualShareText ? owner.actualShareText.trim() : '';
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
        const path = normalizedCityId === 'buenos_aires'
            ? `/parcel-ba/${encodeURIComponent(parcelId)}/ownership`
            : normalizedCityId === 'belgrade'
                ? `/parcel-bg/${encodeURIComponent(parcelId)}/ownership`
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
        const fn = global.Parcels?.ownership?.extractOwnersFromOwnershipPayload;
        return typeof fn === 'function' ? fn(payload) : [];
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

        if (parcelOwnerDataCache.has(cacheKey)) {
            return parcelOwnerDataCache.get(cacheKey);
        }

        if (!shouldUseRealParcelOwners()) {
            parcelOwnerDataCache.set(cacheKey, []);
            return [];
        }

        let owners;
        try {
            owners = await fetchOwnersFromBackend(cacheKey);
        } catch (backendError) {
            if (backendError && backendError.statusCode === 404) {
                console.info('Ownership data not found for parcel', cacheKey);
                owners = [];
            } else if (global.supportsOssOwnership && global.supportsOssOwnership() && typeof global.getCurrentDataSource === 'function' && global.getCurrentDataSource() === 'oss.uredjenazemlja.hr') {
                console.warn('Backend ownership lookup failed, attempting OSS fallback', backendError);
                owners = await fetchOwnersFromOss(cacheKey);
            } else {
                console.warn('Backend ownership lookup failed and no fallback is available in this city', backendError);
                owners = [];
            }
        }
        let ownersList = Array.isArray(owners) ? owners.slice() : [];

        if (ownersList.length > 1) {
            ownersList = ownersList.map((record, index) => ({
                ...record,
                name: record && record.name ? record.name : `Owner ${index + 1}`,
                address: ''
            }));
        } else {
            const chainAddress = await fetchParcelNftOwnerAddress(cacheKey);
            const existing = ownersList[0] || {};
            const baseShare = existing.actualShareText || existing.ownership || existing.condoShare || '100%';
            const tParcelOwner = (typeof global !== 'undefined' && global.i18n && typeof global.i18n.t === 'function')
                ? (fallback => global.i18n.t('panel.parcel.owner.single', fallback))
                : (fallback => fallback);
            const singleOwnerLabel = tParcelOwner('Single owner');
            if (chainAddress) {
                ownersList = [{
                    name: singleOwnerLabel,
                    ownership: '1/1',
                    condoShare: '',
                    actualShareText: baseShare || '100%',
                    shareDetail: existing.shareDetail || '',
                    condoShareNumber: existing.condoShareNumber || '',
                    address: chainAddress
                }];
            } else if (ownersList.length === 1) {
                ownersList = [{
                    ...existing,
                    name: singleOwnerLabel,
                    ownership: existing.ownership || existing.actualShareText || '1/1',
                    actualShareText: existing.actualShareText || existing.ownership || '100%',
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

        parcelOwnerDataCache.set(cacheKey, ownersList);
        return ownersList;
    }

    async function fetchOwnerDataForParcel(parcelId, options = {}) {
        const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
        if (!normalizedId) {
            return { owners: [], slots: [] };
        }

        if (options.forceRefresh) {
            parcelOwnerDataCache.delete(normalizedId);
        }

        if (!shouldUseRealParcelOwners()) {
            const fallbackSlots = global.Parcels?.ownership?.getParcelOwnerSlots
                ? global.Parcels.ownership.getParcelOwnerSlots(normalizedId, { forceSimulated: true })
                : [];
            return { owners: [], slots: fallbackSlots };
        }

        try {
            const owners = await getRealParcelOwners(normalizedId);
            const slots = global.Parcels?.ownership?.mapOwnerRecordsToSlots
                ? global.Parcels.ownership.mapOwnerRecordsToSlots(normalizedId, owners)
                : [];
            return { owners, slots };
        } catch (error) {
            console.warn('fetchOwnerDataForParcel: owner lookup failed', error);
            const fallbackSlots = global.Parcels?.ownership?.getParcelOwnerSlots
                ? global.Parcels.ownership.getParcelOwnerSlots(normalizedId, { forceSimulated: true })
                : [];
            return { owners: [], slots: fallbackSlots };
        }
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
                if (!suppressOwnerAcceptanceRefresh && typeof global.refreshParcelOwnerAcceptanceUI === 'function') {
                    global.refreshParcelOwnerAcceptanceUI(parcelId);
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

    global.ParcelsOwnershipUi = {
        fetchAndDisplayRealOwners,
        refreshParcelOwnerAcceptanceUI,
        fetchOwnerDataForParcel,
        getRealParcelOwners,
        fetchOwnersFromBackend,
        fetchOwnersFromOss,
        buildOssOwnershipRequestUrls
    };
})(typeof window !== 'undefined' ? window : globalThis);

