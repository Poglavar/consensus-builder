// Conservative, source-backed HTML evidence extraction; never invents property facts.
import * as cheerio from 'cheerio';
import { extractExplicitLocation, propertyDetailId } from './explicit-location.js';
import { extractPropertyFacts } from './property-facts.js';
import { developerProjectRoot, extractDeveloperProject } from './developer-projects.js';

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i;
const PLAN_WORD = /(tlocrt|floor[._ -]?plans?|ground[._ -]?plans?|blueprints?|etažni|etazni|tlocrti|\bgrundriss(?:e)?\b)/i;
const PLAN_LABEL = /\b(?:plan|tlocrt)\b/i;
const GALLERY_SELECTOR = '[class*=gallery],[class*=Gallery],[class*=carousel],[class*=Carousel],[class*=swiper],[class*=Swiper],[class*=slider],[class*=Slider],[data-slot="carousel"],[aria-roledescription="carousel"]';
const SEMANTIC_CAROUSEL_SELECTOR = '[data-slot="carousel"],[aria-roledescription="carousel"]';
const BLOCKED = /(captcha|cloudflare|access denied|verify you are human|robot check|too many requests|temporarily blocked|just a moment|checking your browser)/i;
const LEGAL_ARTIFACT = /\b(?:privacy(?: policy)?|privatnost\w*|datenschutz\w*|gdpr|cookie(?: policy)?|izjav\w* (?:o )?obrad\w* osobn\w* podatk\w*|obrad\w* osobn\w* podatk\w*|uvjet\w* (?:poslovanj\w*|koristenj\w*)|opci uvjet\w* poslovanj\w*|terms (?:conditions?|of (?:service|use|business))|brokerage (?:agreement|terms|disclosure)|ugovor\w* o posredovanj\w*|posredovanj\w* (?:ugovor\w*|uvjet\w*)|posrednick\w* (?:ugovor\w*|uvjet\w*)|legal (?:notice|terms))\b/i;
const first = (...values) => values.find(value => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
const number = value => { if (value === null || value === undefined || value === '') return null; const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/); return match ? Number(match[0]) : null; };
const absolute = (raw, base) => { try { const url = new URL(raw, base); if (!['http:', 'https:'].includes(url.protocol)) return null; return url; } catch (_) { return null; } };

export function normalizeUrl(raw, base) {
    if (raw === undefined || raw === null || raw === '') return null;
    const url = absolute(raw, base); if (!url) return null;
    [...url.searchParams.keys()].forEach(key => { if (TRACKING.test(key)) url.searchParams.delete(key); });
    url.hash = '';
    return url.href;
}

const EUROVILLA_PHOTO = /^https:\/\/static\.eurovilla-cdn\.com\/property-photos\/(\d+)\/(\d+)x(\d+)\/([a-f0-9]{32})\.(jpg|webp|avif)$/i;
const EUROVILLA_REGION = /^https:\/\/static\.eurovilla-cdn\.com\/regions\//i;

function eurovillaPhotoParts(asset) {
    const match = String(asset?.url || '').match(EUROVILLA_PHOTO);
    return match ? { propertyId: match[1], width: Number(match[2]), height: Number(match[3]), imageId: match[4].toLowerCase(), format: match[5].toLowerCase() } : null;
}

/** Group only the observed Eurovilla resized gallery-photo URLs; preserve nonmatching assets verbatim. */
export function groupEurovillaPhotoVariants(assets = []) {
    const groups = new Map(), passthrough = [];
    for (const asset of assets) {
        const photo = eurovillaPhotoParts(asset);
        if (EUROVILLA_REGION.test(String(asset?.url || ''))) {
            const cleaned = { ...asset, listingOwned: false };
            delete cleaned.ownerSourceId;
            delete cleaned.ownerListingUrl;
            passthrough.push(cleaned);
            continue;
        }
        if (!photo || asset?.kind === 'floor-plan' || asset?.kind === 'document') { passthrough.push(asset); continue; }
        const key = `${photo.propertyId}/${photo.imageId}`;
        if (!groups.has(key)) groups.set(key, []);
        const variants = groups.get(key), duplicate = variants.findIndex(item => item.asset.url === asset.url);
        if (duplicate < 0) variants.push({ asset, photo });
        else if (asset.listingOwned && !variants[duplicate].asset.listingOwned) variants[duplicate] = { asset, photo };
    }
    for (const variants of groups.values()) {
        variants.sort((a, b) => (b.photo.width * b.photo.height) - (a.photo.width * a.photo.height)
            || Number(b.photo.width) - Number(a.photo.width) || Number(b.photo.height) - Number(a.photo.height)
            || Number(a.photo.format !== 'jpg') - Number(b.photo.format !== 'jpg') || a.asset.url.localeCompare(b.asset.url));
        const chosen = { ...variants[0].asset };
        const owned = variants.find(({ asset }) => asset.listingOwned);
        if (owned && !chosen.listingOwned) {
            chosen.listingOwned = true;
            for (const key of ['ownerSourceId', 'ownerListingUrl', 'listingGallery']) {
                if (chosen[key] === undefined && owned.asset[key] !== undefined) chosen[key] = owned.asset[key];
            }
        }
        const alternatives = [...new Set([...variants.slice(1).map(({ asset }) => asset.url),
            ...variants.flatMap(({ asset }) => asset.alternateUrls || [])])].filter(url => url !== chosen.url);
        if (alternatives.length) chosen.alternateUrls = alternatives;
        else delete chosen.alternateUrls;
        passthrough.push(chosen);
    }
    return passthrough;
}

function jsonScripts($) { const out = []; $('script[type="application/ld+json"]').each((_, el) => { try { const value = JSON.parse($(el).contents().text()); (Array.isArray(value) ? value : [value]).forEach(item => out.push(item)); } catch (_) {} }); return out; }
function kindFor(url, text) { const parsed=new URL(url); const value = `${parsed.pathname} ${parsed.search} ${text}`; if (/page=|pagina|stranica|next|sljede/i.test(value)) return 'pagination'; if (/kontakt|contact|agent|office/i.test(value)) return 'contact'; if (/projekt|project|development|residence/i.test(value)) return 'project'; if (/oglas|listing|nekretn|property|stan|apartment/i.test(value)) return 'listing'; return 'other'; }
function imageKind(url, text) { return PLAN_WORD.test(`${url} ${text}`) || PLAN_LABEL.test(`${url} ${text}`) ? 'floor-plan' : 'image'; }

function sameDocumentUrl(a, b, base) {
    const key = raw => {
        const normalized = normalizeUrl(raw, base); if (!normalized) return null;
        const url = new URL(normalized);
        return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, '') + url.search;
    };
    return key(a) !== null && key(a) === key(b);
}

function operetaPropertyId(raw, base) {
    try {
        const url = new URL(raw, base);
        if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'opereta.hr') return null;
        return url.pathname.match(/^\/(?:nekretnina|de\/immobilie)\/[^/]+\/(\d+)(?:-[^/]*)?\/?$/i)?.[1] || null;
    } catch (_) { return null; }
}

function sameOperetaProperty(a, b) {
    const aId = operetaPropertyId(a, b), bId = operetaPropertyId(b, b);
    return Boolean(aId && bId && aId === bId);
}

function isLegalArtifact(url, label, element) {
    const link = element.closest('a');
    const source = [url, label, link.attr('rel'), link.attr('title'), link.attr('aria-label'), element.attr('title')]
        .filter(Boolean).join(' ').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    return LEGAL_ARTIFACT.test(source);
}

function galleryMembership(element, mainCarousel) {
    const gallery = element.closest(GALLERY_SELECTOR).length > 0;
    const semanticCarousel = element.closest(SEMANTIC_CAROUSEL_SELECTOR);
    const otherCarousel = Boolean(mainCarousel && semanticCarousel.length && semanticCarousel[0] !== mainCarousel);
    return { gallery: gallery && !otherCarousel, otherCarousel };
}

function architectureLocality($, pageUrl) {
    const main = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first()
        : new URL(pageUrl).hostname.replace(/^www\./i, '') === 'radionica-arhitekture.hr' ? $('body').first() : $('article').first();
    if (!main.length) return null;
    const facts = main.find('.section-project-title,.project-data').clone();
    facts.find('header,footer,nav,aside,[class*="contact" i],[class*="office" i],[class*="related" i]').remove();
    for (const label of facts.find('div,p,span').toArray()) {
        if (!/^(?:city|grad)\s*:?$/i.test($(label).text().replace(/\s+/g, ' ').trim())) continue;
        const next = $(label).next();
        if (!next.length || next[0].tagName !== label.tagName) continue;
        const city = next.text().replace(/\s+/g, ' ').trim();
        if (/^[\p{L}][\p{L}\p{M} .'-]{1,59}$/u.test(city)) return city;
    }
    if (new URL(pageUrl).hostname.replace(/^www\./i, '') === 'radionica-arhitekture.hr') {
        const ownContent = main.clone();
        ownContent.find('header,footer,nav,aside,[class*="contact" i],[class*="office" i],[class*="related" i]').remove();
        for (const el of ownContent.find('p').toArray()) {
            const lines = $(el).clone();
            lines.find('br').replaceWith('\n');
            const parts = lines.text().split(/\n/).map(value=>value.replace(/\s+/g,' ').trim());
            if (parts.length < 2 || !/^[\p{L}\p{M} .'-]+\s+\d{1,4}[a-z]?$/iu.test(parts[0])) continue;
            const match = parts[1].match(/^(?:Location|Mjesto):\s*([\p{L}\p{M} .'-]+?)(?:,\s*[\p{L}\p{M} .'-]+)?$/iu);
            if (match && match[1].length <= 60) return match[1].trim();
        }
    }
    const heading = main.find('.section-project-title h2').first().text().replace(/\s+/g, ' ').trim();
    return /^[\p{L}][\p{L}\p{M} .'-]{1,59}$/u.test(heading) && !/^(?:project|projects|projekt|projekti|architecture|arhitektura|portfolio)$/i.test(heading)
        ? heading : null;
}

function architectureDetailRoute(rawUrl, $) {
    const url = new URL(rawUrl), host = url.hostname.replace(/^www\./i, '').toLowerCase(), path = url.pathname;
    if (host === 'hiperprostor.hr' && /^\/projekti\/[^/]+\/\d+\/?$/i.test(path)) return 'hiperprostor';
    if (host === 'ivaarch.hr' || host === 'unifika.hr') {
        const localized = path.match(/^\/(?:hrvatski|english)\/([^/]+)_\d+\/?$/i);
        const nonProject = /^(?:prostorno-uredjenje|architecture|arhitektura|projekti|projects|portfolio|reference|references|o-nama|about|about-us|kontakt|contact|studio|home|naslovnica|pocetna)$/i;
        if (localized && !nonProject.test(localized[1])) return 'localized-project';
    }
    if (host === 'interkonzalting.hr' && /^\/(?:EN\/)?[^/]+\/?$/i.test(path)
        && $('main .project-section-content').find('strong').toArray().some(el => /^Projekt:\s*$/i.test($(el).text().trim()))) return 'interkonzalting';
    if (host === 'gin.hr' && /^\/(?:projektiranje-stambeno-poslovne-zgrade|projektiranje-savjetovanje-i-projektantski-nadzor)\/?$/i.test(path)) return 'gin-project';
    if (host === 'radionica-arhitekture.hr' && /^\/(?:project|projekt)\/\d+\/[^/]+\/?$/i.test(path)) return 'radionica';
    if (host === 'njiric.com' && path.toLowerCase() === '/handlers/project.ashx'
        && /^p\d+$/i.test(url.searchParams.get('id') || '')
        && [...url.searchParams.keys()].every(key => key.toLowerCase() === 'id')) return 'njiric-fragment';
    if (host === 'njiric.com' && /^\/work\/all-projects\/[^/]+\/\d+\/?$/i.test(path)) return 'njiric';
    if (host === 'sza.hr' && path.toLowerCase() === '/project_variable.php' && /^\d+$/.test(url.searchParams.get('id') || '')) return 'sza';
    if (/^\/(?:en\/|hr\/)?(?:project|projects|projekt|projekti)\/[^/]+\/?$/i.test(path)) return 'generic';
    return null;
}

function architectureProjectStatus($, pageUrl) {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '');
    if (host === 'radionica-arhitekture.hr') {
        for (const el of $('main p').toArray()) {
            const copy = $(el).clone(); copy.find('br').replaceWith('\n');
            const lines = copy.text().split(/\n/).map(value=>value.replace(/\s+/g,' ').trim());
            if (!/^[\p{L}\p{M} .'-]+\s+\d{1,4}[a-z]?$/iu.test(lines[0] || '') || !/^(?:Location|Mjesto):/i.test(lines[1] || '')) continue;
            const type = lines.find(line=>/^(?:Type|Vrsta):\s*\S/i.test(line));
            if (type) return { value:type.replace(/^(?:Type|Vrsta):\s*/i,''), quote:type, basis:'project-fact-block-type' };
        }
    }
    const roots = $('.project-data,.project-details,main,article,.node-project').clone();
    roots.find('header,footer,nav,aside,[class*="contact" i],[class*="related" i]').remove();
    for (const label of roots.find('p,h3,dt,th').toArray()) {
        if (!/^status\s*:?$/i.test($(label).text().replace(/\s+/g,' ').trim())) continue;
        const value = $(label).next('p,dd,td').first().text().replace(/\s+/g,' ').trim();
        if (/^[\p{L}\p{M}0-9 /-]{2,80}$/u.test(value)) return {value,quote:value,basis:'project-status-field'};
    }
    return null;
}

function propertyEvidenceText($, sourceType) {
    const root = sourceType === 'architecture' ? $('main').first() : $('main').first().length ? $('main').first() : $('article').first();
    if (!root.length) return '';
    const content = root.clone();
    content.find('header,footer,nav,aside,form,[role="navigation"],[role="contentinfo"],.item-wrap,.property-project-items-table,[class*="related" i],[class*="recommend" i],[class*="similar" i],[class*="menu" i],[class*="breadcrumb" i]').remove();
    return content.text().replace(/\s+/g, ' ').trim();
}

// This text is for resolving the advertised property's location only. Link and
// asset discovery deliberately still sees the full document. Real listing
// pages often append an agency's office address to the otherwise useful
// description: Interklasik puts that in the final description paragraph, and
// Nekretnine Lika appends its office tail to the property paragraph.
const LOCATION_CHROME = 'script,style,noscript,nav,footer,form,header,aside,[role="navigation"],[role="contentinfo"],[class*="agent" i],[class*="broker" i],[class*="contact" i],[class*="office" i],[class*="footer" i],[id*="footer" i]';
const CONTACT_SIGNATURE_START = /\bza\s+sve\s+dodatne\s+informacije\b[^.!?]*\bkontaktirajte\b/i;
const AGENCY_OFFICE_TAIL = /\b(?:[\p{Lu}][\p{L}'’\-]*\s+){1,3}(?:nekretnine|real\s+estate)\s+(?:d\.?\s*o\.?\s*o\.?|j\.?\s*d\.?\s*o\.?\s*o\.?)\b.*$/u;
const AGENCY_OFFICE_NAME = /^(?:[\p{Lu}][\p{L}'’\-]*\s+){1,3}(?:nekretnine|real\s+estate)\s+(?:d\.?\s*o\.?\s*o\.?|j\.?\s*d\.?\s*o\.?\s*o\.?)$/u;
const STANDALONE_ADDRESS = /^[\p{L}][\p{L}\p{M} .’'\-]{2,80}\s+\d{1,4}[a-z]?$/iu;

function locationEvidenceText($) {
    const visible = $('body').clone();
    visible.find(LOCATION_CHROME).remove();
    // Interklasik's office signature begins with an invitation to contact the
    // agency. Remove that signature only from its invitation onward: a property
    // paragraph may itself contain an address before a later contact sentence.
    visible.find('p,li,address').each((_, element) => {
        const item = $(element), text = item.text().replace(/\s+/g, ' ').trim();
        const match = text.match(CONTACT_SIGNATURE_START);
        if (match) item.text(text.slice(0, match.index).trim());
    });
    // Nekretnine Lika appends "Lika nekretnine d.o.o. Palmotićeva 76" to the
    // same property paragraph. Retain the listing description before that
    // agency tail; only the tail is unusable as property-location evidence.
    visible.find('p,li,address').each((_, element) => {
        const item = $(element), text = item.text().replace(/\s+/g, ' ').trim();
        const match = text.match(AGENCY_OFFICE_TAIL);
        if (match && match.index > 0) item.text(text.slice(0, match.index).trim());
    });
    // The same Lika template may render the company and office address as two
    // adjacent paragraphs. They are a contact signature, not a second property
    // location; remove both only when that exact company/address structure is
    // present.
    visible.find('p,li,address').each((_, element) => {
        const item = $(element), text = item.text().replace(/\s+/g, ' ').trim();
        if (!AGENCY_OFFICE_NAME.test(text)) return;
        const next = item.nextAll('p,li,address').first();
        if (next.length && STANDALONE_ADDRESS.test(next.text().replace(/\s+/g, ' ').trim())) next.remove();
        item.remove();
    });
    return visible.text().replace(/\s+/g, ' ').trim();
}

// A page may embed whole project tables and recommendation cards. Discovery is
// page-wide, but a plan belongs to the main listing only when its local owner agrees.
function assetOwnership($, el, listing, pageUrl, url, label, forcedKind = null, mainCarousel = null) {
    const element = $(el), row = element.closest('#property-project-items-table tr');
    let ownerSourceId = null, ownerListingUrl = null;
    if (row.length) {
        row.find('a[href]').each((_, link) => {
            const url = normalizeUrl($(link).attr('href'), pageUrl);
            if (!url || new URL(url).hostname !== new URL(pageUrl).hostname) return;
            const id = new URL(url).pathname.match(/\/(\d+)\/?$/)?.[1];
            if (id && !ownerSourceId) { ownerSourceId = id; ownerListingUrl = url; }
        });
    }
    if (!ownerSourceId && !ownerListingUrl) {
        const card = element.closest('.item-wrap');
        if (card.length) ownerListingUrl = normalizeUrl(card.find('a.listing-featured-thumb[href],a.btn-item[href]').first().attr('href'), pageUrl);
    }
    if (!ownerSourceId && !ownerListingUrl && !row.length) {
        const owner = element.closest('[data-propertyid],[data-property-id]');
        ownerSourceId = first(owner.attr('data-propertyid'), owner.attr('data-property-id'));
    }
    const context = `${url} ${label}`.toLowerCase();
    const globalArtifact = element.closest(`header,footer,nav,[role="contentinfo"],[role="navigation"],
        .agent,.agent-card,.agent-profile,.agent-photo,.agent-portrait,.broker-card,.advisor-card,
        .consultant-card,.avatar,.portrait,.staff-card,.privacy-policy,.cookie-banner`).length > 0
        || /(?:^|\/)(?:regionalphotos?|regional-photos?|agent-photos?|agents?|staff-photos?|team-photos?|avatars?|portraits?)(?:\/|$)/i.test(new URL(url).pathname)
        || isLegalArtifact(url, label, element);
    const recommendation = element.closest(`.item-wrap,.property-project-items-table tr,
        [class*="related-property" i],[class*="similar-property" i],[class*="recommendation" i]`).length > 0;
    const { gallery, otherCarousel } = galleryMembership(element, mainCarousel);
    const floorPlan = forcedKind === 'floor-plan' || PLAN_WORD.test(context) || PLAN_LABEL.test(context);
    const explicitMatch = ownerSourceId ? String(ownerSourceId) === String(listing?.sourceId)
        : ownerListingUrl ? sameDocumentUrl(ownerListingUrl, pageUrl, pageUrl)
            : false;
    const hasConflictingOwner = Boolean(ownerSourceId || ownerListingUrl) && !explicitMatch;
    if (listing?.sourceType === 'architecture-project') {
        const inMain = element.closest('main,article').length > 0
            || (new URL(pageUrl).hostname.replace(/^www\./i, '') === 'njiric.com'
                && element.closest('.tekst .project_details').length > 0);
        const otherProjectCard = element.closest('[class*="other-project" i],[class*="more-project" i],[class*="project-card" i]').length > 0;
        const linkedProject = element.closest('a[href]').attr('href');
        const linkedIdentity = linkedProject && normalizeUrl(linkedProject, pageUrl);
        const otherProjectLink = linkedIdentity && /\/(?:projects?|projekti?)\//i.test(new URL(linkedIdentity).pathname)
            && !sameDocumentUrl(linkedIdentity, pageUrl, pageUrl);
        return { listingOwned: Boolean(inMain && !globalArtifact && !recommendation && !otherProjectCard && !hasConflictingOwner && !otherProjectLink) };
    }
    if (listing?.sourceType === 'developer-project') {
        const root = developerProjectRoot($, pageUrl);
        const inRoot = Boolean(root?.length && (root[0] === element[0] || root.find(element).length));
        const hiddenProjectDialog = element.closest('[role="dialog"],[aria-hidden="true"],[hidden],[data-elementor-type="popup"],[class*="modal" i],[class*="dialog" i],[class*="popup" i],.uk-nav,.sticky-section,[class~="uk-hidden@m"]').length > 0
            || element.parents('section').toArray().some(section => $(section).find('form').length > 0);
        const otherProjectCard = element.closest('[class*="other-project" i],[class*="more-project" i],[class*="project-card" i],[class*="related" i],[class*="recommend" i]').length > 0;
        const linkedProject = element.closest('a[href]').attr('href');
        const linkedIdentity = linkedProject && normalizeUrl(linkedProject, pageUrl);
        const otherProjectLink = linkedIdentity && /\/(?:projects?|projekti?|prodaja-nekretnina)\//i.test(new URL(linkedIdentity).pathname)
            && !sameDocumentUrl(linkedIdentity, pageUrl, pageUrl);
        return { listingOwned: Boolean(inRoot && !globalArtifact && !hiddenProjectDialog && !recommendation && !otherProjectCard && !otherProjectLink && !hasConflictingOwner) };
    }
    const listingOwned = Boolean(listing) && !globalArtifact && !hasConflictingOwner && !otherCarousel
        && (explicitMatch || (!recommendation && !row.length && (gallery || floorPlan)));
    return { listingOwned, ...(ownerSourceId ? { ownerSourceId } : {}), ...(ownerListingUrl ? { ownerListingUrl } : {}) };
}

export function extractPageEvidence(html, pageUrl, { sourceKind = null, discovery = true, document = null } = {}) {
    const $ = document || cheerio.load(String(html || ''));
    const bodyText = locationEvidenceText($);
    if (BLOCKED.test(`${$('title').text()} ${bodyText}`)) return { title: first($('title').text()), canonicalUrl: normalizeUrl($('link[rel="canonical"]').attr('href'), pageUrl) || normalizeUrl(pageUrl, pageUrl), text: bodyText, links: [], assets: [], listing: null, blocked: true, blockedReason: 'challenge-or-access-block' };
    const canonicalUrl = normalizeUrl($('link[rel="canonical"]').attr('href'), pageUrl) || normalizeUrl(pageUrl, pageUrl);
    const scripts = jsonScripts($), records = scripts.flatMap(item => item?.['@graph'] || item);
    const acceptedRecord = item => {
        const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
        return types.some(type => ['Product', 'Apartment', 'RealEstateListing', 'Residence'].includes(type));
    };
    const record = records.find(item => acceptedRecord(item)
        && (!item.url || sameDocumentUrl(item.url, canonicalUrl, pageUrl) || sameDocumentUrl(item.url, pageUrl, pageUrl)))
        || records.find(item => acceptedRecord(item)
            && (Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']]).includes('RealEstateListing')
            && sameOperetaProperty(item.url, pageUrl)) || {};
    const operetaListing = /^(?:www\.)?opereta\.hr$/i.test(new URL(pageUrl).hostname)
        && (Array.isArray(record['@type']) ? record['@type'] : [record['@type']]).includes('RealEstateListing');
    const operetaLabel = label => {
        const heading = $('main p').filter((_, el) => $(el).text().trim() === label).first();
        return heading.length ? heading.parent().parent().children('p').last().text().trim() : null;
    };
    const operetaId = operetaListing ? $('main p').map((_, el) => $(el).text().trim().match(/^ID\s+(I\d+)$/i)?.[1]).get()[0] || null : null;
    const operetaFloor = operetaListing ? operetaLabel('Etage') : null;
    const operetaArea = operetaListing ? operetaLabel('Größe') : null;
    const operetaAddress = operetaListing ? $('main h1').first().next('p').text().trim() || null : null;
    const mainCarousel = operetaListing ? $('main [data-slot="carousel"],main [aria-roledescription="carousel"]').first()[0] : null;
    const address = first(record.address && typeof record.address === 'object' ? first(record.address.streetAddress, record.address.name) : null, operetaAddress);
    const geo = record.geo || record.location?.geo;
    const propertyMap = $('#property-map[data-lat][data-lng]').first();
    // Interklasik emits its agency-office pin in every addressless listing's
    // JSON-LD. Its live page has no property address next to that GeoCoordinates
    // object, so it is not evidence for this property. Keep explicit page-map
    // coordinates and every other source's structured property coordinates.
    const unboundInterklasikGeo = new URL(pageUrl).hostname.replace(/^www\./i, '') === 'interklasik.hr' && !address;
    const lat = number(first(unboundInterklasikGeo ? null : geo?.latitude, propertyMap.attr('data-lat'))), lng = number(first(unboundInterklasikGeo ? null : geo?.longitude, propertyMap.attr('data-lng')));
    const text = `${bodyText} ${$('meta[name="description"]').attr('content') || ''}`;
    const listingTitle = first(record.name, $('meta[property="og:title"]').attr('content'), $('h1').first().text());
    const floor = first(record.floorLevel, record.floor, $('[data-floor]').first().attr('data-floor'), /^\d+(?:\/\d+)?$/.test(operetaFloor || '') ? operetaFloor : null);
    const recordId = operetaListing
        ? first(operetaId, record.identifier?.value, typeof record.identifier === 'object' ? null : record.identifier, record.sku)
        : first(record.identifier?.value, typeof record.identifier === 'object' ? null : record.identifier, record.sku, operetaId);
    const propertyElement = $('#property-view[data-propertyid], #property-view[data-property-id]').first();
    const wordpressPropertyId = $('body.single-property').attr('class')?.match(/(?:^|\s)postid-(\d+)(?:\s|$)/)?.[1] || null;
    const routePropertyId = sourceKind !== 'architecture' ? propertyDetailId(pageUrl) : null;
    let listing = (record['@type'] || record.url || address || record.identifier || propertyElement.length || wordpressPropertyId || routePropertyId) ? {
        title: listingTitle, sourceId: first(recordId, propertyElement.attr('data-propertyid'), propertyElement.attr('data-property-id'), wordpressPropertyId),
        address, coordinates: lat !== null && lng !== null ? { lat, lng } : null, floor,
        unitId: first(record.unitId, record.unitNumber, $('[data-unit-id]').first().attr('data-unit-id')),
        areaM2: number(first(record.floorSize?.value, record.floorSize, record.floorArea, record.size, record.floorSpace, $('[data-area]').first().attr('data-area'), /^\d+(?:[.,]\d+)?\s*m(?:2|²)$/i.test(operetaArea || '') ? operetaArea : null)),
        newBuild: /novograd|new\s*build|new\s*construction/i.test(`${listingTitle || ''} ${$('meta[name=description]').attr('content') || ''}`) ? true : null,
        projectName: first(record.isPartOf?.name, record.projectName, $('[data-project-name]').first().attr('data-project-name')),
        projectUrl: normalizeUrl(record.isPartOf?.url, pageUrl),
        locality: first(record.address?.addressLocality, record.address?.addressRegion)
    } : null;
    const developerProject = extractDeveloperProject($, pageUrl);
    if (developerProject) listing = { ...(listing || {}), title: developerProject.title,
        sourceId: first(listing?.sourceId, normalizeUrl(pageUrl, pageUrl)), sourceType: 'developer-project' };
    if (sourceKind === 'architecture') {
        const route = architectureDetailRoute(pageUrl, $);
        const fragmentId = route === 'njiric-fragment' ? new URL(pageUrl).searchParams.get('id') : null;
        const fragmentTitle = fragmentId ? $(`.tekst .projectlinkclose[name="${fragmentId}"]`).first().text().replace(/\s+/g, ' ').trim() : '';
        const architectureTitle = fragmentTitle || $('main h1,article h1,.section-project-title h1,.node-project h1.title,.node-project h1').first().text().replace(/\s+/g, ' ').trim();
        // An exact handler URL is still a project when its expected title is
        // missing or mismatched. Its absent location remains ineligible for
        // retention, rather than falling through as a generic HTML page.
        const projectDetail = route && (route === 'njiric-fragment' || !/^(?:projects?|projekti?|architecture|arhitektura|portfolio)$/i.test(architectureTitle));
        if (projectDetail) {
            const explicit = extractExplicitLocation(html, pageUrl, null, { document: $ });
            const title = architectureTitle || first($('meta[property="og:title"]').attr('content'), $('title').text())?.replace(/\s+/g, ' ').trim() || null;
            listing = { sourceType: 'architecture-project', title, sourceId: normalizeUrl(pageUrl),
                projectUrl: normalizeUrl(pageUrl), address: explicit?.address || null,
                addressEvidence: explicit || null, coordinates: null, floor: null, unitId: null,
                areaM2: null, newBuild: null, projectName: title, locality: architectureLocality($, pageUrl),
                projectStatus: architectureProjectStatus($, pageUrl) };
        } else listing = null;
    }
    if (listing) {
        const factText = propertyEvidenceText($, sourceKind);
        const propertyDetails = extractPropertyFacts({ record, title: listing.title || listingTitle || '',
            text: developerProject?.text || factText, sourceType: listing.sourceType || null });
        listing.propertyDetails = propertyDetails;
        if (propertyDetails.newBuild !== null) listing.newBuild = propertyDetails.newBuild;
    }
    // A retention audit still identifies every object, but generic pages do
    // not need their directory links and images enumerated again.
    if (!discovery && (!listing || !extractExplicitLocation(html, pageUrl, listing, { document: $ })))
        return { title: first($('title').text(), listingTitle), canonicalUrl,
            text: bodyText, links: [], assets: [], listing, blocked: false, blockedReason: null };
    const links = [], assets = [];
    if (discovery) $('a[href]').each((_, el) => { const url = normalizeUrl($(el).attr('href'), pageUrl); if (url) links.push({ url, text: $(el).text().replace(/\s+/g, ' ').trim(), kind: kindFor(url, $(el).text()) }); });
    // Njirić's own index script loads these named project cards from this exact
    // endpoint. The cards have empty hrefs, so ordinary link discovery misses them.
    if (discovery && sourceKind === 'architecture' && new URL(pageUrl).hostname.replace(/^www\./i, '') === 'njiric.com'
        && /^\/work\/all-projects\/?$/i.test(new URL(pageUrl).pathname)
        && $('script:not([src])').toArray().some(el => /\/Handlers\/Project\.ashx\?id=/i.test($(el).html() || ''))) {
        $('a.projectlink[name]').each((_, el) => {
            const id = $(el).attr('name');
            if (!/^p\d+$/i.test(id || '')) return;
            const url = normalizeUrl(`/Handlers/Project.ashx?id=${id}`, pageUrl);
            if (url) links.push({ url, text: $(el).text().replace(/\s+/g, ' ').trim(), kind: 'project' });
        });
    }
    const assetsByUrl = new Map();
    const addAsset = (el, raw, forcedKind = null) => {
        const url = normalizeUrl(raw, pageUrl), element = $(el);
        if (!url) return;
        const label = `${element.attr('alt') || ''} ${element.text()}`.trim();
        const parsedAssetUrl = new URL(url), parsedPageUrl = new URL(pageUrl);
        const sameSitePropertyPage = element.is('a[href]')
            && parsedAssetUrl.hostname.replace(/^www\./i, '') === parsedPageUrl.hostname.replace(/^www\./i, '')
            && /^\/(?:[a-z]{2}\/)?(?:nekretnina|property)(?:\/|$)/i.test(parsedAssetUrl.pathname)
            && !/\.(?:pdf|png|jpe?g|webp|avif)(?:$|[?#])/i.test(url);
        // Unit/detail pages are navigable HTML even when their anchor says “Tlocrt”.
        // Their actual drawings are discovered from the child page itself; the
        // Eurovilla blueprint handler below still enters through forcedKind.
        if (!forcedKind && sameSitePropertyPage) return;
        if (!forcedKind && !/\.(?:pdf|png|jpe?g|webp|avif)(?:$|[?#])/i.test(url) && !PLAN_WORD.test(`${url} ${label}`)) return;
        const pdf = /\.pdf(?:$|[?#])/i.test(url);
        const { gallery } = galleryMembership(element, mainCarousel);
        const planAsset = PLAN_WORD.test(`${url} ${label}`) || PLAN_LABEL.test(`${url} ${label}`);
        const kind = forcedKind || (pdf ? (planAsset ? 'floor-plan' : 'document') : imageKind(url, label));
        const asset = { url, kind, evidence: label || null,
            ...assetOwnership($, el, listing, pageUrl, url, label, forcedKind, mainCarousel), ...(gallery ? { listingGallery: true } : {}) };
        const previous = assetsByUrl.get(url);
        // The same image can appear in both a card and the main gallery.
        if (!previous || asset.listingOwned && !previous.listingOwned) assetsByUrl.set(url, asset);
    };
    $('img[src], img[data-src], source[srcset], source[data-srcset], a[href]').each((_, el) => {
        const element = $(el);
        const raw = element.attr('src') || element.attr('data-src') || element.attr('href');
        if (raw) addAsset(el, raw);
        const srcset = element.attr('srcset') || element.attr('data-srcset') || '';
        const candidates = srcset.split(',').map(candidate => candidate.trim().split(/\s+/)[0]).filter(Boolean);
        const eurovillaCandidates = candidates.filter(candidate => EUROVILLA_PHOTO.test(normalizeUrl(candidate, pageUrl) || ''));
        if (eurovillaCandidates.length) eurovillaCandidates.forEach(candidate => addAsset(el, candidate));
        else if (!raw && candidates.length) addAsset(el, candidates[0]);
    });
    // Eurovilla's ordinary plan button uses this public URL in its click handler.
    // Keep the exact data-bp value; the fetcher follows the site's redirect to bytes.
    if (/(^|\.)eurovilla\.hr$/i.test(new URL(pageUrl).hostname)) {
        $('a.property-blueprint[data-bp]').each((_, el) => {
            const bp = $(el).attr('data-bp'), handler = $(el).attr('onclick') || '';
            if (bp && handler.includes("api+'blueprint/?link='+this.dataset.bp")) {
                addAsset(el, new URL(`/api/blueprint/?link=${encodeURIComponent(bp)}`, pageUrl).href, 'floor-plan');
            }
        });
    }
    assets.push(...groupEurovillaPhotoVariants([...assetsByUrl.values()]));
    // Membership is taken only from the project's own unit table, never recommendation cards.
    const projectListings=[];
    if (/\/(?:projekt|project)\//i.test(new URL(pageUrl).pathname)) {
        $('#property-project-items-table tr a[href]').each((_, link) => {
            const url=normalizeUrl($(link).attr('href'),pageUrl);
            if(url && new URL(url).hostname===new URL(pageUrl).hostname && /\/(?:nekretnina|property)\//i.test(new URL(url).pathname)) {
                if(!projectListings.some(item=>item.url===url)) projectListings.push({url});
            }
        });
    }
    return { title: first($('title').text(), listingTitle), canonicalUrl, text: bodyText, links, assets, listing,
        ...(projectListings.length?{projectListings}:{}), blocked: false, blockedReason: null };
}
