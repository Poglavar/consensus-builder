// A local estimate's complete binding must survive both a new check and an older server response;
// a server-backed source asks the index which parcels a design on this site would take
// (POST /designs/binding) and shows its answer or its refusal.
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';

const source = fs.readFileSync(new URL('../../frontend/js/site-drawing.js', import.meta.url), 'utf8');
const names = new Set(['requestServerBinding', 'fetchDesignBinding', 'hasLocalEstimatedSource', 'coverageText']);
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
    const state = { serverSeq: 0, site: { type: 'Polygon' }, toleranceM: 0.5, preview: { coverage: 'complete', parcels: [{ parcelId: 'EST:one' }] } };
    const pending = [];
    const fetch = vi.fn(() => new Promise(done => { pending.push(done); }));
    const context = vm.createContext({
        state, cityId: () => 'explore', backendBase: () => 'https://example.test',
        log: vi.fn(), renderLayers: vi.fn(), renderPanel: vi.fn(), console: { ...console, warn: vi.fn() }, t: (_key, fallback) => fallback,
        // The request carries the city and parcel source chosen by frontend configuration (87a04d800).
        win: { fetch, ParcelGroundFallback: { activeSource: () => provider },
            CityConfigManager: { getParcelContext: (_site, city) => ({ city, parcelSourceId: 'custom-url:one' }) } }
    });
    vm.runInContext(functions.join('\n') + '\nthis.check = requestServerBinding; this.coverage = coverageText;', context);
    // Answers the request number `index` (the latest by default) as the index would.
    const respond = (status, payload, index = pending.length - 1) => pending[index]({ ok: status >= 200 && status < 300, status, json: async () => payload });
    return { state, provider, fetch, check: context.check, coverage: context.coverage, respond };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('site binding for browser-local estimates', () => {
    it('keeps the local binding without requesting an unavailable server source', () => {
        const test = harness('estimated-local');
        test.state.server = { coverage: 'none' };
        test.state.serverPending = true;
        test.check();
        expect(test.fetch).not.toHaveBeenCalled();
        expect(test.state.server).toBeNull();
        expect(test.state.serverPending).toBe(false);
        expect(test.state.preview.coverage).toBe('complete');
        expect(test.state.preview.parcels[0].parcelId).toBe('EST:one');
        expect(test.coverage(test.state.preview)).toBe('Local estimates cover the whole site.');
    });

    it('ignores an older server answer after switching to local estimates', async () => {
        const test = harness('custom-url');
        test.check();
        expect(test.fetch).toHaveBeenCalledOnce();
        test.provider.kind = 'estimated-local';
        test.check();
        expect(test.fetch).toHaveBeenCalledOnce();
        test.respond(200, { binding: { coverage: 'none', parcels: [] } }, 0);
        await settle();
        expect(test.state.server).toBeNull();
        expect(test.state.serverPending).toBe(false);
        expect(test.state.preview.coverage).toBe('complete');
    });

    it('asks the design index for the binding of a server-backed source and shows it', async () => {
        const test = harness('custom-url');
        test.check();
        const [url, init] = test.fetch.mock.calls[0];
        expect(url).toBe('https://example.test/designs/binding');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ site: { type: 'Polygon' }, toleranceM: 0.5, city: 'explore', parcelSourceId: 'custom-url:one' });
        expect(test.state.serverPending).toBe(true);
        test.respond(200, { city: 'zagreb', binding: { coverage: 'complete', parcels: [{ parcelId: 'official-one' }] } });
        await settle();
        expect(test.state.server.parcels[0].parcelId).toBe('official-one');
        expect(test.state.serverPending).toBe(false);
    });

    it('shows the index\'s refusal instead of a binding', async () => {
        const test = harness('custom-url');
        test.check();
        test.respond(422, { code: 'site-too-large', error: 'The site is larger than 1 km².' });
        await settle();
        expect(test.state.server).toBeNull();
        expect(test.state.serverError).toBe('The site is larger than 1 km².');
        expect(test.state.serverPending).toBe(false);
    });
});
