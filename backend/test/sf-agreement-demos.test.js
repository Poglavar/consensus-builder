// SF demo preparation verifies archived provenance and never invents consent or changes footprints.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { canonicalBytes } from '../cid.js';
import { prepareSfDemoDesigns } from '../scripts/lib/sf-agreement-demos.mjs';

const authoredAt = '2026-10-26T00:00:00.000Z';
function fixture() {
    const polygon = { type: 'Polygon', coordinates: [[[-122.4,37.7],[-122.399,37.7],[-122.399,37.701],[-122.4,37.701],[-122.4,37.7]]] };
    const footprint = structuredClone(polygon);
    footprint.coordinates[0][1][0] += 0.000001;
    footprint.coordinates[0][2][0] += 0.000001;
    const records = ['courtyard', 'fivepoint'].map(key => ({ proposal_id: key, cadastre_parcel_ids: ['US-test-1'],
        proposal_data: { goal: 'buildings', city: 'san_francisco', title: key, site: polygon,
            geometry: { buildings: [{ type: 'Feature', geometry: footprint, properties: { floors: 3, height: 9 } }] },
            buildingProposal: { type: 'single', parameters: { floors: 3, floorHeight: 3 } } } }));
    const intents = { intents: records.map(row => ({ key: row.proposal_id, agreementLabel: row.proposal_id,
        sourceRecord: { proposalId: row.proposal_id, contentSha256: createHash('sha256').update(canonicalBytes(row.proposal_data)).digest('hex') },
        proposedDeadline: '2027-10-09T08:19:27Z', land: { sourceId: 'test-source', parcelIds: ['US-test-1'] } })) };
    return { records, intents };
}

describe('SF devnet demo source preparation', () => {
    it('labels demos and repairs their site while retaining the exact source footprint', () => {
        const { records, intents } = fixture();
        const items = prepareSfDemoDesigns(records, intents, { authoredAt });
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ title: 'DEVNET DEMO: courtyard', sitePreparation: { method: 'union-with-imported-footprints' } });
        expect(items[0].design.content.description).toContain('simulated rights');
        expect(items[0].design.content.geometry.buildings[0].geometry.coordinates).toEqual(records[0].proposal_data.geometry.buildings[0].geometry.coordinates);
        expect(items[0].design.content.site).not.toEqual(records[0].proposal_data.site);
        expect(turf.booleanWithin(turf.feature(records[0].proposal_data.geometry.buildings[0].geometry), turf.feature(items[0].design.content.site))).toBe(true);
    });

    it('refuses changed source geometry or parcel identity before publishing', () => {
        const changed = fixture();
        changed.records[0].proposal_data.geometry.buildings[0].properties.floors = 7;
        expect(() => prepareSfDemoDesigns(changed.records, changed.intents, { authoredAt })).toThrow(/source hash differs/);
        const identity = fixture();
        identity.records[0].cadastre_parcel_ids = ['another-parcel'];
        expect(() => prepareSfDemoDesigns(identity.records, identity.intents, { authoredAt })).toThrow(/parcel identities differ/);
    });
});
