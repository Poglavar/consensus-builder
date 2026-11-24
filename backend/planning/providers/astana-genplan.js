import { createKzGenplanProvider, genplanLayer, genplanService } from './kz-genplan.js';

const edition = '2026-11-24';
const id = `astana-genplan-cadastre-${edition}`;
const revisedPlan = 'https://primeminister.kz/assets/media/prilozenie-rus-697.pdf#page=40';
export const astanaGenplanSource = Object.freeze({
    id, city: 'astana', label: 'Генплан Астаны · справочный слой кадастра (24.11.2026)', edition, default: true,
    language: 'ru', kind: 'reference', coverage: 'zoning-areas', scope: 'city',
    url: 'https://map.gov4c.kz/egkn/',
    storage: 'bundled-snapshot', snapshotFilename: `${id}.geojson.gz`,
    service: genplanService, layer: genplanLayer, admterrId: '710000000',
    issuer: 'Правительство Республики Казахстан',
    attribution: 'Государственный градостроительный кадастр · срез от 24 ноября 2026 г. · красные линии ссылаются на постановление № 33 (2024)',
    capabilities: { volumes: false, areas: true, parcelEvidence: false, constraintEvaluation: false },
    zoningPageLimit: 1000, viewportZoning: true, zoningOverview: { detailZoom: 15 },
    scenarios: ['general'], scenario: 'general', cacheSeconds: 86400
});

const evidence = Object.freeze({
    snapshotDate: edition,
    revisionVerification: 'unverified',
    redLineDecree: '№ 33 от 25.01.2024',
    redLineReference: 'https://primeminister.kz/ru/25012024-33',
    revisedPlan
});
const stages = { 'Существующие': 'existing', 'Проектируемые': 'planned' };
const useByCode = {
    11010000: ['residential-estate', 'housing-low'],
    11030000: ['residential-mid', 'housing-mid'],
    11050000: ['education', 'public'],
    11060000: [null, 'public'],
    11070000: [null, 'public'],
    11080000: ['industry', 'industry'],
    11090000: [null, 'industry'],
    11100000: ['roads', 'transport'],
    11120000: ['car-services', 'transport'],
    11130000: [null, 'transport'],
    11140000: ['railways', 'transport'],
    11270000: [null, 'agriculture'],
    11280000: ['forest', 'green'],
    11300000: ['green', 'green'],
    11310000: ['parks', 'green'],
    11330000: ['water', 'water'],
    11360000: ['defence', 'restricted'],
    11370000: ['prisons', 'restricted'],
    11380000: ['cemeteries', 'restricted'],
    11390000: [null, 'restricted'],
    11400000: [null, 'restricted']
};

export function interpretAstanaZone(properties) {
    const { functional, name_usl: name, usl_i32: code, gpzone: zoneGroup, implementation } = properties;
    const use = functional?.trim() || name?.trim() || 'Функциональная зона';
    // The cadastre uses one code for housing at 5–9, 10–17, and 18 or more storeys.
    const [useKey, useGroup] = code === 11040000 ? highRiseUse(use)
        : use === 'Территория деловых и коммерческих предприятий' ? [null, 'commercial']
            : useByCode[code] || [null, null];
    return { use, useKey, useGroup, zoneGroup, implementation, stage: stages[implementation] || null,
        status: null, reason: null, heightM: null };
}

function highRiseUse(label) {
    if (/\b5\s*-\s*9\b/.test(label)) return ['residential-high', 'housing-high'];
    if (/\b10\s*-\s*17\b|\b18\s+и более/.test(label)) return ['residential-tall', 'housing-high'];
    return [null, 'housing-high'];
}

export function createAstanaGenplanProvider(descriptor = astanaGenplanSource, { snapshot } = {}) {
    return createKzGenplanProvider(descriptor, {
        snapshot, interpretZone: interpretAstanaZone, rulesEvidence: evidence, effect: 'unknown'
    });
}
