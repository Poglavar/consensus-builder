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
        await expect(votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts })).rejects.toThrow('osm:way/37: unknown [17.4 No existing mansard storey: Unknown]');
        expect(readFacts).toHaveBeenCalledWith(['osm:way/36', 'osm:way/37']);
    });
    it('refuses a Grade II* listed house and leaves an unknown listing unknown, as the app judges them', async () => {
        const starred = { ...notListed, value: { ...notListed.value, listed: true, grade: 'II*', reference: '1195683', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', basis: 'house-number' } };
        const readFacts = async ids => new Map(ids.map(id => [id, { found: true, facts: id === 'osm:way/37' ? { ...georgian, heritage: starred } : { ...georgian, heritage: null } }]));
        const error = await votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts }).catch(e => e);
        expect(error.code).toBe('eligibility-failed');
        expect(error.message).toContain('osm:way/36: unknown [17.9 Not Grade I or II* listed: Unknown]');
        expect(error.message).toContain('osm:way/37: ineligible [17.9 Not Grade I or II* listed: No, grade II* (Listed, grade II*) — List entry 1195683: https://historicengland.org.uk/listing/the-list/list-entry/1195683]');
        expect(error.constraints.eligibility[1].tests[0]).toMatchObject({ cite: '17.9', status: 'fail', link: { url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', text: 'List entry 1195683' } });
    });
    it('gives an agent the reasons and links the building card shows: a register reason with its entry, a key to add', async () => {
        const entry = { reference: '1195683', name: 'NUMBERS 26 TO 50', grade: 'II', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683' };
        const edit = { url: 'https://www.openstreetmap.org/edit?editor=id&way=37', source: 'OpenStreetMap', keys: { parapet: 'building:parapet' } };
        const readFacts = async ids => new Map(ids.map(id => [id, id === 'osm:way/37'
            ? { found: true, edit, facts: { ...georgian, parapet: null, heritage: null }, unknown_reasons: { heritage: { code: 'row-uncertain', message: 'x', entries: [entry] } } }
            : { found: true, facts: georgian }]));
        const error = await votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts }).catch(e => e);
        const [house] = error.constraints.eligibility;
        expect(house).toMatchObject({ id: 'osm:way/37', verdict: 'unknown', edit: edit.url });
        expect(house.tests).toMatchObject([
            { cite: '17.2', status: 'unknown', add: { key: 'building:parapet', source: 'OpenStreetMap', url: edit.url } },
            { cite: '17.9', status: 'unknown', reason: 'A listed entry on this row may cover this house', link: { url: entry.url, text: 'List entry 1195683' } }]);
        expect(error.message).toContain('17.9 Not Grade I or II* listed: Unknown — A listed entry on this row may cover this house — List entry 1195683: https://historicengland.org.uk/listing/the-list/list-entry/1195683');
        expect(error.message).toContain('add building:parapet in OpenStreetMap: https://www.openstreetmap.org/edit?editor=id&way=37');
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
