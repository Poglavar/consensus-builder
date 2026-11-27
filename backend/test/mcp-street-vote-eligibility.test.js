// Agent parity for Living Tradition street votes (backend/agents/mcp-ground.js votingWithEligibility):
// the server judges the plan's raised houses from building facts as the app's editor does, refuses
// with each house's failing or unknown tests, and records the check when every house passes.
import { describe, expect, it, vi } from 'vitest';
import { votingWithEligibility } from '../agents/mcp-ground.js';

const fact = value => ({ value, source: 'osm', key: 'k', raw: String(value) });
const notListed = { value: { listed: false, grade: null, register: 'National Heritage List for England', reference: null, name: null, url: 'https://www.planning.data.gov.uk/dataset/listed-building', basis: 'none' }, source: 'gb-eng-nhle', key: 'listed-building', raw: 'no entry' };
const georgian = { built: fact({ from: 1828, to: 1830 }), parapet: fact(true), storeys: fact(3), roof_shape: fact('flat'), footprint_m2: fact(45.6), row_size: fact(20), heritage: notListed };
const raised = id => ({ type: 'Feature', geometry: null, properties: { basedOnExisting: true, sourceBuildingId: id, roof: 'mansard' } });
const designs = [{ geometry: { buildings: [raised('w36'), raised('w37')] } }];
const voting = rule => ({ organiser: null, participationUrl: null, voting: { schema: 'community-voting/v2', id: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
    codeHashes: ['a'.repeat(64)], rule } });
const LIVING_TRADITION = { id: 'gb-street-vote-living-tradition', version: '2026-11-27' };

describe('agent street votes under Living Tradition', () => {
    it('refuses while a house is not known eligible, naming the tests', async () => {
        const readFacts = vi.fn(async ids => new Map(ids.map(id => [id, { found: true, facts: id === 'osm:way/37' ? { ...georgian, roof_shape: null } : georgian }])));
        await expect(votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts })).rejects.toThrow('osm:way/37: unknown, unknown 17.4');
        expect(readFacts).toHaveBeenCalledWith(['osm:way/36', 'osm:way/37']);
    });
    it('refuses a Grade II* listed house and leaves an unknown listing unknown, as the app judges them', async () => {
        const starred = { ...notListed, value: { ...notListed.value, listed: true, grade: 'II*', reference: '1195683', basis: 'house-number' } };
        const readFacts = async ids => new Map(ids.map(id => [id, { found: true, facts: id === 'osm:way/37' ? { ...georgian, heritage: starred } : { ...georgian, heritage: null } }]));
        await expect(votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts })).rejects.toThrow('osm:way/36: unknown, unknown 17.9; osm:way/37: ineligible, fails 17.9');
    });
    it('records the check once every house passes', async () => {
        const readFacts = async ids => new Map(ids.map(id => [id, { found: true, facts: georgian, source_version: { version: 3, changed: '2026-11-27T15:00:00Z' } }]));
        const result = await votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts });
        expect(result.voting.eligibility.houses.map(house => [house.id, house.verdict])).toEqual([['osm:way/36', 'eligible'], ['osm:way/37', 'eligible']]);
    });
    it('leaves other rules alone and refuses a plan that raises no house with a mansard', async () => {
        const readFacts = vi.fn();
        const other = voting({ id: 'gb-street-vote-strong-suburbs', version: '2026-11-25' });
        expect(await votingWithEligibility(other, designs, { readFacts })).toBe(other);
        await expect(votingWithEligibility(voting(LIVING_TRADITION), [{ geometry: { buildings: [] } }], { readFacts })).rejects.toThrow('nothing to cover');
        expect(readFacts).not.toHaveBeenCalled();
    });
});
