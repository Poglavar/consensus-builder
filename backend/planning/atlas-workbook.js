// Read the value cells in named public Atlas worksheets. Formulas and date-formatted
// numbers retain their source type instead of becoming claimed literal zoning dimensions.
import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';

function xml(bytes, handlers) {
    if (!bytes) throw new Error('Missing Atlas workbook XML');
    const parser = new SaxesParser();
    parser.on('doctype', () => { throw new Error('Atlas workbook DTD is unsupported'); });
    let depth = 0;
    parser.on('opentag', tag => { if (++depth > 128) throw new Error('Atlas workbook XML is too deeply nested'); handlers.opentag?.(tag); });
    parser.on('closetag', tag => { handlers.closetag?.(tag); depth--; });
    if (handlers.text) parser.on('text', handlers.text);
    parser.write(strFromU8(bytes)).close();
}
function dateFormats(bytes) {
    const formats = new Map(), styles = []; let inCells = false;
    if (!bytes) return styles;
    xml(bytes, { opentag: tag => {
        if (tag.name === 'numFmt') {
            if (formats.size >= 10000 || (tag.attributes.formatCode || '').length > 2048) throw new Error('Atlas workbook formats exceed limits');
            formats.set(Number(tag.attributes.numFmtId), tag.attributes.formatCode);
        }
        if (tag.name === 'cellXfs') inCells = true;
        if (tag.name === 'xf' && inCells) {
            if (styles.length >= 10000) throw new Error('Atlas workbook styles exceed limits');
            styles.push(Number(tag.attributes.numFmtId || 0));
        }
    }, closetag: tag => { if (tag.name === 'cellXfs') inCells = false; } });
    return styles.map(id => {
        const code = formats.get(id);
        const tokens = (code || '').replace(/"[^"]*"|\\.|_.|\*./g, '');
        const date = id >= 14 && id <= 22 || id >= 27 && id <= 36 || id >= 45 && id <= 47 || id >= 50 && id <= 58
            || /\[[hms]+\]/i.test(tokens) || /[ymdhs]/i.test(tokens.replace(/\[[^\]]*\]/g, ''));
        return date ? code || `builtin:${id}` : null;
    });
}
export function readAtlasWorkbook(bytes, sheetNames) {
    let total = 0;
    function selectedFiles(names) {
        const seen = new Set();
        const result = unzipSync(bytes, { filter(file) {
            if (!names.has(file.name)) return false;
            if (seen.has(file.name) || (total += file.originalSize) > 64 * 1024 * 1024) throw new Error('Atlas workbook exceeds size limit or has duplicate members');
            seen.add(file.name); return true;
        } });
        if (Object.values(result).reduce((sum, data) => sum + data.length, 0) > 64 * 1024 * 1024) throw new Error('Atlas workbook exceeds size limit');
        return result;
    }
    const files = selectedFiles(new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml']));
    const sheets = new Map(), relationships = new Map();
    let dateSystem = '1900';
    xml(files['xl/workbook.xml'], { opentag: tag => {
        if (tag.name === 'sheet') sheets.set(tag.attributes.name, tag.attributes['r:id']);
        if (tag.name === 'workbookPr' && ['1', 'true'].includes(tag.attributes.date1904)) dateSystem = '1904';
    } });
    const formats = dateFormats(files['xl/styles.xml']);
    xml(files['xl/_rels/workbook.xml.rels'], { opentag: tag => {
        if (tag.name === 'Relationship' && tag.attributes.TargetMode !== 'External') {
            relationships.set(tag.attributes.Id, tag.attributes.Target.replace(/^\/?xl\//, ''));
        }
    } });
    const targets = sheetNames.map(name => {
        const target = relationships.get(sheets.get(name));
        if (!target || !/^worksheets\/sheet\d+\.xml$/.test(target)) throw new Error('Unknown Atlas worksheet');
        return `xl/${target}`;
    });
    Object.assign(files, selectedFiles(new Set(targets)));
    const strings = []; let inString = false, inText = false, value = '', stringChars = 0, cellChars = 0, rowSlots = 0, rowCount = 0;
    if (files['xl/sharedStrings.xml']) xml(files['xl/sharedStrings.xml'], {
        opentag: tag => { if (tag.name === 'si') { inString = true; value = ''; } if (tag.name === 't') inText = true; },
        text: text => { if (inString && inText) {
            stringChars += text.length; value += text;
            if (stringChars > 8 * 1024 * 1024 || value.length > 65536) throw new Error('Atlas workbook strings exceed limits');
        } },
        closetag: tag => { if (tag.name === 't') inText = false; if (tag.name === 'si') {
            if (strings.length >= 100000) throw new Error('Atlas workbook has too many strings');
            strings.push(value); inString = false;
        } }
    });
    return targets.map(target => {
        const rows = []; let row, cell, capture = null;
        xml(files[target], {
            opentag: tag => {
                if (tag.name === 'row') { if (++rowCount > 20000) throw new Error('Atlas workbook has too many rows'); row = []; }
                if (tag.name === 'c') {
                    const reference = /^([A-Z]+)\d+$/.exec(tag.attributes.r || '');
                    if (!reference || !row) throw new Error('Invalid Atlas worksheet cell');
                    const index = [...reference[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
                    if (index > 255) throw new Error('Atlas worksheet exceeds column limit');
                    if (Object.hasOwn(row, index)) throw new Error('Duplicate Atlas worksheet cell');
                    cell = { index, type: tag.attributes.t, format: formats[Number(tag.attributes.s || 0)], value: '', formula: '', hasFormula: false };
                }
                if (cell && ['v', 't', 'f'].includes(tag.name)) capture = tag.name;
                if (cell && tag.name === 'f') cell.hasFormula = true;
            },
            text: text => { if (capture) {
                cellChars += text.length;
                const field = capture === 'f' ? 'formula' : 'value'; cell[field] += text;
                if (cellChars > 16 * 1024 * 1024 || cell[field].length > 65536) throw new Error('Atlas workbook cell text exceeds limits');
            } },
            closetag: tag => {
                if (['v', 't', 'f'].includes(tag.name)) capture = null;
                if (tag.name === 'c') {
                    row[cell.index] = cell.hasFormula ? `=${cell.formula}` : cell.type === 's' ? strings[Number(cell.value)]
                        : cell.type === 'd' || (!cell.type || cell.type === 'n') && cell.format && cell.value
                            ? { type: 'spreadsheet-date', value: cell.value, numberFormat: cell.format || 'ISO 8601', dateSystem }
                            : cell.value;
                    if (row[cell.index] === undefined) throw new Error('Invalid Atlas shared string');
                    cell = null;
                }
                if (tag.name === 'row') {
                    rowSlots += row.length;
                    if (rowSlots > 1000000) throw new Error('Atlas workbook cells exceed memory limit');
                    rows.push(Array.from(row, value => value ?? '')); row = null;
                }
            }
        });
        return rows;
    });
}
