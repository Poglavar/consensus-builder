import { createKzGenplanProvider, genplanService, genplanStoreyLimits } from './kz-genplan.js';

const edition = '2026-11-24';
const id = `almaty-pdp-cadastre-${edition}`;
export const almatyDetailedPlanSource = Object.freeze({
    id, city: 'almaty', edition, default: true, language: 'ru', kind: 'reference', coverage: 'zoning-areas', scope: 'city',
    label: 'ПДП Алматы · три территории из кадастра (24.11.2026)', url: 'https://map.gov4c.kz/egkn/',
    storage: 'bundled-snapshot', snapshotFilename: `${id}.geojson.gz`,
    service: genplanService, layer: 'kz:pdpzone', admterrId: '750000000',
    attribution: 'Государственный градостроительный кадастр · ПДП · срез от 24 ноября 2026 г.',
    capabilities: { volumes: false, areas: true, parcelEvidence: false, constraintEvaluation: false },
    parcelSourceId: 'kz-almaty-mapalmaty-gzk', parcelStudy: 'direct-dimensions.v1',
    zoningPageLimit: 1000, viewportZoning: true, zoningOverview: { detailZoom: 15 },
    scenarios: ['general'], scenario: 'general', cacheSeconds: 86400
});

const evidence = Object.freeze({
    snapshotDate: edition, publishedApproval: 'unrecorded',
    storeyHeightM: 3, storeyHeightNote: 'Assumed 3.0 m floor-to-floor. The detailed-plan cadastre records storey classes.'
});
const uses = new Map([
    [11010001, ['residential-estate', 'housing-low']], [11010003, [null, 'housing-low']],
    [11020001, ['residential-low', 'housing-low']], [11030001, ['residential-mid', 'housing-mid']],
    [11040001, ['residential-high', 'housing-high']], [11040002, ['residential-tall', 'housing-high']],
    [11050001, ['education', 'public']], [11060001, ['health', 'public']],
    [11070007, [null, 'commercial']], [11100001, ['roads', 'transport']],
    [11120001, ['car-services', 'transport']], [11300001, ['green', 'green']], [11310001, ['parks', 'green']],
    [11330001, ['water', 'water']], [11380001, ['cemeteries', 'restricted']]
]);
const groups = new Map([
    ['Общественно-деловые зоны', 'public'], ['Промышленные (производственные) зоны', 'industry'],
    ['Зоны транспортной инфраструктуры', 'transport'], ['Зоны сельскохозяйственного и лесохозяйственного использования', 'agriculture'],
    ['Рекреационные зоны', 'green'], ['Зоны специального назначения', 'restricted'], ['Санитарно-защитные зоны', 'restricted']
]);

export function interpretAlmatyDetailedZone({ functional, name_usl: classLabel, usl_i32: code, pdpzone, implementation }) {
    const use = functional?.trim() || classLabel?.trim() || 'Функциональная зона';
    const [useKey, useGroup] = uses.get(code) || [null, groups.get(pdpzone) || null];
    // The upstream spelling of existing can start with Latin C.
    const stage = implementation === 'Проектируемые' ? 'planned' : /^[СC]уществующие$/u.test(implementation) ? 'existing' : null;
    const base = { use, useKey, useGroup, stage, status: null, reason: null, heightM: null, constraints: [] };
    if (code === 11040002) return { ...base, status: 'instrument_handoff',
        reason: 'Верхняя этажность в записи ПДП не указана.' };
    if (!useGroup?.startsWith('housing-') || !functional) return base;
    // The plan-specific functional label can be narrower than the national classification name.
    const count = functional.match(/(\d+)\s+этаж/u);
    return count ? { ...base, status: 'allowed', ...genplanStoreyLimits(Number(count[1]), evidence, { basis: use }) } : base;
}

export function createAlmatyDetailedPlanProvider(descriptor, { snapshot } = {}) {
    return createKzGenplanProvider(descriptor, { snapshot, interpretZone: interpretAlmatyDetailedZone, rulesEvidence: evidence, effect: 'unknown' });
}
