// State land layers: a cadastre's free state plots (land the state has formed for allocation) and
// land applications (plots drawn in applications for state land). Pure request building, coordinate
// projection and the reading of each record's procedure status; js/state-land-layer.js fetches and
// draws, and backend/oracle/state-land-observer.js records status changes. Kazakhstan's EGKN PKK
// publishes both as WFS views in its native 6-degree Gauss–Krüger grid (zone-prefixed easting).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StateLand = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Each view at its layer-scoped address: the shared /geoserver/wfs answers 403 since 2026-11-27.
    const pkkEndpoint = typename => `https://map.gov4c.kz/geoserver/egkn/${typename.replace(/^egkn:/, '')}/wfs`;
    const PKK_VIEWER = 'https://map.gov4c.kz/egkn/';
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 10;
    // The fields each view is read with; nothing else (names of officials, sellers, applicants) is
    // requested. `status` names the view's procedure status code field.
    const VIEWS = Object.freeze({
        free: Object.freeze({ typename: 'egkn:freelands_view', status: 'auction_land_status_id',
            fields: ['gid', 'id', 'usedesc_ru', 'create_time', 'update_time', 'auction_land_status_id'] }),
        applications: Object.freeze({ typename: 'egkn:reqland_view', status: 'status_land_id',
            fields: ['gid', 'id', 'usedesc_ru', 'create_time', 'update_time', 'status_land_id'] })
    });

    // Procedure stages: `pending` (in procedure), `granted` (the akimat's resolution, a held auction,
    // a signed contract or payment), `registered` (cadastral and rights registration done) and
    // `stopped` (refused, cancelled, failed). A code missing from the table is `unknown`.
    const STAGES = Object.freeze(['pending', 'granted', 'registered', 'stopped', 'unknown']);
    const status = (stage, label) => Object.freeze({ stage, label });
    // The cadastre's own wording, from the GeoServer legend of each view (GetLegendGraphic, rules
    // `[<status field> = '<code>']`, read 2026-11-20). Both views number one shared procedure, so the
    // applications table takes 105 and 107 from the free plots' legend; their wording is the one the
    // cadastre map's Layers panel shows for applications. Codes 2, 23, 57 and 113 occur in Alatau's
    // applications but in neither legend, and stay unknown.
    const STATUSES = Object.freeze({
        free: Object.freeze({
            20: status('pending', 'Предложение подано'),
            25: status('stopped', 'Отказано при рассмотрении заявления'),
            30: status('pending', 'Схема отвода согласована в ЕГКН'),
            35: status('stopped', 'Схема отвода не согласована в ЕГКН'),
            40: status('stopped', 'Схема отвода не согласована в МИО'),
            45: status('pending', 'Схема отвода согласована в МИО'),
            60: status('stopped', 'Отменен по истечению срока согласования схемы отвода Заявителем'),
            62: status('stopped', 'Отменен в связи с истекшим сроком выставления ЗУ на торги'),
            89: status('pending', 'Предстоящий'),
            91: status('stopped', 'Предстоящий торг отменен'),
            93: status('pending', 'Прием заявлений'),
            94: status('granted', 'Торг/аукцион состоялся'),
            95: status('stopped', 'Торг/аукцион не состоялся'),
            96: status('stopped', 'Торг/аукцион отменен'),
            105: status('granted', 'Договор купли-продажи/аренды подписан'),
            107: status('granted', 'Оплата по договору осуществлена'),
            108: status('granted', 'Договор аренды подписан'),
            116: status('stopped', 'Отказано в постановке на кадастровый учет'),
            120: status('registered', 'Постановка на кадастровый учет и гос.регистрацию прав осуществлена'),
            121: status('stopped', 'Гос.регистрация не осуществлена')
        }),
        applications: Object.freeze({
            20: status('pending', 'Заявление подано'),
            25: status('stopped', 'Отказано при рассмотрении заявления'),
            30: status('pending', 'Акт выбора согласован в ЕГКН'),
            35: status('stopped', 'Акт выбора не согласован в ЕГКН'),
            40: status('stopped', 'Акт выбора не согласован в МИО'),
            45: status('pending', 'Акт выбора согласован в МИО'),
            50: status('pending', 'Акт выбора согласован Заявителем'),
            55: status('stopped', 'Акт выбора не согласован Заявителем'),
            60: status('stopped', 'Отменен по истечению срока согласования схемы отвода Заявителем'),
            80: status('pending', 'Землеустроительный проект разработан'),
            100: status('granted', 'Постановление МИО выдано'),
            103: status('stopped', 'Отмена решения в связи с отказом подписания Договора'),
            105: status('granted', 'Договор купли-продажи/права аренды подписан'),
            107: status('granted', 'Оплата по договору осуществлена'),
            116: status('stopped', 'Отказано в постановке на кадастровый учет'),
            120: status('registered', 'Постановка на кадастровый учет и гос.регистрацию прав осуществлена'),
            121: status('stopped', 'Гос.регистрация не осуществлена')
        })
    });

    // The city configuration's `stateLand` block: { provider: 'kazakhstan-pkk', relaySourceId,
    // districtId, zone }. The relay source is the city's PKK parcel source, the same provider.
    function normalizeConfig(value) {
        if (!value || value.provider !== 'kazakhstan-pkk') return null;
        const { relaySourceId, districtId, zone } = value;
        if (typeof relaySourceId !== 'string' || !relaySourceId || !Number.isSafeInteger(districtId) || districtId < 1
            || !Number.isSafeInteger(zone) || zone < 1 || zone > 60) return null;
        return Object.freeze({ provider: value.provider, relaySourceId, districtId, zone });
    }

    function projectionDefinition(zone) {
        return `+proj=tmerc +lat_0=0 +lon_0=${zone * 6 - 3} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`;
    }

    // One WFS page of a view in the district.
    function viewUrl(config, viewName, { startIndex = 0 } = {}) {
        const view = VIEWS[viewName];
        if (!view) throw new Error(`Unknown state land view: ${viewName}`);
        const params = new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature', typename: view.typename,
            outputFormat: 'application/json', propertyname: [...view.fields, 'geom'].join(','),
            count: String(PAGE_SIZE), startIndex: String(startIndex), sortBy: 'gid',
            viewparams: `district_id:${config.districtId}`
        });
        return `${pkkEndpoint(view.typename)}?${params}`;
    }

    // The provider through the backend relay, as a cacheable GET (backend/routes/parcel-provider-relay.js).
    function relayUrl(relayBase, config, providerUrl) {
        const query = new URLSearchParams({ url: providerUrl, referer: PKK_VIEWER, accept: 'application/json' });
        return `${String(relayBase).replace(/\/$/, '')}/parcel-provider-relay/${encodeURIComponent(config.relaySourceId)}?${query}`;
    }

    // Checks one page and says where the next starts, or null when the view is complete.
    function readPage(payload, startIndex) {
        const features = payload?.features;
        const matched = payload?.numberMatched ?? payload?.totalFeatures;
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(features) || !Number.isSafeInteger(matched)
            || matched < startIndex + features.length) {
            throw new Error('The cadastre returned an incomplete state land page.');
        }
        const next = startIndex + features.length;
        if (next < matched && !features.length) throw new Error('The cadastre ended a state land view early.');
        return { features, next: next < matched ? next : null };
    }

    function polygonsOf(geometry) {
        if (geometry?.type === 'Polygon') return [geometry.coordinates];
        if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
        return null;
    }

    // The calendar day a cadastre timestamp names, or null. Both views publish ISO timestamps.
    function dayOf(value) {
        if (typeof value !== 'string') return null;
        const match = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
        return match ? match[1] : null;
    }

    // A record's procedure status: { code, stage, label }. A record with no code is `pending` for a
    // free plot (listed, no procedure started) and `unknown` for an application; label null when
    // the code is not in the table.
    function statusOf(viewName, properties) {
        const view = VIEWS[viewName];
        if (!view) throw new Error(`Unknown state land view: ${viewName}`);
        const raw = properties?.[view.status];
        const code = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (code === null) return { code: null, stage: viewName === 'free' ? 'pending' : 'unknown', label: null };
        const entry = Number.isSafeInteger(code) ? STATUSES[viewName][code] : null;
        return { code: Number.isSafeInteger(code) ? code : null, stage: entry ? entry.stage : 'unknown', label: entry ? entry.label : null };
    }

    // A feature in WGS84 with only the fields the map shows. `project([x, y])` converts native metres.
    function toDisplayFeature(feature, viewName, project) {
        const polygons = polygonsOf(feature?.geometry);
        if (!polygons) return null;
        const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(point => project([point[0], point[1]]))));
        const p = feature.properties || {};
        const { code, stage, label } = statusOf(viewName, p);
        return {
            type: 'Feature',
            geometry: { type: 'MultiPolygon', coordinates },
            properties: {
                kind: viewName === 'free' ? 'free' : 'application', gid: p.gid,
                id: p.id === undefined || p.id === null ? null : String(p.id),
                use: typeof p.usedesc_ru === 'string' && p.usedesc_ru.trim() ? p.usedesc_ru.trim() : null,
                listedOn: dayOf(p.create_time), statusCode: code, stage, statusLabel: label, statusOn: dayOf(p.update_time)
            }
        };
    }

    // Counts per kind and stage: { free: { total, pending, granted, … }, application: { … } }.
    function summarize(features) {
        const counts = {};
        for (const feature of features) {
            const { kind, stage } = feature.properties;
            counts[kind] ||= Object.fromEntries([['total', 0], ...STAGES.map(name => [name, 0])]);
            counts[kind].total += 1;
            counts[kind][stage] += 1;
        }
        return counts;
    }

    return Object.freeze({
        VIEWS, STAGES, STATUSES, PAGE_SIZE, MAX_PAGES, normalizeConfig, projectionDefinition, viewUrl,
        relayUrl, readPage, dayOf, statusOf, toDisplayFeature, summarize
    });
});
