// Alatau general plan (Government Decree No. 727 of 9 September 2025, the corrected plan) as a
// Permitted source: the functional-zone polygons the state urban-planning cadastre publishes over
// public WFS (map.gov4c.kz/ggkgs, layer kz:gpzone), read live per viewport. Each zone's use and
// storey class become a status and, for residential classes, storey and height constraints.
import * as turf from '@turf/turf';
import { readFileSync } from 'node:fs';
import { createHttpsJsonFetch } from '../../parcels/https-json-fetch.js';
import { validateGeometry } from '../../parcels/source-contract.js';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';

export const ALATAU_GENPLAN_SERVICE = 'https://map.gov4c.kz/ggkgs/ows';
export const ALATAU_GENPLAN_LAYER = 'kz:gpzone';
// KATO code of Alatau city; the layer is national, so zones of neighbouring plans share it.
export const ALATAU_ADMTERR_ID = '191810000';
const VIEWER = 'https://map.gov4c.kz/egkn/';
export const alatauGenplanSource = Object.freeze({
    id: 'alatau-genplan-727', city: 'alatau', label: 'Генплан Алатау · Постановление № 727 (2025)', edition: '2025-09-09', default: true,
    kind: 'regulation', coverage: 'zoning-areas', scope: 'city',
    url: 'https://primeminister.kz/assets/media/prilozenie-1-rus-727.pdf',
    storage: 'ogc-wfs', service: ALATAU_GENPLAN_SERVICE, layer: ALATAU_GENPLAN_LAYER, admterrId: ALATAU_ADMTERR_ID,
    issuer: 'Правительство Республики Казахстан',
    attribution: 'Генеральный план города Алатау, Постановление Правительства РК № 727 от 9 сентября 2025 г. · зоны из государственного градостроительного кадастра (map.gov4c.kz)',
    capabilities: { volumes: false, areas: true, parcelEvidence: false, constraintEvaluation: false },
    parcelSourceId: 'kz-alatau-pkk', parcelStudy: 'direct-dimensions.v1',
    scenarios: ['general'], scenario: 'general'
});

// Storey height is not stated by the plan; 3.0 m floor-to-floor is an assumption recorded as evidence.
export const ALATAU_RULES = Object.freeze({
    decree: 'Постановление Правительства РК № 727 от 09.09.2025 (корректировка генерального плана г. Алатау)',
    storeyHeightM: 3.0,
    storeyHeightNote: 'Assumed 3.0 m floor-to-floor; the general plan states storey classes, not heights.'
});

const PDP = 'Параметры застройки устанавливает проект детальной планировки (ПДП) и АПЗ.';
const NOT_FOR_BUILDING = 'Зона не предназначена для застройки по генплану.';
// Functional zones by their exact cadastre label (whitespace normalised). `storeys` is the class's
// upper limit as the legend writes it; `uplift` keeps a legend value marked with an asterisk.
const ZONES = new Map(Object.entries({
    'Территория усадебной застройки с земельным участком при доме (квартире)': { use: 'Усадебная застройка', status: 'allowed', storeys: 3,
        storeysBasis: 'assumed: detached houses with plots; the legend gives no storey count' },
    'Территория малоэтажной застройки (2-3 этажа) без участка': { use: 'Малоэтажная застройка', status: 'allowed', storeys: 3, storeysBasis: 'legend: 2–3 этажа' },
    'Территория среднеэтажной застройки (4-5 и 6* этажей)': { use: 'Среднеэтажная застройка', status: 'allowed', storeys: 5,
        uplift: { storeys: 6, condition: '6* этажей по легенде генплана; условие примечания не прочитано' }, storeysBasis: 'legend: 4–5 и 6* этажей' },
    'Территория многоэтажной застройки (6-12 этажей)': { use: 'Многоэтажная застройка', status: 'allowed', storeys: 12, storeysBasis: 'legend: 6–12 этажей' },
    'Территория застройки повышенной этажности (выше 12 этажей)': { use: 'Застройка повышенной этажности', status: 'instrument_handoff',
        reason: `Выше 12 этажей: верхний предел генплан не задаёт. ${PDP}` },
    'Территория учреждений и предприятий обслуживания в том числе общегородского значения': { use: 'Обслуживание', status: 'instrument_handoff', reason: PDP },
    'Территория учреждений образования': { use: 'Образование', status: 'instrument_handoff', reason: PDP },
    'Территория организаций здравоохранения и социального обеспечения': { use: 'Здравоохранение', status: 'instrument_handoff', reason: PDP },
    'Территория промышленной застройки': { use: 'Промышленность', status: 'instrument_handoff', reason: PDP },
    'Территория коммунально-складской застройки': { use: 'Коммунально-складская', status: 'instrument_handoff', reason: PDP },
    'Территория предприятий автосервиса (автозапровочных станций, станций технического обслуживания, автомоек)': { use: 'Автосервис', status: 'instrument_handoff', reason: PDP },
    'Территория сооружений внешнего транспорта (автовокзалов, ж/д вокзалов, аэропортов, аэровокзалов)': { use: 'Внешний транспорт', status: 'instrument_handoff', reason: PDP },
    'Территория оборонных объектов': { use: 'Оборонные объекты', status: 'instrument_handoff', reason: 'Режимная территория.' },
    'Территория исправительно-трудовых учреждений': { use: 'Исправительные учреждения', status: 'instrument_handoff', reason: 'Режимная территория.' },
    'Территории канализационных очистных сооружений': { use: 'Очистные сооружения', status: 'instrument_handoff', reason: PDP },
    'Резервные территории': { use: 'Резервная территория', status: 'instrument_handoff', reason: 'Резерв развития; застройка после изменения генплана или ПДП.' },
    'Территории растениеводства': { use: 'Растениеводство', status: 'instrument_handoff', reason: 'Сельскохозяйственное использование.' },
    'Территории животноводства': { use: 'Животноводство', status: 'instrument_handoff', reason: 'Сельскохозяйственное использование.' },
    'Территория теплиц, цветочных хозяйств и питомников': { use: 'Теплицы и питомники', status: 'instrument_handoff', reason: 'Сельскохозяйственное использование.' },
    'Зелени общего пользования и зелени спецназначения': { use: 'Озеленение', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория парков, скверов и т.д. (зона кратковременного отдыха)': { use: 'Парки и скверы', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория рек, водоемов, береговых полос': { use: 'Водные объекты', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория лесного хозяйства': { use: 'Лесное хозяйство', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория особо охраняемых земель': { use: 'Особо охраняемые земли', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория автомобильных дорог': { use: 'Автомобильные дороги', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория железных дорог и сооружений железнодорожного транспорта': { use: 'Железные дороги', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория кладбищ': { use: 'Кладбища', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территории скотомогильников': { use: 'Скотомогильники', status: 'prohibited', reason: NOT_FOR_BUILDING }
}));
const normalise = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const implementationLabels = { 'Существующие': 'существующая', 'Проектируемые': 'проектируемая' };

function constraint(quantity, value, unit, bound, evidence, sourceField, extra = {}) {
    return { quantity, value, unit, bound, evidence, evaluation: 'not-evaluated', sourceField, ...extra };
}

// One zone's attributes as the shared record fields: the status the plan gives its use and, for a
// residential storey class, its storey and height limits.
export function interpretZone(properties, rules = ALATAU_RULES) {
    const functional = normalise(properties?.functional ?? properties?.name_usl);
    const implementation = normalise(properties?.implementation) || null;
    const zone = ZONES.get(functional);
    const base = { functional, zoneGroup: normalise(properties?.gpzone) || null, implementation,
        implementationLabel: implementationLabels[implementation] || null, storeyHeightM: rules.storeyHeightM, uplift: null, constraints: [] };
    if (!zone) return { ...base, use: functional || 'Зона', status: 'unrecorded', reason: `Функциональная зона не интерпретирована: ${functional || 'пусто'}`,
        storeys: null, heightM: null, heightLabel: 'не интерпретировано' };
    if (zone.status !== 'allowed') return { ...base, use: zone.use, status: zone.status, reason: zone.reason, storeys: null, heightM: null,
        heightLabel: zone.status === 'prohibited' ? 'без застройки' : 'по ПДП' };
    const heightM = Math.round(zone.storeys * rules.storeyHeightM * 100) / 100;
    return { ...base, use: zone.use, status: 'allowed', reason: null, storeys: zone.storeys, heightM, uplift: zone.uplift || null,
        heightLabel: zone.uplift ? `до ${zone.storeys} эт. (${zone.uplift.storeys}*)` : `до ${zone.storeys} эт.`,
        constraints: [
            constraint('storeys', zone.storeys, 'count', 'maximum', 'direct', 'functional', { basis: zone.storeysBasis }),
            // As in Bogotá's provider: a storey count times the recorded storey height, its derivation attached.
            constraint('height', heightM, 'm', 'maximum', 'direct', 'functional',
                { derivation: `${zone.storeys} × ${rules.storeyHeightM} m`, rule: rules.storeyHeightNote })
        ] };
}

const upstream = message => Object.assign(new Error(message), { status: 503, code: 'planning-source-unavailable' });
const spatialReference = Object.freeze({ horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' });
const TTL_MS = 15 * 60 * 1000, READ_CAP = 128, FEATURE_CAP = 8000;
let defaultFetch;
// The host omits its Sectigo intermediate; the same pinned CA the parcel source uses supplements it.
function certificateFetch() {
    if (!defaultFetch) {
        const pem = readFileSync(new URL('../../parcels/certificates/sectigo-public-server-authentication-ca-dv-r36.pem', import.meta.url), 'utf8');
        defaultFetch = createHttpsJsonFetch(pem, { maxBytes: 32 * 1024 * 1024 });
    }
    return defaultFetch;
}

export function createAlatauGenplanProvider(descriptor = alatauGenplanSource, { fetchImpl = null, now = Date.now } = {}) {
    const service = descriptor.service || ALATAU_GENPLAN_SERVICE, layer = descriptor.layer || ALATAU_GENPLAN_LAYER;
    const admterrId = descriptor.admterrId || ALATAU_ADMTERR_ID;
    const features = new Map(), reads = new Map();
    function remember(feature) {
        if (features.size >= FEATURE_CAP) features.delete(features.keys().next().value);
        features.set(String(feature.properties.object_id_i32), { feature, at: now() });
    }
    // One guarded GetFeature. Zones of other territories and features without usable geometry are
    // counted as omitted, never drawn.
    async function getFeatures(params) {
        const url = new URL(service);
        for (const [key, value] of Object.entries({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: layer,
            outputFormat: 'application/json', sortBy: 'object_id_i32', ...params })) url.searchParams.set(key, String(value));
        let payload;
        try {
            const response = await (fetchImpl || certificateFetch())(url.href, { headers: { Accept: 'application/json', Referer: VIEWER } });
            if (!response.ok) throw new Error('status');
            payload = await response.json();
        } catch (_) { throw upstream('Alatau general plan service could not be read.'); }
        if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstream('Alatau general plan service returned an invalid collection.');
        const kept = [];
        let omitted = 0;
        for (const feature of payload.features) {
            const id = feature?.properties?.object_id_i32;
            if (feature?.type !== 'Feature' || !Number.isSafeInteger(id) || id < 0) throw upstream('Alatau general plan zone has no identity.');
            if (String(feature.properties.admterr_id) !== admterrId || !validateGeometry(feature.geometry)) { omitted++; continue; }
            remember(feature);
            kept.push(feature);
        }
        return { features: kept, omitted, returned: payload.features.length };
    }
    // A viewport page: WFS 2.0 reads EPSG:4326 bounds latitude first. `after` is the index of the
    // next feature in the service's object_id order.
    function readBounds(bbox, { after = 0, count }) {
        const key = JSON.stringify([bbox, after, count]);
        const cached = reads.get(key);
        if (cached && now() - cached.at < TTL_MS) return cached.promise;
        const promise = getFeatures({ bbox: `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]},urn:ogc:def:crs:EPSG::4326`, count, startIndex: after })
            .catch(error => { reads.delete(key); throw error; });
        if (reads.size >= READ_CAP) reads.delete(reads.keys().next().value);
        reads.set(key, { at: now(), promise });
        return promise;
    }
    const rulesEvidence = Object.freeze({ decree: ALATAU_RULES.decree, storeyHeightM: ALATAU_RULES.storeyHeightM, storeyHeightNote: ALATAU_RULES.storeyHeightNote });
    function record(feature, displayGeometry, city = descriptor.city, scenario = descriptor.scenario) {
        const p = feature.properties, reading = interpretZone(p), recordId = String(p.object_id_i32);
        const id = `${descriptor.id}:${recordId}`;
        const site = validateGeometry(displayGeometry) ? displayGeometry : null;
        const title = [reading.use, reading.heightLabel, reading.implementationLabel].filter(Boolean).join(' · ');
        return withSourceProposal({
            id, role: 'permitted', title, site, areas: site ? [{ id: `${id}:area`, geometry: site }] : [], volumes: [], spatialReference,
            source: { ...descriptor, city: city || descriptor.city, scenario, recordId,
                version: sourceRevision({ id: recordId, geometry: feature.geometry, properties: p }), publishedAt: descriptor.edition },
            authority: { effect: 'obligatory', basis: 'source-summary', applicability: 'unresolved' },
            assessment: { meaning: 'zoning-area', status: reading.status, reason: reading.reason, geometry: 'source-area', constraints: 'not-evaluated', current: true },
            metrics: { floorAreaM2: null, heightM: reading.heightM },
            constraints: reading.status === 'allowed' ? reading.constraints.map(item => ({ ...item, scenario })) : [],
            sourceEvidence: { layer, service, properties: p, interpretation: reading, ...(reading.uplift ? { uplift: reading.uplift } : {}), rules: rulesEvidence }
        });
    }
    return {
        descriptor,
        async query(_pool, { bbox, limit, after = null, scenario = descriptor.scenario, city }) {
            if (after !== null && !/^\d{1,7}$/.test(String(after))) throw Object.assign(new Error('Invalid source cursor'), { status: 400 });
            const start = after === null ? 0 : Number(after);
            // A full page may have more behind it; the cursor counts service rows, kept or omitted.
            const page = await readBounds(bbox, { after: start, count: limit });
            const visible = page.features;
            const items = visible.map(feature => record(feature, turf.bboxClip(feature, bbox).geometry, city, scenario));
            const statuses = {};
            for (const item of items) statuses[item.assessment.status] = (statuses[item.assessment.status] || 0) + 1;
            return { items, nextAfter: page.returned >= limit ? String(start + page.returned) : null, omitted: page.omitted,
                summary: { sourceId: descriptor.id, cachedResults: visible.length + page.omitted, withGeometry: visible.length,
                    withoutGeometry: page.omitted, statuses } };
        },
        async record(_pool, { recordId, city, scenario }) {
            if (!/^\d{1,10}$/.test(String(recordId))) return [];
            const cached = features.get(String(recordId));
            let feature = cached && now() - cached.at < TTL_MS ? cached.feature : null;
            if (!feature) {
                const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsEqualTo><fes:ValueReference>object_id_i32</fes:ValueReference><fes:Literal>${Number(recordId)}</fes:Literal></fes:PropertyIsEqualTo></fes:Filter>`;
                feature = (await getFeatures({ FILTER: filter, count: 2 })).features.find(item => String(item.properties.object_id_i32) === String(recordId)) || null;
            }
            return feature ? [record(feature, feature.geometry, city, scenario)] : [];
        }
    };
}
