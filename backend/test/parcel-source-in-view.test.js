// Settings → Information names the parcel source that last answered for the map, not only the city's configured one.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createBrowserParcelRuntime, publicSourceInfo } from '../parcels/browser-source-runtime.js';

const require = createRequire(import.meta.url);
const { createTracker, sourceKeyFor } = require('../../frontend/js/parcels/source-in-view.js');
const { inViewLines } = require('../../frontend/js/ui/map-credits.js');
const tr = (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? '');

describe('parcel source in view', () => {
    it('remembers the last source that answered and tells listeners only when it changes', () => {
        let clock = 1000;
        const tracker = createTracker(() => clock);
        const listener = vi.fn();
        tracker.subscribe(listener);
        expect(tracker.latest()).toBe(null);
        tracker.record('mumbai', { source: 'parcel-source', sourceId: 'in-mh-ncscm-czmp-survey-plots' });
        clock = 2000;
        tracker.record('mumbai', { source: 'parcel-source', sourceId: 'in-mh-ncscm-czmp-survey-plots' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(tracker.latest()).toMatchObject({ cityId: 'mumbai', sourceKey: 'in-mh-ncscm-czmp-survey-plots', browserSource: true, at: 2000 });
        tracker.record('surat', { source: 'parcel-source', sourceId: 'in-gj-tpvd-final-plots' });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(tracker.latest().cityId).toBe('surat');
        expect(tracker.record('explore', { source: 'none' })).toBe(null);
        expect(tracker.latest().cityId).toBe('surat');
        expect(sourceKeyFor({ source: 'oss-wfs' })).toEqual({ sourceKey: 'oss-wfs', browserSource: false });
    });

    it('describes a browser source from the bundled catalog, with no request', () => {
        const fetchImpl = vi.fn();
        const info = createBrowserParcelRuntime({ fetchImpl }).describe('in-mh-ncscm-czmp-survey-plots');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(info).toMatchObject({ id: 'in-mh-ncscm-czmp-survey-plots', host: 'gisportal.ncscm.res.in', viaRelay: false,
            catalogueUrl: 'https://czmp.ncscm.res.in/' });
        expect(info.name).toMatch(/NCSCM/);
        expect(publicSourceInfo({ id: 'x', endpoint: 'https://a.example/wfs', browserTransport: 'relay', catalogueUrl: 'javascript:alert(1)' }))
            .toMatchObject({ name: 'x', host: 'a.example', viaRelay: true, catalogueUrl: null });
    });

    it('lists name, how it is read, coverage, terms, links and when it last answered', () => {
        const latest = { cityId: 'mumbai', sourceKey: 'in-mh-ncscm-czmp-survey-plots', browserSource: true, at: 0 };
        const info = { name: 'NCSCM survey plots', attribution: 'NCSCM — plots', host: 'gisportal.ncscm.res.in', viaRelay: false,
            scope: 'Greater Mumbai', licenceNote: 'No licence stated.', catalogueUrl: 'https://czmp.ncscm.res.in/', licenceUrl: null };
        const lines = inViewLines({ latest, info, time: '14:05', tr });
        expect(lines.map(line => line.text)).toEqual(['NCSCM survey plots', 'NCSCM — plots',
            'Read by your browser directly from gisportal.ncscm.res.in', 'Greater Mumbai', 'No licence stated.', 'Source page', 'Last loaded at 14:05']);
        expect(lines.find(line => line.url)?.url).toBe('https://czmp.ncscm.res.in/');
        const relayed = inViewLines({ latest, info: { ...info, viaRelay: true, host: 'mapy.geoportal.gov.pl' }, time: '14:05', recordCityLabel: 'Radom, Poland', tr });
        expect(relayed.map(line => line.text)).toContain("Read from mapy.geoportal.gov.pl through this site's server");
        expect(relayed.at(-1).text).toBe('Last loaded at 14:05 for Radom, Poland');
        // A server-side source keeps the configured attribution; generated ground says it is not a register.
        expect(inViewLines({ latest: { ...latest, sourceKey: 'oss-wfs', browserSource: false }, credits: ['DGU cadastre'], time: '1', tr })[0])
            .toEqual({ html: 'DGU cadastre' });
        expect(inViewLines({ latest: { ...latest, sourceKey: 'ground-schelling' }, time: '1', tr })[0].text).toMatch(/no parcel register/);
        expect(inViewLines({ latest: { ...latest, sourceKey: 'ground-custom-url', detail: { host: 'files.example' } }, time: '1', tr })[0].text)
            .toBe('Your parcel file from files.example');
        expect(inViewLines({ latest: null, tr })).toBe(null);
    });
});
