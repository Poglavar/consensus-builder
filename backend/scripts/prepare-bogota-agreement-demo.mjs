#!/usr/bin/env node
// Prepare local Bogotá plan and agreement examples from bounded public parcel ground or a saved sample.
// This writes only local sample files; it never pins, indexes, publishes, signs or contacts voters.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as turf from '@turf/turf';
import { parcelSourceById } from '../parcels/sources.js';
import { agreementObject, communityRule, mapViewFromGeometry, noMoney, partyKey } from '../agents/agreement-objects.js';
import { deriveWithApp } from '../agents/mcp-ground-runtime.js';
import { cidOfObject } from '../cid.js';

const require = createRequire(import.meta.url);
const PlanFile = require('../../frontend/js/plan-file.js');
const Approval = require('../../frontend/js/proposals/approval.js');
const ApprovalRegimes = require('../../frontend/js/proposals/approval-regimes.js');
const VoterList = require('../../frontend/js/community/voting.js');
const AgreementRecord = require('../../frontend/js/agreement-record.js');

export const PARCEL_SOURCE_ID = 'co-bogota-uaecd-lote';
export const PARCEL_IDS = Object.freeze([
    'CO-BOGOTA-006104024011', 'CO-BOGOTA-006104024012',
    'CO-BOGOTA-006104024010', 'CO-BOGOTA-006104024013'
]);
export const BBOX = Object.freeze([-74.083, 4.609, -74.08, 4.613]);
export const AUTHORED_AT = '2026-10-29T12:00:00.000Z';
export const VOTING_ID = '43af9e8c-4fa6-4db5-93a2-9df6947a99c1';
export const SYNTHETIC_AUTHORITY_ID = 'DEMO-AUTHORITY-BOGOTA-PLANNING';
const unitValuesCents = new Map([
    [PARCEL_IDS[0], 18_500_000], [PARCEL_IDS[1], 17_200_000],
    [PARCEL_IDS[2], 16_800_000], [PARCEL_IDS[3], 19_100_000]
]);
const DEMO_CODES = Object.freeze([
    { label: 'Example voter 1', code: 'ABCDEFGHJKMNPQR' },
    { label: 'Example voter 2', code: 'STUVWXYZABCDEFG' },
    { label: 'Example voter 3', code: 'HJKMNPQRSTUVWXY' }
]);
const LENS = 'demo-bogota-lens';
const fail = message => { throw new Error(message); };
const featureOf = geometry => turf.feature(geometry);
const areaOf = geometry => turf.area(featureOf(geometry));
const union = geometries => {
    if (!geometries.length) fail('A parcel pool needs geometry.');
    let result = featureOf(geometries[0]);
    for (const geometry of geometries.slice(1)) {
        result = turf.union(result, featureOf(geometry));
        if (!result) fail('The source parcel pool could not be unioned.');
    }
    return result.geometry;
};
const intersect = (left, right) => turf.intersect(featureOf(left), featureOf(right))?.geometry || null;
const difference = (left, right) => turf.difference(featureOf(left), featureOf(right))?.geometry || null;

function assertAdjacent(parcels) {
    const reached = new Set([parcels[0].parcelId]);
    for (let changed = true; changed;) {
        changed = false;
        for (const a of parcels) for (const b of parcels) {
            if (reached.has(a.parcelId) && !reached.has(b.parcelId)
                && turf.booleanIntersects(featureOf(a.geometry), featureOf(b.geometry))) {
                reached.add(b.parcelId); changed = true;
            }
        }
    }
    if (reached.size !== parcels.length) fail('The selected source parcels are not one adjoining group.');
}

function frontageSpace(geometry) {
    // These four selected lots front Carrera 17 on their west side. Keep the public piece on
    // that boundary, with access from the street, rather than an island inside private land.
    const ring = geometry.coordinates[0];
    const edges = ring.slice(1).map((point, index) => [ring[index], point]);
    const edge = edges.sort((a, b) => (a[0][0] + a[1][0]) - (b[0][0] + b[1][0]))[0];
    const strip = turf.buffer(turf.lineString(edge), 2.4, { units: 'meters', steps: 8 });
    const piece = strip && intersect(geometry, strip.geometry);
    if (!piece || areaOf(piece) < 1) fail('Could not form the street-front public space.');
    return piece;
}

function createDesigns(parcels, authoredAt) {
    const site = union(parcels.map(parcel => parcel.geometry));
    const publicGeometry = frontageSpace(parcels[0].geometry);
    const remainder = difference(parcels[0].geometry, publicGeometry);
    if (!remainder || areaOf(remainder) < 1) fail('The public-space piece leaves no buildable remainder.');
    const buildingGeometry = turf.buffer(featureOf(parcels[1].geometry), -0.8, { units: 'meters', steps: 8 })?.geometry;
    if (!buildingGeometry || areaOf(buildingGeometry) < 40) fail('The example building needs a usable footprint.');
    if (!turf.booleanWithin(featureOf(buildingGeometry), featureOf(parcels[1].geometry))) fail('The building footprint falls outside its assigned buildable plot.');
    const plots = [
        { geometry: publicGeometry, source: 'manual', label: 'Public square' },
        { geometry: remainder, source: 'manual', label: 'Buildable plot 1' },
        ...parcels.slice(1).map((parcel, index) => ({ geometry: parcel.geometry, source: 'manual', label: `Buildable plot ${index + 2}` }))
    ];
    const layout = {
        goal: 'parcel-layout', title: 'Manzana de cuatro lotes',
        description: 'Replacement layout with one public-space plot and buildable plots; the plots conserve the source parcel pool.',
        author: 'sampledata-demo', city: 'bogota', createdAt: authoredAt, site,
        parcelLayout: { algorithm: 'manual', generatedAt: authoredAt, poolSource: 'site', pool: site,
            openGroundM2: 0, plots }
    };
    const publicSpace = {
        goal: 'square', title: 'Plazoleta pública',
        description: 'Public-square geometry matches the public plot in the replacement layout.',
        author: 'sampledata-demo', city: 'bogota', createdAt: authoredAt, site,
        structureProposal: { kind: 'square', geometry: publicGeometry }
    };
    const building = {
        goal: 'single', title: 'Vivienda de cinco pisos',
        description: 'Example residential massing placed wholly inside buildable plot 2.',
        author: 'sampledata-demo', city: 'bogota', createdAt: authoredAt, site: parcels[1].geometry,
        buildingProposal: { typologyType: 'single', createdFrom: 'freeform', blockName: 'Bogotá demo',
            parameters: { typology: 'single', floors: 5, height: 20.25, rotation: 0, footprintMode: 'polygon' },
            ineligibleParcels: [] },
        geometry: { buildings: [{ type: 'Feature', geometry: buildingGeometry,
            properties: { floors: 5, height: 20.25, name: 'Vivienda de cinco pisos' } }] }
    };
    return { site, publicGeometry, buildingGeometry, remainder, plots,
        records: [layout, publicSpace, building] };
}

function syntheticRights(inputParcels) {
    return Approval.normalizeRights({
        schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'bogota-demo-synthetic-rights-v1' },
        parcels: inputParcels.map(parcel => ({ parcelId: parcel.parcelId, complete: true, areaM2: parcel.areaM2,
            owners: parcel.parcelId === PARCEL_IDS[2]
                ? [{ ownerId: 'DEMO-PERSON-BRUNO', share: '1/2' }, { ownerId: 'DEMO-PERSON-CAMILA', share: '1/2' }]
                : [{ ownerId: parcel.parcelId === PARCEL_IDS[0] || parcel.parcelId === PARCEL_IDS[1] ? 'DEMO-PERSON-ALMA' : 'DEMO-PERSON-BRUNO', share: '1/1' }] }))
    });
}

function ownerRule(rights) {
    const regime = ApprovalRegimes.latest('co-readjustment');
    if (!regime) fail('The Colombian readjustment rule is unavailable.');
    return {
        electorate: 'owners', binding: true, lens: [LENS],
        approvalConfig: Approval.normalizeConfig({ schema: Approval.CONFIG_SCHEMA, rights,
            policy: ApprovalRegimes.policyOf(regime, [SYNTHETIC_AUTHORITY_ID]),
            regime: { id: regime.id, version: regime.version } }),
        settlement: { method: 'value', rateCentsPerM2: 0, contributionBasisPoints: 0 }
    };
}

function outputRows(replay) {
    return replay.outputs.map(output => ({ ...output, geometry: structuredClone(output.geometry) }));
}

function outputSourceValue(output, inputValues, parcelsById) {
    const pieces = output.fromParcelIds.map(parcelId => {
        const clipped = intersect(output.geometry, parcelsById.get(parcelId).geometry);
        return { parcelId, areaM2: clipped ? areaOf(clipped) : 0 };
    }).filter(piece => piece.areaM2 > 0);
    const total = pieces.reduce((sum, piece) => sum + piece.areaM2, 0);
    if (!total) fail(`Cannot value replay output ${output.hash} against its source parcels.`);
    return Math.round(pieces.reduce((sum, piece) => sum + inputValues.get(piece.parcelId) * piece.areaM2, 0) / total);
}

function primarySourceParcel(output, parcelsById) {
    return output.fromParcelIds.map(parcelId => ({ parcelId,
        areaM2: intersect(output.geometry, parcelsById.get(parcelId)?.geometry)
            ? areaOf(intersect(output.geometry, parcelsById.get(parcelId).geometry)) : 0
    })).sort((a, b) => b.areaM2 - a.areaM2 || a.parcelId.localeCompare(b.parcelId))[0]?.parcelId;
}

function valuation(inputParcels, outputs, sourceParcels) {
    const inputValues = new Map(inputParcels.map(parcel => [parcel.parcelId, unitValuesCents.get(parcel.parcelId)]));
    const parcelsById = new Map(sourceParcels.map(parcel => [parcel.parcelId, parcel]));
    return {
        inputs: inputParcels.map(parcel => ({ parcelId: parcel.parcelId, unitValueCents: inputValues.get(parcel.parcelId) })),
        outputs: outputs.map(output => ({ output: output.hash, unitValueCents: outputSourceValue(output, inputValues, parcelsById) }))
    };
}

function allocations(outputs, publicHash, sourceParcels, counter = false) {
    const parcelsById = new Map(sourceParcels.map(parcel => [parcel.parcelId, parcel]));
    let counterApplied = false;
    const rows = outputs.map(output => {
        if (output.hash === publicHash) return { output: output.hash, to: { kind: 'public' } };
        const sourceParcelId = primarySourceParcel(output, parcelsById);
        if (!sourceParcelId) fail(`Cannot allocate replay output ${output.hash} to a source parcel.`);
        const originalParty = partyKey(sourceParcelId);
        if (counter && !counterApplied && sourceParcelId === PARCEL_IDS[1]) {
            counterApplied = true;
            return { output: output.hash, to: { kind: 'party', ownerKey: partyKey(PARCEL_IDS[2]) } };
        }
        return { output: output.hash, to: { kind: 'party', ownerKey: originalParty } };
    });
    if (counter && !counterApplied) fail('The replay has no buildable plot for the counter-agreement allocation.');
    return rows;
}

export async function replayBogotaPlan(planFile, parcels) {
    const records = planFile.designs.map(row => ({ ...row, parcelIds: parcels.map(parcel => parcel.parcelId) }));
    const source = parcels.map(parcel => ({ type: 'Feature', id: parcel.parcelId,
        properties: { parcelId: parcel.parcelId }, geometry: parcel.geometry }));
    return deriveWithApp({ designs: records, parcels: source });
}

async function votingFiles() {
    const entries = await Promise.all(DEMO_CODES.map(async row => ({ ...row,
        codeHash: await VoterList.codeHash(VOTING_ID, row.code, webcrypto) })));
    return {
        voting: VoterList.configuration({ schema: 'community-voting/v1', id: VOTING_ID,
            codeHashes: entries.map(row => row.codeHash) }),
        privateExampleVoterList: VoterList.localFile(VOTING_ID, entries)
    };
}

function assertPoolConservation(site, plots) {
    const sum = plots.reduce((total, plot) => total + areaOf(plot.geometry), 0);
    const poolArea = areaOf(site);
    if (Math.abs(sum - poolArea) > Math.max(0.03, poolArea * 1e-5)) fail(`Layout plots do not conserve the pool area (${sum} vs ${poolArea} m²).`);
    const plotUnion = union(plots.map(plot => plot.geometry));
    if (Math.abs(areaOf(plotUnion) - poolArea) > Math.max(0.03, poolArea * 1e-5)) fail('Layout plots overlap or leave a gap in the pool.');
    const missing = difference(site, plotUnion), outside = difference(plotUnion, site);
    if ((missing && areaOf(missing) > 0.03) || (outside && areaOf(outside) > 0.03)) fail('Layout plots do not match the source pool geometry.');
}

export async function prepareBogotaDemo(features, { authoredAt = AUTHORED_AT } = {}) {
    if (!Array.isArray(features)) fail('Provide source parcel features.');
    const byId = new Map(features.map(feature => [String(feature.id), feature]));
    const missing = PARCEL_IDS.filter(id => !byId.has(id));
    if (missing.length) fail(`The complete bounded source result is missing: ${missing.join(', ')}.`);
    const parcels = PARCEL_IDS.map(parcelId => {
        const feature = byId.get(parcelId);
        if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) fail(`${parcelId} has no polygon geometry.`);
        return { parcelId, geometry: structuredClone(feature.geometry), areaM2: areaOf(feature.geometry),
            sourceAttributes: structuredClone(feature.properties?.sourceProperties || {}) };
    });
    assertAdjacent(parcels);
    const geometry = createDesigns(parcels, authoredAt);
    assertPoolConservation(geometry.site, geometry.plots);
    const source = { sourceId: PARCEL_SOURCE_ID, snapshotId: '2021-12' };
    const view = mapViewFromGeometry([geometry.site], 'bogota');
    view.at = view.at.split(',').slice(0, 2).concat('19').join(',');
    const planFile = await PlanFile.create(geometry.records.map((record, index) => ({
        ...record, proposalId: `bogota-demo-${index + 1}`, planFileSource: source
    })), { title: 'Bogotá · cuatro lotes y espacio público', view,
        designSources: Object.fromEntries(geometry.records.map((record, index) => {
            const cid = require('../../frontend/js/design-record.js').cidOf({ ...record, proposalId: `bogota-demo-${index + 1}` });
            return [cid, source];
        })) });
    // Agreement membership and CIDs come from the exact canonical member records PlanFile emits.
    const planCid = cidOfObject(planFile.plan);
    const namedPlan = { cid: planCid, content: planFile.plan };
    const designByGoal = goal => planFile.designs.find(row => row.content.goal === goal);
    const layout = designByGoal('parcel-layout'), square = designByGoal('square'), building = designByGoal('single');
    if (!layout || !square || !building || planFile.designs.length !== 3) fail('The canonical plan is missing a required design.');
    const replay = await replayBogotaPlan(planFile, parcels);
    const outputs = outputRows(replay);
    const inputParcels = replay.inputs.parcels;
    const rights = syntheticRights(inputParcels);
    const publicHash = AgreementRecord.outputHash(geometry.publicGeometry);
    if (!outputs.some(output => output.hash === publicHash)) fail('App replay did not retain the public-space plot.');
    const rule = ownerRule(rights);
    const common = { title: null, author: 'sampledata-demo', sponsor: null, city: 'bogota', createdAt: authoredAt,
        plan: namedPlan, designs: planFile.designs.map(row => ({ cid: row.cid, goal: row.content.goal, title: row.content.title })),
        parcels: inputParcels.map(({ parcelId, areaM2 }) => ({ parcelId, areaM2, parcelSourceId: PARCEL_SOURCE_ID })),
        openGroundM2: replay.inputs.openGroundM2, outputs, money: noMoney('COP'),
        valuation: valuation(inputParcels, outputs, parcels), deadline: null };
    const allocationRows = counter => allocations(outputs, publicHash, parcels, counter);
    const original = agreementObject({ ...common, title: 'Bogotá · acuerdo de propietarios', rule, allocations: allocationRows(false) });
    const counter = agreementObject({ ...common, title: 'Bogotá · contraacuerdo', rule, allocations: allocationRows(true) });
    const voting = await votingFiles();
    const community = agreementObject({ ...common, title: 'Bogotá · votación comunitaria', rule: communityRule([]),
        allocations: [], valuation: null, consultation: { voting: voting.voting } });
    const agreementRows = [original, counter, community].map(row => ({ cid: row.cid, content: row.content }));
    for (const row of agreementRows) {
        const checked = require('../routes/agreements.js').validateAgreementContent(row.content, { designCids: planFile.plan.designCids });
        if (!checked.ok) fail(`Prepared agreement is invalid (${checked.section}): ${checked.error}`);
    }
    const ownership = rights;
    return {
        schema: 'bogota-agreement-demo/v1', authoredAt,
        provenance: { city: 'bogota', parcelSourceId: PARCEL_SOURCE_ID, sourceDate: '2021-12',
            endpoint: 'https://sig.car.gov.co/arcgis/rest/services/VISOR/Capas_base/FeatureServer/9',
            queryBbox: BBOX, requestedParcelIds: PARCEL_IDS, sampleOnly: true },
        syntheticData: { rights: true, valuations: true, voterCodes: true,
            authorityId: SYNTHETIC_AUTHORITY_ID,
            personRows: [{ ownerId: 'DEMO-PERSON-ALMA', parcels: PARCEL_IDS.slice(0, 2) },
                { ownerId: 'DEMO-PERSON-BRUNO', parcels: PARCEL_IDS.slice(2) }],
            coOwners: [{ parcelId: PARCEL_IDS[2], ownerId: 'DEMO-PERSON-CAMILA', share: '1/2' },
                { parcelId: PARCEL_IDS[2], ownerId: 'DEMO-PERSON-BRUNO', share: '1/2' }],
            note: 'Every person, right, authority, unit value and voter code is invented example data; it does not identify an owner or establish consent.' },
        ground: parcels, planFile, agreements: agreementRows, ownership, replay: { inputs: replay.inputs, outputs },
        privateExampleVoterList: voting.privateExampleVoterList,
        references: { planCid, designCids: planFile.plan.designCids, agreementCids: agreementRows.map(row => row.cid) }
    };
}

export async function fetchGround() {
    const source = parcelSourceById(PARCEL_SOURCE_ID);
    const result = await source.adapter.queryBounds(BBOX);
    if (!result.complete) fail('The bounded parcel response was incomplete.');
    return result.features;
}

async function main(argv) {
    let features;
    let outputDir;
    if (argv[0] === '--from-sampledata') {
        if (!argv[1]) fail('Usage: --from-sampledata <sampledata.json> [output-directory]');
        const saved = JSON.parse(await readFile(resolve(argv[1]), 'utf8'));
        features = saved.ground.map(parcel => ({ id: parcel.parcelId, geometry: parcel.geometry,
            properties: { sourceProperties: parcel.sourceAttributes || {} } }));
        outputDir = resolve(argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/demo/bogota-agreements'));
    } else {
        outputDir = resolve(argv[0] || resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/demo/bogota-agreements'));
        features = await fetchGround();
    }
    const prepared = await prepareBogotaDemo(features);
    await mkdir(outputDir, { recursive: true });
    const { privateExampleVoterList, ownership, ...sampledata } = prepared;
    await writeFile(resolve(outputDir, 'sampledata.json'), `${JSON.stringify(sampledata, null, 2)}\n`);
    await writeFile(resolve(outputDir, 'plan.json'), PlanFile.stringify(prepared.planFile));
    await writeFile(resolve(outputDir, 'ownership.json'), `${JSON.stringify(ownership, null, 2)}\n`);
    await writeFile(resolve(outputDir, 'example-voters-private.json'), `${JSON.stringify(privateExampleVoterList, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Prepared ${prepared.ground.length} source parcels and ${prepared.agreements.length} agreement examples in ${outputDir}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
