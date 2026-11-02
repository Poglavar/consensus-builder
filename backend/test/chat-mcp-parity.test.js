// Private plan-member CID parity for granular MCP tools and the isolated internal listener contract.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { createMcpComparison } from '../agents/mcp-compare.js';
import { buildTypedDesign } from '../agents/mcp-constructors.js';
import { appTurf as turf, intentDesign } from '../agents/mcp-geometry.js';
import { cidOfObject } from '../cid.js';
import { createMcpHttpService } from '../agents/mcp-http.mjs';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { previewArtifact } from '../agents/mcp-preview.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';

const site = { type: 'Polygon', coordinates: [[[15,45],[15.002,45],[15.002,45.002],[15,45.002],[15,45]]] };
const common = { city: 'london', site, authoredAt: '2026-10-23T00:00:00.000Z' };
const park = () => intentDesign.build({ ...common, kind: 'space', spaceKind: 'park', title: 'Private park' }, { turf });
const boundRead = {
    siteOfDesign: design => design.site,
    async request(path) {
        if (path === '/designs/binding') return { parcelSourceId: 'private-parcels', binding: { coverage: 'complete', unknownM2: 0, unsurveyedM2: 0, parcels: [] } };
        throw new Error(`Unexpected index read ${path}`);
    },
    async parcels() { return { parcelSourceId: 'private-parcels', features: [] }; }
};

describe('MCP private plan member parity', () => {
    it('uses the real working-plan artifact for draft, inspect, modify and compare', async () => {
        const paths = [];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, appOrigin: 'https://app.example', fetchImpl: async url => {
            const path = new URL(url).pathname; paths.push(path);
            if (path === '/designs/binding') return Response.json({ parcelSourceId: 'private-parcels', binding: { coverage: 'complete', unknownM2: 0, unsurveyedM2: 0, parcels: [] } });
            throw new Error(`Unexpected index request ${path}`);
        } });
        const drafted = await tools.draftSpace({ city: 'london', outline: site, spaceKind: 'park', title: 'Working park' });
        const plan = drafted.plan, cid = drafted.cid;
        expect(plan.draftArtifact.plan.designCids).toContain(cid);
        const inspected = await tools.inspectDesign({ design: cid, plan, paths: ['/title'] });
        expect(inspected.values).toEqual([{ path: '/title', untrustedValue: 'Working park' }]);
        const revised = await tools.modifyDesign({ design: cid, plan, changes: [{ type: 'set_kind', value: 'square' }] });
        expect(revised.design.structureProposal.kind).toBe('square');
        const compared = await tools.compare({ targets: [cid, cid], plan, buildingSources: ['osm'] });
        expect(compared.alternatives).toHaveLength(2);
        expect(paths.filter(path => path.startsWith('/designs/') && path !== '/designs/binding')).toEqual([]);
    });

    it('inspects, patches and modifies an unpublished member by CID when scoped to its plan', async () => {
        const design = park(), cid = cidOfObject(design), plan = { draftRef: 'https://mcp.example/private-plan' };
        const resolvePlan = vi.fn(async value => {
            expect(value).toBe(plan);
            return { designs: [{ cid, content: design, parcelSourceId: 'private-parcels' }] };
        });
        const tools = createMcpDraftTools({ read: boundRead, appOrigin: 'https://app.example', resolvePlan });
        const inspected = await tools.inspectDesign({ design: cid, plan, paths: ['/title'] });
        expect(inspected).toMatchObject({ cid, parcelSourceId: 'private-parcels', values: [{ path: '/title', untrustedValue: 'Private park' }] });
        const edited = await tools.editDesign({ design: cid, plan, expectedCid: cid, edits: [{ op: 'replace', path: '/title', value: 'Patched park' }] });
        expect(edited.design.title).toBe('Patched park');
        const modified = await tools.modifyDesign({ design: cid, plan, changes: [{ type: 'set_kind', value: 'square' }] });
        expect(modified.design.structureProposal.kind).toBe('square');
        expect(resolvePlan).toHaveBeenCalledTimes(3);
    });

    it('compares a private member by CID without falling back to an index lookup', async () => {
        const design = park(), cid = cidOfObject(design), resolveDesign = vi.fn(async value => value);
        const compare = createMcpComparison({ read: boundRead, resolveDesign, appOrigin: 'https://app.example', plans: {
            async resolvePlan() { return { designs: [{ cid, content: design, parcelSourceId: 'private-parcels' }] }; }
        } });
        const result = await compare({ targets: [cid, cid], plan: { draftRef: 'private-plan' }, buildingSources: ['osm'] });
        expect(result.alternatives).toHaveLength(2);
        expect(resolveDesign).toHaveBeenCalledTimes(2);
        expect(resolveDesign).toHaveBeenNthCalledWith(1, design);
    });

    it('resolves a station corridor CID from the private plan', async () => {
        const corridor = buildTypedDesign({ kind: 'track', points: [[15,45],[15.002,45]], gauge: 1000, speed: 80, authoredAt: common.authoredAt });
        const cid = cidOfObject(corridor), plan = { draftRef: 'private-plan' }, resolvePlan = vi.fn(async () => ({ designs: [{ cid, content: corridor, parcelSourceId: 'private-parcels' }] }));
        const tools = createMcpDraftTools({ read: boundRead, appOrigin: 'https://app.example', resolvePlan });
        const station = await tools.draftStation({ city: 'london', stationType: 'underground', point: [15.001,45], corridors: [cid], plan });
        expect(station.design.structureProposal.attachment.sourceId).toBe(cid);
        expect(resolvePlan).toHaveBeenCalledWith(plan);
    });

    it('isolates internal request capacity while sharing its private previews with the public listener', async () => {
        let now = 0;
        const directory = mkdtempSync(join(tmpdir(), 'chat-mcp-parity-'));
        const design = park(), cid = cidOfObject(design);
        const service = createMcpHttpService({ env: {}, storeDirectory: directory, maxPerMinute: 1, now: () => now,
            publicOrigin: 'https://app.example', previewOrigin: 'https://mcp.example',
            factory: settings => createUrbanGameTheoryMcpServer({ ...settings, mode: 'hosted', env: {}, tools: {
                draftSpace: async () => ({ ...await previewArtifact({ origin: 'https://app.example', design }), design, cid,
                    plan: null, placement: { status: 'placed' }, consequences: { removed: [], junctions: [], cuts: [] } })
            } }) });
        const internal = service.createInternal();
        const client = new Client({ name: 'chat-mcp-parity', version: '1' });
        try {
            service.http.listen(0, '::'); await once(service.http, 'listening');
            internal.http.listen(0, '::'); await once(internal.http, 'listening');
            const publicBase = `http://[::1]:${service.http.address().port}`;
            const internalBase = `http://[::1]:${internal.http.address().port}`;
            await fetch(`${publicBase}/mcp`);
            expect((await fetch(`${publicBase}/mcp`)).status).toBe(429);
            await client.connect(new StreamableHTTPClientTransport(new URL(`${internalBase}/mcp`)));
            const result = (await client.callTool({ name: 'ugt_draft_space', arguments: { city: 'london', outline: site, spaceKind: 'park' } })).structuredContent;
            expect(result).toMatchObject({ cid, previewStatus: 'private-link' });
            // The preview endpoint has its own read window. The exhausted public MCP window rolls
            // over here; the private object must still be the one created through the internal port.
            now = 60_001;
            const response = await fetch(`${publicBase}${new URL(result.draftRef).pathname}`);
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ cid, record: design });
        } finally {
            await client.close().catch(() => {});
            await internal.close(); await service.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
