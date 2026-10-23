// Concrete read/draft contract fixtures and an evaluation seed from a current indexed agreement.
// No publication, payment, signature or model call. The caller selects the existing agreement.
import { appTurf as turf, intentDesign as builder } from '../agents/mcp-geometry.js';
import { createMcpReadTools } from '../agents/mcp-read-tools.js';

export async function acceptanceFixtures({ apiBase, appOrigin, agreementCid, fetchImpl = fetch }) {
    const read = createMcpReadTools({ apiBase, appOrigin, fetchImpl });
    const row = await read.getAgreement({ agreementCid });
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
    const building = builder.build({ kind: 'building', site, floors: 4, city, authoredAt }, { turf });
    const account = row.onchain?.account;
    if (!account) throw new Error('Choose a minted agreement for chain support/oracle/approval checks');
    const fixtures = {
        ugt_capabilities: {}, ugt_activity: { limit: 1 }, ugt_list_agreements: { city, limit: 1 },
        ugt_get_agreement: { agreementCid }, ugt_list_attesters: {}, ugt_support_status: { agreementAccount: account },
        ugt_oracle_events: { agreementAccount: account }, ugt_inspect_verified_fact: { agreementAccount: account },
        ugt_publish_design: { design, parcelSourceId, confirm: false },
        ugt_propose_agreement: { agreement: row.content, confirm: false },
        ugt_approval_link: { action: 'bet', target: account, params: { side: 'yes', amount: '0.05', city } },
        ugt_find_place: { query: row.content.designs[0].cid, city }, ugt_parcel_context: { city, parcelSourceId, parcelId },
        ugt_list_designs: { city, limit: 1 }, ugt_get_design: { designCid: row.content.designs[0].cid },
        ugt_markets: { city }, ugt_explain: { term: 'Parcel binding' },
        ugt_draft_road: { city, parcelSourceId, points: streetPoints, preset: '1+1', authoredAt },
        ugt_draft_building: { ...scope, floors: 4, authoredAt },
        ugt_draft_space: { ...scope, spaceKind: 'park', authoredAt },
        ugt_draft_parcel_layout: { ...scope, algorithm: 'equal', count: 4, authoredAt },
        ugt_draft_urban_rule: { ...scope, rule: { floors: 6 }, authoredAt },
        ugt_modify_design: { design, parcelSourceId, changes: [{ type: 'retitle', value: 'MCP acceptance draft' }] },
        ugt_compare: { targets: [design, building], parcelSourceId },
        ugt_draft_agreement: { designs: [design], parcelSourceId, title: 'MCP acceptance draft', createdAt: authoredAt }
    };
    return { fixtures, seed: { ...scope, streetPoints, agreementAccount: account }, provenance: { agreementCid, parcelId, parcelSourceId } };
}
