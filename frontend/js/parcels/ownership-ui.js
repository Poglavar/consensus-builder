(function (global) {
    'use strict';

    const PARCEL_OWNER_VALUE_ELEMENT_ID = 'parcel-owner-value';
    const parcelOwnerDataCache = new Map();
    const parcelOwnerErrorCache = new Map(); // Cache for failed requests to avoid repeated warnings
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

    function formatPercentValue(value) {
        if (!Number.isFinite(value)) {
            return '';
        }
        const abs = Math.abs(value);
        const decimals = abs >= 10 ? 0 : (abs >= 1 ? 1 : 2);
        const formatted = value.toFixed(decimals);
        // Remove trailing zeros only after the decimal point, not from whole numbers
        const cleaned = formatted.includes('.') ? formatted.replace(/\.?0+$/, '') : formatted;
        return `${cleaned}%`;
    }

    function formatSharePercent(shareText) {
        const share = (shareText || '').toString().trim();
        if (!share) {
            return '';
        }
        if (share.endsWith('%')) {
            return share;
        }
        const parse = typeof global.parseFraction === 'function' ? global.parseFraction : null;
        if (parse && share.includes('/')) {
            const fraction = parse(share);
            if (fraction && Number.isFinite(fraction.numerator) && Number.isFinite(fraction.denominator) && fraction.denominator !== 0) {
                const pct = (fraction.numerator / fraction.denominator) * 100;
                if (Number.isFinite(pct)) {
                    return formatPercentValue(pct);
                }
            }
        }
        const num = Number(share);
        if (Number.isFinite(num)) {
            const pct = num <= 1 ? num * 100 : num;
            return formatPercentValue(pct);
        }
        return share;
    }

    function normalizeOwnerTypeString(raw = '') {
        const value = raw.toString().trim().toLowerCase();
        if (!value) return '';
        if (['gov', 'government', 'state', 'city', 'municipal', 'municipality', 'republic'].some(k => value.includes(k))) {
            return 'government';
        }
        if (['institution', 'university', 'school', 'hospital', 'church', 'faculty', 'institute'].some(k => value.includes(k))) {
            return 'institution';
        }
        if (['company', 'business', 'corp', 'corporation', 'firm', 'enterprise', 'd.o.o', 'd.o.o.', 'd.d', 'd.d.', 'llc', 'inc', 'gmbh', 'sa', 'spa'].some(k => value.includes(k))) {
            return 'company';
        }
        return 'individual';
    }

    function getOwnershipType(owner) {
        if (!owner) {
            return 'individual';
        }
        const explicitType = normalizeOwnerTypeString(owner.type || owner.ownerType || owner.ownershipType || owner.category || '');
        if (explicitType) {
            return explicitType;
        }
        const name = (owner.name || '').toString().toLowerCase();
        if (name) {
            const nameType = normalizeOwnerTypeString(name);
            if (nameType) {
                return nameType;
            }
        }
        return 'individual';
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
        if (parcelOwnerDataCache.has(normalizedId)) {
            return mapOwnerRecordsToSlots(normalizedId, parcelOwnerDataCache.get(normalizedId) || []);
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

        if (parcelOwnerDataCache.has(cacheKey)) {
            return parcelOwnerDataCache.get(cacheKey);
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
            parcelOwnerDataCache.set(cacheKey, []);
            return [];
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
            const fallbackSlots = getParcelOwnerSlots(normalizedId, { forceSimulated: true });
            return { owners: [], slots: fallbackSlots };
        }

        try {
            const owners = await getRealParcelOwners(normalizedId);
            const slots = mapOwnerRecordsToSlots(normalizedId, owners);
            return { owners, slots };
        } catch (error) {
            console.warn('fetchOwnerDataForParcel: owner lookup failed', error);
            const fallbackSlots = getParcelOwnerSlots(normalizedId, { forceSimulated: true });
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
    global.getParcelOwnerSlots = getParcelOwnerSlots;
    global.mapOwnerRecordsToSlots = mapOwnerRecordsToSlots;
    global.extractOwnersFromOwnershipPayload = extractOwnersFromOwnershipPayload;
    global.formatSharePercent = formatSharePercent;
    global.formatPercentValue = formatPercentValue;
    global.getOwnershipType = getOwnershipType;
    global.shouldUseRealParcelOwners = shouldUseRealParcelOwners;

    global.buildRealOwnerRowsHtml = buildRealOwnerRowsHtml;

    global.ParcelsOwnershipUi = {
        fetchAndDisplayRealOwners,
        refreshParcelOwnerAcceptanceUI,
        fetchOwnerDataForParcel,
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

