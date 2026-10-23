// Comparison uses the app's land, cash ledger and demolition thresholds. Public source failures
// keep the affected measurement unknown; a missing source never becomes an empty building stock.
import { createRequire } from 'node:module';
import { appTurf as turf } from './mcp-geometry.js';
import { cidOfObject } from './agreement-objects.js';
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
            const floors = building.properties?.floors ?? design.buildingProposal?.parameters?.floors;
            if (!finite(floors)) floorAreaM2 = null;
            else if (floorAreaM2 !== null) floorAreaM2 += turf.area(building) * floors;
        }
        if (design.structureProposal?.kind === 'park') green.push(turf.feature(design.structureProposal.geometry));
        if (design.roadProposal) roads.push(turf.feature(design.roadProposal.definition.polygon));
    }
    return { floorAreaM2, greenAreaM2: green.length ? turf.area(union(green)) : 0,
        roadAreaM2: roads.length ? turf.area(union(roads)) : 0 };
}

export function createMcpComparison({ read, resolveDesign, appOrigin }) {
    return async function compare({ targets, parcelSourceId }) {
        const alternatives = [], warnings = [];
        for (const target of targets) {
            let content = target?.untrusted?.agreement || target?.untrusted?.design || target?.agreement || target?.design || target;
            let sourceId = target?.parcelSourceId || parcelSourceId;
            let published = false;
            if (typeof target === 'string') {
                try {
                    const row = await read.getDesign({ designCid: target }); content = row.content;
                    sourceId ||= row.parcelSourceId;
                    published = true;
                }
                catch (error) {
                    if (!['http-404', 'design-not-found'].includes(error.code)) throw error;
                    const row = await read.getAgreement({ agreementCid: target }); content = row.content;
                    sourceId ||= row.parcelSourceId;
                    published = true;
                }
            }
            const isAgreement = content?.schema === 'agreement/v1';
            const designs = isAgreement ? await Promise.all(content.designs.map(d => resolveDesign(d.cid))) : [await resolveDesign(content)];
            if (!isAgreement) content = designs[0];
            const cid = cidOfObject(content), scoped = [], parcels = new Map();
            const measurementErrors = [];
            let takes = null, ground = null, ledger = null;
            try {
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
                    ledger = records.ledger({ ...content, id: cid, designs: content.designs.map(d => ({ ...d, proposalId: d.cid })), outputs: ground.outputs });
                }
            } catch (error) {
                measurementErrors.push({ code: error.code || 'ground-unavailable', message: error.message,
                    next: error.next || { action: 'Retry when complete parcel ground is available.' } });
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
                        const stock = await read.request('/buildings/under', {}, { regions });
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
                        next: error.next || { action: 'Retry the building source.' } });
                }
            }
            alternatives.push({ cid, title: content.title, ...authoredAreas(designs), areaBasis: 'authored-geometry',
                parcelsTaken: takes, buildingsRemoved, buildingsCut, removedFootprintM2, ledger,
                measurementErrors, ...(published ? { previewUrl: `${appOrigin}/${isAgreement ? 'agreements' : 'designs'}/${cid}`, previewStatus: 'published' }
                    : await previewArtifact({ origin: appOrigin, ...(isAgreement ? { agreement: content, designs } : { design: content }), parcelSourceId: sourceId })) });
        }
        warnings.push('Areas describe authored geometry; they are not a prediction of construction. The party ledger is the app’s modeled allocation, not proof of ownership or compensation.');
        return { alternatives, warnings };
    };
}
