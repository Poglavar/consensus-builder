// Globe arrival (frontend/js/world/arrival.js): a city or feed pick dives into 3D on a design only
// when there is one and the city has 3D buildings to stand it among; the city's design is the
// newest row of the design index, GET /designs?city=<code>&limit=1, opened by its CID.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const arrival = require('../../frontend/js/world/arrival.js');
const Cid = require('../../frontend/js/cid.js');
const source = readFileSync(new URL('../../frontend/js/world/arrival.js', import.meta.url), 'utf8');

const cidOf = text => Cid.cidOf(new TextEncoder().encode(text));
const NEWEST = cidOf('design-a');
const OLDER = cidOf('design-b');

describe('globe arrival decision', () => {
    it('dives into 3D for a design in a city with 3D buildings', () => {
        expect(arrival.plan({ proposalId: NEWEST, buildingsSource: 'gdi_building_3d' })).toEqual({ dive3D: true });
        expect(arrival.plan({ proposalId: NEWEST, buildingsSource: 'overture' })).toEqual({ dive3D: true });
        // Zagreb has no buildings block: the default provider (map-core.js reads it the same way).
        expect(arrival.plan({ proposalId: NEWEST, buildingsSource: undefined })).toEqual({ dive3D: true });
    });

    it('stays in 2D without a design or without 3D buildings', () => {
        expect(arrival.plan({ proposalId: null, buildingsSource: 'overture' })).toEqual({ dive3D: false });
        expect(arrival.plan({ proposalId: '', buildingsSource: 'overture' })).toEqual({ dive3D: false });
        expect(arrival.plan({ proposalId: NEWEST, buildingsSource: 'none' })).toEqual({ dive3D: false });
    });
});

describe('latest design from the index answer', () => {
    it('takes the first (newest) row by its CID', () => {
        const payload = { designs: [{ cid: NEWEST, title: 'Road 7' }, { cid: OLDER, title: 'Park 2' }], count: 2 };
        expect(arrival.latestDesignCid(payload)).toBe(NEWEST);
    });

    it('returns null for a city with no published design or an answer that is not the index', () => {
        expect(arrival.latestDesignCid({ designs: [] })).toBeNull();
        expect(arrival.latestDesignCid({ designs: [{ cid: '' }] })).toBeNull();
        expect(arrival.latestDesignCid({ proposals: [{ id: 41, proposalId: 'road-7' }] })).toBeNull();
        expect(arrival.latestDesignCid(null)).toBeNull();
    });
});

describe('asking the index for a city', () => {
    function browser(answer) {
        const fetch = vi.fn(async () => answer);
        const window = {
            document: {},
            getBackendBase: () => 'https://api.example.test',
            normalizeCityCodeForApi: id => (id === 'zagreb' ? 'zg' : id)
        };
        vm.runInNewContext(source, { window, fetch, console: { log() {} } });
        return { window, fetch };
    }

    it('reads the newest design of the city under its API code', async () => {
        const { window, fetch } = browser({ ok: true, json: async () => ({ designs: [{ cid: NEWEST }], count: 1 }) });
        await expect(window.WorldArrival.fetchLatestDesignCid('zagreb')).resolves.toBe(NEWEST);
        expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.example.test/designs?city=zg&limit=1');
    });

    it('fails loudly when the index answers with an error', async () => {
        const { window } = browser({ ok: false, status: 503, json: async () => ({}) });
        await expect(window.WorldArrival.fetchLatestDesignCid('zagreb')).rejects.toThrow('/designs?city=zg&limit=1 -> HTTP 503');
    });
});
