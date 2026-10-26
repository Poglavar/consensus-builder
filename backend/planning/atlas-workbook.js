// Read the value cells in named public Atlas worksheets. Formatting, drawings and macros
// are irrelevant; formulas remain expressions instead of becoming claimed literal rules.
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
    const files = selectedFiles(new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']));
    const sheets = new Map(), relationships = new Map();
    xml(files['xl/workbook.xml'], { opentag: tag => { if (tag.name === 'sheet') sheets.set(tag.attributes.name, tag.attributes['r:id']); } });
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
                    cell = { index, type: tag.attributes.t, value: '', formula: '' };
                }
                if (cell && ['v', 't', 'f'].includes(tag.name)) capture = tag.name;
            },
            text: text => { if (capture) {
                cellChars += text.length;
                const field = capture === 'f' ? 'formula' : 'value'; cell[field] += text;
                if (cellChars > 16 * 1024 * 1024 || cell[field].length > 65536) throw new Error('Atlas workbook cell text exceeds limits');
            } },
            closetag: tag => {
                if (['v', 't', 'f'].includes(tag.name)) capture = null;
                if (tag.name === 'c') {
                    row[cell.index] = cell.formula ? `=${cell.formula}` : cell.type === 's' ? strings[Number(cell.value)] : cell.value;
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
