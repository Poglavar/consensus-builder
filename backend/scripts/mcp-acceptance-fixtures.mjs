// Concrete read/draft contract fixtures and an evaluation seed from a current indexed agreement.
// No publication, payment, signature or model call. The caller selects the existing agreement.
import { appTurf as turf, intentDesign as builder } from '../agents/mcp-geometry.js';
import { buildTypedDesign } from '../agents/mcp-constructors.js';
import { createMcpReadTools } from '../agents/mcp-read-tools.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
import { cidOfObject } from '../cid.js';

export async function acceptanceFixtures({ apiBase, appOrigin, agreementCid, fetchImpl = fetch }) {
    const read = createMcpReadTools({ apiBase, appOrigin, fetchImpl });
    const row = await read.getAgreement({ agreementCid });
    const referencedPlan = await read.request(`/plans/${encodeURIComponent(row.content.planCid)}`);
    if (referencedPlan.cid !== row.content.planCid || !referencedPlan.content || cidOfObject(referencedPlan.content) !== referencedPlan.cid
        || referencedPlan.content.schema !== PlanRecord.SCHEMA || PlanRecord.validate(referencedPlan.content)) {
        throw new Error('The selected agreement does not resolve to its exact valid indexed plan');
    }
    const firstDesignCid = referencedPlan.content.designCids[0];
    if (!firstDesignCid) throw new Error('The selected agreement plan has no designs');
    const city = row.content.city, parcelId = row.content.inputs.parcels[0]?.parcelId;
    if (!city || !parcelId) throw new Error('Choose an indexed agreement over cadastral parcels in a configured city');
    const source = await read.parcels({ city, parcelSourceId: row.parcelSourceId, parcelIds: [parcelId] });
    if (source.features.length !== 1) throw new Error('Acceptance needs one exact source parcel');
    const parcelSourceId = source.parcelSourceId, site = source.features[0].geometry;
    const bounds = turf.bbox(source.features[0]), mid = (bounds[1] + bounds[3]) / 2;
    const streetPoints = [[bounds[0], mid], [bounds[2], mid]];
    const scope = { city, parcelSourceId, parcelIds: [parcelId] };
    const authoredAt = row.content.createdAt || '2026-10-23T00:00:00.000Z';
    const design = builder.build({ kind: 'space', spaceKind: 'park', site, city, authoredAt }, { turf });
    const building = buildTypedDesign({ kind: 'building', typology: 'freeform', site, floors: 4, city, authoredAt }, { parcels: source.features });
    const road = builder.build({ kind: 'road', points: streetPoints, city, authoredAt }, { turf });
    const track = builder.build({ kind: 'track', points: streetPoints, gauge: 1000, speed: 80, city, authoredAt }, { turf });
    const view = { at: `${mid},${(bounds[0] + bounds[2]) / 2},17`, mode: '2d', city };
    const plan = PlanRecord.create('MCP acceptance plan', [cidOfObject(design), cidOfObject(building)], view);
    const privatePlan = { plan, designs: [design, building], designSources: { [cidOfObject(design)]: parcelSourceId, [cidOfObject(building)]: parcelSourceId } };
    const account = row.onchain?.account;
    if (!account) throw new Error('Choose a minted agreement for chain support/oracle/approval checks');
    const fixtures = {
        ugt_capabilities: {}, ugt_help: { topic: 'workflow' }, ugt_list_sources: { city, abstraction: 'parcels', limit: 2 }, ugt_activity: { limit: 1 }, ugt_list_agreements: { city, limit: 1 },
        ugt_get_agreement: { agreementCid }, ugt_list_attesters: {}, ugt_support_status: { agreementAccount: account },
        ugt_oracle_events: { agreementAccount: account }, ugt_inspect_verified_fact: { agreementAccount: account },
        ugt_publish_design: { design, parcelSourceId, confirm: false },
        ugt_propose_agreement: { agreement: row.content, confirm: false },
        ugt_approval_link: { action: 'bet', target: account, params: { side: 'yes', amount: '0.05', city } },
        ugt_find_place: { query: firstDesignCid, city }, ugt_parcel_context: { city, parcelSourceId, parcelId },
        ugt_list_designs: { city, limit: 1 }, ugt_get_design: { designCid: firstDesignCid },
        ugt_markets: { city }, ugt_explain: { term: 'Parcel binding' },
        ugt_draft_road: { city, parcelSourceId, points: streetPoints, preset: '1+1', authoredAt },
        ugt_draft_building: { ...scope, floors: 4, authoredAt },
        ugt_draft_space: { ...scope, spaceKind: 'park', authoredAt },
        ugt_draft_parcel_layout: { ...scope, algorithm: 'equal', count: 4, authoredAt },
        ugt_draft_urban_rule: { ...scope, rule: { floors: 6 }, authoredAt },
        ugt_modify_design: { design, parcelSourceId, changes: [{ type: 'retitle', value: 'MCP acceptance draft' }] },
        ugt_inspect_design: { design, paths: ['/structureProposal'] },
        ugt_edit_design: { design, parcelSourceId, expectedCid: cidOfObject(design), edits: [{ op: 'replace', path: '/title', value: 'MCP acceptance edit' }] },
        ugt_inspect_agreement: { plan: agreementCid, filter: { kind: 'design' } },
        ugt_edit_agreement: { plan: agreementCid, expectedCid: agreementCid, terms: { title: 'MCP acceptance revision' } },
        ugt_draft_plan: { designs: [{ content: design, parcelSourceId }, { content: building, parcelSourceId }], title: plan.title, view },
        ugt_get_plan: { plan: privatePlan },
        ugt_inspect_plan: { plan: privatePlan, filter: { kind: 'design' } },
        ugt_edit_plan: { plan: privatePlan, expectedCid: cidOfObject(plan), title: 'MCP acceptance revised plan' },
        ugt_publish_plan: { plan: privatePlan, expectedCid: cidOfObject(plan), confirm: false },
        ugt_export_draft: { draftRef: { $result: 'ugt_draft_space', path: 'draftRef' } },
        ugt_import_design: { city, parcelSourceId, format: 'geojson', floors: 3, data: { type: 'Feature', geometry: site, properties: { name: 'Acceptance imported building' } } },
        ugt_import_model: { city, parcelSourceId, center: [(bounds[0] + bounds[2]) / 2, mid], confirmAssetUpload: false },
        ugt_render_preview: { design },
        ugt_draft_track: { city, parcelSourceId, points: streetPoints, gauge: 1000, speed: 80, authoredAt },
        ugt_draft_station: { city, parcelSourceId, stationType: 'bus', point: [(bounds[0] + bounds[2]) / 2, mid], corridors: [{ content: road, parcelSourceId }] },
        ugt_submit_feedback: { kind: 'bug', message: 'Acceptance confirmation guard check', confirm: false },
        ugt_compare: { targets: [design, building], parcelSourceId },
        ugt_draft_agreement: { designs: [design], parcelSourceId, currency: row.content.money.currency, title: 'MCP acceptance draft', createdAt: authoredAt }
    };
    const constructionCases = [
        // Row houses need two distinct parcels; on the one acceptance parcel they start from its outline, cut into row plots.
        ...['freeform', 'block', 'row', 'detached'].map(typology => ({ id: `building-${typology}`, tool: 'ugt_draft_building', arguments: typology === 'row'
            ? { city, parcelSourceId, outline: site, typology, floors: 4, authoredAt } : { ...scope, typology, floors: 4, authoredAt } })),
        { id: 'road', tool: 'ugt_draft_road', arguments: fixtures.ugt_draft_road },
        { id: 'track', tool: 'ugt_draft_track', arguments: fixtures.ugt_draft_track },
        ...['bus', 'tram', 'underground', 'elevated'].map(stationType => ({ id: `station-${stationType}`, tool: 'ugt_draft_station', arguments: {
            city, parcelSourceId, stationType, point: [(bounds[0] + bounds[2]) / 2, mid], corridors: [{ content: stationType === 'bus' ? road : track, parcelSourceId }] } })),
        ...['park', 'square', 'lake'].map(spaceKind => ({ id: spaceKind, tool: 'ugt_draft_space', arguments: { ...scope, spaceKind, authoredAt } })),
        { id: 'parcel-layout', tool: 'ugt_draft_parcel_layout', arguments: fixtures.ugt_draft_parcel_layout }
    ];
    return { fixtures, constructionCases, seed: { ...scope, streetPoints, agreementAccount: account }, provenance: { agreementCid, parcelId, parcelSourceId } };
}
