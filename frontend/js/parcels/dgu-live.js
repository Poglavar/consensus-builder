// Croatia's state cadastre read straight from the browser. Zagreb, Split and Šibenik ('oss-wfs')
// load their parcels from our server's copy of the DGU register; when our server cannot answer,
// the same parcels come from DGU's public WFS (oss.uredjenazemlja.hr, CORS open to any origin,
// public token), so the map keeps working with our server down. Answers are in our server's
// parcel shape (CESTICA_ID, BROJ_CESTICE, MATICNI_BROJ_KO, parcelId HR-<KO>-<number>) in WGS84;
// ownership lives only on our server and is absent. Pure apart from the injected request and
// projection functions, so it is tested in node (backend/test/dgu-live.test.js).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DguLiveCadastre = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const SourceRuntime = root?.SourceRuntime
        || (typeof require === 'function' ? require('../source-runtime.js') : null);

    const WFS_URL = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
    const HOST = 'oss.uredjenazemlja.hr';
    const PUBLIC_TOKEN = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
    const PAGE_SIZE = 2000;
    // Each id is a two-clause XML filter in a GET URL; 20 keeps the URL well under 8 KB.
    const ID_BATCH = 20;
    // The backend's measured-noise floor for "this footprint takes part of this parcel" (/parcels/under).
    const TAKEN_FLOOR_M2 = 0.25;
    // The most parcels one read takes, as on our server (MAX_PARCELS_UNDER in routes/parcels.js):
    // past it the browser would page and intersect tens of thousands of parcels.
    const MAX_PARCELS = 5000;

    function baseParams() {
        return { token: PUBLIC_TOKEN, service: 'WFS', version: '2.0.0', request: 'GetFeature',
            outputFormat: 'json', typeName: 'oss:DKP_CESTICE', srsName: 'EPSG:3765' };
    }

    // One page of the parcels in an EPSG:3765 box "minE,minN,maxE,maxN".
    function bboxUrl(bbox, { count = PAGE_SIZE, startIndex = 0 } = {}) {
        return `${WFS_URL}?${new URLSearchParams({ ...baseParams(), bbox: String(bbox),
            count: String(count), startIndex: String(startIndex) })}`;
    }

    function escapeXml(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    const equal = (name, value) => `<PropertyIsEqualTo><PropertyName>${name}</PropertyName><Literal>${escapeXml(value)}</Literal></PropertyIsEqualTo>`;

    // A parcel id as the WFS filter that finds it: HR-<KO>-<number>, or HR-<CESTICA_ID> (the
    // backend's fallback form). Null for anything else.
    function idClause(id) {
        const text = String(id || '').trim();
        const numbered = /^HR-(\d+)-(.+)$/.exec(text);
        if (numbered) return `<And>${equal('MATICNI_BROJ_KO', numbered[1])}${equal('BROJ_CESTICE', numbered[2])}</And>`;
        const internal = /^HR-(\d+)$/.exec(text);
        return internal ? equal('CESTICA_ID', internal[1]) : null;
    }

    function idsUrl(ids) {
        const clauses = ids.map(idClause).filter(Boolean);
        if (!clauses.length) return null;
        const filter = clauses.length === 1 ? `<Filter>${clauses[0]}</Filter>` : `<Filter><Or>${clauses.join('')}</Or></Filter>`;
        return `${WFS_URL}?${new URLSearchParams({ ...baseParams(), FILTER: filter })}`;
    }

    // A raw DKP_CESTICE feature in our server's property shape (geometry still EPSG:3765).
    function toParcelFeature(feature) {
        const props = feature && feature.properties || {};
        if (props.MATICNI_BROJ_KO === undefined || props.BROJ_CESTICE === undefined || !feature.geometry) return null;
        const ko = String(props.MATICNI_BROJ_KO);
        const number = String(props.BROJ_CESTICE);
        return {
            type: 'Feature',
            geometry: feature.geometry,
            properties: {
                CESTICA_ID: props.CESTICA_ID === undefined ? null : String(props.CESTICA_ID),
                BROJ_CESTICE: number,
                MATICNI_BROJ_KO: ko,
                parcelId: `HR-${ko}-${number}`,
                groundSource: 'dgu-live'
            }
        };
    }

    // Whether a failed request to our server should be answered from DGU instead: only when our
    // server is unreachable or failing (no answer, a timeout, a 5xx). A 4xx is our server answering
    // about the request itself — "this area covers too many parcels" (413), "this shape is too big
    // or invalid" (400) — and stands: DGU would only be asked the same oversized question.
    function shouldFallBack(error, signal) {
        if (signal && signal.aborted) return false;
        if (error && error.name === 'AbortError' && !error.status) return false;
        const status = Number(error && error.status);
        return !Number.isFinite(status) || status === 0 || status >= 500;
    }

    // requestJson(url) → parsed JSON or throws; toWgs84(fc) → the collection in WGS84;
    // toDatasetBox([w,s,e,n] WGS84) → "minE,minN,maxE,maxN" in EPSG:3765; turf for the footprint test.
    function createDguLiveReader({ requestJson, toWgs84, toDatasetBox, turf }) {
        async function pagedBbox(bbox) {
            const features = [];
            let startIndex = 0;
            for (;;) {
                const payload = await requestJson(bboxUrl(bbox, { startIndex }));
                const page = Array.isArray(payload && payload.features) ? payload.features : [];
                features.push(...page);
                const matched = Number(payload && (payload.numberMatched ?? payload.totalFeatures));
                if (Number.isFinite(matched) && matched > MAX_PARCELS) {
                    throw Object.assign(new Error(`The area covers ${matched} parcels, over the ${MAX_PARCELS} limit.`),
                        { status: 413, code: 'parcel-area-too-large', count: matched });
                }
                startIndex += page.length;
                const more = Number.isFinite(matched) ? startIndex < matched : page.length === PAGE_SIZE;
                if (!page.length || !more) return features;
            }
        }

        function shaped(rawFeatures) {
            const features = rawFeatures.map(toParcelFeature).filter(Boolean);
            return toWgs84({ type: 'FeatureCollection', features }).features;
        }

        // The parcels in an EPSG:3765 box, in WGS84.
        async function fetchBbox(bbox) {
            return shaped(await pagedBbox(bbox));
        }

        async function fetchIds(ids) {
            const raw = [];
            for (let i = 0; i < ids.length; i += ID_BATCH) {
                const url = idsUrl(ids.slice(i, i + ID_BATCH));
                if (!url) continue;
                const payload = await requestJson(url);
                if (!Array.isArray(payload && payload.features)) throw new Error('DGU parcel response has no features array.');
                raw.push(...payload.features);
            }
            return shaped(raw);
        }

        // The parcels a WGS84 footprint takes area from, with the backend's taken_m2 and coverage.
        // parcelsOnly answers every parcel touching the footprint's box test, as the lean backend mode does.
        async function fetchUnder(geometry, { parcelsOnly = false } = {}) {
            const footprint = turf.feature(geometry);
            const candidates = await fetchBbox(toDatasetBox(turf.bbox(footprint)));
            if (parcelsOnly) {
                const features = candidates.filter(parcel => turf.booleanIntersects(parcel, footprint));
                return { features, coverage: null };
            }
            const footprintM2 = turf.area(footprint);
            let takenTotal = 0;
            const features = [];
            candidates.forEach(parcel => {
                let piece = null;
                try { piece = turf.intersect(parcel, footprint); } catch (error) {
                    // These takes stand in for the server's binding (which parcels a proposal
                    // stands on, and its coverage); "takes nothing" would bind it wrongly. Refuse
                    // with a typed ClipFailure (parcel-arrangement.js).
                    const clips = (typeof window !== 'undefined' && window.__parcelArrangement)
                        || (typeof require === 'function' ? require('../proposals/parcel-arrangement.js') : null);
                    if (!clips || typeof clips.clipFailure !== 'function') throw error;
                    const props = parcel && parcel.properties || {};
                    throw clips.clipFailure('intersect', error, { site: 'dgu-live.fetchUnder', parcelId: props.parcelId || null }, [parcel, footprint]);
                }
                const taken = piece ? turf.area(piece) : 0;
                if (taken <= TAKEN_FLOOR_M2) return;
                takenTotal += taken;
                parcel.properties = { ...parcel.properties, taken_m2: taken };
                features.push(parcel);
            });
            // Parcels tessellate, so the takes add up to the covered share of the footprint.
            const coverage = footprintM2 > 0 ? Math.max(0, Math.min(1, takenTotal / footprintM2)) : 0;
            return { features, coverage, footprintM2 };
        }

        return { fetchBbox, fetchIds, fetchUnder };
    }

    const registry = SourceRuntime.createRegistry({
        abstraction: 'parcels', runtime: 'browser', required: ['fetchBbox', 'fetchIds', 'fetchUnder'],
        adapters: { 'dgu-live': { custom: false, create: (_config, context) => createDguLiveReader(context) } },
        sources: [SourceRuntime.source('parcels', 'dgu-live', {
            id: 'dgu-live-cadastre', endpoint: WFS_URL, typeName: 'oss:DKP_CESTICE', srsName: 'EPSG:3765'
        })]
    });
    function createDguLive(context) { return registry.open('dgu-live-cadastre', context); }

    return Object.freeze({ WFS_URL, HOST, MAX_PARCELS, bboxUrl, idsUrl, idClause, toParcelFeature, shouldFallBack, createDguLive });
});
