import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function ui(fetchImpl, globals = {}) {
    const extract = vi.fn(payload => payload.owners);
    const scope = { URL, console: { warn: vi.fn() }, fetch: fetchImpl, setTimeout,
        formatPercentValue: String, formatSharePercent: String,
        Parcels: { ownership: { extractOwnersFromOwnershipPayload: extract } }, ...globals };
    scope.window = scope;
    const context = createContext(scope);
    for (const file of ['source-runtime.js', 'browser-ownership-source.js', 'parcels/ownership-ui.js']) {
        runInContext(readFileSync(new URL('../../frontend/js/' + file, import.meta.url), 'utf8'), context);
    }
    return { scope, extract, lookup: scope.ParcelsOwnershipUi.fetchOwnersFromOss };
}
const ok = owners => ({ ok: true, json: async () => ({ owners }) });

describe('browser OSS ownership adapter dispatch', () => {
    it('uses the registered public source and preserves owner extraction and configured URL context', async () => {
        const owners = [{ name: 'Example owner', actualShareText: '1/2' }];
        const fetchImpl = vi.fn(async () => ok(owners));
        const { scope, lookup, extract } = ui(fetchImpl, { OSS_PUBLIC_ACCESS_TOKEN: 'runtime-only-token' });
        expect(await lookup(' HR-1-2 ')).toEqual(owners);
        expect(fetchImpl.mock.calls[0][0]).toContain('parcelId=HR-1-2');
        expect(fetchImpl.mock.calls[0][0]).toContain('token=runtime-only-token');
        expect(fetchImpl.mock.calls[0][1]).toEqual({ headers: { Accept: 'application/json' } });
        expect(extract).toHaveBeenCalledOnce();
        const catalogue = scope.SourceRuntime.catalogue();
        expect(catalogue.abstractions[0].adapters[0]).toMatchObject({ id: 'hr-oss-public-fallback', required: ['lookup'], runtime: 'browser', custom: false });
        expect(JSON.stringify(catalogue)).not.toContain('runtime-only-token');
    });
    it('keeps candidate order and continues after a failed response or JSON parse', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 404 })
            .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('invalid JSON'); } })
            .mockResolvedValueOnce(ok([{ name: 'Example owner' }]));
        const { lookup, scope } = ui(fetchImpl, { OSS_OWNERSHIP_PROXY_TARGETS: ['direct', 'https://example.org/fetch/', 'https://example.org/proxy?url='] });
        expect(await lookup('HR-1-2')).toEqual([{ name: 'Example owner' }]);
        expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(scope.ParcelsOwnershipUi.buildOssOwnershipRequestUrls('HR-1-2'));
        expect(scope.console.warn).toHaveBeenCalledTimes(2);
    });
    it('returns no owners for an empty id and preserves the last candidate error', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('lookup unavailable'); });
        const { lookup } = ui(fetchImpl);
        expect(await lookup('')).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
        await expect(lookup('HR-1-2')).rejects.toThrow('lookup unavailable');
    });
});
