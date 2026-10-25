// Comparison uses the app's land, cash ledger and demolition thresholds. Public source failures
// keep the affected measurement unknown; a missing source never becomes an empty building stock.
import { createRequire } from 'node:module';
import { trustedMetadata } from './mcp-results.js';
import { appTurf as turf } from './mcp-geometry.js';
import { cidOfObject, isCid } from './agreement-objects.js';
import { deriveWithApp } from './mcp-ground-runtime.js';
import { previewArtifact } from './mcp-preview.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
const require = createRequire(import.meta.url);
const records = require('../../frontend/js/agreement-record.js');
const demolition = require('../../frontend/js/proposals/demolition-prefetch.js');
const route = require('../../frontend/js/proposals/apply/route.js');
const { findBuildingTunnelIntersections, splitDemolitionFootprint } = require('../../frontend/js/corridor-tunnel.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const union = features => features.reduce((out, feature) => out ? turf.union(out, feature) : feature, null);
const fail = (code, message) => Object.assign(new Error(message), { code, next: { action: 'Review the alternative and its current parcel source in the app.' } });

export function authoredAreas(designs) {
    let floorAreaM2 = 0;
    const green = [], roads = [];
    for (const design of designs) {
        const buildings = design.geometry?.buildings || [];
        if (design.buildingProposal && !buildings.length) floorAreaM2 = null;
        for (const building of buildings) {
            const explicitFloors = building.properties?.floors ?? design.buildingProposal?.parameters?.floors;
            const floorHeight = building.properties?.urbanRule?.floorHeightM;
            const height = building.properties?.height;
            const floors = explicitFloors ?? (finite(height) && finite(floorHeight) && floorHeight > 0 ? Math.floor(height / floorHeight) : null);
            if (!finite(floors)) floorAreaM2 = null;
            else if (floorAreaM2 !== null) floorAreaM2 += turf.area(building) * floors;
        }
        if (design.structureProposal?.kind === 'park') green.push(turf.feature(design.structureProposal.geometry));
        if (design.roadProposal) roads.push(turf.feature(design.roadProposal.definition.polygon));
    }
    return { floorAreaM2, greenAreaM2: green.length ? turf.area(union(green)) : 0,
        roadAreaM2: roads.length ? turf.area(union(roads)) : 0 };
}

export function createMcpComparison({ read, resolveDesign, appOrigin, resolveDraftReference, plans }) {
    return async function compare({ targets, parcelSourceId, buildingSourceId }) {
        const alternatives = [], warnings = [];
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
            let planResult;
            if (content?.schema === 'plan/v1' || explicitKind === 'plans') {
                if (!plans?.getPlan) throw fail('plan-resolver-unavailable', 'Named plan comparison needs the shared named plan resolver.');
                planResult = await plans.getPlan({ plan: explicitKind ? lookup : privateArtifact || target });
                content = planResult.plan; published = planResult.publication === 'published';
            } else if (!privateArtifact && typeof lookup === 'string') {
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
                const holders = new Map((isAgreement ? content.inputs.parcels : []).map(p => [p.parcelId, p.holders]));
                ground = await deriveWithApp({ designs: scoped, parcels: [...parcels.values()], ownerOf: id => holders.get(id) || [] });
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
            let buildingsRemoved = null, buildingsCut = null, removedFootprintM2 = null;
            if (ground) {
                try {
                    const regions = scoped.map(row => {
                        const design = row.content;
                        const shapes = ground.outputs.filter(o => o.role !== 'corridor' && o.fromParcelIds.some(id => row.parcelIds.includes(id)))
                            .map(o => turf.feature(o.geometry));
                        const geometry = design.roadProposal ? read.siteOfDesign(design)
                            : demolition.demolitionRegionOf(design, { normalizeGoalKey: route.normalizeGoalKey, parcelFeatures: () => shapes });
                        return geometry ? { key: row.cid, geometry } : null;
                    }).filter(Boolean);
                    if (!regions.length) { buildingsRemoved = 0; buildingsCut = 0; removedFootprintM2 = 0; }
                    else {
                        if (!buildingSourceId) throw fail('building-source-required', 'Select a building source to measure demolition.');
                        const stock = await read.request('/buildings/under', {}, { source: buildingSourceId, regions });
                        if (stock.supported !== true || stock.truncated || stock.unavailable || regions.some(r => !Array.isArray(stock.regions?.[r.key]))) throw fail('building-coverage-incomplete', 'Building stock is unsupported, truncated or unavailable; demolitions are unknown.');
                        const region = union(regions.map(r => turf.feature(r.geometry)));
                        const hits = findBuildingTunnelIntersections(region, regions.flatMap(r => stock.regions[r.key]), turf);
                        buildingsRemoved = 0; buildingsCut = 0; removedFootprintM2 = 0;
                        for (const hit of hits) {
                            const split = splitDemolitionFootprint(hit.feature, region, turf);
                            if (!split) continue;
                            if (split.full) { buildingsRemoved++; removedFootprintM2 += turf.area(hit.feature); }
                            else { buildingsCut++; removedFootprintM2 += turf.area(turf.feature(split.demolishedPart)); }
                        }
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
            alternatives.push({ cid, title: content.title, ...authoredAreas(designs), areaBasis: 'authored-geometry',
                parcelsTaken: takes, buildingsRemoved, buildingsCut, removedFootprintM2, ledger,
                measurementErrors, ...(isPlan ? { designSources } : {}), ...preview });
        }
        warnings.push('Areas describe authored geometry; they are not a prediction of construction. The party ledger is the app’s modeled allocation, not proof of ownership or compensation.');
        return { alternatives, warnings };
    };
}
