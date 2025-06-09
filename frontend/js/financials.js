/*
    Financial calculations and utilities for the consensus builder application.
    This file contains functions for estimating parcel values, transaction costs,
    and other economic calculations.
*/

// Hard-coded parcel market value for now
const DEFAULT_PARCEL_VALUE_ETH = 0.1;

/**
 * Estimate the market value of a parcel in ETH
 * @param {string} parcelId - The ID of the parcel
 * @returns {number} - Market value in ETH
 */
function estimateParcelMarketValue(parcelId) {
    // For now, return a hard-coded value as specified
    // In the future, this could be based on area, location, improvements, etc.
    return DEFAULT_PARCEL_VALUE_ETH;
}

/**
 * Get the last transacted price for a parcel
 * @param {string} parcelId - The ID of the parcel
 * @returns {number|null} - Last price in ETH, or null if no transactions
 */
function getLastTransactedPrice(parcelId) {
    // Placeholder for future implementation
    // Could check transaction history in localStorage
    return null;
}

/**
 * Calculate total portfolio value for an agent
 * @param {Array} parcelIds - Array of parcel IDs owned by the agent
 * @returns {number} - Total value in ETH
 */
function calculatePortfolioValue(parcelIds) {
    return parcelIds.reduce((total, parcelId) => {
        return total + estimateParcelMarketValue(parcelId);
    }, 0);
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