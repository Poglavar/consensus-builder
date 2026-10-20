// A local estimate's complete binding must survive both a new check and an older server response.
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';

const source = fs.readFileSync(new URL('../../frontend/js/site-drawing.js', import.meta.url), 'utf8');
const names = new Set(['requestServerBinding', 'hasLocalEstimatedSource', 'coverageText']);
const functions = [];
(function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && names.has(node.id?.name)) functions.push(source.slice(node.start, node.end));
    for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
    }
})(parse(source, { sourceType: 'script' }));

function harness(kind) {
    const provider = { kind };
    const state = { serverSeq: 0, site: { type: 'Polygon' }, preview: { coverage: 'complete', parcels: [{ parcelId: 'EST:one' }] } };
    let resolve;
    const fetchBinding = vi.fn(() => new Promise(done => { resolve = done; }));
    const context = vm.createContext({
        state, cityId: () => 'explore', backendBase: () => 'https://example.test',
        log: vi.fn(), renderLayers: vi.fn(), renderPanel: vi.fn(), console, t: (_key, fallback) => fallback,
        win: { fetch: vi.fn(), ParcelGroundFallback: { activeSource: () => provider },
            __publishBinding: { createFetchBinding: () => fetchBinding } }
    });
    vm.runInContext(functions.join('\n') + '\nthis.check = requestServerBinding; this.coverage = coverageText;', context);
    return { state, provider, fetchBinding, check: context.check, coverage: context.coverage, resolve: binding => resolve(binding) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('site binding for browser-local estimates', () => {
    it('keeps the local binding without requesting an unavailable server source', () => {
        const test = harness('estimated-local');
        test.state.server = { coverage: 'none' };
        test.state.serverPending = true;
        test.check();
        expect(test.fetchBinding).not.toHaveBeenCalled();
        expect(test.state.server).toBeNull();
        expect(test.state.serverPending).toBe(false);
        expect(test.state.preview.coverage).toBe('complete');
        expect(test.state.preview.parcels[0].parcelId).toBe('EST:one');
        expect(test.coverage(test.state.preview)).toBe('Local estimates cover the whole site.');
    });

    it('ignores an older server answer after switching to local estimates', async () => {
        const test = harness('custom-url');
        test.check();
        expect(test.fetchBinding).toHaveBeenCalledOnce();
        test.provider.kind = 'estimated-local';
        test.check();
        test.resolve({ coverage: 'none', parcels: [] });
        await settle();
        expect(test.state.server).toBeNull();
        expect(test.state.serverPending).toBe(false);
        expect(test.state.preview.coverage).toBe('complete');
    });

    it('continues checking server-backed sources', async () => {
        const test = harness('custom-url');
        test.check();
        test.resolve({ coverage: 'complete', parcels: [{ parcelId: 'official-one' }] });
        await settle();
        expect(test.state.server.parcels[0].parcelId).toBe('official-one');
        expect(test.state.serverPending).toBe(false);
    });
});
