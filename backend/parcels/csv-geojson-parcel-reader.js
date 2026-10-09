import { validateGeometry } from './source-contract.js';

export const CSV_GEOJSON_FIELDS = Object.freeze([
    'MSLINK', 'SECCION', 'MANZANA', 'GRAFICO', 'SD', 'SP', 'PASILLO', 'CARPETA', 'GEOJSON'
]);

function parseRows(text) {
    if (typeof text !== 'string' || !text.length) throw new Error('Empty CSV snapshot.');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], field = '', quoted = false, closedQuote = false;
    const endField = () => { row.push(field); field = ''; closedQuote = false; };
    const endRow = () => { endField(); rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { quoted = false; closedQuote = true; }
            } else field += char;
            continue;
        }
        if (closedQuote) {
            if (char === ',') endField();
            else if (char === '\n') endRow();
            else if (char === '\r' && text[i + 1] === '\n') { endRow(); i++; }
            else throw new Error('Invalid CSV quoting.');
            continue;
        }
        if (char === '"') {
            if (field.length) throw new Error('Invalid CSV quoting.');
            quoted = true;
        } else if (char === ',') endField();
        else if (char === '\n') endRow();
        else if (char === '\r' && text[i + 1] === '\n') { endRow(); i++; }
        else if (char === '\r') throw new Error('Invalid CSV line ending.');
        else field += char;
    }
    if (quoted) throw new Error('Unclosed CSV field.');
    if (closedQuote || field.length || row.length) endRow();
    return rows;
}

export function readCsvGeojsonParcelSnapshot(text, { csvFields, csvGeometryField, idFields, outFields }) {
    if (!Array.isArray(csvFields) || csvFields.length !== CSV_GEOJSON_FIELDS.length
        || csvFields.some((field, index) => field !== CSV_GEOJSON_FIELDS[index])
        || csvGeometryField !== 'GEOJSON'
        || !Array.isArray(idFields) || !idFields.length || !Array.isArray(outFields)
        || new Set(idFields).size !== idFields.length || new Set(outFields).size !== outFields.length
        || idFields.some(field => field === csvGeometryField || !outFields.includes(field)
            || !csvFields.includes(field))
        || outFields.some(field => field === csvGeometryField || !csvFields.includes(field))) {
        throw new Error('Invalid CSV GeoJSON snapshot descriptor.');
    }
    const rows = parseRows(text);
    const header = rows.shift();
    if (!header || header.length !== csvFields.length || header.some((field, index) => field !== csvFields[index])) {
        throw new Error('CSV parcel snapshot schema does not match its verified header.');
    }
    const geometryIndex = csvFields.indexOf(csvGeometryField);
    const features = rows.map(values => {
        if (values.length !== header.length || values[geometryIndex] === '') throw new Error('Invalid CSV parcel row.');
        let embedded;
        try { embedded = JSON.parse(values[geometryIndex]); }
        catch (_) { throw new Error('Invalid embedded GeoJSON feature.'); }
        if (embedded?.type !== 'Feature' || !validateGeometry(embedded.geometry)) {
            throw new Error('Unsupported embedded GeoJSON geometry.');
        }
        const properties = Object.fromEntries(outFields.map(field => [field, values[csvFields.indexOf(field)]]));
        return { type: 'Feature', geometry: embedded.geometry, properties };
    });
    return { type: 'FeatureCollection', features };
}
