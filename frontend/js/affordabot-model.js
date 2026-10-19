// Shared, pure rental feasibility and research-proposal model for Affordabot's scanner and review UI.
(function attachAffordabotModel(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AffordabotModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAffordabotModel() {
    'use strict';
    // These are editable test assumptions, not observed prices, a valuation, or a financing offer.
    const defaults = Object.freeze({
        unitM2: 50, netRatio: 0.8, constructionEurM2: 1600, landEurM2: 250,
        softCostPct: 20, contingencyPct: 15, parkingPerHome: 0, parkingEur: 25000,
        grantPerHome: 0, annualInterestPct: 3.5, loanYears: 40,
        operatingEurM2Month: 2, vacancyPct: 5, householdIncomeMonth: 1600,
        incomeSharePct: 30, utilitiesMonth: 100, costSensitivityPct: 20
    });
    const ranges = {
        unitM2: [20, 150], netRatio: [0.4, 0.95], constructionEurM2: [1, 15000],
        landEurM2: [0, 50000], softCostPct: [0, 100], contingencyPct: [0, 100],
        parkingPerHome: [0, 3], parkingEur: [0, 150000], grantPerHome: [0, 1000000],
        annualInterestPct: [0, 20], loanYears: [1, 80], operatingEurM2Month: [0, 30],
        vacancyPct: [0, 50], householdIncomeMonth: [1, 100000], incomeSharePct: [1, 50],
        utilitiesMonth: [0, 3000], costSensitivityPct: [0, 50]
    };
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    function validateAssumptions(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid assumptions');
        for (const [key, value] of Object.entries(input)) {
            if (!ranges[key]) throw new Error(`Unknown assumption: ${key}`);
            if (value === null) continue;
            const [min, max] = ranges[key];
            if (!finite(value) || value < min || value > max) throw new Error(`Invalid assumption: ${key}`);
        }
        return { ...defaults, ...input };
    }
    function monthlyCapitalFactor(annualInterestPct, years) {
        if (!finite(annualInterestPct) || !finite(years) || annualInterestPct < 0 || years <= 0) return null;
        const rate = annualInterestPct / 1200, months = years * 12;
        return rate === 0 ? 1 / months : rate / -Math.expm1(-months * Math.log1p(rate));
    }
    function rentalFeasibility({ gfaM2, siteAreaM2, maxHomes = null, minParkingPerHome = null }, input = {}) {
        const assumptions = validateAssumptions(input);
        if (finite(minParkingPerHome) && finite(assumptions.parkingPerHome)) assumptions.parkingPerHome = Math.max(assumptions.parkingPerHome, minParkingPerHome);
        if (maxHomes !== null && (!finite(maxHomes) || maxHomes < 0)) throw new Error('Invalid dwelling limit');
        const missing = Object.keys(defaults).filter(key => !finite(assumptions[key]));
        if (!finite(gfaM2) || gfaM2 <= 0) missing.push('gfaM2');
        if (!finite(siteAreaM2) || siteAreaM2 <= 0) missing.push('siteAreaM2');
        const measuredHomes = finite(gfaM2) && finite(assumptions.netRatio) && finite(assumptions.unitM2)
            ? Math.floor(gfaM2 * assumptions.netRatio / assumptions.unitM2) : null;
        const homes = measuredHomes === null ? null : finite(maxHomes) ? Math.min(measuredHomes, Math.floor(maxHomes)) : measuredHomes;
        if (missing.length || !homes) return { homes, rentMonth: null, targetRentMonth: null, missing, assumptions };
        // Whole dwellings only. All building costs are recovered over those homes; leftover floor
        // area never creates a fractional home or unearned rent revenue.
        const rentableM2 = homes * assumptions.unitM2;
        const construction = gfaM2 * assumptions.constructionEurM2;
        const land = siteAreaM2 * assumptions.landEurM2;
        const parkingSpaces = Math.ceil(homes * assumptions.parkingPerHome);
        const parking = parkingSpaces * assumptions.parkingEur;
        const soft = construction * assumptions.softCostPct / 100;
        const contingency = (construction + parking + soft) * assumptions.contingencyPct / 100;
        const capital = construction + land + parking + soft + contingency;
        const grant = homes * assumptions.grantPerHome;
        const financed = Math.max(0, capital - grant);
        const factor = monthlyCapitalFactor(assumptions.annualInterestPct, assumptions.loanYears);
        const collection = 1 - assumptions.vacancyPct / 100;
        const operating = rentableM2 * assumptions.operatingEurM2Month;
        const rentMonth = (financed * factor + operating) / collection / homes;
        const housingBudget = assumptions.householdIncomeMonth * assumptions.incomeSharePct / 100;
        const targetRentMonth = Math.max(0, housingBudget - assumptions.utilitiesMonth);
        const supportableCapital = Math.max(0, (targetRentMonth * homes * collection - operating) / factor);
        const additionalGrantPerHome = Math.max(0, financed - supportableCapital) / homes;
        const sensitivity = assumptions.costSensitivityPct / 100;
        const rentAt = constructionDelta => (Math.max(0, financed + constructionDelta
            * (1 + assumptions.softCostPct / 100) * (1 + assumptions.contingencyPct / 100)) * factor + operating) / collection / homes;
        return {
            homes, rentableM2, rentMonth, targetRentMonth, housingBudget,
            totalHousingMonth: rentMonth + assumptions.utilitiesMonth,
            incomeSharePct: (rentMonth + assumptions.utilitiesMonth) / assumptions.householdIncomeMonth * 100,
            additionalGrantPerHome, operatingFloorAboveTarget: operating / collection / homes > targetRentMonth,
            withinTarget: rentMonth <= targetRentMonth,
            rentLowMonth: rentAt(-construction * sensitivity), rentHighMonth: rentAt(construction * sensitivity),
            cost: { construction, land, parking, parkingSpaces, soft, contingency, capital, grant, financed },
            missing: [], assumptions
        };
    }
    function buildResearchProposal(site, variant, assumptions, { title, description, proposalId, createdAt }) {
        if (!site?.parcelId || !variant?.massing?.geometry || !proposalId) throw new Error('A site, massing and proposal ID are required');
        const finance = rentalFeasibility({ gfaM2: variant.gfaM2, siteAreaM2: site.areaM2, maxHomes: variant.maxHomes, minParkingPerHome: variant.minParkingPerHome }, assumptions);
        const feature = JSON.parse(JSON.stringify(variant.massing));
        feature.properties = { ...feature.properties, type: 'proposedBuildingSingle', title, block: site.parcelId };
        return {
            proposalId, city: 'zagreb', type: 'building', goal: 'single', typologyType: 'single',
            primaryType: 'Urban Rule', name: title, title, description, createdAt,
            lifecycleStatus: 'Proposed', cadastreParcelIds: [site.parcelId],
            facets: { landUse: 'single', parcels: 'as-is', ownership: 'no-change' },
            offer: 0, offerCurrency: 'EUR', geometry: { buildings: [feature] }, bounds: site.bounds,
            buildingProposal: { blockName: site.parcelId, typologyType: 'single', parameters: {
                floors: variant.floors, height: variant.floors * 3, typology: 'single'
            } },
            agent: { persona: 'affordabot', rationale: description },
            affordabilityResearch: {
                version: 1, status: 'research-draft', form: variant.form, scenario: variant.scenario,
                assumptions: finance.assumptions, feasibility: finance, planning: site.planning,
                accessibility: site.accessibility, evidenceGaps: site.evidenceGaps,
                source: site.source, ownerConsent: false, authorityApproval: false
            }
        };
    }
    return Object.freeze({ defaults, ranges, validateAssumptions, monthlyCapitalFactor, rentalFeasibility, buildResearchProposal });
});
