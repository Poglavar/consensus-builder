// Comparison uses the app's land, cash ledger and demolition thresholds. Public source failures
// keep the affected measurement unknown; a missing source never becomes an empty building stock.
import { createRequire } from 'node:module';
import { trustedMetadata } from './mcp-results.js';
import { appTurf as turf } from './mcp-geometry.js';
import { cidOfObject, isCid } from './agreement-objects.js';
import { deriveWithApp } from './mcp-ground-runtime.js';
import { previewArtifact } from './mcp-preview.js';
import { parcelSourceIdOf, cityEconomics } from './mcp-read-tools.js';
import { cityMoney, cityPlanningSourceIds } from '../scripts/lib/frontend-city-money.mjs';
const require = createRequire(import.meta.url);
const records = require('../../frontend/js/agreement-record.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');
const demolition = require('../../frontend/js/proposals/demolition-prefetch.js');
const route = require('../../frontend/js/proposals/apply/route.js');
const DemolitionDerive = require('../../frontend/js/demolition-derive.js');
const { locationOf } = require('../../frontend/js/economic-sources.js');
// The decision-sheet rules Compare plans reads by (road/green area, demolition totals, Permitted
// verdict, backing agreements) and the chain reader of crowdfunding progress.
const planDecision = require('../../frontend/js/proposals/plan-decision.js');
const PermittedCheck = require('../../frontend/js/planning/permitted-check.js');
const FundingProgress = require('../../frontend/js/solana/funding-progress.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const union = features => features.reduce((out, feature) => out ? turf.union(out, feature) : feature, null);
const fail = (code, message) => Object.assign(new Error(message), { code, next: { action: 'Review the alternative and its current parcel source in the app.' } });

export function authoredAreas(designs) {
    // keptFloorAreaM2: what the existing buildings the designs extend already had (plan-yield
    // measureBuilding keptGfaM2), null while one states no existing height.
    let floorAreaM2 = 0, keptFloorAreaM2 = 0, buildingsExtended = 0;
    for (const design of designs) {
        const buildings = planYield.buildingFeaturesOf(design);
        if (design.buildingProposal && !buildings.length) floorAreaM2 = null;
        // Plan stats' rule (plan-yield measureProposal): stated storeys first, else the height over
        // the storey height; a building with neither leaves the floor area unknown.
        const measured = planYield.measureProposal(design, {});
        if (measured.unmeasuredBuildings > 0) floorAreaM2 = null;
        else if (floorAreaM2 !== null) floorAreaM2 += measured.grossFloorAreaM2;
        buildingsExtended += measured.extendedBuildings;
        if (measured.extendedUnmeasured > 0) keptFloorAreaM2 = null;
        else if (keptFloorAreaM2 !== null) keptFloorAreaM2 += measured.keptFloorAreaM2;
    }
    // Parks and road corridors by Compare plans' rule (plan-decision.js roadAndGreen).
    return { floorAreaM2, keptFloorAreaM2, buildingsExtended, ...planDecision.roadAndGreen(designs, { turf }) };
}

// The designs' new buildings against the Permitted limits where they stand, as Compare plans checks
// a plan (planning/permitted-check.js over the city's Permitted source, plan-decision.js
// permittedSummary). The zones' own limits only: designations of rule sets are not applied here and
// limits stated relative to the existing context read unknown.
export async function permittedOf(designs, { read, planningSource = null }) {
    const buildings = planDecision.permittedBuildings(designs.map((design, index) => ({ ...design, proposalId: cidOfObject(design) || `design-${index}` })));
    if (!buildings.length) return { state: 'noBuildings' };
    const city = designs.find(design => typeof design?.city === 'string' && design.city)?.city;
    const source = planningSource || (city ? cityPlanningSourceIds(city)[0] : null);
    if (!source) return { state: 'none', reason: 'No Permitted source is configured for this city.' };
    const box = turf.bbox(turf.featureCollection(buildings.map(building => building.footprint)));
    const answer = await read.request('/planning/representations', { city, source, bbox: box.join(',') });
    if (answer?.truncated || answer?.nextCursor) return { state: 'notChecked', source, reason: 'The Permitted source has more items over these buildings than one read returns.' };
    const result = PermittedCheck.check({ items: answer?.items || [], buildings, geometryOps: turf });
    const floorArea = new Map(buildings.map(building => [building.id, building.floorAreaM2]));
    return { source, ...planDecision.permittedSummary(result, id => floorArea.get(id) ?? null) };
}

// The agreements published on one exact plan revision (GET /agreements?plan=), each as Compare plans'
// Backing block reads it, with a crowdfunding round's progress read from the chain by readFunding
// (FundingProgress.readProgress) when this server has a Solana connection. Amounts are USDC atomic
// units as strings.
export async function backingOf(planCid, { read, readFunding = null }) {
    const rows = [];
    for (let offset = 0, pages = 0; offset !== null && pages < 10; pages++) {
        const page = await read.request('/agreements', { plan: planCid, limit: 100, offset });
        rows.push(...(page?.agreements || []));
        offset = page?.hasMore ? page.nextOffset : null;
    }
    const agreements = rows.map(row => ({ ...planDecision.backingOf(row) }));
    const rounds = rows.filter(row => FundingProgress.isCrowdfunding(row));
    let progress = null, progressError = null;
    if (rounds.length && readFunding) {
        try { progress = await readFunding(rounds); } catch (error) { progressError = error.message; }
    }
    agreements.forEach(agreement => {
        if (!agreement.crowdfunding) return;
        const observed = progress?.get(agreement.cid);
        agreement.funding = !readFunding ? { state: 'notRead', reason: 'This MCP server has no Solana connection; read the agreement in the app or on Solana Explorer.' }
            : progressError ? { state: 'failed', reason: progressError }
                : !observed ? { state: 'failed', reason: 'Not read.' }
                    : observed.state === 'read' ? { ...observed, raisedUsdcAtomic: String(observed.raisedUsdcAtomic),
                        targetUsdcAtomic: observed.targetUsdcAtomic === null ? null : String(observed.targetUsdcAtomic), source: 'solana' } : observed;
    });
    return { planCid, agreements };
}

// The floor area of the part of an existing building a design takes, by plan-yield's rule, as Plan
// stats counts the buildings a plan clears (present-state.js builtRecords: the source's height and
// storeys, 3 m storeys otherwise). null when the source states neither.
const positive = value => finite(value) && value > 0;
export function existingFloorArea(geometry, building) {
    const properties = { type: 'proposedBuilding', floorHeightM: 3 };
    if (positive(building?.height_m)) properties.height = building.height_m;
    if (positive(building?.floors)) properties.floors = building.floors;
    return planYield.measureBuilding({ type: 'Feature', properties, geometry }, null, {}).gfaM2;
}

// What an alternative's new floor area is worth and costs in its city's currency
// (CityMoney.newBuildMoney, the rule of Plan stats and the 3D panel): value, the all-in cost
// (construction, the development charge, land, the sale tax inside the value less the tax reclaimed on a tax-inclusive
// construction cost, the floor area it removes), profit and rent, at the city's rates where its land is
// (`at`, [lng, lat], EconomicSources.locationOf of its designs' sites, as the 3D panel and Plan stats
// locate theirs) or at the prices the caller gives, which are scenario assumptions. Each price keeps its source under `prices`; a given
// construction price keeps the tax basis (taxIncluded) of the city's rate, as the slider does.
// keptFloorAreaM2: the floor area extended buildings already had, which is not built, sold or replaced
// (builtFloorAreaM2 is the rest); the land is then the land of the designs that extend none.
export function moneyOf({ city, floorAreaM2, keptFloorAreaM2 = 0, replacedFloorAreaM2, landAreaM2, at = null, prices = {} }) {
    const { currency, rates, unavailable, reason } = cityEconomics(city, at);
    if (unavailable) throw fail('city-money-unavailable', reason);
    const price = (metric, given) => (finite(given) && given >= 0
        ? { amount: given, currency, basis: 'assumption', sourceId: 'caller',
            ...(metric === 'construction' && rates.construction?.taxIncluded ? { taxIncluded: true } : {}) }
        : rates[metric] || null);
    const used = { sale: price('sale', prices.salePerM2), construction: price('construction', prices.constructionPerM2),
        land: price('land', prices.landPerM2), saleTax: price('saleTax', prices.saleTaxShare), rent: price('rent', prices.rentPerM2Month),
        devCharge: price('devCharge', prices.devChargePerM2) };
    const amountOf = metric => (used[metric] ? used[metric].amount : null);
    return { currency, unit: 'm2-floor', prices: used, floorAreaM2, keptFloorAreaM2, replacedFloorAreaM2, landAreaM2,
        ...cityMoney(city).newBuildMoney({ floorAreaM2, keptFloorAreaM2, replacedFloorAreaM2, landAreaM2, salePerM2: amountOf('sale'),
            constructionPerM2: amountOf('construction'), landPerM2: amountOf('land'), saleTaxShare: amountOf('saleTax'),
            constructionTaxIncluded: used.construction?.taxIncluded === true, rentPerM2Month: amountOf('rent'),
            devChargePerM2: amountOf('devCharge') }) };
}

// The land an alternative takes, as Plan stats prices it: the ground its designs' sites cover.
export function landAreaOf(designs, siteOf) {
    const sites = designs.map(design => siteOf(design)).filter(Boolean).map(site => turf.feature(site));
    return sites.length ? turf.area(union(sites)) : 0;
}

export function createMcpComparison({ read, resolveDesign, appOrigin, resolveDraftReference, plans, readFunding = null }) {
    return async function compare({ targets, parcelSourceId, buildingSources, plan, prices, planningSource }) {
        const alternatives = [], warnings = [];
        const scope = plan == null ? null : await plans.resolvePlan(plan);
        for (const target of targets) {
            const supplied = target?.draftArtifact || target;
            let privateArtifact = null, content = supplied?.untrusted?.agreement || supplied?.untrusted?.design || supplied?.untrusted?.plan || supplied?.agreement || supplied?.design || supplied?.plan || supplied;
            let sourceId = supplied?.parcelSourceId || target?.parcelSourceId || parcelSourceId, published = false, explicitKind, lookup = target;
            const reference = typeof target === 'string' && !isCid(target) ? target : target?.draftRef;
            if (reference) {
                let url;
                try { url = new URL(reference); } catch { throw fail('invalid-reference', 'Use an app link, CID or private draft reference.'); }
                const path = url.origin === new URL(appOrigin).origin && url.pathname.match(/^\/(plans|designs|agreements)\/(baf(?:krei|ybei)[a-z2-7]{52})\/?$/);
                if (path) { explicitKind = path[1]; lookup = path[2]; }
                else {
                    if (!resolveDraftReference) throw fail('draft-reference-unavailable', 'Use canonical draft objects here; hosted references belong to their HTTP server.');
                    privateArtifact = await resolveDraftReference(reference);
                    content = privateArtifact.agreement || privateArtifact.design || privateArtifact.plan;
                    sourceId = privateArtifact.parcelSourceId || sourceId;
                    if (target?.cid && target.cid !== cidOfObject(content)) throw fail('cid-mismatch', 'The draftRef does not identify the supplied CID.');
                }
            }
            const member = scope?.designs.find(row => row.cid === lookup);
            if (member) { content = member.content; sourceId ||= member.parcelSourceId; }
            let planResult;
            if (content?.schema === 'plan/v1' || explicitKind === 'plans') {
                if (!plans?.getPlan) throw fail('plan-resolver-unavailable', 'Named plan comparison needs the shared named plan resolver.');
                planResult = await plans.getPlan({ plan: explicitKind ? lookup : privateArtifact || target });
                content = planResult.plan; published = planResult.publication === 'published';
            } else if (!member && !privateArtifact && typeof lookup === 'string') {
                const kinds = explicitKind ? [explicitKind] : ['designs', 'agreements', ...(plans?.getPlan ? ['plans'] : [])];
                for (let index = 0; index < kinds.length; index++) {
                    const kind = kinds[index];
                    try {
                        if (kind === 'plans') { planResult = await plans.getPlan({ plan: lookup }); content = planResult.plan; }
                        else {
                            const row = kind === 'designs' ? await read.getDesign({ designCid: lookup }) : await read.getAgreement({ agreementCid: lookup });
                            content = row.content || row.untrusted?.content;
                            sourceId ||= row.parcelSourceId;
                        }
                        published = true; break;
                    } catch (error) { if (!['http-404', 'design-not-found', 'agreement-not-found'].includes(error.code) || index === kinds.length - 1) throw error; }
                }
            }
            const isAgreement = content?.schema === 'agreement/v1', isPlan = content?.schema === 'plan/v1';
            const carriedRows = privateArtifact?.designs || target?.designs || target?.draftArtifact?.designs || [];
            const carried = new Map(carriedRows.map(row => { const d = row.content || row.untrusted?.content || row; return [cidOfObject(d), d]; }));
            const designRows = isPlan ? planResult.designs : null;
            let agreementPlan = null;
            if (isAgreement) {
                agreementPlan = privateArtifact?.plan || target?.plan || target?.draftArtifact?.plan;
                if (!agreementPlan && content.planCid) agreementPlan = await read.request(`/plans/${content.planCid}`);
                if (agreementPlan?.schema === 'plan/v1') agreementPlan = { cid: cidOfObject(agreementPlan), content: agreementPlan };
                if (agreementPlan?.content == null && agreementPlan?.plan) agreementPlan = { cid: agreementPlan.cid, content: agreementPlan.plan };
                if (!agreementPlan || agreementPlan.cid !== content.planCid || cidOfObject(agreementPlan.content) !== content.planCid) {
                    throw fail('plan-cid-mismatch', 'The agreement does not resolve to its exact plan revision.');
                }
            }
            const agreementDesignCids = agreementPlan?.content?.designCids || [];
            if (isAgreement && carriedRows.length && agreementDesignCids.some(cid => !carried.has(cid))) {
                throw fail('plan-members-invalid', 'A carried design does not match the exact plan membership.');
            }
            if (isAgreement && carriedRows.length) for (const cid of agreementDesignCids) {
                if (carried.get(cid)?.schema !== 'design/v1') throw fail('plan-members-invalid', `The carried member for ${cid} is not design/v1.`);
            }
            if (isAgreement && plans?.getPlan) {
                planResult = await plans.getPlan({ plan: { plan: agreementPlan.content, cid: agreementPlan.cid,
                    designs: carriedRows, parcelSourceId: sourceId } });
            }
            const designs = isPlan ? designRows.map(row => row.content) : isAgreement
                ? planResult ? planResult.designs.map(row => row.content)
                    : await Promise.all(agreementDesignCids.map(cid => resolveDesign(carried.get(cid) || cid))) : [await resolveDesign(content)];
            if (!isAgreement && !isPlan) content = designs[0];
            const unknownPlanSource = isPlan && designRows.some(row => !row.parcelSourceId && !sourceId);
            const knownSources = new Set((designRows || []).map(row => row.parcelSourceId || sourceId).filter(Boolean));
            if (knownSources.size === 1) sourceId = [...knownSources][0];
            const cid = cidOfObject(content), scoped = [], parcels = new Map();
            const measurementErrors = [];
            let takes = null, ground = null, ledger = null;
            try {
                if (unknownPlanSource) throw fail('parcel-source-required', 'One or more named-plan members have no selected parcel source. Combined ground and demolition measurements are unknown.');
                if (knownSources.size > 1) throw fail('mixed-source-ground-unavailable', 'This named plan uses multiple parcel sources. Combined ground and demolition measurements are unknown.');
                for (const design of designs) {
                    const answer = await read.request('/designs/binding', {}, { site: read.siteOfDesign(design), city: design.city, parcelSourceId: sourceId });
                    sourceId = parcelSourceIdOf(answer) || sourceId;
                    if (answer.binding?.coverage !== 'complete' || answer.binding.unknownM2 > 0 || answer.binding.unsurveyedM2 > 0) throw fail('ground-incomplete', 'Comparison needs complete cadastral ground for land and demolition measurements.');
                    const ids = answer.binding.parcels.map(p => p.parcelId);
                    if (ids.length) {
                        const source = await read.parcels({ city: design.city, parcelSourceId: sourceId, parcelIds: ids });
                        sourceId ||= source.parcelSourceId;
                        source.features.forEach(f => parcels.set(String(f.id ?? f.properties.parcelId), f));
                    }
                    scoped.push({ content: design, cid: cidOfObject(design), parcelIds: ids });
                }
                takes = [...parcels.keys()].sort();
                ground = await deriveWithApp({ designs: scoped, parcels: [...parcels.values()] });
                if (isAgreement) {
                    if (JSON.stringify([...content.inputs.parcels.map(p => p.parcelId)].sort()) !== JSON.stringify(takes)
                        || ground.outputs.length !== content.outputs.length || ground.outputs.some(o => !content.outputs.some(p => p.hash === o.hash))) throw fail('agreement-ground-changed', 'This agreement no longer matches the current source ground.');
                    ledger = records.ledger({ ...content, id: cid, plan: agreementPlan,
                        designs: agreementDesignCids.map(cid => ({ cid, proposalId: cid })), outputs: ground.outputs });
                }
            } catch (error) {
                measurementErrors.push({ code: error.code || 'ground-unavailable', message: error.message,
                    next: trustedMetadata(error.next || { action: 'Retry when complete parcel ground is available.' }) });
            }
            let buildingsRemoved = null, buildingsCut = null, removedFootprintM2 = null, removedFloorAreaM2 = null;
            if (ground) {
                try {
                    // The land each design takes, its road tunnels taking nothing (demolition-derive.js, the
                    // rule the map derives its demolitions by).
                    const takers = scoped.map(row => {
                        const design = row.content;
                        const region = design.roadProposal ? read.siteOfDesign(design)
                            : demolition.demolitionRegionOf(design, { normalizeGoalKey: route.normalizeGoalKey });
                        const tunnels = design.roadProposal?.definition ? DemolitionDerive.tunnelRegionsOf(design.roadProposal.definition) : [];
                        // A design that redraws existing buildings extends them and replaces none.
                        const extending = !design.roadProposal && demolition.extendsExisting(design);
                        return region ? { proposalId: row.cid, region, tunnels, ...(extending ? { extending: true } : {}) } : null;
                    }).filter(Boolean);
                    if (!takers.length) { buildingsRemoved = 0; buildingsCut = 0; removedFootprintM2 = 0; removedFloorAreaM2 = 0; }
                    else {
                        // The sources in order: the first that answers the whole land completely is the stock.
                        const sources = Array.isArray(buildingSources) ? buildingSources.filter(Boolean) : [];
                        if (!sources.length) throw fail('building-source-required', 'Select the building sources to measure demolition.');
                        const regions = takers.map(taker => ({ key: taker.proposalId, geometry: taker.region }));
                        let stock = null, used = null;
                        for (const source of sources) {
                            const answer = await read.request('/buildings/under', {}, { source, regions });
                            if (answer.supported === true && !answer.truncated && !answer.unavailable && regions.every(r => Array.isArray(answer.regions?.[r.key]))) {
                                stock = answer; used = source;
                                break;
                            }
                        }
                        if (!stock) throw fail('building-coverage-incomplete', 'No building source answered this land completely; demolitions are unknown.');
                        const byKey = new Map();
                        const stated = new Map();
                        regions.forEach(r => stock.regions[r.key].forEach(building => {
                            byKey.set(`${used}:${building.id}`, { key: `${used}:${building.id}`, geometry: building.geometry });
                            stated.set(`${used}:${building.id}`, building);
                        }));
                        const { records } = DemolitionDerive.derive({ takers, buildings: [...byKey.values()] }, turf);
                        // Totalled by Compare plans' rule (plan-decision.js demolitionTotals): a removed
                        // building the source gives no height leaves the removed floor area unknown.
                        const totals = planDecision.demolitionTotals([...records].filter(([, record]) => !record.extended).map(([key, record]) => {
                            const part = record.remainder ? record.demolishedPart : record.geometry;
                            return { whole: !record.remainder, footprintM2: turf.area(turf.feature(part)), floorAreaM2: existingFloorArea(part, stated.get(key)) };
                        }));
                        ({ buildingsRemoved, buildingsCut, removedFootprintM2, removedFloorAreaM2 } = totals);
                    }
                } catch (error) {
                    measurementErrors.push({ code: error.code || 'buildings-unavailable', message: error.message,
                        next: trustedMetadata(error.next || { action: 'Retry the building source.' }) });
                }
            }
            const designSources = isPlan ? Object.fromEntries(designRows.filter(row => row.parcelSourceId).map(row => [row.cid, row.parcelSourceId])) : null;
            const preview = published ? { previewUrl: `${appOrigin}/${isPlan ? 'plans' : isAgreement ? 'agreements' : 'designs'}/${cid}`, previewStatus: 'published' }
                : await previewArtifact({ origin: appOrigin, ...(isPlan ? { plan: content, designs } : isAgreement ? { agreement: content, plan: agreementPlan, designs } : { design: content }), parcelSourceId: sourceId });
            if (isPlan && preview.draftArtifact) preview.draftArtifact.designSources = designSources;
            const areas = authoredAreas(designs);
            let money = null;
            try {
                const city = designs.find(design => typeof design?.city === 'string' && design.city)?.city;
                if (!city) throw fail('city-unknown', 'No design names its city, so its money is unknown.');
                money = moneyOf({ city, floorAreaM2: areas.floorAreaM2, keptFloorAreaM2: areas.keptFloorAreaM2, replacedFloorAreaM2: removedFloorAreaM2,
                    landAreaM2: landAreaOf(designs.filter(design => !demolition.extendsExisting(design)), design => read.siteOfDesign(design)),
                    at: locationOf(designs.map(design => read.siteOfDesign(design)).filter(Boolean)), prices: prices || {} });
            } catch (error) {
                measurementErrors.push({ code: error.code || 'money-unavailable', message: error.message,
                    next: trustedMetadata(error.next || { action: 'Give salePerM2, constructionPerM2 and landPerM2 in prices, in the city currency.' }) });
            }
            // Compare plans' decision rows: the tallest new building, the build-out and the Permitted
            // limits, and the agreements published on the exact plan revision.
            const form = planDecision.builtForm({ records: designs, turf });
            const periods = isPlan || isAgreement ? planDecision.periodSummary(planYield.planYield(designs.map(design => ({ ...design, applied: true, proposalId: cidOfObject(design) })),
                { periodOf: record => { const end = (isPlan ? content : agreementPlan?.content)?.schedule?.[record.proposalId]?.end; return end ? Number(end.slice(0, 4)) : null; } })) : null;
            let permitted = null;
            try { permitted = await permittedOf(designs, { read, planningSource }); }
            catch (error) { permitted = { state: 'notChecked', reason: error.message }; }
            const backedPlan = isPlan ? (published ? cid : null) : isAgreement ? agreementPlan.cid : null;
            let backing = null;
            if (backedPlan) {
                try { backing = await backingOf(backedPlan, { read, readFunding }); }
                catch (error) { backing = { planCid: backedPlan, agreements: null, error: error.message }; }
            }
            alternatives.push({ cid, title: content.title, ...areas, areaBasis: 'authored-geometry',
                maxHeightM: form.maxHeightM, maxStoreys: form.maxStoreys, buildOut: periods, permitted, backing,
                parcelsTaken: takes, buildingsRemoved, buildingsCut, removedFootprintM2, removedFloorAreaM2, money, ledger,
                measurementErrors, ...(isPlan ? { designSources } : {}), ...preview });
        }
        warnings.push('Areas describe authored geometry; they are not a prediction of construction. The party ledger is the app’s modeled allocation, not proof of ownership or compensation.');
        warnings.push('Permitted checks each new building against the zones of the city\'s Permitted source where it stands (or planningSource); planning designations of rule sets are not applied here and limits relative to the existing context read unknown. Crowdfunding progress under backing is read from Solana when this server has a connection, never from the index.');
        warnings.push('Money is a model at prices each with its source: value of the new floor area, its all-in cost (construction, the development charge on new floor area, land at the land price, the sale tax inside the value, the value of the floor area it removes), profit, annual rent and its yield on the cost without the sale tax. It is not an appraisal; fees and finance are not in it.');
        return { alternatives, warnings };
    };
}
