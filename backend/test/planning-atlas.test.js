// Atlas source areas retain conditional/evidence semantics and never become invented massing.
import { describe, expect, it } from 'vitest';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { planningRepresentations, planningRecord } from '../planning/sources.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const envelopes = require('../../frontend/js/planning/envelopes.js');
const contract = require('../../frontend/js/planning/source-proposal.js');
const metadata = { id: 'atlas-sample', city: 'sample', label: 'Source example', edition: 'sample-1', url: 'https://example.test/source' };
const feature = id => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[10,40],[10.02,40],[10.02,40.02],[10,40.02],[10,40]]] },
    properties: { slice_id: id, jurisdiction: 'Example', family1_treatment: 'hearing', family4_treatment: 'allowed',
        family1_frontsetbackft: 0, family1_frontsetbackft_method: 'direct_number',
        family1_maxheightft: 35, family1_maxheightft_method: 'estimation',
        family1_sidesetbackft: -1, family1_sidesetbackft_method: 'indeterminate',
        family4_maxheightft: 50, family4_maxheightft_method: 'direct_number', unusual_condition: 'Keep this source field.' } });
const provider = () => createAtlasProvider({ type: 'FeatureCollection', features: [feature(1), feature(2)] }, metadata);
const query = { city: 'sample', source: 'atlas-sample', scenario: 'family1', bbox: [10.005,40.005,10.01,40.01], limit: 1 };

describe('Atlas planning adapter', () => {
    it('draws source areas, preserves all source fields and distinguishes direct, estimated and indeterminate constraints', async () => {
        const result = await planningRepresentations({}, query, [provider()]);
        const item = result.items[0];
        expect(item.volumes).toEqual([]); expect(item.areas).toHaveLength(1); expect(item.metrics.heightM).toBeNull();
        expect(item.constraints).toContainEqual(expect.objectContaining({ quantity: 'frontSetback', value: 0, evidence: 'direct', unit: 'ft' }));
        expect(item.constraints).toContainEqual(expect.objectContaining({ quantity: 'height', value: 35, evidence: 'estimated' }));
        expect(item.constraints.some(c => c.quantity === 'sideSetback')).toBe(false);
        expect(item.sourceEvidence.properties.unusual_condition).toBe('Keep this source field.');
        expect(item.sourceEvidence.numericEvidence.family1_sidesetbackft.status).toBe('indeterminate');
        expect(item.assessment).toMatchObject({ status: 'hearing', constraints: 'not-evaluated', meaning: 'zoning-area' });
        expect(envelopes.mapFeatures(item, { detail:'footprint' })).toHaveLength(1); expect(envelopes.volumeFeatures(item)).toEqual([]);
    });
    it('paginates source areas and clips their display without changing source identity or revision', async () => {
        const source = provider(), first = await planningRepresentations({}, query, [source]);
        const second = await planningRepresentations({}, { ...query, cursor: first.nextCursor }, [source]);
        expect(first.items[0].id).not.toBe(second.items[0].id); expect(second.nextCursor).toBeNull();
        const original = await planningRecord({}, { city: 'sample', source: 'atlas-sample', recordId: '1', scenario: 'family1' }, [source]);
        expect(first.items[0].site).not.toEqual(original.items[0].site);
        expect(first.items[0].source.version).toBe(original.items[0].source.version);
        expect(first.items[0].proposal.proposalId).toBe(original.items[0].proposal.proposalId);
    });
    it('selects a housing scenario and refuses to reuse another scenario’s cursor', async () => {
        const source = provider(), first = await planningRepresentations({}, query, [source]);
        const other = await planningRepresentations({}, { ...query, scenario: 'family4' }, [source]);
        expect(other.items[0].constraints.find(c => c.quantity === 'height').value).toBe(50);
        expect(other.items[0].assessment.status).toBe('allowed');
        await expect(planningRepresentations({}, { ...query, scenario: 'family4', cursor: first.nextCursor }, [source])).rejects.toMatchObject({ status: 400 });
        await expect(planningRepresentations({}, { ...query, scenario: 'unknown' }, [source])).rejects.toMatchObject({ status: 400 });
    });
    it('pins area/scenario references without inventing cadastral parcel membership', async () => {
        const { items } = await planningRepresentations({}, query, [provider()]);
        const reference = contract.reference(items[0].proposal);
        expect(reference).toMatchObject({ recordId: '1', parcelId: null, scenario: 'family1' });
        expect(() => contract.validateReferences([reference])).not.toThrow();
    });
});
