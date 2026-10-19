// Convert the source-derived Borovje mesh to ordinary, portable proposal instructions.
// Roads cut first; readjustments conserve their remainders; buildings occupy their authored plots.
import authored from '../../frontend/js/proposals/authored-record.js';

export const REPAIR_VERSION = 'borovje-flat-plan-v1';
export const BOROVJE_IDS = [
    'p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3',
    'upu-borovje-ulice', 'upu-borovje-ulice-split-1',
    ...Array.from({ length: 11 }, (_, i) => `upu-borovje-m1-${i + 1}`),
    'upu-borovje-r2-0', ...Array.from({ length: 5 }, (_, i) => `upu-borovje-z1-${i + 1}`)
];

export function repairBorovjeRecords(input, turf) {
    const records = input.map(record => authored.stripCadastreAliases(authored.cleanFeatureContainers(record)));
    const actual = new Set(records.map(record => record.proposalId));
    if (records.length !== BOROVJE_IDS.length || actual.size !== records.length
        || BOROVJE_IDS.some(id => !actual.has(id))) throw new Error('Expected all 22 distinct Borovje proposals.');
    const plots = records.flatMap(record => record.reparcellization?.polygons || []);
    if (plots.length !== 17) throw new Error('Expected the 17 intended Borovje plots.');
    const adjustments = [];
    for (const record of records) {
        // This retired runtime switch deliberately discarded ground intended for later siblings.
        // Source provenance belongs in metadata that cannot alter materialization or validation.
        delete record.coordinatedPlanId;
        delete record.ownershipFlow;
        delete record.cadastreFrame;
        record.reconstructionPlanId = 'upu-borovje';
        record.reconstructionRepair = REPAIR_VERSION;
        if (record.reparcellization) record.reparcellization.algorithm = 'manual';
        if (!record.geometry?.buildings?.length) continue;
        const name = record.proposalId.replace('upu-borovje-', '').toUpperCase();
        const plot = plots.find(item => item.sourceName === name);
        if (!plot) throw new Error(`Missing intended plot for ${name}.`);
        // Keep the single-building editor, with the existing content-on-plots application route.
        // A freeform 'single' take would subdivide the freshly authored plot a second time.
        record.goal = 'buildings';
        record.typologyType = 'single';
        for (const building of record.geometry.buildings) {
            const before = turf.area(building);
            const outside = turf.difference(building, turf.feature(plot.geometry));
            const outsideM2 = outside ? turf.area(outside) : 0;
            if (outsideM2 > 1e-6) {
                const clipped = turf.intersect(building, turf.feature(plot.geometry));
                // The raw M1-9 extraction overhangs its plot by 5.8%; permit modest edge repairs,
                // while refusing a misplaced building whose position needs a separate decision.
                if (!clipped || clipped.geometry.type !== 'Polygon' || turf.area(clipped) < before * 0.9) {
                    throw new Error(`${name}: clipping would disconnect the building or remove more than 10%.`);
                }
                building.geometry = clipped.geometry;
            }
            adjustments.push({ name, beforeM2: before, afterM2: turf.area(building), trimmedM2: outsideM2 });
        }
    }
    return { records, adjustments };
}
