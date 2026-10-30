// CityGML building reader for the backend: streams CityGML text through saxes into the shared
// collector of frontend/js/city-model-reader.js, so the browser (DOMParser) and the server read
// buildings by one rule. buildingRecord turns a building into the 3D view's mesh record.
// No Node imports, so the browser's adapter worker bundles it too (city-model-url-source.js).
import { SaxesParser } from 'saxes';
import CityModelReader from '../../frontend/js/city-model-reader.js';

const local = name => name.slice(name.indexOf(':') + 1);

// CityGML text → the shared building shape, in the file's own coordinates.
export function parseCityGml(text) {
    const parser = new SaxesParser({ xmlns: false });
    const collector = CityModelReader.createCityGmlCollector();
    parser.on('opentag', tag => collector.open(local(tag.name), name => tag.attributes[name] ?? null));
    parser.on('text', value => collector.text(value));
    parser.on('cdata', value => collector.text(value));
    parser.on('closetag', tag => collector.close(local(tag.name)));
    parser.write(text).close();
    return collector.buildings();
}

// A CityGML stream (chunks of text, e.g. a file too large for one string) → each building to onBuilding
// as it closes. write(chunk) as text arrives, end() at the end.
export function createCityGmlStream(onBuilding) {
    const parser = new SaxesParser({ xmlns: false });
    const collector = CityModelReader.createCityGmlCollector({ onBuilding });
    parser.on('opentag', tag => collector.open(local(tag.name), name => tag.attributes[name] ?? null));
    parser.on('text', value => collector.text(value));
    parser.on('cdata', value => collector.text(value));
    parser.on('closetag', tag => collector.close(local(tag.name)));
    return { write: chunk => { parser.write(chunk); }, end: () => { parser.close(); } };
}

export const { buildingRecord } = CityModelReader;
