/*
    Financial calculations and utilities for the consensus builder application.
    This file contains functions for estimating parcel values, transaction costs,
    and other economic calculations.
*/

// Valuation assumptions
const PORTFOLIO_PRICE_PER_SQM_USD = 200;
const USD_PER_ETH_ESTIMATE = 2000; // fallback if no live rate is available

function normalizeParcelIdForValuation(parcelId) {
    if (parcelId === undefined || parcelId === null) return null;
    try {
        return parcelId.toString();
    } catch (_) {
        return null;
    }
}

function getParcelAreaFromCache(parcelId) {
    if (typeof getParcelAreaById !== 'function') {
        return 0;
    }
    const area = getParcelAreaById(parcelId);
    return Number.isFinite(area) && area > 0 ? area : 0;
}

async function ensureParcelsAvailable(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;

    const unique = Array.from(new Set(parcelIds.map(normalizeParcelIdForValuation).filter(Boolean)));
    if (!unique.length) return;

    const forceRefresh = options.forceRefresh === true;
    try {
        if (typeof fetchParcelsByIds === 'function') {
            await fetchParcelsByIds(unique, { forceRefresh });
        } else if (typeof fetchParcelsForIds === 'function') {
            await fetchParcelsForIds(unique, { forceRefresh });
        } else if (typeof fetchSingleParcelById === 'function') {
            await Promise.allSettled(unique.map(id => fetchSingleParcelById(id, { forceRefresh })));
        } else if (typeof fetchParcelData === 'function') {
            await fetchParcelData();
        }
    } catch (error) {
        console.warn('ensureParcelsAvailable: fetch failed', error);
    }

    // Wait for layers to be ready before attempting to read areas
    if (typeof waitForParcelLayersReady === 'function') {
        try {
            await waitForParcelLayersReady(unique, {
                timeoutMs: options.fetchTimeoutMs || 8000
            });
        } catch (error) {
            console.warn('ensureParcelsAvailable: waitForParcelLayersReady failed', error);
        }
    }
}

function resolveUsdPerEth(options = {}) {
    if (options && Number.isFinite(options.usdPerEth) && options.usdPerEth > 0) {
        return options.usdPerEth;
    }
    try {
        const candidate = (typeof window !== 'undefined' && window && Number.isFinite(window.ethUsdEstimate))
            ? window.ethUsdEstimate
            : null;
        if (candidate && candidate > 0) {
            return candidate;
        }
    } catch (_) { }
    return USD_PER_ETH_ESTIMATE;
}

function areaToEth(areaSqM, options = {}) {
    if (!Number.isFinite(areaSqM) || areaSqM <= 0) {
        return 0;
    }
    const usdPerEth = resolveUsdPerEth(options);
    if (!usdPerEth || !Number.isFinite(usdPerEth) || usdPerEth <= 0) {
        return 0;
    }
    return (areaSqM * PORTFOLIO_PRICE_PER_SQM_USD) / usdPerEth;
}

/**
 * Estimate the market value of a parcel in ETH using area from map data.
 * @param {string} parcelId - The ID of the parcel
 * @returns {Promise<number>} - Market value in ETH
 */
async function estimateParcelMarketValue(parcelId, options = {}) {
    const value = await calculatePortfolioValue([parcelId], options);
    return value;
}

/**
 * Get the last transacted price for a parcel
 * @param {string} parcelId - The ID of the parcel
 * @returns {number|null} - Last price in ETH, or null if no transactions
 */
function getLastTransactedPrice(parcelId) {
    // Placeholder for future implementation
    // Could check transaction history in PersistentStorage
    return null;
}

/**
 * Calculate total portfolio value for an agent
 * @param {Array} parcelIds - Array of parcel IDs owned by the agent
 * @returns {Promise<number>} - Total value in ETH
 */
async function calculatePortfolioValue(parcelIds, options = {}) {
    const cityId = options.cityId
        || (typeof CityConfigManager !== 'undefined' && CityConfigManager.getCurrentCityId ? CityConfigManager.getCurrentCityId() : null);
    const normalizedIds = Array.from(new Set(
        (Array.isArray(parcelIds) ? parcelIds : [])
            .map(normalizeParcelIdForValuation)
            .filter(Boolean)
            .filter(id => typeof isInCity === 'function' ? isInCity(id, cityId) : true)
    ));
    if (!normalizedIds.length) {
        return NaN;
    }

    let totalArea = 0;
    let missing = [];

    normalizedIds.forEach(id => {
        const area = getParcelAreaFromCache(id);
        if (area > 0) {
            totalArea += area;
        } else {
            missing.push(id);
        }
    });

    if (missing.length) {
        await ensureParcelsAvailable(missing, options);
        missing.forEach(id => {
            const area = getParcelAreaFromCache(id);
            if (area > 0) {
                totalArea += area;
            }
        });

        // If still missing after bulk fetch, try individual fetches as a last resort
        let stillMissing = missing.filter(id => getParcelAreaFromCache(id) <= 0);
        if (stillMissing.length && typeof fetchSingleParcelById === 'function') {
            await Promise.allSettled(stillMissing.map(id => fetchSingleParcelById(id, { forceRefresh: true })));
            if (typeof waitForParcelLayersReady === 'function') {
                try {
                    await waitForParcelLayersReady(stillMissing, { timeoutMs: options.fetchTimeoutMs || 8000, cityId });
                } catch (_) { }
            }
            stillMissing.forEach(id => {
                const area = getParcelAreaFromCache(id);
                if (area > 0) {
                    totalArea += area;
                }
            });
        }
        // Recompute missing after all attempts
        stillMissing = normalizedIds.filter(id => getParcelAreaFromCache(id) <= 0);
        missing = stillMissing;
    }

    if (missing.length) {
        console.warn('[PortfolioValue] Missing areas for parcel IDs, returning NaN to keep display as placeholder:', missing);
        return NaN;
    }

    return areaToEth(totalArea, options);
}

/**
 * Calculate proposal execution payout per parcel
 * @param {number} totalBudget - Total proposal budget in ETH
 * @param {number} numberOfParcels - Number of parcels in the proposal
 * @returns {number} - Payout per parcel in ETH
 */
function calculatePayoutPerParcel(totalBudget, numberOfParcels) {
    if (numberOfParcels === 0) return 0;
    return totalBudget / numberOfParcels;
}

// Make functions available globally
window.estimateParcelMarketValue = estimateParcelMarketValue;
window.getLastTransactedPrice = getLastTransactedPrice;
window.calculatePortfolioValue = calculatePortfolioValue;
window.calculatePayoutPerParcel = calculatePayoutPerParcel; 