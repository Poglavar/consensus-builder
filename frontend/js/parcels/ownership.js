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

