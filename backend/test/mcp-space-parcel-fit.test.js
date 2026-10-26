import { describe, expect, it, vi } from 'vitest';
import { registerMcpCompanion } from '../agents/mcp-companion.mjs';
import { createMcpReadTools } from '../agents/mcp-read-tools.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { appTurf, intentDesign } from '../agents/mcp-geometry.js';
import { cidOfObject } from '../cid.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const structureParcelFit = require('../../frontend/js/structure-parcel-fit.js');

const ring = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const polygon = (west, south, east, north) => ({ type: 'Polygon', coordinates: [ring(west, south, east, north)] });
const outline = polygon(-0.1, 51.5, -0.098, 51.502);
const feature = (id, geometry) => ({ type: 'Feature', id, properties: { parcelId: id }, geometry });
const sourceFeatures = [
    feature('LONDON-1', polygon(-0.1, 51.5, -0.099, 51.502)),
    feature('LONDON-2', polygon(-0.099, 51.5, -0.095, 51.502)),
    // An edge-only contact is returned by the stub source but must not be considered touched.
    feature('LONDON-EDGE', polygon(-0.098, 51.5, -0.097, 51.502))
];

function publicParcelContextTool(action) {
    const tools = new Map();
    const server = {
        registerTool(name, options, callback) { tools.set(name, { options, callback }); },
        registerResource() {},
        registerPrompt() {}
    };
    registerMcpCompanion(server, {
        actions: { parcelContext: action },
        handler: callback => callback,
        readOnly: { readOnlyHint: true },
        discovery: {}
    });
    return tools.get('ugt_parcel_context');
}

describe('public MCP parcel outline lookup', () => {
    it('accepts one Polygon or MultiPolygon selector and rejects mixed or missing selectors', () => {
        const tool = publicParcelContextTool(vi.fn());
        const schema = tool.options.inputSchema;
        expect(schema.safeParse({ city: 'london', parcelSourceId: 'fixture', geometry: outline }).success).toBe(true);
        expect(schema.safeParse({ city: 'london', parcelSourceId: 'fixture', geometry: { type: 'MultiPolygon', coordinates: [[ring(-0.1, 51.5, -0.099, 51.502)]] } }).success).toBe(true);
        expect(schema.safeParse({ city: 'london', parcelSourceId: 'fixture', parcelId: 'LONDON-1', geometry: outline }).success).toBe(false);
        expect(schema.safeParse({ city: 'london', parcelSourceId: 'fixture', point: [-0.099, 51.501], geometry: outline }).success).toBe(false);
        expect(schema.safeParse({ city: 'london', parcelSourceId: 'fixture' }).success).toBe(false);
        expect(schema.safeParse({ city: 'london', parcelSourceId: 'fixture', geometry: { type: 'Point', coordinates: [-0.099, 51.501] } }).success).toBe(false);
    });

    it('queries complete outline ground through the exposed tool and returns only positive-area touches', async () => {
        const fetchImpl = vi.fn(async (url, options) => {
            expect(new URL(url).pathname).toBe('/parcel-sources/fixture/under');
            expect(options.method).toBe('POST');
            expect(JSON.parse(options.body)).toEqual({ geometry: outline });
            return Response.json({ complete: true, features: sourceFeatures });
        });
        const reads = createMcpReadTools({ apiBase: 'https://api.example', appOrigin: 'https://app.example', fetchImpl });
        const action = vi.fn(args => reads.parcelContext(args));
        const tool = publicParcelContextTool(action);
        const result = await tool.callback({ city: 'london', parcelSourceId: 'fixture', geometry: outline });

        expect(action).toHaveBeenCalledWith({ city: 'london', parcelSourceId: 'fixture', geometry: outline });
        expect(result).toMatchObject({ complete: true, parcelSourceId: 'fixture', features: sourceFeatures.slice(0, 2),
            parcelAreasM2: {
                'LONDON-1': appTurf.area(sourceFeatures[0]),
                'LONDON-2': appTurf.area(sourceFeatures[1])
            } });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('refuses incomplete outline coverage rather than returning a partial parcel set', async () => {
        const reads = createMcpReadTools({ apiBase: 'https://api.example', appOrigin: 'https://app.example',
            fetchImpl: vi.fn(async () => Response.json({ complete: false, features: sourceFeatures })) });
        await expect(reads.parcelContext({ city: 'london', parcelSourceId: 'fixture', geometry: outline }))
            .rejects.toMatchObject({ code: 'parcel-coverage-incomplete' });
    });

    it('unions returned parcel geometries through the documented atomic edit primitives', async () => {
        const design = intentDesign.build({ kind: 'space', spaceKind: 'square', site: outline,
            city: 'london', title: 'Square', authoredAt: '2026-10-25T00:00:00.000Z' }, { turf: appTurf });
        const read = createMcpReadTools({ apiBase: 'https://api.example', appOrigin: 'https://app.example',
            fetchImpl: async () => Response.json({ binding: { coverage: 'complete', parcels: [] }, parcelSourceId: 'fixture' }) });
        const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        const edited = await drafts.editDesign({ design, expectedCid: cidOfObject(design), edits: [
            { op: 'add', path: '/structureProposal/_fitA', value: sourceFeatures[0].geometry },
            { op: 'add', path: '/structureProposal/_fitB', value: sourceFeatures[1].geometry },
            { op: 'union', path: '/structureProposal/_fitA', from: '/structureProposal/_fitB' },
            { op: 'copy', path: '/structureProposal/geometry', from: '/structureProposal/_fitA' },
            { op: 'remove', path: '/structureProposal/_fitA' },
            { op: 'remove', path: '/structureProposal/_fitB' }
        ] });
        expect(appTurf.area(appTurf.feature(edited.design.site))).toBeCloseTo(sourceFeatures.slice(0, 2).reduce((sum, f) => sum + appTurf.area(f), 0), 4);
        expect(edited.design.structureProposal.geometry).toEqual(edited.design.site);
        expect(edited.design.structureProposal).not.toHaveProperty('_fitA');
        expect(edited.design.structureProposal).not.toHaveProperty('_fitB');
    });

    it('rejects a disconnected lake fit without changing the source', async () => {
        const design = intentDesign.build({ kind: 'space', spaceKind: 'lake', site: outline,
            city: 'london', title: 'Lake', authoredAt: '2026-10-25T00:00:00.000Z' }, { turf: appTurf });
        const before = structuredClone(design);
        const read = createMcpReadTools({ apiBase: 'https://api.example', appOrigin: 'https://app.example',
            fetchImpl: async () => Response.json({ binding: { coverage: 'complete', parcels: [] }, parcelSourceId: 'fixture' }) });
        const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        await expect(drafts.editDesign({ design, expectedCid: cidOfObject(design), edits: [{ op: 'replace', path: '/structureProposal/geometry',
            value: { type: 'MultiPolygon', coordinates: [sourceFeatures[0].geometry.coordinates, polygon(-.09, 51.5, -.08, 51.502).coordinates] }
        }] })).rejects.toMatchObject({ code: 'invalid-lake' });
        expect(design).toEqual(before);
    });

    for (const kind of ['park', 'lake', 'square']) for (const mode of ['largest', 'all']) {
        it(`uses the existing inspect/edit design path to fit a ${kind} to ${mode} source parcels`, async () => {
            const fetchImpl = vi.fn(async (url, options) => {
                const path = new URL(url).pathname;
                if (path === '/parcel-sources/fixture/under') return Response.json({ complete: true, features: sourceFeatures });
                if (path === '/designs/binding') return Response.json({ parcelSourceId: 'fixture', binding: { coverage: 'complete', parcels: [] } });
                throw new Error(`Unexpected MCP read ${path} (${options.method || 'GET'})`);
            });
            const read = createMcpReadTools({ apiBase: 'https://api.example', appOrigin: 'https://app.example', fetchImpl });
            const publicTool = publicParcelContextTool(args => read.parcelContext(args));
            const source = await publicTool.callback({ city: 'london', parcelSourceId: 'fixture', geometry: outline });
            const fitted = structureParcelFit.fit({ boundary: outline, parcels: source.features, mode, turf: appTurf });
            expect(fitted.parcelIds).toEqual(mode === 'largest' ? ['LONDON-2'] : ['LONDON-2', 'LONDON-1']);

            const design = intentDesign.build({ kind: 'space', spaceKind: kind, site: outline, city: 'london', title: `${kind} fit`,
                description: 'Preserve authored content', authoredAt: '2026-10-25T00:00:00.000Z', treeCount: 2 }, { turf: appTurf });
            const before = structuredClone(design);
            const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
            const inspected = await drafts.inspectDesign({ design, paths: ['/structureProposal/geometry', '/site'] });
            expect(inspected.values.map(item => item.untrustedValue)).toEqual([outline, outline]);
            const edited = await drafts.editDesign({ design, expectedCid: inspected.cid, edits: [
                { op: 'replace', path: '/structureProposal/geometry', value: fitted.geometry }
            ] });

            expect(edited.design.structureProposal.geometry).toEqual(fitted.geometry);
            expect(edited.design.site).toEqual(fitted.geometry);
            const originalDecorations = before.structureProposal.decorationDesign;
            if (originalDecorations) {
                const expectedTrees = originalDecorations.trees.filter(tree =>
                    appTurf.booleanPointInPolygon(appTurf.point(tree.coordinate), appTurf.feature(fitted.geometry)));
                expect(edited.design.structureProposal.decorationDesign.trees).toEqual(expectedTrees);
                expect(edited.design.structureProposal.decorationDesign.benches).toEqual(originalDecorations.benches);
            }
            if (kind === 'lake') {
                expect(edited.design.structureProposal.lakeGraphics.geometry).toEqual(fitted.geometry);
                expect(edited.design.structureProposal.lakeGraphics).toMatchObject({ version: 3, shore: expect.any(Object), water: expect.any(Object) });
            }
            expect(edited.design.origin).toEqual({ cid: cidOfObject(design) });
            expect(design).toEqual(before);
        });
    }
});
