// A positive result is evidence of the advertised property's address, not a geocode.
import * as cheerio from 'cheerio';
import { normalizeUrl } from './page-evidence.js';

const PROPERTY_TYPES = new Set(['Apartment', 'House', 'SingleFamilyResidence', 'Residence', 'RealEstateListing', 'Product']);
const EXCLUDED = 'header,footer,nav,aside,form,[role="contentinfo"],[role="navigation"],.agent,.agent-profile,.broker,.agency,.contact,.kontakt,.recommendation,.related,.similar,.item-wrap,[class*="recommend" i],[class*="related" i],[class*="similar" i],[class*="agent" i],[class*="broker" i],[class*="contact" i]';
const NON_STREET = /\b(?:stan|apartman|apartment|etaža|etaza|kat|floor|sprat|soba|room|kvadrat|m2|m²|eur|euro|€|poštanski|postanski|poštanski broj|postal|postcode|projekt|project)\b/i;
const PROXIMITY = /\b(?:kod|blizu|pored|pokraj|nasuprot|near|opposite|next\s+to)\b/i;
const LOCALITY = /^(?:split|zagreb|rijeka|osijek|zadar|pula|dubrovnik|varaždin|varazdin|šibenik|sibenik|makarska|opatija|sesvete|samobor)$/i;
const HOUSE = /^(.*?\p{L}[\p{L}\p{M}. '’\-]*?)\s+(\d{1,4}\s*[a-zA-Z]?(?:\s*[-/]\s*\d{1,4}\s*[a-zA-Z]?)?)$/u;
const LOCATION_LABEL = /^(?:lokacija|location|address|adresa(?:\s+(?:nekretnine|stana|građevine|gradevine|projekta|objekta))?|property address|project address)$/i;
const LOCATION_PHRASE = /(?:adresa(?:\s+(?:nekretnine|stana|građevine|gradevine|projekta|objekta))?|lokacija|location|project address|property address|na adresi|at the address|befindet sich an der adresse)\s*[:\-]?\s*([^.;!?]+)/ig;
const CONTACT_CONTEXT = /\b(?:kontakt|contact|studio|ured|office|sjedište|sjediste|agencija|agency|telefon|phone|email|e-mail|pišite|pisite)\b/i;

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function htmlLines($, element) {
    const copy = $(element).clone();
    copy.find('br').replaceWith('\n');
    return copy.text().split(/\n/).map(clean).filter(Boolean);
}

function parseAddress(value) {
    // A city may precede the street. More than one street-and-number is ambiguous.
    const candidates = clean(value).split(/[,;|\n]/).map(part => part.replace(/^[\s:–—-]+|[\s.]+$/g, ''));
    const addresses = candidates.map(parseStreet).filter(Boolean);
    for (let i = 0; i < candidates.length - 1; i++) {
        if (!/^\d{1,4}(?:\s*[/\-]\s*\d{1,4})?[a-z]?$/i.test(candidates[i])) continue;
        if (!/^\p{L}[\p{L}\p{M} .'-]+\s+(?:street|road)$/iu.test(candidates[i + 1])) continue;
        addresses.push(parseStreet(`${candidates[i + 1].replace(/\s+(?:street|road)$/i, '')} ${candidates[i]}`));
    }
    const valid = addresses.filter(Boolean);
    return valid.length === 1 ? valid[0] : null;
}

function parseStreet(candidate) {
    if (!candidate || candidate.length > 120 || /\b\d{5}\b/.test(candidate)) return null;
    const match = candidate.match(HOUSE);
    if (!match) return null;
    const street = clean(match[1]).replace(/^["“„']|["”']$/g, '').replace(/\s+(?:street|road)$/i, '');
    const houseNumber = match[2].replace(/\s+/g, '');
    if (street.length < 3 || !/\p{L}{2}/u.test(street) || NON_STREET.test(street) || PROXIMITY.test(street)) return null;
    // A single place name plus a number (Split 3, Zagreb 10000) is not a street.
    if (LOCALITY.test(street)) return null;
    if (/^\d+\.?\s*$/u.test(street) || /^\d{1,4}\s*(?:m2|m²)$/i.test(candidate)) return null;
    return { street, houseNumber, address: `${street} ${houseNumber}` };
}

function propertyRecord(item, pageUrl) {
    const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
    if (!types.some(type => PROPERTY_TYPES.has(type))) return false;
    if (!item.url) return true;
    return listingIdentity(item.url) === listingIdentity(pageUrl);
}

function result(raw, basis, sourceUrl) {
    const parsed = parseAddress(raw);
    return parsed && { schema: 'explicit-listing-location.v1', ...parsed, quote: clean(raw), basis, sourceUrl };
}

export function listingIdentity(url, sourceId = null) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    // These are observed Croatian/German/English listing routes; numeric search routes stay distinct.
    const opereta = host === 'opereta.hr' && parsed.pathname.match(/^\/(?:nekretnina|de\/immobilie|en\/real-estate)\/[^/]+\/(\d+)(?:-[^/]*)?\/?$/i);
    if (opereta) return `opereta:${opereta[1]}`;
    // Source IDs are often agency-wide, reused, or absent; a URL is the durable fallback.
    void sourceId;
    parsed.hostname = host;
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    return parsed.href;
}

export function propertyDetailId(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;
    // Observed singular property routes; numeric search/category pages do not match.
    return new URL(url).pathname.match(/^\/(?:nekretnina|immobile|immobilie|de\/immobilie|en\/real-estate)\/[^/]+\/(\d+)(?:-[^/]*)?\/?$/i)?.[1] || null;
}

export function extractExplicitLocation(html, url, listingFacts = null, { document = null } = {}) {
    const sourceUrl = normalizeUrl(url);
    if (!sourceUrl || !html) return null;
    const $ = document || cheerio.load(String(html));
    const parsedUrl = new URL(sourceUrl);
    const njiricId = parsedUrl.hostname.replace(/^www\./i, '') === 'njiric.com'
        && parsedUrl.pathname.toLowerCase() === '/handlers/project.ashx'
        && /^p\d+$/i.test(parsedUrl.searchParams.get('id') || '')
        && [...parsedUrl.searchParams.keys()].every(key => key.toLowerCase() === 'id')
            ? parsedUrl.searchParams.get('id') : null;
    // Do not let generic schema/address controls bypass the handler's own ID
    // and title match. A malformed fragment is an addressless project.
    if (njiricId && !$(`#project_${njiricId.slice(1)}_divSadrzajZaSkrivanje.tekst #project_${njiricId.slice(1)}_tdTekst a.projectlinkclose[name="${njiricId}"]`).filter((_,el)=>clean($(el).text())).length) return null;
    const scripts = $('script[type="application/ld+json"]').map((_, el) => {
        try { return JSON.parse($(el).text()); } catch { return null; }
    }).get();
    const records = scripts.flatMap(value => Array.isArray(value) ? value : [value]).flatMap(value => Array.isArray(value?.['@graph']) ? value['@graph'] : [value]);
    const propertyRecords = njiricId ? [] : records.filter(record => propertyRecord(record, sourceUrl));
    for (const record of propertyRecords) {
        if (!record.url && propertyRecords.length !== 1) continue;
        const address = record.address;
        const raw = typeof address === 'object' ? address?.streetAddress : null;
        const found = result(raw, 'structured-property-address', sourceUrl);
        if (found) return found;
    }

    // Hiperprostor puts an explicit building address in the introductory
    // paragraph beside its own project title, outside a semantic <main>.
    // Require the building as grammatical subject and a direct "at street N"
    // locative; nearby streets and later historical descriptions do not count.
    if (parsedUrl.hostname.replace(/^www\./i, '') === 'hiperprostor.hr'
        && /^\/projekti\/[^/]+\/\d+\/?$/i.test(parsedUrl.pathname)) {
        const title = clean($('h1.title').first().text());
        const intro = title && $('.heading.left.dark.no-padd-top').filter((_, el) => clean($(el).find('p').first().text()) === title).first();
        const paragraph = title ? clean(intro.find('p').eq(1).text()) : '';
        const direct = paragraph.match(/^(?:palača|kuća|zgrada|objekt|građevina)\b[^.!?]{0,90}?,\s*smješten[ao]\s+u\s+([\p{L}\p{M}][\p{L}\p{M} .’'-]{2,80}?)\s+(\d{1,4}[a-z]?)\s+u\s+[\p{L}\p{M}-]+/iu);
        if (direct) {
            const parsed = parseStreet(`${direct[1]} ${direct[2]}`);
            if (parsed) return {schema:'explicit-listing-location.v1',...parsed,
                quote:clean(direct[0].match(/smješten[ao]\s+u\s+.+?\s+\d{1,4}[a-z]?/iu)?.[0]),basis:'explicit-building-locative-text',sourceUrl};
        }
    }

    // Radionica publishes the address at the start of its own project fact block.
    const radionicaDetail = parsedUrl.hostname.replace(/^www\./i, '') === 'radionica-arhitekture.hr'
        && /^\/(?:project|projekt)\/\d+\/[^/]+\/?$/i.test(parsedUrl.pathname);
    // Address controls must be on the property view, away from agents and recommendations.
    const main = $('main,article,#property-view,[itemtype*="RealEstateListing"],[itemtype*="Apartment"],[class*="project-detail" i],[id*="project-detail" i]').first();
    const root = main.length ? main : radionicaDetail ? $('body').first()
        : njiricId ? $(`#project_${njiricId.slice(1)}_divSadrzajZaSkrivanje.tekst`).first() : main;
    if (!root.length) return null;
    if (/(?:^|\/)(?:kontakt|contact|about|o-nama|team|studio)(?:\/|$)/i.test(new URL(sourceUrl).pathname)) return null;
    const propertyRoot = root.clone();
    propertyRoot.find(EXCLUDED).remove();
    const ownAddress = propertyRoot.find('[itemprop="streetAddress"],[data-property-address],[data-listing-address],.property-address,.listing-address').first();
    if (ownAddress.length) {
        const raw = clean(ownAddress.attr('content') || ownAddress.attr('data-property-address') || ownAddress.attr('data-listing-address') || ownAddress.text());
        const found = result(raw, 'listing-address-element', sourceUrl);
        if (found) return found;
    }
    // Project detail tables and definition lists have a label/value relationship.
    for (const row of propertyRoot.find('tr,dl').toArray()) {
        const cells = $(row).is('tr') ? $(row).children('th,td') : $(row).children('dt,dd');
        if (cells.length < 2 || !LOCATION_LABEL.test(clean($(cells[0]).text()).replace(/:$/, ''))) continue;
        const raw = clean($(cells[1]).text());
        const found = result(raw, 'project-location-field', sourceUrl);
        if (found) return found;
    }
    for (const dt of propertyRoot.find('dt').toArray()) {
        if (!LOCATION_LABEL.test(clean($(dt).text()).replace(/:$/, ''))) continue;
        const raw = clean($(dt).next('dd').text());
        const found = result(raw, 'project-location-field', sourceUrl);
        if (found) return found;
    }
    for (const container of propertyRoot.find('.section-project-title,.project-data,[class*="project-detail" i]').toArray()) {
        for (const label of $(container).find('div,p,span').toArray()) {
            if (!LOCATION_LABEL.test(clean($(label).text()).replace(/:$/, ''))) continue;
            const next = $(label).next();
            if (!next.length || next[0].tagName !== label.tagName) continue;
            const found = result(next.text(), 'project-location-field', sourceUrl);
            if (found) return found;
        }
    }
    if (radionicaDetail) {
        for (const el of propertyRoot.find('p').toArray()) {
            const lines = htmlLines($, el);
            // The own Wix project fact block begins with the street address,
            // followed immediately by its Location field. Other prose and
            // gallery captions cannot satisfy this structure.
            if (lines.length < 2 || !/^(?:Location|Mjesto):\s*[^\d]+$/i.test(lines[1]) || CONTACT_CONTEXT.test(lines[0])) continue;
            const found = result(lines[0], 'project-fact-block-address', sourceUrl);
            if (found) return found;
        }
    }
    if (njiricId) {
        const ownText = propertyRoot.find(`#project_${njiricId.slice(1)}_tdTekst`).first();
        if (ownText.length && ownText.find(`a.projectlinkclose[name="${njiricId}"]`).length) {
            for (const line of htmlLines($, ownText)) {
                const match = line.match(/^location:\s*(.+)$/i);
                if (!match) continue;
                const found = result(match[1], 'project-location-field', sourceUrl);
                if (found) return found;
            }
        }
    }
    if (parsedUrl.hostname.replace(/^www\./, '') === 'opereta.hr' && /^\/(?:nekretnina|de\/immobilie|en\/real-estate)\//i.test(parsedUrl.pathname)) {
        const h1 = propertyRoot.find('h1').first();
        const next = h1.next('p');
        if (next.length) {
            const found = result(next.text(), 'opereta-listing-address', sourceUrl);
            if (found) return found;
        }
    }
    // Plain prose is accepted only where it explicitly labels the property's address.
    for (const el of propertyRoot.find('p,li,dd,td').toArray()) {
        const raw = clean($(el).text());
        if (raw.length > 20000) continue;
        for (const match of raw.matchAll(LOCATION_PHRASE)) {
            const context = raw.slice(Math.max(0, match.index - 80), match.index);
            if (CONTACT_CONTEXT.test(context)) continue;
            const found = result(match[1], 'explicit-property-address-text', sourceUrl);
            if (found) return found;
        }
    }
    void listingFacts;
    return null;
}
