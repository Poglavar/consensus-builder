import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { districtRecord } from '../planning/atlas-districts.js';
import { readAtlasArchive } from '../planning/atlas-archive.js';
import { readAtlasWorkbook } from '../planning/atlas-workbook.js';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { parseAtlasSources, createAtlasUrlProvider } from '../planning/atlas-url-sources.js';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';
import { resolveParcelSourceDescriptor } from '../parcels/sources.js';

const geometry = { type: 'Polygon', coordinates: [[[-97,32],[-96.999,32],[-96.999,32.001],[-97,32.001],[-97,32]]] };
const feature = properties => ({ type: 'Feature', geometry, properties });
const collection = features => ({ type: 'FeatureCollection', features });
const metadata = { id: 'atlas-public', city: 'arlington', label: 'Public Atlas', edition: '2024', product: 'districts',
    url: 'https://example.org/atlas.zip', parcelSourceId: 'arlington-tax-parcels' };
const district = { id: 12, jurisdiction: 'Example', abbrvname: 'R1', name: 'Residential', family1_treatment: 'allowed',
    family1_maxheightft: '35', family1_frontsetbackft: '10', family1_sidesetbackft: '5', family1_rearsetbackft: '5', family1_minlotacres: '.1' };
const query = { city: 'arlington', source: metadata.id, bbox: [-97,32,-96.999,32.001], limit: 10 };
const zip = files => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));

describe('Public Atlas rule observations', () => {
    it('retains literal evidence separately from Slices methods and rejects conditions, buckets and unknown units', () => {
        const record = districtRecord({ ...district, family1_frontsetbackft: '10 + 1 per foot of height',
            family1_sidesetbackft: '5', family1_sidesetbackft_units: 'alternatives', family1_rearsetbackft: null });
        expect(record.numericEvidence.family1_maxheightft).toMatchObject({ status: 'literal', value: 35 });
        expect(record.numericEvidence.family1_frontsetbackft.status).toBe('unparsed_expression');
        expect(record.numericEvidence.family1_sidesetbackft).not.toHaveProperty('value');
        expect(record.numericEvidence.family1_rearsetbackft).not.toHaveProperty('value');
        const worksheet = districtRecord({ Jurisdiction: 'Example', 'Full District Name': 'R1', '1-Family Treatment': 'Public Hearing',
            '1-Family Max. Height': '40', '1-Family Max. Height Units': 'Feet',
            '1-Family Min. Lot': '4356', '1-Family Min. Lot Units': 'Square Feet',
            '1-Family Front Setback': '10', '1-Family Front Setback Units': 'constructor', '1MH': 'B' });
        expect(worksheet.values).toMatchObject({ family1_treatment: 'hearing', family1_maxheightft: 40 });
        expect(worksheet.values.family1_minlotacres).toBeCloseTo(0.1);
        expect(worksheet.numericEvidence.family1_frontsetbackft.status).toBe('unsupported_unit');
        expect(districtRecord({ T: 'Example', Z: 'R1', '1MH': 'B' }).numericEvidence.family1_maxheightft.status).toBe('absent');
    });
    it('reads the NH headings without combining its separate four-family and five-plus categories', () => {
        const record = districtRecord({ Jurisdiction: 'Concord', 'Full District Name': 'R1', '1-Family Treatment': 'Allowed/Conditional',
            '1-Family Max Height (# of feet)': 35, '1-Family Min Lot (ACRES)': 1,
            '4-Family Treatment': 'Allowed/Conditional', '5+-Family Treatment': 'Prohibited' });
        expect(record.values).toMatchObject({ family1_maxheightft: 35, family1_minlotacres: 1, family4_treatment: null });
    });
    it('uses literal dimensions in parcel envelopes while preserving raw district evidence', async () => {
        const source = createAtlasProvider(collection([feature(district)]), metadata);
        const answer = await loadParcelEnvelopes(query, { sources: [source], parcelProvider: () => ({ queryBounds: async () => ({ complete: true,
            features: [{ ...feature({ parcelNumber: '1' }), id: 'parcel-1' }] }) }) });
        expect(answer.items).toHaveLength(1);
        expect(answer.items[0].volumes[0].topM).toBeCloseTo(10.668);
        expect(answer.items[0].configurations[0].lotArea.status).toBe('pass');
        const [record] = await source.record(null, { recordId: '12' });
        expect(record.sourceEvidence).toMatchObject({ product: 'districts', properties: district,
            numericEvidence: { family1_maxheightft: { status: 'literal', value: 35 } } });
        expect(record.constraints).toContainEqual(expect.objectContaining({ quantity: 'height', evidence: 'literal' }));
    });
    it('withholds envelopes where an unresolved overlay intersects the parcel', async () => {
        const source = createAtlasProvider(collection([feature(district), feature({ ...district, id: 13, overlay: true, family1_treatment: 'overlay' })]), metadata);
        const answer = await loadParcelEnvelopes(query, { sources: [source], parcelProvider: () => ({ queryBounds: async () => ({ complete: true,
            features: [{ ...feature({ parcelNumber: '1' }), id: 'parcel-1' }] }) }) });
        expect(answer.items).toEqual([]);
        expect(answer.unavailable).toEqual([{ parcelId: 'parcel-1', reason: 'study-multiple-zoning-areas' }]);
    });
    it('keeps unmapped source records inspectable without inventing map geometry', async () => {
        const source = createAtlasProvider(collection([{ ...feature(district), geometry: null }]), metadata);
        expect((await source.query(null, query)).items).toEqual([]);
        expect((await source.record(null, { recordId: '12' }))[0]).toMatchObject({ site: null, areas: [], sourceEvidence: { properties: district } });
    });
    it('preserves signed native IDs and unidentified source polygons as unresolved records', async () => {
        const source = createAtlasProvider(collection([feature({ ...district, id: -4294967295 }),
            feature({ T: 'Example', Z: null, '1F': null })]), metadata);
        const answer = await source.query(null, query);
        expect(answer.items).toHaveLength(2);
        expect(answer.items[0].source.recordId).toBe('-4294967295');
        expect(answer.items[1]).toMatchObject({ constraints: [], assessment: { status: null }, sourceEvidence: { properties: { Z: null } } });
    });
});

describe('Public Atlas archives', () => {
    const archive = { geometry: 'zones.geojson', rules: 'rules.csv', join: [
        { geometry: 'T', rule: 'Jurisdiction' }, { geometry: 'Z', rule: 'Full District Name', stripPrefix: 'Abbreviated District Name' }] };
    it('joins by verified names, preserves unjoined geometry and never first-wins ambiguous rules', async () => {
        const geo = collection([feature({ T: 'Example', Z: 'Residential' }), feature({ T: 'Example', Z: 'Ambiguous' }), feature({ T: 'Example', Z: 'Unknown' })]);
        const csv = 'I,II,III,IV\nJurisdiction,Abbreviated District Name,Full District Name,1-Family Max. Height (# of feet)\n'
            + 'Example,R1,R1 Residential,35\nExample,A,Ambiguous,30\nExample,B,Ambiguous,40\n';
        const result = await readAtlasArchive(zip({ 'zones.geojson': JSON.stringify(geo), 'rules.csv': csv, 'ignored.txt': 'ignored' }), archive);
        expect(result.features.map(f => f.atlasJoin.status)).toEqual(['matched', 'ambiguous', 'unmatched']);
        expect(result.features[0].properties['1-Family Max. Height (# of feet)']).toBe('35');
        expect(result.features[0].atlasGeometryProperties).toEqual(geo.features[0].properties);
        expect(result.features[1].properties).toEqual(geo.features[1].properties);
        expect(result.features.map(f => f.geometry)).toEqual(geo.features.map(f => f.geometry));
    });
    it('streams selected jurisdictions and retains original feature ordinals', async () => {
        const bytes = zip({ 'zones.geojson': JSON.stringify(collection([feature({ ...district, jurisdiction: 'Other' }), feature(district)])) });
        const result = await readAtlasArchive(bytes, { geometry: 'zones.geojson', jurisdiction: { field: 'jurisdiction', values: ['Example'] } });
        expect(result.features).toHaveLength(1);
        expect(result.features[0].atlasFeatureIndex).toBe(1);
        await expect(readAtlasArchive(bytes, { geometry: 'missing.geojson' })).rejects.toThrow();
    });
    it('applies explicit duplicate-column names and exact repeated-header trimming while retaining raw cells', async () => {
        const columns = ['Jurisdiction', 'Jurisdiction', 'Full District Name', '1-Family Max. Height (# of feet)'];
        const values = ['Example', '', 'Residential', '35', ...columns];
        const bytes = zip({ 'zones.geojson': JSON.stringify(collection([feature({ T: 'Example', Z: 'Residential' })])),
            'rules.csv': `${columns.join(',')}\n${values.join(',')}\n` });
        const result = await readAtlasArchive(bytes, { ...archive, repeatedHeaderTail: true, columnNames: { 1: 'Secondary Jurisdiction' } });
        expect(result.features[0]).toMatchObject({ properties: { Jurisdiction: 'Example', 'Secondary Jurisdiction': '',
            '1-Family Max. Height (# of feet)': '35' }, atlasRuleRow: { columns, values, repeatedHeaderTailColumns: 4 } });
        await expect(readAtlasArchive(bytes, archive)).rejects.toThrow();
    });
    it('does not turn a joined overlay or conflicting geometry treatment into a base-district envelope', async () => {
        const bytes = zip({ 'zones.geojson': JSON.stringify(collection([feature({ T: 'Example', Z: 'Residential', O: 'Yes', '1F': 'P' })])),
            'rules.csv': 'Jurisdiction,Full District Name,Overlay,1-Family Treatment,1-Family Max. Height (# of feet)\nExample,Residential,No,Allowed/Conditional,35\n' });
        const joined = await readAtlasArchive(bytes, archive);
        const source = createAtlasProvider(joined, metadata);
        const record = (await source.query(null, query)).items[0];
        expect(record).toMatchObject({ assessment: { status: null, reason: 'district-evidence-conflict' },
            sourceEvidence: { applicability: { overlay: true, conflicts: [
                { field: 'overlay', rules: false, geometry: true }, { field: 'family1_treatment', rules: 'allowed', geometry: 'prohibited' }] } } });
        const answer = await loadParcelEnvelopes(query, { sources: [source], parcelProvider: () => ({ queryBounds: async () => ({ complete: true,
            features: [{ ...feature({ parcelNumber: '1' }), id: 'parcel-1' }] }) }) });
        expect(answer.items).toEqual([]);
    });
    it('shares a regional download between city entries and permits more than twenty unique configurations', async () => {
        const data = zip({ 'zones.geojson': JSON.stringify(collection([feature(district)])) });
        const fetchImpl = vi.fn(async () => new Response(data));
        const configs = Array.from({ length: 25 }, (_, i) => ({ ...metadata, id: `city-${i}`, city: `city_${i}`, archive: { geometry: 'zones.geojson' } }));
        expect(parseAtlasSources(JSON.stringify(configs))).toHaveLength(25);
        const sources = configs.slice(0, 2).map(config => createAtlasUrlProvider(config, { fetchImpl }));
        const results = await Promise.all(sources.map(source => source.query(null, query)));
        expect(results.map(result => result.items.length)).toEqual([1, 1]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        for (const bad of [{ geometry: '../zones.geojson' }, { geometry: 'zones.geojson', rules: 'rules.csv' },
            { geometry: 'zones.geojson', rules: 5, sheets: ['Rules'] },
            { geometry: 'zones.geojson', jurisdiction: { field: 'jurisdiction', values: [] } }]) {
            expect(() => parseAtlasSources(JSON.stringify([{ ...metadata, archive: bad }]))).toThrow();
        }
    });
    it('reads named worksheet values, inline strings and expressions without evaluating formulas', () => {
        const workbook = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Rules" r:id="r1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/sharedStrings.xml': '<sst><si><t>Jurisdiction</t></si><si><t>Example</t></si></sst>',
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Height</t></is></c></row>'
                + '<row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>35</v></c><c r="C2"><f>30+5</f><v>35</v></c></row></sheetData></worksheet>' });
        expect(readAtlasWorkbook(workbook, ['Rules'])).toEqual([[['Jurisdiction', 'Height'], ['Example', '35', '=30+5']]]);
        expect(() => readAtlasWorkbook(workbook, ['Missing'])).toThrow('Unknown Atlas worksheet');
    });
    it('retains date cell types and raw serials instead of using them as zoning dimensions', () => {
        const workbook = zip({ 'xl/workbook.xml': '<workbook><workbookPr date1904="1"/><sheets><sheet name="Rules" r:id="r1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="m/d"/><numFmt numFmtId="165" formatCode="0 &quot;ft&quot;"/></numFmts>'
                + '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>',
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" s="1"><v>45056</v></c><c r="B1" s="2"><v>45219</v></c>'
                + '<c r="C1" s="3"><v>35</v></c><c r="D1" t="d"><v>2023-10-19</v></c>'
                + '<c r="E1"><f t="shared" si="0"/><v>35</v></c></row></sheetData></worksheet>' });
        const [[cells]] = readAtlasWorkbook(workbook, ['Rules']);
        expect(cells).toEqual([{ type: 'spreadsheet-date', value: '45056', numberFormat: 'builtin:14', dateSystem: '1904' },
            { type: 'spreadsheet-date', value: '45219', numberFormat: 'm/d', dateSystem: '1904' }, '35',
            { type: 'spreadsheet-date', value: '2023-10-19', numberFormat: 'ISO 8601', dateSystem: '1904' }, '=']);
        const record = districtRecord({ Jurisdiction: 'Example', 'Full District Name': 'R1',
            'Abbreviated District Name': cells[0],
            '1-Family Front Setback (# of feet)': cells[0], '1-Family Max. Height (# of feet)': cells[2],
            '1-Family Side Setback (# of feet)': cells[4] }, 0);
        expect(record.numericEvidence.family1_frontsetbackft.status).toBe('invalid');
        expect(record.values.family1_frontsetbackft).toBeUndefined();
        expect(record.values.family1_sidesetbackft).toBeUndefined();
        expect(record.values.family1_maxheightft).toBe(35);
        expect(record.code).toBe('R1');
    });
    it('bounds sparse worksheet rows before materializing a large table', () => {
        const workbook = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Rules" r:id="r1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="ALL1"><v>35</v></c></row></sheetData></worksheet>' });
        expect(() => readAtlasWorkbook(workbook, ['Rules'])).toThrow('Atlas worksheet exceeds column limit');
    });
});

it('enables the public Atlas cities with explicitly selected planning and parcel sources', () => {
    const configured = JSON.parse(readFileSync(new URL('../../frontend/data/planning-sources.json', import.meta.url), 'utf8'));
    const sources = parseAtlasSources(JSON.stringify(configured.sources));
    const context = { URLSearchParams, console }; context.window = context;
    runInContext(readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8'), createContext(context));
    expect(sources.map(source => source.city).sort()).toEqual(['arlington', 'arlington_va', 'concord', 'dale_city', 'fall_river',
        'helena', 'honolulu', 'lawrence', 'lindberg', 'lowell', 'lynn', 'manassas_park', 'nashville', 'norfolk', 'south_central',
        'sugarland_run', 'worcester'].sort());
    for (const source of sources) {
        const city = context.CityConfigManager.getCityConfig(source.city);
        expect(city.planning.sourceIds).toEqual([source.id]);
        expect(source.parcelSourceId).toBe(city.parcels.sourceId || city.parcels.liveSource?.sourceId);
        expect(resolveParcelSourceDescriptor(source.parcelSourceId)).toBeTruthy();
    }
});
