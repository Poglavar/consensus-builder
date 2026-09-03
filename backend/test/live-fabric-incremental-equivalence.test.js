import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

function parcel(id, column, row = 0, properties = {}) {
    const west = 15 + column * 0.0001;
    const south = 45 + row * 0.0001;
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [west, south], [west + 0.0001, south],
                [west + 0.0001, south + 0.0001], [west, south + 0.0001], [west, south]
            ]]
        }
    };
}

function split(id, column, producer) {
    const west = 15 + column * 0.0001;
    const south = 45;
    const common = { cadastreParcelIds: [id], producedByProposalId: producer };
    return [
        {
            ...parcel(`${id}#${producer}-a`, column, 0, common),
            geometry: { type: 'Polygon', coordinates: [[
                [west, south], [west + 0.00005, south],
                [west + 0.00005, south + 0.0001], [west, south + 0.0001], [west, south]
            ]] }
        },
        {
            ...parcel(`${id}#${producer}-b`, column, 0, common),
            geometry: { type: 'Polygon', coordinates: [[
                [west + 0.00005, south], [west + 0.0001, south],
                [west + 0.0001, south + 0.0001], [west + 0.00005, south + 0.0001], [west + 0.00005, south]
            ]] }
        }
    ];
}

async function commit(fabric, operation, meta = {}) {
    const mutation = fabric.beginMutation(meta);
    try {
        const result = await operation(mutation);
        await mutation.prepare();
        mutation.publish();
        return result;
    } catch (error) {
        mutation.rollback();
        throw error;
    }
}

function fullReference(features) {
    const byCadastre = new Map();
    const byProducer = new Map();
    for (const feature of features) {
        const id = String(feature.properties.parcelId);
        for (const cadastreId of feature.properties.cadastreParcelIds || []) {
            if (!byCadastre.has(cadastreId)) byCadastre.set(cadastreId, new Set());
            byCadastre.get(cadastreId).add(id);
        }
        const producer = feature.properties.producedByProposalId;
        if (producer) {
            if (!byProducer.has(producer)) byProducer.set(producer, new Set());
            byProducer.get(producer).add(id);
        }
    }
    return { byCadastre, byProducer };
}

function ids(features) {
    return features.map(feature => String(feature.properties.parcelId)).sort();
}

describe('incremental fabric/reference equivalence', () => {
    it('matches freshly rebuilt indexes after a deterministic randomized mutation sequence', async () => {
        const count = 24;
        const fabric = createLiveParcelFabric();
        await commit(fabric, mutation => mutation.seedCadastre(
            Array.from({ length: count }, (_, index) => parcel(`HR-${index}`, index))
        ), { kind: 'ground-load' });

        let randomState = 0x5eed1234;
        const random = () => {
            randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
            return randomState / 0x100000000;
        };

        for (let step = 0; step < 48; step += 1) {
            const index = Math.floor(random() * count);
            const cadastreId = `HR-${index}`;
            const useSplit = random() >= 0.35;
            const replacements = useSplit
                ? split(cadastreId, index, `proposal-${step % 7}`)
                : [parcel(cadastreId, index, 0, { cadastreParcelIds: [cadastreId] })];
            await commit(fabric, mutation => {
                mutation.replaceCadastreScope([cadastreId], replacements);
            }, { kind: 'proposal-apply' });

            const all = fabric.list();
            const reference = fullReference(all);
            expect(fabric.snapshot().parcelIds.slice().sort()).toEqual(ids(all));
            for (let cadastreIndex = 0; cadastreIndex < count; cadastreIndex += 1) {
                const key = `HR-${cadastreIndex}`;
                expect(ids(fabric.entriesForCadastre([key], { includeCorridors: true })))
                    .toEqual(Array.from(reference.byCadastre.get(key) || []).sort());
            }
            for (let producerIndex = 0; producerIndex < 7; producerIndex += 1) {
                const key = `proposal-${producerIndex}`;
                expect(ids(fabric.producedBy(key)))
                    .toEqual(Array.from(reference.byProducer.get(key) || []).sort());
            }
        }
    });

    it('reports normalization and index work proportional to the changed batch, not fabric size', async () => {
        const report = [];
        for (const size of [1000, 4000, 8000]) {
            const fabric = createLiveParcelFabric();
            await commit(fabric, mutation => mutation.seedCadastre(
                Array.from({ length: size }, (_, index) => parcel(`HR-${index}`, index % 100, Math.floor(index / 100)))
            ), { kind: 'ground-load' });
            const before = fabric.diagnostics();
            const sourceId = `HR-${Math.floor(size / 2)}`;
            const sourceColumn = Math.floor(size / 2) % 100;
            const sourceRow = Math.floor(Math.floor(size / 2) / 100);
            await commit(fabric, mutation => mutation.upsertFeatures([
                parcel(`${sourceId}#diagnostic`, sourceColumn, sourceRow, {
                    cadastreParcelIds: [sourceId],
                    producedByProposalId: 'diagnostic-proposal'
                })
            ]), { kind: 'diagnostic' });
            const after = fabric.diagnostics();
            report.push({
                size,
                normalized: after.normalized - before.normalized,
                indexUpdates: after.indexUpdates - before.indexUpdates
            });
        }

        expect(report).toEqual([
            { size: 1000, normalized: 1, indexUpdates: 2 },
            { size: 4000, normalized: 1, indexUpdates: 2 },
            { size: 8000, normalized: 1, indexUpdates: 2 }
        ]);
    }, 30000);
});
