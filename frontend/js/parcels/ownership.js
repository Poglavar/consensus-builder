(function (global) {
    'use strict';

    const OSS_PUBLIC_ACCESS_TOKEN = global.OSS_PUBLIC_ACCESS_TOKEN || '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
    const OSS_OWNERSHIP_ENDPOINT = 'https://oss.uredjenazemlja.hr/oss/public/cad/parcel-info';

    const ownershipCache = new Map();
    const ownershipErrors = new Map();
    const ownershipRequestsInProgress = new Map();
    const FRACTION_REGEX = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;

    function simplifyFraction(fraction) {
        if (!fraction || !Number.isFinite(fraction.numerator) || !Number.isFinite(fraction.denominator) || fraction.denominator === 0) {
            return null;
        }
        const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
        const divisor = Math.abs(gcd(Math.abs(fraction.numerator), Math.abs(fraction.denominator))) || 1;
        return {
            numerator: fraction.numerator / divisor,
            denominator: fraction.denominator / divisor
        };
    }

    function formatFraction(fraction) {
        const simplified = simplifyFraction(fraction);
        if (!simplified) return '';
        return `${simplified.numerator}/${simplified.denominator}`;
    }

    function multiplyFractions(a, b) {
        if (!a || !b) return null;
        return {
            numerator: a.numerator * b.numerator,
            denominator: a.denominator * b.denominator
        };
    }

    function parseFraction(value) {
        if (!value || typeof value !== 'string') return null;
        const match = value.match(FRACTION_REGEX);
        if (!match) return null;
        const numerator = Number(match[1]);
        const denominator = Number(match[2]);
        if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
            return null;
        }
        return { numerator, denominator };
    }

    function computeCondominiumSharePortion(ownershipFraction, condoFraction) {
        if (!condoFraction) return { display: '', detail: '' };
        let product = condoFraction;
        let detail = '';
        const condoText = formatFraction(condoFraction);
        if (ownershipFraction) {
            product = multiplyFractions(ownershipFraction, condoFraction) || condoFraction;
            if (ownershipFraction.numerator !== ownershipFraction.denominator) {
                const ownershipText = formatFraction(ownershipFraction);
                if (ownershipText && condoText) {
                    detail = `${ownershipText} of ${condoText}`;
                }
            }
        }
        if (!product) {
            return { display: condoText || '', detail };
        }
        const baseDenominator = condoFraction.denominator;
        const combinedDenominator = product.denominator;
        if (baseDenominator && combinedDenominator % baseDenominator === 0) {
            const scale = combinedDenominator / baseDenominator;
            if (scale !== 0 && Number.isFinite(scale)) {
                const adjustedNumerator = product.numerator / scale;
                if (Number.isFinite(adjustedNumerator)) {
                    return { display: `${adjustedNumerator}/${baseDenominator}`, detail };
                }
            }
        }
        return { display: formatFraction(product) || condoText || '', detail };
    }

    async function fetchOwnershipDetails(parcelId, options = {}) {
        if (global.CityConfigManager?.getCurrentCityConfig?.()?.parcels?.ownership === false) return null;
        const normalizedParcelId = global.normalizeParcelIdValue ? global.normalizeParcelIdValue(parcelId) : parcelId;
        if (!normalizedParcelId) throw new Error('Invalid parcelId');
        const bypassCache = options.bypassCache || false;
        if (!bypassCache && ownershipCache.has(normalizedParcelId)) {
            return ownershipCache.get(normalizedParcelId);
        }
        if (ownershipErrors.has(normalizedParcelId) && !options.forceRetry) {
            return null;
        }
        const existingPromise = ownershipRequestsInProgress.get(normalizedParcelId);
        if (existingPromise) return existingPromise;

        const requestPromise = (async () => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                const url = `${OSS_OWNERSHIP_ENDPOINT}?parcel=${encodeURIComponent(normalizedParcelId)}&cadastralParcelId=${encodeURIComponent(normalizedParcelId)}&token=${OSS_PUBLIC_ACCESS_TOKEN}`;
                const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, signal: controller.signal });
                clearTimeout(timeout);
                if (!response.ok) throw new Error(`Network response was not ok: ${response.statusText}`);
                const data = await response.json();
                ownershipCache.set(normalizedParcelId, data);
                ownershipErrors.delete(normalizedParcelId);
                return data;
            } catch (error) {
                ownershipErrors.set(normalizedParcelId, error);
                throw error;
            } finally {
                ownershipRequestsInProgress.delete(normalizedParcelId);
            }
        })();

        ownershipRequestsInProgress.set(normalizedParcelId, requestPromise);
        return requestPromise;
    }

    async function fetchOwnerDataForParcel(parcelId, parcelData) {
        const normalizedParcelId = global.normalizeParcelIdValue ? global.normalizeParcelIdValue(parcelId) : parcelId;
        if (!normalizedParcelId) {
            throw new Error('Invalid parcelId');
        }
        if (ownershipCache.has(normalizedParcelId)) {
            return ownershipCache.get(normalizedParcelId);
        }
        const data = await fetchOwnershipDetails(normalizedParcelId);
        if (data) {
            ownershipCache.set(normalizedParcelId, data);
        }
        return data;
    }

    function updateOwnershipCache(parcelId, ownershipData) {
        const normalizedParcelId = global.normalizeParcelIdValue ? global.normalizeParcelIdValue(parcelId) : parcelId;
        if (!normalizedParcelId) return;
        ownershipCache.set(normalizedParcelId, ownershipData);
        ownershipErrors.delete(normalizedParcelId);
    }

    function clearOwnershipCache() {
        ownershipCache.clear();
        ownershipErrors.clear();
        ownershipRequestsInProgress.clear();
    }

    // Which parcel source issued this parcel id, from the city's parcels config. A database-backed
    // city names its provider in `source` (oss-wfs, parcel-ba, ...); a catalog-backed city
    // (`source: 'parcel-source'`) names `sourceId`, and an id saved under a source the city used
    // before belongs to that source: the longest matching idPrefix wins, as in fetch.js.
    function parcelSourceIdFor(parcelsConfig, parcelId) {
        if (!parcelsConfig || !parcelsConfig.source || parcelsConfig.source === 'none') return null;
        if (parcelsConfig.source !== 'parcel-source') return parcelsConfig.source;
        const id = String(parcelId || '');
        const candidates = [{ sourceId: parcelsConfig.sourceId, idPrefix: parcelsConfig.idPrefix || '' }, ...(parcelsConfig.historicalSources || [])]
            .filter(row => row.sourceId && id.startsWith(row.idPrefix || ''))
            .sort((a, b) => (b.idPrefix || '').length - (a.idPrefix || '').length);
        return candidates[0]?.sourceId || null;
    }

    // The one ownership route (backend/routes/parcel-ownership.js); a parcel id may hold slashes.
    function ownershipRequestPath(sourceId, parcelId) {
        return `/parcel-ownership/${encodeURIComponent(sourceId)}/${encodeURIComponent(parcelId)}`;
    }

    // parcel-ownership/1 record -> the owner rows the parcel panel stores and renders.
    function ownersFromOwnershipRecord(record) {
        if (record?.contract !== 'parcel-ownership/1' || !Array.isArray(record.owners)) {
            throw new Error('Ownership response is not a parcel-ownership/1 record');
        }
        return record.owners.map((owner, index) => ({
            name: owner.name,
            ownerLabel: owner.name,
            ownership: owner.shareText || '',
            actualShareText: owner.shareText || '',
            percentageShare: Number.isFinite(owner.sharePercent) ? owner.sharePercent : undefined,
            ownerType: owner.ownerType,
            shareDetail: '',
            index
        }));
    }

    global.__parcelOwnershipRequest = Object.freeze({ parcelSourceIdFor, ownershipRequestPath, ownersFromOwnershipRecord });
    global.parseFraction = parseFraction;
    global.simplifyFraction = simplifyFraction;
    global.formatFraction = formatFraction;
    global.multiplyFractions = multiplyFractions;
    global.computeCondominiumSharePortion = computeCondominiumSharePortion;
    global.fetchOwnershipDetails = fetchOwnershipDetails;
    global.fetchOwnerDataForParcel = fetchOwnerDataForParcel;
    global.updateOwnershipCache = updateOwnershipCache;
    global.clearOwnershipCache = clearOwnershipCache;
    global.ownershipCache = ownershipCache;
    global.ownershipErrors = ownershipErrors;
})(typeof window !== 'undefined' ? window : globalThis);
