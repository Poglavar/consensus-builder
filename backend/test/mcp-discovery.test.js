// Discovery stays bounded, preserves exact source contracts as data, and carries usable pagination.
import { describe, expect, it, vi } from 'vitest';
import { createMcpDiscoveryTools } from '../agents/mcp-discovery.js';
import { markUntrusted } from '../agents/mcp-results.js';
import { MCP_HOSTED_TOOLS } from '../agents/mcp-catalog.js';

function fixture() {
    const contract = { id: 'arcgis', methods: ['queryIds', 'queryGeometry'], configSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } };
    const catalogue = { abstractions: [{ id: 'parcels', contract: { schemaVersion: 'source-abstraction/v1', operations: { queryIds: {} }, adapters: Array.from({ length: 1000 }, () => contract) },
        adapters: [{ id: 'arcgis', contract }, { id: 'unrelated', contract: { ...contract, id: 'unrelated' } }],
        sources: [{ id: 'first', adapter: 'arcgis', label: 'First source', config: { cityIds: ['london'], bbox: [-1, 50, 1, 52], name: 'Exact source name' } },
            { id: 'second', adapter: 'arcgis', config: { city: 'london' } },
            { id: 'elsewhere', adapter: 'unrelated', config: { city: 'paris', bbox: [2, 48, 3, 49] } }] }] };
    const read = { request: vi.fn(async () => catalogue) };
    return { ...createMcpDiscoveryTools({ read }), read, contract };
}

describe('tool-only MCP discovery', () => {
    it('describes every exposed authoring family without fetching a giant upstream manifest', () => {
        const tools = fixture(), result = markUntrusted(tools.capabilities());
        expect(tools.read.request).not.toHaveBeenCalled();
        expect(result.tools.map(tool => tool.name)).toEqual(MCP_HOSTED_TOOLS);
        expect(result.features.find(row => row.feature === 'stations')).toMatchObject({
            kinds: ['bus', 'tram', 'underground', 'elevated'],
            categories: { road: ['bus'], track: ['tram', 'elevated', 'underground'] },
            trackPlacement: { ground: 'tram', elevated: 'elevated', underground: 'underground' }
        });
        expect(result.features.find(row => row.feature === 'review').validate).toBe('ugt_validate_plan');
        expect(result.features.find(row => row.feature === 'imports')).toMatchObject({ modelKinds: expect.arrayContaining(['furniture']),
            furnitureKinds: ['bench', 'statue', 'fountain', 'stall', 'tree', 'lamp', 'swing', 'seesaw', 'slide'], furnitureLimits: { maxTriangles: 5000, maxTextureSize: 1024, maxBytes: 4 * 1024 * 1024 } });
        expect(result.features.find(row => row.feature === 'public-spaces')).toMatchObject({ furnitureKinds: { park: ['bench', 'stall', 'tree', 'lamp', 'swing', 'seesaw', 'slide'] },
            furniture: expect.stringMatching(/lamps.*stalls.*models.*enclosures/), enclosures: { fences: ['rail', 'mesh', 'iron', 'plinth'], uses: ['none', 'dog', 'play'] } });
        expect(result.next.tool).toBe('ugt_help');
        expect(JSON.stringify(result).length).toBeLessThan(16_000);
    });
    it('filters geography and adapter, then paginates without losing options or creating an endless next page', async () => {
        const tools = fixture();
        const first = markUntrusted(await tools.listSources({ city: 'london', bbox: [-0.2, 51.4, 0, 51.6], abstraction: 'parcels', adapterId: 'arcgis', limit: 1, includeConfiguration: true }));
        expect(first.items.map(row => row.id)).toEqual(['first']);
        expect(first.items[0].operations).toEqual(['queryIds', 'queryGeometry']);
        expect(first.items[0].untrusted.config.name).toBe('Exact source name');
        expect(first.next.arguments).toMatchObject({ city: 'london', adapterId: 'arcgis', includeConfiguration: true, offset: 1 });
        const last = await tools.listSources(first.next.arguments);
        expect(last.items.map(row => row.id)).toEqual(['second']);
        expect(last).toMatchObject({ total: 2, truncated: false });
        expect(last).not.toHaveProperty('next');
        expect(last.items[0].coverage).toBeNull();
    });
    it('requires a selected adapter for detailed contracts and excludes unrelated schemas', async () => {
        const tools = fixture();
        await expect(tools.listSources({ includeContract: true })).rejects.toMatchObject({ code: 'source-contract-selection-required', next: { tool: 'ugt_list_sources' } });
        expect(tools.read.request).not.toHaveBeenCalled();
        const result = markUntrusted(await tools.listSources({ abstraction: 'parcels', sourceId: 'first', includeContract: true }));
        expect(result.abstractions[0].untrusted.adapters).toEqual([{ id: 'arcgis', contract: tools.contract }]);
        expect(result.abstractions[0].untrusted.contract).not.toHaveProperty('adapters');
        expect(result.abstractions[0].untrusted.adapters[0].contract.configSchema.properties.name).toEqual({ type: 'string' });
        expect(JSON.stringify(result).length).toBeLessThan(2000);
    });
    it('provides corrective tools and valid choices for unknown topics and abstractions', async () => {
        const tools = fixture();
        expect(() => tools.help({ topic: 'invented' })).toThrow(expect.objectContaining({ code: 'help-topic-unknown', next: { tool: 'ugt_capabilities', arguments: {} } }));
        await expect(tools.listSources({ abstraction: 'invented' })).rejects.toMatchObject({ code: 'source-abstraction-unknown', constraints: { allowedValues: ['parcels'] } });
    });
});

describe('the scheme catalogue', () => {
    it('lists every scheme a rule can pin, with its rules and sources, as a help topic', () => {
        const result = fixture().help({ topic: 'schemes' });
        expect(result.topic).toBe('schemes');
        const ids = result.schemes.map(scheme => scheme.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(expect.arrayContaining(['nl-kavelruil', 'jp-association', 'de-umlegung-new', 'in-gj-tps']));
        const germany = result.schemes.find(scheme => scheme.id === 'de-umlegung-developed');
        expect(germany).toMatchObject({ version: '2026-10-28', family: 'authority-led', country: 'DE', authorities: 1, tests: [],
            allocation: { basis: 'either', cap: { numerator: 1, denominator: 10, per: 'owner', basis: 'area' }, valueGain: { numerator: 1, denominator: 1 } } });
        expect(germany.distribution).toEqual([
            'Distributed by area, no owner gives up more than 10% of their land.',
            'Distributed by value, each owner is made whole to the value they put in; the whole value gain is settled in money.',
            'Land returns to its owners or goes to public use; a proposer cannot acquire it.'
        ]);
        expect(germany.sources[0].url).toMatch(/gesetze-im-internet/);
        // The guide's dimensions, coded and worded the same way for every scheme.
        expect(Object.keys(germany.dimensions)).toEqual(['initiator', 'decider', 'support', 'electorate', 'dissenters', 'stage', 'basis', 'publicLand', 'levelling', 'valueGain', 'minParties']);
        expect(germany.dimensions.dissenters).toEqual({ value: 'bound-by-authority', short: 'Bound by the authority', long: 'The authority’s decision binds every owner.' });
        expect(germany.dimensions.publicLand).toMatchObject({ value: { per: 'owner', ratio: 0.1, basis: 'area' }, short: '≤ 10% per owner (by area)' });
        expect(result.schemes.find(scheme => scheme.id === 'jp-joint').dimensions.dissenters.value).toBe('veto');
        expect(result.instructions).toMatch(/rule\.approvalConfig\.regime/);
    });
});
