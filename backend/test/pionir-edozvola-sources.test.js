import { describe, expect, it, vi } from 'vitest';
import { CASES, fetchCase } from '../scripts/fetch-pionir-edozvola-sources.mjs';

function response(features) {
    return {
        ok: true,
        json: async () => ({ type: 'FeatureCollection', features })
    };
}

describe('Pionir eDozvola source archive', () => {
    it('keeps configured case ids unique within each project', () => {
        const keys = CASES.map(entry => `${entry.project}/${entry.caseId}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('archives the complete legacy Borongaj record alongside its migrated case', () => {
        const borongaj = CASES.filter(entry => entry.project === 'borongajska-caviceva');
        expect(borongaj.map(entry => entry.caseId)).toContain('A20220613-2838627-V020101');
        expect(borongaj.map(entry => entry.caseId)).toContain('P20221230-1037184-Z02');
        expect(borongaj.find(entry => entry.caseId === 'A20220613-2838627-V020101')?.expectedMinimum)
            .toEqual({ eDozvola_building_polygon: 11 });
    });

    it('keeps both labelled and latest Savica location-permit states', () => {
        const savica = CASES.filter(entry => entry.project === 'savica-f1-f3');
        expect(savica.map(entry => entry.caseId)).toEqual([
            'A20211027-2824386-V020101',
            'P20230927-1364307-Z06',
            'A20220330-2833642-V010101',
            'P20240131-1445130-Z01'
        ]);
        expect(savica.find(entry => entry.caseId === 'A20211027-2824386-V020101')?.expectedMinimum)
            .toEqual({ eDozvola_building_polygon: 4 });
    });

    it('normalizes public WFS features and records their source layer', async () => {
        const config = {
            project: 'test',
            caseId: 'P-TEST',
            output: 'test.geojson',
            title: 'Test case',
            note: 'Test note',
            expectedMinimum: { eDozvola_building_polygon: 1 }
        };
        const polygon = {
            type: 'Feature',
            id: 'eDozvola_building_polygon.1',
            geometry: {
                type: 'Polygon',
                coordinates: [[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.8]]]
            },
            properties: {
                predmet_web_id: 'P-TEST',
                predmet_klasa: 'TEST',
                predmet_vrsta: 'Građevinska dozvola'
            }
        };
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
            const typeName = new URL(url).searchParams.get('typeNames');
            return response(typeName.endsWith('eDozvola_building_polygon') ? [polygon] : []);
        });
        try {
            const collection = await fetchCase(config);
            expect(collection.edozvola.schema).toBe('consensus-builder.edozvola-source.v1');
            expect(collection.edozvola.caseId).toBe('P-TEST');
            expect(collection.features).toHaveLength(1);
            expect(collection.features[0].properties['edozvola:sourceLayer']).toBe('eDozvola_building_polygon');
            expect(collection.features[0].properties['edozvola:geometryAreaM2']).toBeGreaterThan(0);
        } finally {
            fetchMock.mockRestore();
        }
    });
});
