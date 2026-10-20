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

/**
 * Fetch area from NFT metadata on-chain
 * @param {string} parcelId - The parcel ID
 * @returns {Promise<number>} - Area in square meters or 0 if not found
 */
async function getParcelAreaFromMetadata(parcelId) {
    try {
        if (typeof window === 'undefined' || !window.ChainDataLoader || typeof window.ChainDataLoader.getParcelMetadata !== 'function') {
            return 0;
        }

        // Get current chain and contract address from settings
        const chainId = typeof CityConfigManager !== 'undefined' && CityConfigManager.getCurrentChainId
            ? CityConfigManager.getCurrentChainId()
            : null;

        const parcelAddress = typeof CityConfigManager !== 'undefined' && CityConfigManager.getParcelContractAddress
            ? CityConfigManager.getParcelContractAddress()
            : null;

        if (!chainId || !parcelAddress) {
            return 0;
        }

        const metadata = await window.ChainDataLoader.getParcelMetadata(parcelId, chainId, parcelAddress);
        if (!metadata) {
            return 0;
        }

        // Try to get area from metadata
        const area = metadata.areaSquareMeters;
        return Number.isFinite(area) && area > 0 ? area : 0;
    } catch (error) {
        console.warn(`Failed to fetch area from metadata for parcel ${parcelId}:`, error);
        return 0;
    }
}

async function ensureParcelsAvailable(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;

    const unique = Array.from(new Set(parcelIds.map(normalizeParcelIdForValuation).filter(Boolean)));
    if (!unique.length) return;

    try {
        const ground = (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository)
            ? CadastralParcelRepository
            : ((typeof window !== 'undefined') ? window.CadastralParcelRepository : null);
        if (!ground || typeof ground.ensureIds !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }
        await ground.ensureIds(unique);
    } catch (error) {
        console.warn('ensureParcelsAvailable: cadastral ground load failed', error);
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

function getPortfolioValuationBasis(options = {}) {
    return {
        pricePerSqmUsd: PORTFOLIO_PRICE_PER_SQM_USD,
        usdPerEth: resolveUsdPerEth(options),
        areaUnit: 'm²',
        inputCurrency: 'USD',
        outputCurrency: 'ETH',
        method: 'parcel-area × fixed USD/m² model, converted by estimated USD/ETH rate'
    };
}

function normalizeEstimateCurrency(currency) {
    if (typeof currency !== 'string') return null;
    const normalized = currency.trim().toUpperCase();
    return /^[A-Z][A-Z0-9]{1,7}$/.test(normalized) ? normalized : null;
}

// A source estimate is usable only with its own currency field. The optional fallback is a
// separately identified model (area × rate) and carries its currency and rate in the result.
function buildParcelPriceEstimate(properties, areaM2, options = {}) {
    const props = properties && typeof properties === 'object' ? properties : {};
    const raw = props.estimatedMarketPrice;
    const hasRaw = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '');
    if (hasRaw) {
        const amount = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
        const currency = normalizeEstimateCurrency(props.estimatedMarketPriceCurrency);
        if (!Number.isFinite(amount) || amount < 0 || !currency) {
            return { amount: null, currency: null, basis: 'unusable-source-estimate', rate: null };
        }
        return { amount, currency, basis: 'source-estimate', rate: null };
    }

    const area = Number(areaM2);
    const rate = Number(options.areaPricePerSqm);
    const currency = normalizeEstimateCurrency(options.currency);
    if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(rate) || rate < 0 || !currency) {
        return { amount: null, currency: null, basis: 'unavailable', rate: null };
    }
    return { amount: area * rate, currency, basis: 'area-model', rate };
}

function aggregateParcelPriceEstimates(estimates, expectedCount = null) {
    const rows = Array.isArray(estimates) ? estimates : [];
    if (!rows.length || (Number.isInteger(expectedCount) && expectedCount !== rows.length)) {
        return { amount: null, currency: null, basis: 'incomplete', count: rows.length };
    }
    if (rows.some(row => !row || !Number.isFinite(row.amount) || row.amount < 0 || !normalizeEstimateCurrency(row.currency))) {
        return { amount: null, currency: null, basis: 'unknown-component', count: rows.length };
    }
    const currencies = [...new Set(rows.map(row => normalizeEstimateCurrency(row.currency)))];
    if (currencies.length !== 1) {
        return { amount: null, currency: null, basis: 'mixed-currency', count: rows.length };
    }
    const amount = rows.reduce((sum, row) => sum + row.amount, 0);
    if (!Number.isFinite(amount)) {
        return { amount: null, currency: null, basis: 'invalid-total', count: rows.length };
    }
    const bases = [...new Set(rows.map(row => row.basis || 'unspecified'))];
    return {
        amount,
        currency: currencies[0],
        basis: bases.length === 1 ? bases[0] : 'combined-estimates',
        componentBases: bases,
        count: rows.length
    };
}

// Both inputs are ETH quantities. A missing land estimate or balance is not a zero holding.
function calculateModeledTotalEth(balanceEth, portfolioEth) {
    if (!Number.isFinite(balanceEth) || balanceEth < 0
        || !Number.isFinite(portfolioEth) || portfolioEth < 0) return null;
    const total = balanceEth + portfolioEth;
    return Number.isFinite(total) ? total : null;
}

/**
 * Calculate the modeled parcel estimate in ETH using area from map data and the fixed portfolio basis.
 * @param {string} parcelId - The ID of the parcel
 * @returns {Promise<number>} - Modeled estimate in ETH
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

        // The ground service owns retries, negative caching, and transport choice. Asking a second
        // low-level fetcher here used to download the same parcel again after the bulk answer.
        let stillMissing = missing.filter(id => getParcelAreaFromCache(id) <= 0);

        // Final fallback: fetch area from NFT metadata on-chain
        stillMissing = normalizedIds.filter(id => getParcelAreaFromCache(id) <= 0);
        const metadataAreaMap = new Map();
        if (stillMissing.length) {
            console.log('[PortfolioValue] Attempting to fetch area from NFT metadata for', stillMissing.length, 'parcels');
            const metadataAreas = await Promise.all(stillMissing.map(id => getParcelAreaFromMetadata(id)));
            stillMissing.forEach((id, index) => {
                const area = metadataAreas[index];
                metadataAreaMap.set(id, area);
                if (area > 0) {
                    console.log(`[PortfolioValue] Retrieved area ${area} m² from NFT metadata for parcel ${id}`);
                    totalArea += area;
                }
            });
        }

        // Recompute missing after all attempts
        stillMissing = normalizedIds.filter(id => {
            const cacheArea = getParcelAreaFromCache(id);
            if (cacheArea > 0) return false;
            // Check if we got it from metadata
            const metadataArea = metadataAreaMap.get(id);
            if (metadataArea && metadataArea > 0) {
                return false;
            }
            return true;
        });
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
 * @returns {number|null} - Payout per parcel in ETH; null when the proposal binds no parcel (open
 *   ground: there is no owner to pay, which is not the same as paying each owner 0) or the budget
 *   is not a number.
 */
function calculatePayoutPerParcel(totalBudget, numberOfParcels) {
    if (!(typeof numberOfParcels === 'number' && Number.isInteger(numberOfParcels) && numberOfParcels > 0)) return null;
    if (!(typeof totalBudget === 'number' && Number.isFinite(totalBudget))) return null;
    return totalBudget / numberOfParcels;
}

// Make functions available globally
if (typeof window !== 'undefined') {
    window.estimateParcelMarketValue = estimateParcelMarketValue;
    window.getLastTransactedPrice = getLastTransactedPrice;
    window.calculatePortfolioValue = calculatePortfolioValue;
    window.calculatePayoutPerParcel = calculatePayoutPerParcel;
    window.getPortfolioValuationBasis = getPortfolioValuationBasis;
    window.calculateModeledTotalEth = calculateModeledTotalEth;
    window.ParcelPriceModel = { buildEstimate: buildParcelPriceEstimate, aggregate: aggregateParcelPriceEstimates };
}

// Node tests load this classic script with require (the browser ignores this branch).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculatePayoutPerParcel, areaToEth, getPortfolioValuationBasis, calculateModeledTotalEth,
        buildParcelPriceEstimate, aggregateParcelPriceEstimates
    };
}
