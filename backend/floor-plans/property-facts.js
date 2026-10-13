const YEAR = /(?:19|20)\d{2}/g;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const valuesFor = (text, pattern) => [...text.matchAll(pattern)].map(match => ({ value: match[1], quote: clean(match[0]).slice(0, 180) }));
// Keep a fact only when every source-backed candidate for that field agrees.
const choose = entries => {
    const values = [...new Set(entries.map(entry => entry.value))];
    return values.length === 1 ? { value: values[0], quote: entries.find(entry => entry.value === values[0]).quote } : { value: null, quote: null };
};

function recordYear(value) {
    const match = String(value ?? '').match(YEAR);
    return match ? Number(match[0]) : null;
}

function inferType(title, text, sourceType) {
    const t = clean(title).toLocaleLowerCase('hr');
    if (sourceType === 'architecture-project') {
        if (/\b(hotel|ured|office|poslovn\w*|trgov\w*|muzej|galerij\w*|izložb\w*|izlozb\w*)\b/.test(t)) return 'commercial';
        if (/\b(stamben\w*|residential|housing|zgrada|building|dom)\b/.test(t)) return 'residential';
        if (/\b(kuća|kuca|house|villa|vila)\b/.test(t)) return 'house';
        return 'unknown';
    }
    if (/\b(stan|apartman|apartment|flat)\b/.test(t)) return 'apartment';
    if (/\b(kuća|kuca|house|villa|vila)\b/.test(t)) return 'house';
    if (/\b(hotel|ured|office|poslovn\w*|trgov\w*|muzej|galerij\w*|izložb\w*|izlozb\w*)\b/.test(t)) return 'commercial';
    if (/\b(stamben\w*|residential|housing|zgrada|building|dom)\b/.test(t)) return 'residential';
    if (/\b(kuća|kuca|house|villa|vila)\b/.test(t)) return 'house';
    if (/\b(hotel|ured|office|poslovn\w*|trgov\w*|muzej|galerij\w*|izložb\w*|izlozb\w*)\b/.test(t)) return 'commercial';
    if (/\b(stamben\w*|residential|housing|zgrada|building|dom)\b/.test(t)) return 'residential';
    return 'unknown';
}

function schemaEntries(record, fields) {
    return fields.flatMap(field => {
        const value = record[field];
        if (value === null || value === undefined || value === '') return [];
        const raw = typeof value === 'object' ? value.value : value;
        const year = recordYear(raw);
        return Number.isInteger(year) ? [{ value: year, quote: `${field}: ${clean(raw)}` }] : [];
    });
}

function roomWordEntries(text) {
    const entries = valuesFor(text, /(?<![\d,.])\b([12345])\s*[- ]?(?:soban|sobna|sobno)\b/giu)
        .map(entry => ({ value: Number(entry.value), quote: entry.quote }));
    const words = [['dvo', 2], ['tro', 3], ['četvero', 4], ['cetvero', 4], ['petero', 5]];
    for (const [word, value] of words) {
        const match = text.match(new RegExp(`\\b${word}sob(?:an|na|no|ni|ne|nih)?\\b`, 'iu'));
        if (match) entries.push({ value, quote: clean(match[0]) });
    }
    const english = [['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5]];
    for (const [word, value] of english) {
        const match = text.match(new RegExp(`\\b${word}[- ]room\\b`, 'i'));
        if (match) entries.push({ value, quote: clean(match[0]) });
    }
    return entries;
}

function orientationCodes(value) {
    const raw = value.toLocaleLowerCase('hr').replace(/[‐‑–—]/g, '-');
    const compound = [
        [/sjeveroistok|north-east|northeast/, 'NE'], [/sjeverozapad|north-west|northwest/, 'NW'],
        [/jugoistok|south-east|southeast/, 'SE'], [/jugozapad|south-west|southwest/, 'SW']
    ];
    const codes = new Set();
    for (const [pattern, code] of compound) if (pattern.test(raw)) codes.add(code);
    const residual = raw.replace(/sjeveroistok|sjeverozapad|jugoistok|jugozapad|north-east|northeast|north-west|northwest|south-east|southeast|south-west|southwest/g, ' ');
    for (const [pattern, code] of [[/sjever|north/, 'N'], [/jug|south/, 'S'], [/istok|east/, 'E'], [/zapad|west/, 'W']]) {
        if (pattern.test(residual)) codes.add(code);
    }
    return [...codes];
}

export function extractPropertyFacts({ record = {}, title = '', text = '', sourceType = null } = {}) {
    const body = clean(text), titleText = clean(title);
    const evidence = {};
    const getYear = (schemaFields, evidenceField, patterns) => {
        let entries = schemaEntries(record, schemaFields);
        for (const pattern of patterns) entries.push(...valuesFor(body, pattern).map(entry => ({ value: Number(entry.value), quote: entry.quote })));
        const result = choose(entries);
        if (result.quote) evidence[evidenceField] = result.quote;
        return result.value;
    };

    const constructionYear = getYear(['constructionYear', 'yearBuilt'], 'constructionYear', [
        /(?:godina\s+izgradnje|izgrađen(?:a|o|e)?(?:\s+je)?|izgradnj\w*\s+(?:završen\w*|dovršen\w*)|year\s+built|construction\s+year)\s*[:\-]?\s*((?:19|20)\d{2})/giu
    ]);
    const completionYear = getYear(['completionYear'], 'completionYear', [
        /(?:završetak\s+gradnje|zavrsetak\s+gradnje|planirani\s+završetak|completion\s+(?:date|year)|expected\s+completion)\s*[:\-]?\s*((?:19|20)\d{2})/giu
    ]);
    const renovationYear = getYear(['renovationYear'], 'renovationYear', [
        /(?:godina\s+renovacije|renovir(?:an[ao]?|ano)|obnov(?:ljen[ao]?|a)|renovated|renovation\s+year)\s*[:\-]?\s*((?:19|20)\d{2})/giu
    ]);

    const schemaRooms = record.numberOfRooms == null ? [] : [Number(typeof record.numberOfRooms === 'object' ? record.numberOfRooms.value : record.numberOfRooms)].filter(Number.isFinite);
    const labelledRooms = valuesFor(body, /(?:broj\s+soba|rooms?)\s*[:\-]?\s*(\d+(?:[,.]\d+)?)/giu)
        .map(entry => ({ value: Number(entry.value.replace(',', '.')), quote: entry.quote }));
    const schemaRoomCount = schemaRooms.map(value => ({ value, quote: 'numberOfRooms' }));
    const roomEntries = [...labelledRooms, ...roomWordEntries(`${titleText} ${body}`), ...schemaRoomCount];
    const decimalRoomEntries = valuesFor(`${titleText} ${body}`, /\b(\d+[,.]\d+)\s*[- ]?sob(?:an|na|no|ni|ne)?\b/giu)
        .map(entry => ({ value: Number(entry.value.replace(',', '.')), quote: entry.quote }));
    roomEntries.push(...decimalRoomEntries);
    const roomResult = choose(roomEntries);
    if (roomResult.quote) evidence.roomCount = roomResult.quote;

    const facingQuotes = valuesFor(body, /(?:orijentacij\w*|orijentiran\w*|orijentis\w*|pogled\w*\s+(?:prema|na)|facing)\s*[:\-]?\s*(?:prema\s+)?((?:sjever(?:ozapad|oistok)?|jug(?:ozapad|oistok)?|istok|zapad|north(?:west|east)?|south(?:west|east)?|east|west)(?:[\s,\/i-]+(?:sjever(?:ozapad|oistok)?|jug(?:ozapad|oistok)?|istok|zapad|north(?:west|east)?|south(?:west|east)?|east|west))*)/giu);
    const orientation = new Set();
    for (const entry of facingQuotes) {
        orientationCodes(entry.value).forEach(code => orientation.add(code));
        if (entry.quote) evidence.orientation = entry.quote;
    }

    const explicitType = inferType(titleText, body, sourceType);
    const positiveNew = /\b(?:novogradnj\w*|new\s+build|new\s+construction|under\s+construction|u\s+izgradnji)\b/i.test(`${titleText} ${body}`);
    const oldNew = /\b(?:starogradnj\w*|old\s+building|existing\s+building)\b/i.test(`${titleText} ${body}`);
    const newBuild = positiveNew && !oldNew ? true : oldNew && !positiveNew ? false : null;
    const newQuote = [titleText, body].map(value => value.match(/(?:novogradnj\w*|new\s+build|new\s+construction|under\s+construction|u\s+izgradnji|starogradnj\w*|old\s+building|existing\s+building)/i)?.[0]).find(Boolean) || null;
    if (newQuote) evidence.newBuild = newQuote;

    return {
        constructionYear, completionYear, renovationYear,
        roomCount: roomResult.value,
        orientation: [...orientation].sort(),
        propertyType: explicitType,
        newBuild,
        evidence
    };
}
