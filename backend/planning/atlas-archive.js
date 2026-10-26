// Select only configured members; archives are never extracted onto the filesystem.
import { unzipSync, strFromU8, Unzip, UnzipInflate } from 'fflate';
import { parseCsvRows } from '../parcels/csv-geojson-parcel-reader.js';
import { readGeojsonFeatureStream } from '../parcels/geojson-stream-reader.js';
import { readAtlasWorkbook } from './atlas-workbook.js';

const MAX_MEMBER_BYTES = 128 * 1024 * 1024;
const normal = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
async function readGeography(bytes, archive) {
    let queue = [], found = false, complete = false, total = 0;
    const unzip = new Unzip(file => {
        if (file.name !== archive.geometry) return;
        if (found) throw new Error('Duplicate Atlas geography member');
        found = true;
        file.ondata = (error, data, final) => {
            if (error) throw error;
            total += data.length;
            if (total > 768 * 1024 * 1024) throw new Error('Atlas geography exceeds size limit');
            queue.push(data); complete = final;
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    async function* chunks() {
        for (let offset = 0; offset < bytes.length; offset += 16384) {
            unzip.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length);
            for (const chunk of queue) yield chunk;
            queue = [];
        }
        if (!found || !complete) throw new Error('Atlas geography member is missing or incomplete');
    }
    const features = []; let retained = 0;
    const { metadata } = await readGeojsonFeatureStream(chunks(), { maxRecordBytes: 32 * 1024 * 1024,
        onFeature(feature, index) {
            if (index >= 50000) throw new Error('Atlas geography exceeds feature limit');
            if (archive.jurisdiction && !archive.jurisdiction.values.some(value =>
                normal(feature.properties?.[archive.jurisdiction.field]) === normal(value))) return;
            retained += Buffer.byteLength(JSON.stringify(feature));
            if (retained > MAX_MEMBER_BYTES) throw new Error('Selected Atlas geography exceeds memory limit');
            features.push({ ...feature, atlasFeatureIndex: index });
        } });
    return { ...metadata, features };
}

export async function readAtlasArchive(bytes, archive) {
    const collection = await readGeography(bytes, archive);
    if (!archive.rules) return collection;
    const seen = new Set();
    let total = 0;
    const files = unzipSync(bytes, { filter(member) {
        if (member.name !== archive.rules) return false;
        total += member.originalSize;
        if (seen.has(member.name) || total > MAX_MEMBER_BYTES) throw new Error('Atlas archive members are ambiguous or too large');
        seen.add(member.name);
        return true;
    } });
    if (!files[archive.rules] || Object.values(files).reduce((sum, data) => sum + data.length, 0) > MAX_MEMBER_BYTES) {
        throw new Error('Atlas archive member missing or too large');
    }
    const tables = archive.sheets ? readAtlasWorkbook(files[archive.rules], archive.sheets)
        : [parseCsvRows(strFromU8(files[archive.rules]))];
    const index = new Map();
    for (const rows of tables) {
      const headerIndex = rows.findIndex(row => archive.join.every(({ rule }) => row.map(value => value.trim()).includes(rule)));
      if (headerIndex < 0) throw new Error('Atlas rule table has no matching header');
      const originalHeader = rows[headerIndex].map(value => value.trim());
      if (Object.keys(archive.columnNames || {}).some(key => Number(key) >= originalHeader.length)) throw new Error('Atlas column override is outside the table');
      const header = originalHeader.map((value, i) => archive.columnNames?.[i] ?? value);
      const filterRule = archive.jurisdiction && archive.join.find(pair => pair.geometry === archive.jurisdiction.field)?.rule;
      for (let row of rows.slice(headerIndex + 1)) {
        const originalRow = row;
        if (row.every(value => !value.trim())) continue;
        // Filtering is explicit and uses a configured join column; it never shifts malformed rows.
        if (filterRule && !archive.jurisdiction.values.some(value => normal(row[header.indexOf(filterRule)]) === normal(value))) continue;
        if (archive.repeatedHeaderTail) {
            const repeated = [originalHeader, originalHeader.slice(1)].find(tail => row.length > tail.length
                && tail.every((value, i) => row[row.length - tail.length + i]?.trim() === value));
            if (repeated) row = row.slice(0, row.length - repeated.length);
        }
        if (row.length > header.length && row.slice(header.length).some(value => value.trim())) throw new Error('Invalid Atlas rule table row');
        const record = Object.create(null);
        header.forEach((key, i) => {
            if (!key) return;
            const value = row[i] ?? '';
            if (Object.hasOwn(record, key) && record[key] !== value) throw new Error('Atlas rule table has conflicting duplicate columns');
            record[key] = value;
        });
        const key = JSON.stringify(archive.join.map(({ rule, stripPrefix }) => {
            const value = normal(record[rule]), prefix = stripPrefix ? normal(record[stripPrefix]) : '';
            return prefix && value.startsWith(`${prefix} `) ? value.slice(prefix.length + 1) : value;
        }));
        const matches = index.get(key) || []; matches.push({ record, row: { columns: originalHeader, values: originalRow,
            ...(archive.columnNames ? { columnNames: archive.columnNames } : {}),
            ...(row !== originalRow ? { repeatedHeaderTailColumns: originalRow.length - row.length } : {}) } }); index.set(key, matches);
      }
    }
    return { ...collection, features: collection.features.map(feature => {
        const key = JSON.stringify(archive.join.map(({ geometry }) => normal(feature.properties?.[geometry])));
        const matches = index.get(key) || [], matched = matches.length === 1;
        return { ...feature, properties: matched ? matches[0].record : feature.properties,
            ...(matched ? { atlasRuleRow: matches[0].row } : {}),
            atlasGeometryProperties: feature.properties,
            atlasJoin: { status: matched ? 'matched' : matches.length ? 'ambiguous' : 'unmatched',
                geometryMember: archive.geometry, rulesMember: archive.rules, fields: archive.join } };
    }) };
}
