// Checks manual source information, safe links and metadata failures without loading parcel ground.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const notice = require('../../frontend/js/parcel-source-notice.js');
const city = { id: 'sample', parcels: { sourceId: 'native', source: 'parcel-source' } };
const source = { id: 'native', name: 'Publisher parcels', cityIds: ['sample'], scope: 'Bounded city',
    licenceNote: 'Reuse is restricted', licenceUrl: 'https://example.org/terms', endpoint: 'https://example.org/features' };
describe('manual parcel-source information', () => {
    it('reports actual metadata and restrictions without an acceptance requirement', () => {
        const result = notice.buildNotice(city, [source]);
        expect(result.message).toContain('Publisher parcels');
        expect(result.message).toContain('Bounded city');
        expect(result.message).toContain('Reuse is restricted');
        expect(result.message).toContain('responsible for checking');
        expect(result.message).toContain('{{txLink}}');
        expect(result.options.linkUrl).toBe(source.licenceUrl);
        expect(result.message).not.toMatch(/CC BY|accept|checkbox|no data.*stor/i);
    });
    it('selects matching city metadata and only safe HTTPS links', () => {
        const result = notice.buildNotice({ id: 'sample' }, [{ ...source, licenceUrl: 'javascript:alert(1)', catalogueUrl: 'https://example.org/catalog' }]);
        expect(result.options.linkUrl).toBe('https://example.org/catalog');
        expect(notice.safeLink('https://user:password@example.org/')).toBeNull();
        expect(notice.safeLink('http://example.org/')).toBeNull();
    });
    it('handles imported city configuration without inventing licence details', () => {
        const result = notice.buildNotice({ id: 'imported', parcels: { source: 'cadastre' } });
        expect(result.message).toContain('Source: cadastre');
        expect(result.message).toContain('metadata is unavailable');
        expect(result.options).toEqual({});
    });
    it('fetches metadata only when the browser opener is explicitly called', async () => {
        const global = { CityConfigManager: { getCurrentCityConfig: () => city },
            getBackendBase: () => 'https://example.org/api/',
            fetch: vi.fn(async () => ({ ok: true, json: async () => ({ sources: [source] }) })),
            showStyledAlert: vi.fn() };
        const script = readFileSync(new URL('../../frontend/js/parcel-source-notice.js', import.meta.url), 'utf8');
        vm.runInNewContext(script, { window: global, URL, AbortSignal });
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.showStyledAlert).not.toHaveBeenCalled();
        await global.openParcelSourceNotice();
        expect(global.fetch).toHaveBeenCalledOnce();
        expect(global.fetch.mock.calls[0][0]).toBe('https://example.org/api/parcel-sources');
        expect(global.showStyledAlert.mock.calls[0][0]).toContain('Reuse is restricted');
        expect(global.showStyledAlert.mock.calls[0][1].linkUrl).toBe(source.licenceUrl);
    });
    it.each(['network', 'http', 'schema'])('shows honest information after %s metadata failure', async failure => {
        const global = { CityConfigManager: { getCurrentCityConfig: () => city }, getBackendBase: () => '',
            fetch: vi.fn(async () => {
                if (failure === 'network') throw new Error('offline');
                return { ok: failure !== 'http', json: async () => ({ sources: null }) };
            }), showStyledAlert: vi.fn() };
        await notice.open(global);
        expect(global.showStyledAlert).toHaveBeenCalledOnce();
        expect(global.showStyledAlert.mock.calls[0][0]).toContain('metadata is unavailable');
        expect(global.showStyledAlert.mock.calls[0][1]).toEqual({});
    });
});
