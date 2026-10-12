// Location signals read from a posting's own text and structured facts, the way a person would
// skim an ad: street and number, a bare street name, the map pin, a cited permit or parcel, and
// project facts (units, storeys, new build). Pure: the caller supplies text and a street index.

const GENERIC = new Set(['ulica', 'ul', 'cesta', 'trg', 'avenija', 'put', 'odvojak', 'prilaz', 'sljeme', 'novi', 'stari',
    'gornji', 'donji', 'mali', 'veliki', 'prolaz', 'stube', 'park', 'naselje', 'obala', 'setaliste', 'vijenac', 'breg', 'dol']);

// Generic street words in any case form: ulica/ulici/ulicu, cesta/cesti, trg/trgu, avenija/aveniji...
const GENERIC_STEM = /^(?:ulic|ul$|cest|trg|aveni|odvoj|prilaz|prolaz|obal|setalist|vijen|naselj|zavrtnic)/;
const isGeneric = word => GENERIC.has(word) || GENERIC_STEM.test(word);

export function fold(value) {
    return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase().replace(/[^a-z0-9/ -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Croatian street names inflect ("Jurišićeva" → "Jurišićevoj ulici", "Glavna" → "Glavnoj"): strip the
// nominative case ending and let a word match when it is that stem plus at most four letters.
export function stem(token) {
    if (token.length < 5) return token;
    return token.replace(/(?:ama|ima|om|oj|og|em|ih|im|a|e|i|o|u)$/, '');
}
const inflects = (word, root) => word.startsWith(root) && word.length - root.length <= 4;

// Index entries: { name, tokens:[stem...] } from the city's street list; generic words are dropped.
// Single-token names shorter than 5 letters are too ambiguous.
export function buildStreetIndex(names = []) {
    const seen = new Map();
    for (const name of names) {
        const tokens = fold(name).split(' ').filter(Boolean);
        const key = tokens.filter(token => !isGeneric(token) && !/^\d+$/.test(token));
        // A name made only of generic words ("Ulica") cannot be told apart from ordinary prose.
        const useful = key;
        if (!useful.length || (useful.length === 1 && useful[0].length < 5)) continue;
        const id = useful.join(' ');
        if (!seen.has(id)) seen.set(id, { name, tokens: useful.map(stem) });
    }
    return [...seen.values()];
}

const HOUSE_NUMBER = /^(\d{1,4}[a-z]?(?:\s*[/-]\s*\d{1,4}[a-z]?)?)$/;
const PREPOSITIONS = new Set(['u', 'na', 'uz', 'kod', 'pokraj', 'blizu', 'iz', 'prema', 'do', 'od', 'adresa', 'lokacija', 'location', 'address']);
// "u blizini Radničke ceste", "kod", "pokraj", "nasuprot": a nearby street, not where the object is.
const PROXIMITY = new Set(['blizini', 'blizu', 'kod', 'pokraj', 'nasuprot', 'nedaleko', 'near', 'opposite', 'close']);
const LABELS = new Set(['adresa', 'lokacija', 'location', 'address']);
// A four-digit number in the 1800-2100 range is a year ("Kovačić 2019"), not a house number.
const isHouseNumber = token => HOUSE_NUMBER.test(token) && !(/^\d{4}$/.test(token) && Number(token) >= 1800 && Number(token) <= 2100);

// Source tokens with their folded forms, one-to-one, so capitalization survives for context checks.
// `stop` marks punctuation after a token: "Držića, 20 stanova" is a street and a count, not Držića 20.
function tokenize(text) {
    return String(text ?? '').split(/\s+/).flatMap(chunk => {
        const raw = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const word = fold(raw);
        return word ? [{ raw, word, stop: /[,.;:!?)\]|]$/.test(chunk), sentence: /[.;!?]$/.test(chunk) }] : [];
    });
}

const byPrefix = new WeakMap();
function prefixLookup(index) {
    if (!byPrefix.has(index)) {
        const lookup = new Map();
        for (const street of index) {
            const key = street.tokens[0].slice(0, 4);
            if (!lookup.has(key)) lookup.set(key, []);
            lookup.get(key).push(street);
        }
        byPrefix.set(index, lookup);
    }
    return byPrefix.get(index);
}

// Ad titles are location slots ("Zagreb, Strojarska - Vukovarska, AVENUE V"), so a capitalized
// street name in a title needs no further context; in prose it does.
// Find street mentions the way a reader would: a word of the name (or the street word before it) is capitalized
// in the source and it sits in street context — a house number follows, a street word ("ulica", "trg") is next to
// it, or a location preposition ("u", "na", "uz") precedes it. Common nouns that happen to name a
// street ("hrast", "glavna") and personal names ("Davor") fail that context.
export function findStreets(text, index, { requireContext = true } = {}) {
    const tokens = tokenize(text);
    const words = tokens.map(token => token.word);
    const lookup = prefixLookup(index);
    const found = [];
    for (let i = 0; i < words.length; i++) {
        for (const street of lookup.get(words[i].slice(0, 4)) || []) {
            const n = street.tokens.length;
            if (i + n > words.length || !street.tokens.every((token, k) => inflects(words[i + k], token))) continue;
            const genericBefore = i > 0 && isGeneric(words[i - 1]);
            const capital = token => /^\p{Lu}/u.test(token.raw);
            if (!tokens.slice(i, i + n).some(capital) && !(genericBefore && capital(tokens[i - 1]))) continue;
            let j = i + n;
            while (j < words.length && !tokens[j - 1].stop && isGeneric(words[j])) j++;
            const number = j < words.length && !tokens[j - 1].stop && isHouseNumber(words[j]) ? words[j] : null;
            const genericNext = j > i + n;
            const preposition = i > 0 && PREPOSITIONS.has(words[i - 1]);
            if (requireContext && !number && !genericNext && !genericBefore && !preposition) continue;
            // "Near" words count within the same clause (back to a comma); an address label counts
            // within the sentence ("Adresa: Zagreb, Trnje, Avenija Marina Držića").
            const first = genericBefore ? i - 1 : i;
            const clause = [], sentence = [];
            for (let k = first - 1; k >= 0 && clause.length < 5 && !tokens[k].stop; k--) clause.push(words[k]);
            for (let k = first - 1; k >= 0 && sentence.length < 8 && !tokens[k].sentence; k--) sentence.push(words[k]);
            const near = clause.some(word => PROXIMITY.has(word));
            const labelled = !near && sentence.some(word => LABELS.has(word));
            found.push({ street: street.name, number, quote: tokens.slice(genericBefore ? i - 1 : i, number ? j + 1 : j).map(t => t.raw).join(' '),
                ...(near ? { near: true } : {}), ...(labelled ? { labelled: true } : {}) });
        }
    }
    // One entry per street, preferring a mention that carries a number.
    const best = new Map();
    for (const item of found) if (!best.has(item.street) || (!best.get(item.street).number && item.number)) best.set(item.street, item);
    return [...best.values()];
}

const KLASA = /UP\/I-?\s?\d{3}-\d{2}\/\d{2}-\d{2,3}\/\d{3,6}/gi;
const PARCEL = /\bk\.?\s?č\.?\s*(?:br\.?\s*)?(\d{1,5}(?:\/\d{1,4})?(?:\s*(?:,|i)\s*\d{1,5}(?:\/\d{1,4})?)*)/giu;
const UNITS = /(\d{1,4})\s+(?:stambenih\s+jedinica|stanova|stambenih\s+jedinica|residential\s+units|apartments|units)\b/i;
const FLOORS = /\b(?:p|pr|po|su)\s?\+\s?\d(?:\s?\+\s?(?:pk|pot|uk|k))?\b|\b(\d{1,2})\s+(?:katova|kata|etaža|etaze|floors|storeys)\b/i;
const NEW_BUILD = /novogradnj|novi projekt|u izgradnji|izgradnja (?:je )?u tijeku|završetak (?:radova|gradnje)|new build|new development|under construction|neubau/i;

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function listingSignals({ facts = {}, text = '', title = '', streetIndex = [] } = {}) {
    const all = `${title}\n${text}`;
    const titleStreets = findStreets(title, streetIndex, { requireContext: false });
    const explicit = facts.explicitLocation?.schema === 'explicit-listing-location.v1' && facts.explicitLocation.street
        ? [{ street: facts.explicitLocation.street, number: facts.explicitLocation.houseNumber || null,
            quote: facts.explicitLocation.quote || facts.explicitLocation.address, basis: 'explicit-location' }] : [];
    const bodyStreets = findStreets(text, streetIndex);
    const mentioned = [...titleStreets.map(item => ({ ...item, basis: 'title-mention' })),
        ...bodyStreets.filter(item => !item.near && !titleStreets.some(t => t.street === item.street && (t.number || !item.number)))
            .map(item => ({ ...item, basis: item.labelled ? 'address-label' : 'text-mention' }))];
    const nearby = bodyStreets.filter(item => item.near && !mentioned.some(m => m.street === item.street)).map(({ street, quote }) => ({ street, quote }));
    const lat = number(facts.coordinates?.lat), lng = number(facts.coordinates?.lng);
    const klasa = [...new Set((all.match(KLASA) || []).map(value => value.replace(/\s+/g, '').toUpperCase()))];
    const parcels = [...new Set([...all.matchAll(PARCEL)].flatMap(match => match[1].split(/\s*(?:,|i)\s*/)).map(value => value.trim()).filter(Boolean))];
    const units = Number(all.match(UNITS)?.[1]) || null;
    const floors = all.match(FLOORS)?.[0] || null;
    return {
        schema: 'listing-location-signals.v1',
        addresses: [...explicit, ...mentioned.filter(item => item.number && !explicit.some(e => fold(e.street) === fold(item.street)))],
        streets: mentioned.filter(item => !item.number).map(({ street, quote, basis }) => ({ street, quote, basis })),
        nearbyStreets: nearby,
        titleText: fold(title).slice(0, 300),
        pin: lat !== null && lng !== null ? { lat, lng } : null,
        klasa,
        parcels,
        units,
        floors,
        newBuild: NEW_BUILD.test(all),
        locality: typeof facts.locality === 'string' ? facts.locality : null,
    };
}

// A posting is worth keeping when anything at all points at a place smaller than a district.
export function hasLocationSignal(signals) {
    return Boolean(signals && (signals.addresses.length || signals.streets.length || signals.pin
        || signals.klasa.length || signals.parcels.length));
}
