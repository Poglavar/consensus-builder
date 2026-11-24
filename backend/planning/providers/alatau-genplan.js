// Alatau general plan (Government Decree No. 727 of 9 September 2025, the corrected plan) as a
// Permitted source: the functional-zone polygons the state urban-planning cadastre publishes over
// public WFS (map.gov4c.kz/ggkgs, layer kz:gpzone), queried from a local source snapshot.
import { createKzGenplanProvider, genplanLayer, genplanService } from './kz-genplan.js';

export const ALATAU_GENPLAN_SERVICE = genplanService;
export const ALATAU_GENPLAN_LAYER = genplanLayer;
// KATO code of Alatau city; the layer is national, so zones of neighbouring plans share it.
export const ALATAU_ADMTERR_ID = '191810000';
export const alatauGenplanSource = Object.freeze({
    id: 'alatau-genplan-727', city: 'alatau', label: 'Генплан Алатау · Постановление № 727 (2025)', edition: '2025-09-09', default: true,
    // The language of the source's own wording (titles, labels), so the app can mark it as quoted text.
    language: 'ru',
    kind: 'regulation', coverage: 'zoning-areas', scope: 'city',
    url: 'https://primeminister.kz/assets/media/prilozenie-1-rus-727.pdf',
    storage: 'bundled-snapshot', snapshotFilename: 'alatau-genplan-727.geojson.gz',
    service: ALATAU_GENPLAN_SERVICE, layer: ALATAU_GENPLAN_LAYER, admterrId: ALATAU_ADMTERR_ID,
    issuer: 'Правительство Республики Казахстан',
    attribution: 'Генеральный план города Алатау, Постановление Правительства РК № 727 от 9 сентября 2025 г. · зоны из государственного градостроительного кадастра (map.gov4c.kz)',
    capabilities: { volumes: false, areas: true, parcelEvidence: false, constraintEvaluation: false },
    parcelSourceId: 'kz-alatau-pkk', parcelStudy: 'direct-dimensions.v1',
    // The plan's zones are small; a block of lots lies under several hundred, read in one request.
    zoningPageLimit: 1000, viewportZoning: true, zoningOverview: { detailZoom: 15 },
    scenarios: ['general'], scenario: 'general',
    // The adopted plan changes only by a new decree: its answers keep a day (routes/planning.js).
    cacheSeconds: 86400
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
    'Территория усадебной застройки с земельным участком при доме (квартире)': { key: 'residential-estate', group: 'housing-low', use: 'Усадебная застройка', status: 'allowed', storeys: 3,
        storeysEvidence: 'assumed', storeysBasis: 'assumed: detached houses with plots; the legend gives no storey count' },
    'Территория малоэтажной застройки (2-3 этажа) без участка': { key: 'residential-low', group: 'housing-low', use: 'Малоэтажная застройка', status: 'allowed', storeys: 3, storeysBasis: 'legend: 2–3 этажа' },
    'Территория среднеэтажной застройки (4-5 и 6* этажей)': { key: 'residential-mid', group: 'housing-mid', use: 'Среднеэтажная застройка', status: 'allowed', storeys: 5,
        uplift: { storeys: 6, condition: '6* этажей по легенде генплана; условие примечания не прочитано', conditionCode: 'legend-asterisk' }, storeysBasis: 'legend: 4–5 и 6* этажей' },
    'Территория многоэтажной застройки (6-12 этажей)': { key: 'residential-high', group: 'housing-high', use: 'Многоэтажная застройка', status: 'allowed', storeys: 12, storeysBasis: 'legend: 6–12 этажей' },
    'Территория застройки повышенной этажности (выше 12 этажей)': { key: 'residential-tall', group: 'housing-high', use: 'Застройка повышенной этажности', status: 'instrument_handoff', reasonCode: 'above-12-floors',
        reason: `Выше 12 этажей: верхний предел генплан не задаёт. ${PDP}` },
    'Территория учреждений и предприятий обслуживания в том числе общегородского значения': { key: 'services', group: 'public', use: 'Обслуживание', status: 'instrument_handoff', reason: PDP },
    'Территория учреждений образования': { key: 'education', group: 'public', use: 'Образование', status: 'instrument_handoff', reason: PDP },
    'Территория организаций здравоохранения и социального обеспечения': { key: 'health', group: 'public', use: 'Здравоохранение', status: 'instrument_handoff', reason: PDP },
    'Территория промышленной застройки': { key: 'industry', group: 'industry', use: 'Промышленность', status: 'instrument_handoff', reason: PDP },
    'Территория коммунально-складской застройки': { key: 'storage', group: 'industry', use: 'Коммунально-складская', status: 'instrument_handoff', reason: PDP },
    'Территория предприятий автосервиса (автозапровочных станций, станций технического обслуживания, автомоек)': { key: 'car-services', group: 'industry', use: 'Автосервис', status: 'instrument_handoff', reason: PDP },
    'Территория сооружений внешнего транспорта (автовокзалов, ж/д вокзалов, аэропортов, аэровокзалов)': { key: 'transport-terminals', group: 'transport', use: 'Внешний транспорт', status: 'instrument_handoff', reason: PDP },
    'Территория оборонных объектов': { key: 'defence', group: 'restricted', use: 'Оборонные объекты', status: 'instrument_handoff', reason: 'Режимная территория.' },
    'Территория исправительно-трудовых учреждений': { key: 'prisons', group: 'restricted', use: 'Исправительные учреждения', status: 'instrument_handoff', reason: 'Режимная территория.' },
    'Территории канализационных очистных сооружений': { key: 'sewage', group: 'industry', use: 'Очистные сооружения', status: 'instrument_handoff', reason: PDP },
    'Резервные территории': { key: 'reserve', group: 'reserve', use: 'Резервная территория', status: 'instrument_handoff', reason: 'Резерв развития; застройка после изменения генплана или ПДП.' },
    'Территории растениеводства': { key: 'crops', group: 'agriculture', use: 'Растениеводство', status: 'instrument_handoff', reason: 'Сельскохозяйственное использование.' },
    'Территории животноводства': { key: 'livestock', group: 'agriculture', use: 'Животноводство', status: 'instrument_handoff', reason: 'Сельскохозяйственное использование.' },
    'Территория теплиц, цветочных хозяйств и питомников': { key: 'greenhouses', group: 'agriculture', use: 'Теплицы и питомники', status: 'instrument_handoff', reason: 'Сельскохозяйственное использование.' },
    'Зелени общего пользования и зелени спецназначения': { key: 'green', group: 'green', use: 'Озеленение', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория парков, скверов и т.д. (зона кратковременного отдыха)': { key: 'parks', group: 'green', use: 'Парки и скверы', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория рек, водоемов, береговых полос': { key: 'water', group: 'water', use: 'Водные объекты', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория лесного хозяйства': { key: 'forest', group: 'green', use: 'Лесное хозяйство', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория особо охраняемых земель': { key: 'protected', group: 'green', use: 'Особо охраняемые земли', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория автомобильных дорог': { key: 'roads', group: 'transport', use: 'Автомобильные дороги', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория железных дорог и сооружений железнодорожного транспорта': { key: 'railways', group: 'transport', use: 'Железные дороги', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территория кладбищ': { key: 'cemeteries', group: 'restricted', use: 'Кладбища', status: 'prohibited', reason: NOT_FOR_BUILDING },
    'Территории скотомогильников': { key: 'burial-grounds', group: 'restricted', use: 'Скотомогильники', status: 'prohibited', reason: NOT_FOR_BUILDING }
}));
const normalise = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const implementationLabels = { 'Существующие': 'существующая', 'Проектируемые': 'проектируемая' };
// Whether the plan keeps a zone's use or plans it, as a stage the app translates (planningViews.zoneStage).
const implementationStages = { 'Существующие': 'existing', 'Проектируемые': 'planned' };
// The reasons above as codes the app translates (planningViews.zoneReason.<code>); the text stays on the
// record for API and MCP readers.
const REASON_CODES = new Map([[PDP, 'detailed-plan'], [NOT_FOR_BUILDING, 'not-for-building'], ['Режимная территория.', 'restricted-regime'],
    ['Резерв развития; застройка после изменения генплана или ПДП.', 'reserve'], ['Сельскохозяйственное использование.', 'agriculture']]);

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
        implementationLabel: implementationLabels[implementation] || null, stage: implementationStages[implementation] || null, storeyHeightM: rules.storeyHeightM, uplift: null, constraints: [] };
    // Alatau's planned blocks are the boundary of its massing calculation.
    if (base.stage === 'planned') base.landBasis = 'zone';
    if (!zone) return { ...base, useKey: null, useGroup: null, use: functional || 'Зона', status: 'unrecorded', reason: `Функциональная зона не интерпретирована: ${functional || 'пусто'}`, reasonCode: 'uninterpreted',
        storeys: null, heightM: null, heightLabel: 'не интерпретировано' };
    if (zone.status !== 'allowed') return { ...base, useKey: zone.key, useGroup: zone.group, use: zone.use, status: zone.status, reason: zone.reason,
        reasonCode: zone.reasonCode || REASON_CODES.get(zone.reason) || null, storeys: null, heightM: null,
        heightLabel: zone.status === 'prohibited' ? 'без застройки' : 'по ПДП' };
    const heightM = Math.round(zone.storeys * rules.storeyHeightM * 100) / 100;
    return { ...base, useKey: zone.key, useGroup: zone.group, use: zone.use, status: 'allowed', reason: null, storeys: zone.storeys, heightM, uplift: zone.uplift || null,
        heightLabel: zone.uplift ? `до ${zone.storeys} эт. (${zone.uplift.storeys}*)` : `до ${zone.storeys} эт.`,
        constraints: [
            constraint('storeys', zone.storeys, 'count', 'maximum', zone.storeysEvidence || 'direct', 'functional', { basis: zone.storeysBasis }),
            constraint('height', heightM, 'm', 'maximum', 'derived', 'functional',
                { derivation: `${zone.storeys} × ${rules.storeyHeightM} m`, rule: rules.storeyHeightNote })
        ] };
}

export function createAlatauGenplanProvider(descriptor = alatauGenplanSource, { snapshot } = {}) {
    return createKzGenplanProvider(descriptor, { snapshot, interpretZone, rulesEvidence: ALATAU_RULES });
}
