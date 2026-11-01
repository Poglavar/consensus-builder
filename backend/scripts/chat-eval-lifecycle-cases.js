// Live model cases for every MCP authored design family. Run with
// `node scripts/chat-eval-lifecycle-cases.js --write-json /tmp/chat-eval-lifecycle.json`
// to preserve the current cases and append this bounded lifecycle matrix.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildTypedDesign } from '../agents/mcp-constructors.js';
import { appTurf, constructorRuntime, intentDesign } from '../agents/mcp-geometry.js';
import { cidOfObject } from '../cid.js';

export const outline = {
    type: 'Polygon', coordinates: [[[-0.1482, 51.4922], [-0.1472, 51.4922], [-0.1472, 51.4929], [-0.1482, 51.4929], [-0.1482, 51.4922]]]
};
const smallParcelSite = {
    type: 'Polygon', coordinates: [[[-0.09252, 51.50380], [-0.09218, 51.50380], [-0.09218, 51.504025], [-0.09252, 51.504025], [-0.09252, 51.50380]]]
};
const common = { city: 'london', authoredAt: '2026-10-01T00:00:00.000Z', outline };
const points = [[-0.1481, 51.4925], [-0.1473, 51.4925]];
const siteSelection = { parcelIds: ['GB-HMLR-BROWSER-v1-63542395'] };
const forbiddenPublish = ['ugt_publish_design', 'ugt_publish_plan', 'ugt_edit_shared_plan'];
const buildingParcelIds = { block: ['GB-HMLR-BROWSER-v1-55048514#cadastre-1'], detached: ['GB-HMLR-BROWSER-v1-55048514#cadastre-1'] };
const baseContext = { city: 'london', parcelSourceId: 'gb-hmlr-browser-v1' };

export const designFixtures = {
    'building-freeform': { kind: 'building', ...common, typology: 'freeform', floors: 3, rotationDegrees: 15, title: 'Lifecycle freeform' },
    'building-block': { kind: 'building', ...common, typology: 'block', floors: 3, title: 'Lifecycle block' },
    'building-row': { kind: 'building', ...common, typology: 'row', floors: 3, title: 'Lifecycle row' },
    'building-detached': { kind: 'building', ...common, typology: 'detached', floors: 3, title: 'Lifecycle detached' },
    'space-park': { kind: 'space', ...common, spaceKind: 'park', treeCount: 3, title: 'Lifecycle park' },
    'space-square': { kind: 'space', ...common, spaceKind: 'square', title: 'Lifecycle square' },
    'space-lake': { kind: 'space', ...common, spaceKind: 'lake', title: 'Lifecycle lake' },
    road: { kind: 'road', ...common, points, preset: '1+1', title: 'Lifecycle road' },
    track: { kind: 'track', ...common, points, gauge: 1435, speed: 80, title: 'Lifecycle track' },
    'parcel-layout': { kind: 'parcel-layout', ...common, algorithm: 'equal', count: 4, title: 'Lifecycle layout' },
    'urban-rule': { kind: 'building', ...common, typology: 'row', floors: 3, floorHeightM: 3, depthM: 10, title: 'Lifecycle Row rule' }
};

const moveTurn = (text, tools, moved = null, designIndex = 0) => ({ text, expect: { ...(moved ? { outcome: 'reply' } : { outcome: 'question' }), planChanged: Boolean(moved), forbidTools: forbiddenPublish, anyTools: moved ? [...new Set([...tools, 'ugt_modify_design', 'ugt_edit_plan'])] : tools, ...(moved ? { artifact: { designIndex, moved, previousUnchanged: true } } : {}) } });
const editTurn = (text, artifact = {}, designIndex = 0) => ({ text, expect: { outcome: 'reply', planChanged: true, forbidTools: forbiddenPublish, anyTools: ['ugt_modify_design', 'ugt_edit_design', 'ugt_edit_plan', 'ugt_draft_parcel_layout', 'ugt_draft_track', 'ugt_draft_station'], artifact: { designIndex, ...artifact, previousUnchanged: true } } });
const createTurn = (text, tool, artifact = {}, designIndex = 0) => ({ text, expect: { outcome: 'reply', planChanged: true, forbidTools: forbiddenPublish, tools: [tool], artifact: { designIndex, ...artifact } } });
const caseContext = (kind, typology) => ({ ...baseContext, ...(typology === 'row' ? {}
    : buildingParcelIds[typology]
    ? { selection: { parcelIds: buildingParcelIds[typology] } }
    : kind === 'building' || kind === 'space' ? { selection: siteSelection } : {}) });
const rowOutlineText = `Use this connected outline in WGS84: [[[-0.1482,51.4922],[-0.1472,51.4922],[-0.1472,51.4929],[-0.1482,51.4929],[-0.1482,51.4922]]].`;
const buildingGoal = { block: 'buildings', row: 'row', detached: 'parcelBased' };
const buildingCase = (key, typology) => ({
    id: `lifecycle-${key}`, language: 'en', context: caseContext('building', typology),
    turns: [
        createTurn(`Create a 3-floor ${typology} building${typology === 'row' ? ` inside this outline. ${rowOutlineText}` : ' on the selected parcel'}${typology === 'freeform' ? ', rotated 15 degrees' : ''}.`, 'ugt_draft_building', typology === 'freeform'
            ? { building: { index: 0, floors: 3, rotation: 15 } }
            : { paths: { goal: buildingGoal[typology], 'buildingProposal.typologyType': typology === 'detached' ? 'parcelBased' : typology } }),
        editTurn('Set the selected building to 4 floors.', { building: { index: 0, floors: 4 } }),
        editTurn('Change its use to office.', { paths: { [typology === 'freeform' ? 'buildingProposal.parameters.use' : 'buildingProposal.parameters.rule.use']: 'office' } }),
        ...(typology === 'freeform' ? [
            moveTurn('Move the selected building 12 metres north.', ['ugt_modify_design', 'ugt_edit_design'], { paths: ['geometry.buildings.0', 'site'], eastM: 0, northM: 12, toleranceM: 2 }),
            editTurn('Rotate the selected building 25 degrees clockwise.', { rotated: { path: 'geometry.buildings.0', degrees: -25, toleranceDegrees: 2 } }),
            moveTurn('Move it another 8 metres east.', ['ugt_modify_design', 'ugt_edit_design'], { paths: ['geometry.buildings.0', 'site'], eastM: 8, northM: 0, toleranceM: 2 })
        ] : [
            moveTurn('Move the buildings 1 metre east inside their fixed site.', ['ugt_modify_design', 'ugt_edit_design'], { paths: ['geometry.buildings.0'], eastM: 1, northM: 0, toleranceM: 0.2 }),
            moveTurn('Move the buildings another 1 metre east inside the same fixed site.', ['ugt_modify_design', 'ugt_edit_design'], { paths: ['geometry.buildings.0'], eastM: 1, northM: 0, toleranceM: 0.2 })
        ])
    ]
});

const spaceCase = (key, kind) => ({
    id: `lifecycle-${key}`, language: 'en', context: caseContext('space'),
    turns: [
        createTurn(`Create a ${kind}${kind === 'park' ? ' with 3 trees' : ''} on the selected parcel.`, 'ugt_draft_space', kind === 'park' ? { proposalKind: kind, decorationCounts: { trees: 3 } } : { proposalKind: kind }),
        kind === 'park'
            ? editTurn('Give this public space a clear new title: Riverside Commons.', { paths: { title: 'Riverside Commons' } })
            : editTurn(`Reduce the ${kind}'s footprint to about 70% of its current area, centered in the same place. Resize both its site and authored geometry together.`, { changedPaths: ['site', 'structureProposal.geometry'], areaRatio: { path: 'site', ratio: 0.7, tolerance: 0.025 } }),
        kind === 'park'
            ? editTurn('Set the authored tree count to 5.', { decorationCounts: { trees: 5 } })
            : editTurn('Change its title to Riverside Commons Park.', { paths: { title: 'Riverside Commons Park' } }),
        moveTurn('Move the entire public space and its authored contents 12 metres north.', ['ugt_edit_design'], { paths: ['site', 'structureProposal.geometry', ...(kind === 'park' ? ['structureProposal.decorationDesign.trees'] : [])], eastM: 0, northM: 12, toleranceM: 2 }),
        moveTurn('Move the entire public space another 8 metres east.', ['ugt_edit_design'], { paths: ['site', 'structureProposal.geometry', ...(kind === 'park' ? ['structureProposal.decorationDesign.trees'] : [])], eastM: 8, northM: 0, toleranceM: 2 })
    ]
});

const canonicalFixtures = buildDesignFixtures();
export const lifecycleCases = [
    ...['freeform', 'block', 'row', 'detached'].map(type => buildingCase(`building-${type}`, type)),
    ...['park', 'square', 'lake'].map(kind => spaceCase(`space-${kind}`, kind)),
    {
        id: 'lifecycle-road', language: 'en', context: baseContext,
        turns: [
            createTurn(`Create a 1+1 road following these WGS84 points: ${JSON.stringify(points)}.`, 'ugt_draft_road', { paths: { goal: 'road-track', 'roadProposal.definition.osm.elements.2.tags.highway': 'road' } }),
            editTurn('Set the cross section to 1+1 with cycle lanes.', { paths: { 'roadProposal.definition.osm.elements.2.tags.cycleway:both': 'lane' } }),
            editTurn('Widen the road cross section by 2 metres on its north side.', { paths: { 'roadProposal.definition.osm.elements.2.tags.width': '15.002' } }),
            moveTurn('Translate the whole road alignment 10 metres north. Move the canonical OSM nodes together so the derived footprint follows them.', ['ugt_edit_design'], { paths: ['roadProposal.definition.polygon', 'site'], eastM: 0, northM: 10, toleranceM: 2 }),
            moveTurn('Translate the whole road alignment another 8 metres east, keeping its OSM topology and cross section intact.', ['ugt_edit_design'], { paths: ['roadProposal.definition.polygon', 'site'], eastM: 8, northM: 0, toleranceM: 2 })
        ]
    },
    {
        id: 'lifecycle-track', language: 'en', context: baseContext,
        turns: [
            createTurn(`Create a 1435 mm gauge railway track with an 80 km/h speed target along these WGS84 points: ${JSON.stringify(points)}.`, 'ugt_draft_track', { paths: { goal: 'road-track', 'roadProposal.definition.metadata.type': 'track', 'roadProposal.definition.metadata.isTrack': true, 'roadProposal.definition.metadata.trackSpeed': 80 } }),
            editTurn('Lower this track speed target to 50 km/h.', { paths: { 'roadProposal.definition.metadata.trackSpeed': 50 }, unchangedPaths: ['site'] }),
            editTurn('Set the minimum curve radius to 700 metres while retaining the speed target.', { paths: { 'roadProposal.definition.metadata.trackMinRadius': 700 } }),
            moveTurn('Translate the whole track alignment 10 metres north. Move all canonical track nodes together and keep its rail geometry and constraints aligned.', ['ugt_edit_design'], { paths: ['roadProposal.definition.polygon', 'site'], eastM: 0, northM: 10, toleranceM: 2 }),
            moveTurn('Translate the whole track alignment another 8 metres east, preserving its rail geometry and constraints.', ['ugt_edit_design'], { paths: ['roadProposal.definition.polygon', 'site'], eastM: 8, northM: 0, toleranceM: 2 })
        ]
    },
    {
        id: 'lifecycle-parcel-layout', language: 'en', context: baseContext,
        turns: [
            createTurn(`Create an equal parcel layout with 4 plots inside this polygon. ${rowOutlineText}`, 'ugt_draft_parcel_layout', { paths: { goal: 'parcel-layout', 'parcelLayout.algorithm': 'equal', 'parcelLayout.plots.length': 4 } }),
            editTurn('Rename this layout East Garden Plots.', { paths: { title: 'East Garden Plots' } }),
            editTurn('Replace this layout in the plan with a regenerated equal layout of 5 plots, preserving the same site.', { paths: { 'parcelLayout.plots.length': 5 } }),
            moveTurn('Move the complete parcel layout 10 metres north, keeping every plot aligned to its site.', ['ugt_edit_design'], { paths: ['site', 'parcelLayout.pool', ...Array.from({ length: 5 }, (_, i) => `parcelLayout.plots.${i}.geometry`)], eastM: 0, northM: 10, toleranceM: 0.3 }),
            moveTurn('Move the complete parcel layout another 8 metres east.', ['ugt_edit_design'], { paths: ['site', 'parcelLayout.pool', ...Array.from({ length: 5 }, (_, i) => `parcelLayout.plots.${i}.geometry`)], eastM: 8, northM: 0, toleranceM: 0.3 })
        ]
    },
    {
        id: 'lifecycle-urban-rule', language: 'en', context: caseContext('building', 'row'),
        turns: [
            createTurn(`Create an urban rule with a row typology, 3 floors, 3-metre floor height and 10-metre depth. ${rowOutlineText}`, 'ugt_draft_urban_rule',
                { paths: { goal: 'row', 'buildingProposal.typologyType': 'row' }, building: { index: 0, floors: 3 } }),
            editTurn('Set this Row rule to office use.', { paths: { 'buildingProposal.parameters.rule.use': 'office' } }),
            editTurn('Increase this Row rule to 4 floors and keep its other parameters.', { building: { index: 0, floors: 4 } }),
            ...[
                'Move the Row buildings 1 metre east inside their fixed site.',
                'Move the Row buildings another 1 metre east inside the same fixed site.'
            ].map(text => {
                const turn = moveTurn(text, ['ugt_modify_design', 'ugt_edit_design'],
                    { paths: ['geometry.buildings.0'], eastM: 1, northM: 0, toleranceM: 0.2 });
                turn.expect.artifact.unchangedPaths = ['site'];
                return turn;
            })
        ]
    },
    {
        id: 'lifecycle-station', language: 'en', context: { ...baseContext, selection: { memberIndex: 0 },
        planSeed: [{ tool: 'ugt_draft_track', asPlan: true, args: (({ kind, outline: _outline, ...trackArgs }) => ({ ...trackArgs, city: 'london', parcelSourceId: 'gb-hmlr-browser-v1' }))(designFixtures.track) }] },
        turns: [
            createTurn('Place an elevated track station halfway along the selected rail track, with a platform height of 10 metres.', 'ugt_draft_station', { designGoal: 'station', proposalKind: 'station', paths: { 'structureProposal.stationType': 'elevated', 'structureProposal.platformHeightM': 10 } }),
            { ...editTurn('Set this elevated station platform height to 12 metres.', { designGoal: 'station', paths: { 'structureProposal.platformHeightM': 12 } }), selection: { memberGoal: 'station' } },
            { ...editTurn('Rename this station Riverside Station.', { designGoal: 'station', paths: { title: 'Riverside Station' } }), selection: { memberGoal: 'station' } },
            ...[
                moveTurn('Move this station 10 metres east along the connected track alignment, retaining its type, height and name.', ['ugt_edit_design', 'ugt_draft_station'], { paths: ['site', 'structureProposal.geometry'], eastM: 10, northM: 0, toleranceM: 1 }),
                moveTurn('Move the station another 8 metres east along that track, retaining its type, height and name.', ['ugt_edit_design', 'ugt_draft_station'], { paths: ['site', 'structureProposal.geometry'], eastM: 8, northM: 0, toleranceM: 1 })
            ].map(turn => ({ ...turn, selection: { memberGoal: 'station' }, expect: { ...turn.expect, artifact: { ...turn.expect.artifact, designGoal: 'station', unchangedPaths: ['title', 'structureProposal.stationType', 'structureProposal.platformHeightM', 'structureProposal.attachment.sourceId'] } } }))
        ]
    },
    ...['as-is', 'ownership-transfer'].map(goal => ({
        id: `lifecycle-${goal}`, language: 'en', context: { ...baseContext, selection: { memberIndex: 0 },
            planSeed: [{ tool: 'ugt_draft_plan', asPlan: true, args: { designs: [{ content: canonicalFixtures[goal].design, parcelSourceId: 'gb-hmlr-browser-v1' }], title: `Lifecycle ${goal}` } }] },
        turns: [
            editTurn('Retitle this private design to Rights Review.', { paths: { title: 'Rights Review' } }),
            editTurn('Add this description: Keep the existing parcel arrangement while reviewing rights.', { paths: { description: 'Keep the existing parcel arrangement while reviewing rights.' } }),
            moveTurn('Relocate this proposal site 10 metres north, retaining its rights-review intent.', ['ugt_edit_design'], { paths: ['site'], eastM: 0, northM: 10, toleranceM: 0.3 }),
            moveTurn('Relocate its site another 8 metres east.', ['ugt_edit_design'], { paths: ['site'], eastM: 8, northM: 0, toleranceM: 0.3 })
        ]
    }))
];

export function buildDesignFixtures({ site = outline, city = 'london', sourceParcel = null } = {}) {
    const result = {};
    const bounds = appTurf.bbox({ type: 'Feature', properties: {}, geometry: site });
    const pointsInSite = [[bounds[0] + (bounds[2] - bounds[0]) * 0.15, (bounds[1] + bounds[3]) / 2],
        [bounds[0] + (bounds[2] - bounds[0]) * 0.85, (bounds[1] + bounds[3]) / 2]];
    for (const [key, args] of Object.entries(designFixtures)) {
        try {
            const input = { ...args, city, site };
            if (args.points) input.points = pointsInSite;
            delete input.outline;
            const sourceGeometry = sourceParcel?.geometry || sourceParcel?.feature?.geometry || smallParcelSite;
            const sourceId = sourceParcel?.id || sourceParcel?.parcelId || 'fixture-parcel';
            const parcels = ['block', 'detached'].includes(args.typology)
                ? [{ id: sourceId, feature: sourceParcel?.feature || { type: 'Feature', properties: { parcelId: sourceId }, geometry: sourceGeometry } }]
                : [];
            if (parcels.length) input.site = sourceGeometry;
            const design = args.kind === 'building' || args.kind === 'track'
                ? buildTypedDesign(input, { parcels })
                : intentDesign.build(input, { turf: appTurf });
            result[key] = { cid: cidOfObject(design), design };
        } catch (error) { throw new Error(`Could not build canonical lifecycle fixture ${key}: ${error.message}`, { cause: error }); }
    }
    const track = result.track.design;
    const station = buildTypedDesign({ kind: 'station', city, authoredAt: common.authoredAt,
        stationType: 'tram', point: pointsInSite[0].map((n, i) => (n + pointsInSite[1][i]) / 2), corridors: [{ cid: cidOfObject(track), content: track }], title: 'Lifecycle station' });
    result.station = { cid: cidOfObject(station), design: station, corridor: { cid: cidOfObject(track), design: track } };
    for (const goal of ['as-is', 'ownership-transfer']) {
        const design = constructorRuntime.record.published({ goal, title: `Lifecycle ${goal}`, city, site,
            buildingProposal: { typologyType: goal, parameters: {} }, createdAt: common.authoredAt });
        const checked = constructorRuntime.record.validate(design);
        if (!checked.valid) throw new Error(`Invalid canonical ${goal} fixture: ${checked.errors.map(row => row.message).join('; ')}`);
        result[goal] = { cid: cidOfObject(design), design };
    }
    for (const [key, row] of Object.entries(result)) if (row.design) {
        const checked = constructorRuntime.record.validate(row.design);
        if (!checked.valid) throw new Error(`Invalid canonical lifecycle fixture ${key}: ${checked.errors.map(item => item.message).join('; ')}`);
    }
    return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const flag = process.argv.indexOf('--write-json');
    if (flag < 0 || !process.argv[flag + 1]) throw new Error('Usage: node scripts/chat-eval-lifecycle-cases.js --write-json <path>');
    const target = path.resolve(process.argv[flag + 1]);
    const basePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-eval-cases.json');
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    const known = new Set(base.map(row => row.id));
    writeFileSync(target, `${JSON.stringify([...base, ...lifecycleCases.filter(row => !known.has(row.id))], null, 2)}\n`);
}
