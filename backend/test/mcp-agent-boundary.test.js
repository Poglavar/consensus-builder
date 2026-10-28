// Acceptance checks use the real MCP protocol and real tool implementations, with bounded fixture IO.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from 'canvas';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { MCP_HOSTED_TOOLS } from '../agents/mcp-catalog.js';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';
import { canonicalBytes, cidOf, cidOfObject } from '../cid.js';

const outline = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.0996, 51.5], [-0.0996, 51.5004], [-0.1, 51.5004], [-0.1, 51.5]]] };
const fixtures = [];
afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        await fixture.client?.close(); await fixture.server?.close(); fixture.store?.dispose();
        rmSync(fixture.directory, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
});
async function connect() {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-agent-boundary-'));
    const state = { directory, publishedDesigns: new Map(), publishedPlans: new Map(), pinned: new Map(), calls: [] };
    fixtures.push(state);
    const tile = createCanvas(256, 256).toBuffer('image/png');
    const sources = Array.from({ length: 250 }, (_, index) => ({ id: `boundary-source-${index}`, label: `Fixture ground ${index}`, adapter: 'fixture', kind: 'default',
        config: { city: 'london', capabilities: { byId: true, under: true }, endpoint: `https://source.example/${index}`, attribution: 'Fixture source' } }));
    const fetchImpl = vi.fn(async (value, options = {}) => {
        const url = new URL(value), method = options.method || 'GET';
        expect(['https://api.example', 'https://api.maptiler.com']).toContain(url.origin);
        if (url.origin === 'https://api.maptiler.com') return new Response(tile);
        const body = options.body ? JSON.parse(options.body) : undefined, path = url.pathname;
        state.calls.push({ path, method, body });
        if (path === '/source-system') return Response.json({ abstractions: [{ id: 'parcels', contract: { operations: { byId: {}, under: {} } }, sources }] });
        if (path.startsWith('/parcel-sources/boundary-source-')) return Response.json({ complete: true, features: [{ type: 'Feature', id: 'P-1', properties: { parcelId: 'P-1' }, geometry: outline }] });
        if (path === '/designs/binding') return Response.json({ parcelSourceId: body.parcelSourceId || 'boundary-source-0', binding: { coverage: 'complete', unknownM2: 0, parcels: [{ parcelId: 'P-1' }] } });
        if (path === '/pins') {
            const bytes = Buffer.from(body.bytes, 'base64');
            expect(cidOf(bytes)).toBe(body.cid); state.pinned.set(body.cid, bytes);
            return Response.json({ cid: body.cid, pinnedAt: '2026-10-25T00:00:00.000Z' });
        }
        if (path === '/designs' && method === 'POST') {
            expect(canonicalBytes(body.content)).toEqual(state.pinned.get(body.cid));
            const row = { cid: body.cid, content: body.content, parcelSourceId: body.parcelSourceId };
            const status = state.publishedDesigns.has(body.cid) ? 409 : 201;
            state.publishedDesigns.set(body.cid, row); return Response.json(row, { status });
        }
        if (path === '/designs') return Response.json({ designs: [...state.publishedDesigns.values()], count: state.publishedDesigns.size });
        if (path.startsWith('/designs/')) {
            const row = state.publishedDesigns.get(path.split('/').at(-1));
            return Response.json(row || { error: 'Design not found' }, { status: row ? 200 : 404 });
        }
        if (path === '/plans' && method === 'POST') {
            expect(body.content.designCids.every(cid => state.publishedDesigns.has(cid))).toBe(true);
            const cid = cidOfObject(body.content), row = { cid, content: body.content };
            state.publishedPlans.set(cid, row); return Response.json(row, { status: 201 });
        }
        if (path.startsWith('/plans/')) {
            const row = state.publishedPlans.get(path.split('/').at(-1));
            return Response.json(row || { error: 'Plan not found' }, { status: row ? 200 : 404 });
        }
        if (path === '/models') return Response.json({ modelUrl: '/uploads/models/fixture.glb' });
        throw new Error(`Unexpected fixture API route: ${method} ${path}`);
    });
    state.store = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example', storeDirectory: directory });
    const env = { UGT_API_BASE: 'https://api.example', UGT_APP_ORIGIN: 'https://app.example' };
    const tools = createUrbanGameTheoryTools({ mode: 'hosted', env, fetchImpl, resolveDraftReference: state.store.resolve });
    state.server = createUrbanGameTheoryMcpServer({ mode: 'hosted', env, tools, decorateResult: state.store.decorate });
    state.client = new Client({ name: 'boundary-acceptance', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([state.server.connect(serverTransport), state.client.connect(clientTransport)]);
    state.call = (name, args = {}) => state.client.callTool({ name, arguments: args });
    state.ok = async (name, args) => {
        const result = await state.call(name, args);
        expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
        expect(result.structuredContent).toBeTypeOf('object');
        return result.structuredContent;
    };
    return state;
}

describe('hosted MCP agent acceptance boundary', () => {
    it('advertises bounded capabilities, usable instructions and complete input/output contracts without schema corruption', async () => {
        const { client, ok } = await connect();
        const tools = (await client.listTools()).tools;
        expect(tools.map(tool => tool.name)).toEqual(MCP_HOSTED_TOOLS);
        for (const tool of tools) {
            expect(tool.inputSchema.type).toBe('object'); expect(tool.outputSchema.type).toBe('object');
            expect(tool.outputSchema.properties).toHaveProperty('code');
            expect(tool.title).toBeTypeOf('string');
        }
        const required = {
            ugt_draft_building: ['cid', 'untrusted', 'previewStatus', 'previewUrl'],
            ugt_inspect_design: ['cid', 'values'], ugt_get_plan: ['cid', 'untrusted', 'designs', 'publication'],
            ugt_inspect_plan: ['cid', 'items', 'total', 'offset', 'truncated'],
            ugt_render_preview: ['ready', 'provenance', 'metrics'], ugt_export_draft: ['cid', 'artifact', 'publication'],
            ugt_import_design: ['designs', 'publication', 'import'], ugt_import_model: ['asset'],
            ugt_list_sources: ['items', 'total', 'offset', 'truncated'], ugt_capabilities: ['version', 'mode', 'workflow', 'tools']
        };
        for (const [name, fields] of Object.entries(required)) {
            expect(tools.find(tool => tool.name === name).outputSchema.required).toEqual(expect.arrayContaining(fields));
        }
        expect(client.getInstructions()).toMatch(/ugt_capabilities/);
        expect(client.getInstructions()).toMatch(/Hosted MCP never signs or pays/);
        const capabilities = await ok('ugt_capabilities');
        expect(Buffer.byteLength(JSON.stringify(capabilities))).toBeLessThan(16_000);
        expect(capabilities.tools.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
        expect(capabilities.drafts.exportTool).toBe('ugt_export_draft');
        const workflow = await ok('ugt_help', { topic: 'workflow' });
        expect(workflow.steps.join(' ')).toMatch(/ugt_draft_plan/);
        expect(workflow.steps.join(' ')).toMatch(/expectedCid/);
        const sourcePage = await ok('ugt_list_sources', { abstraction: 'parcels', limit: 2 });
        expect(sourcePage.items).toHaveLength(2); expect(sourcePage.total).toBe(250); expect(sourcePage.truncated).toBe(true);
        expect(sourcePage.items[0]).not.toHaveProperty('config');
        expect((await ok('ugt_list_sources', sourcePage.next.arguments)).offset).toBe(2);
        const help = await ok('ugt_help', { topic: 'schemas/design' });
        const recipe = JSON.parse(readFileSync(new URL('../routes/agent-recipe-schema.json', import.meta.url), 'utf8'));
        expect(help.schema).toEqual({ ...recipe, $ref: '#/$defs/design' });
        const contract = await ok('ugt_help', { topic: 'ugt_draft_building' });
        expect(contract.contract.inputSchema.properties.typology.enum).toContain('freeform');
        expect(contract.contract.outputSchema.properties).toHaveProperty('draftRef');
    });
    it('recovers invalid lane, missing site and missing source using protocol-returned guidance', async () => {
        const { call, ok } = await connect();
        const invalidLane = await call('ugt_draft_road', { city: 'london', points: [[-0.1, 51.5], [-0.099, 51.5]], lanes: [{ type: 'invented-lane', width: 3 }] });
        expect(invalidLane.isError).toBe(true);
        expect(invalidLane.structuredContent).toMatchObject({ code: 'invalid-arguments', field: 'lanes.0.type', constraints: expect.any(Array), next: { tool: 'ugt_help', arguments: { topic: 'ugt_draft_road' } } });
        const help = await ok(invalidLane.structuredContent.next.tool, invalidLane.structuredContent.next.arguments);
        expect(help.contract.inputSchema.properties.lanes.items.properties.type.enum).toContain('driving');
        const missingSite = await call('ugt_draft_building', { city: 'london', typology: 'freeform', floors: 6 });
        expect(missingSite.isError).toBe(true); expect(missingSite.structuredContent.next.tool).toBe('ugt_help');
        expect((await ok(missingSite.structuredContent.next.tool, missingSite.structuredContent.next.arguments)).contract.name).toBe('ugt_draft_building');
        const missingSource = await call('ugt_draft_building', { city: 'london', parcelIds: ['P-1'], floors: 6 });
        expect(missingSource.isError).toBe(true); expect(missingSource.structuredContent).toMatchObject({ code: 'parcel-source-required', field: 'parcelSourceId', next: { tool: 'ugt_list_sources' } });
        const sources = await ok(missingSource.structuredContent.next.tool, missingSource.structuredContent.next.arguments);
        const drafted = await ok('ugt_draft_building', { city: 'london', parcelSourceId: sources.items[0].id, parcelIds: ['P-1'], floors: 6 });
        expect(drafted.untrusted.design.geometry.buildings[0].properties.floors).toBe(6);
        const road = await ok('ugt_draft_road', { city: 'london', parcelSourceId: sources.items[0].id, points: [[-0.1, 51.5], [-0.099, 51.5]], lanes: [{ type: 'driving', width: 3 }] });
        expect(road.draftRef).toMatch(/^https:\/\/mcp.example\/mcp\/previews\//);
    });
    it('preserves exact design and plan revisions through inspect, typed and granular edits, reference publication and canonical reopen', async () => {
        const state = await connect(), { ok, call, store } = state;
        expect((await ok('ugt_list_designs', { city: 'london' })).designs).toEqual([]);
        const tower = await ok('ugt_draft_building', { city: 'london', parcelSourceId: 'boundary-source-0', typology: 'freeform', outline, floors: 6, title: 'West tower' });
        const original = tower.untrusted.design;
        expect(original.buildingProposal.typologyType).toBe('single');
        expect(cidOfObject(original)).toBe(tower.cid);
        const inspected = await ok('ugt_inspect_design', { design: tower.draftRef, paths: ['/geometry/buildings/0/properties/floors', '/title'] });
        expect(inspected.values.map(row => row.untrustedValue)).toEqual([6, 'West tower']);
        const shorter = await ok('ugt_modify_design', { design: tower.draftRef, changes: [{ type: 'set_floors', value: 4 }] });
        expect(shorter.untrusted.design.geometry.buildings[0].properties).toMatchObject({ floors: 4, height: 12 });
        const renamed = await ok('ugt_edit_design', { design: shorter.draftRef, expectedCid: shorter.cid, edits: [{ op: 'replace', path: '/title', value: 'Final tower' }] });
        expect(renamed.untrusted.design.title).toBe('Final tower'); expect(renamed.cid).toBe(cidOfObject(renamed.untrusted.design));
        expect((await store.resolve(tower.draftRef)).design).toEqual(original);
        const publishedDesign = await ok('ugt_publish_design', { design: renamed.draftRef, expectedCid: renamed.cid, confirm: true });
        expect(publishedDesign.url).toBe(`https://app.example/designs/${renamed.cid}`);
        const reopenedDesign = await ok('ugt_inspect_design', { design: publishedDesign.url, paths: [''] });
        expect(canonicalBytes(reopenedDesign.values[0].untrustedValue)).toEqual(canonicalBytes(renamed.untrusted.design));
        const park = await ok('ugt_draft_space', { city: 'london', parcelSourceId: 'boundary-source-0', outline, spaceKind: 'park', title: 'Garden' });
        const plan = await ok('ugt_draft_plan', { title: 'Initial neighbourhood', designs: [renamed.draftRef, park.draftRef] });
        expect(plan.untrusted.plan.designCids).toEqual([renamed.cid, park.cid].sort());
        const inventory = await ok('ugt_inspect_plan', { plan: plan.draftRef, filter: { kind: 'building' } });
        expect(inventory.items).toHaveLength(1); expect(inventory.items[0].floors).toBe(4);
        const revised = await ok('ugt_edit_plan', { plan: plan.draftRef, expectedCid: plan.cid, title: 'Final neighbourhood', operations: [
            { type: 'modify', ref: inventory.items[0].ref, changes: [{ type: 'set_floors', value: 2 }] }, { type: 'remove', ref: `design:${park.cid}` }
        ] });
        expect(revised.untrusted.plan.title).toBe('Final neighbourhood'); expect(revised.untrusted.plan.designCids).toHaveLength(1);
        expect(revised.untrusted.plan.designCids).not.toContain(park.cid); expect(revised.untrusted.plan.designCids).not.toContain(renamed.cid);
        const beforePublish = await ok('ugt_inspect_plan', { plan: revised.draftRef, filter: { kind: 'building' } });
        expect(beforePublish.items[0].floors).toBe(2);
        const published = await ok('ugt_publish_plan', { plan: revised.draftRef, expectedCid: revised.cid, confirm: true });
        expect(published.url).toBe(`https://app.example/plans/${revised.cid}`);
        const reopened = await ok('ugt_get_plan', { plan: published.url });
        expect(reopened.cid).toBe(revised.cid); expect(canonicalBytes(reopened.untrusted.plan)).toEqual(canonicalBytes(revised.untrusted.plan));
        expect(reopened.untrusted.plan.designCids).toEqual([...state.publishedPlans.get(revised.cid).content.designCids]);
        const afterPublish = await ok('ugt_inspect_plan', { plan: published.url, filter: { kind: 'building' } });
        expect(afterPublish.items[0].floors).toBe(2); expect(afterPublish.items[0].untrusted.title).toBe('Final tower');
        const pinCount = state.pinned.size;
        expect((await ok('ugt_publish_plan', { plan: published.url, expectedCid: revised.cid, confirm: true })).url).toBe(published.url);
        expect(state.pinned.size).toBe(pinCount);
        const exported = await ok('ugt_export_draft', { draftRef: revised.draftRef });
        expect(exported.cid).toBe(revised.cid);
        expect(canonicalBytes(exported.artifact.untrusted.plan)).toEqual(canonicalBytes(revised.untrusted.plan));
        expect(exported.artifact.designs.map(member => cidOfObject(member.untrusted.content)).sort()).toEqual(revised.untrusted.plan.designCids);
        const stale = await call('ugt_edit_plan', { plan: revised.draftRef, expectedCid: plan.cid, title: 'Stale edit' });
        expect(stale).toMatchObject({ isError: true, structuredContent: { code: 'plan-revision-mismatch' } });
        store.clear();
        const recovered = await ok('ugt_get_plan', { plan: exported.artifact });
        expect(recovered.cid).toBe(revised.cid);
        expect(canonicalBytes(recovered.untrusted.plan)).toEqual(canonicalBytes(revised.untrusted.plan));
    });
    it('returns the actual rendered PNG as MCP image content while structured output keeps readiness and provenance', async () => {
        vi.stubEnv('MAPTILER_API_KEY', 'protocol-fixture');
        const { ok, call } = await connect();
        const draft = await ok('ugt_draft_building', { city: 'london', parcelSourceId: 'boundary-source-0', outline, floors: 3 });
        const rendered = await call('ugt_render_preview', { design: draft.draftRef, view: '2d' });
        expect(rendered.isError, JSON.stringify(rendered.structuredContent)).not.toBe(true);
        const image = rendered.content.find(item => item.type === 'image');
        expect(image).toMatchObject({ mimeType: 'image/png' });
        expect(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(rendered.structuredContent).toMatchObject({ ready: true, provenance: { persisted: false, designCids: [draft.cid] }, metrics: { width: 1200, height: 630, designCount: 1 } });
        expect(rendered.structuredContent).not.toHaveProperty('image');
        expect(JSON.stringify(rendered.structuredContent)).not.toContain(image.data);
        expect(JSON.stringify(rendered.content.filter(item => item.type === 'text'))).not.toContain(image.data);
    });
});
