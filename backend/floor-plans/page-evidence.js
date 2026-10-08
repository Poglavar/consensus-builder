// Conservative, source-backed HTML evidence extraction; never invents property facts.
import * as cheerio from 'cheerio';

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i;
const PLAN_WORD = /(tlocrt|floor[._ -]?plans?|ground[._ -]?plans?|blueprints?|etažni|etazni|tlocrti)/i;
const PLAN_LABEL = /\b(?:plan|tlocrt)\b/i;
const BLOCKED = /(captcha|cloudflare|access denied|verify you are human|robot check|too many requests|temporarily blocked|just a moment|checking your browser)/i;
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

// A page may embed whole project tables and recommendation cards. Discovery is
// page-wide, but a plan belongs to the main listing only when its local owner agrees.
function assetOwnership($, el, listing, pageUrl, url, label, forcedKind = null) {
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
        || /(?:privacy|privatnost|datenschutz|gdpr|cookie|osobni-podaci)/i.test(context);
    const recommendation = element.closest(`.item-wrap,.property-project-items-table tr,
        [class*="related-property" i],[class*="similar-property" i],[class*="recommendation" i]`).length > 0;
    const gallery = element.closest(`[class*=gallery],[class*=Gallery],[class*=carousel],[class*=Carousel],
        [class*=swiper],[class*=Swiper],[class*=slider],[class*=Slider]`).length > 0;
    const floorPlan = forcedKind === 'floor-plan' || PLAN_WORD.test(context) || PLAN_LABEL.test(context);
    const explicitMatch = ownerSourceId ? String(ownerSourceId) === String(listing?.sourceId)
        : ownerListingUrl ? sameDocumentUrl(ownerListingUrl, pageUrl, pageUrl)
            : false;
    const hasConflictingOwner = Boolean(ownerSourceId || ownerListingUrl) && !explicitMatch;
    const listingOwned = Boolean(listing) && !globalArtifact && !hasConflictingOwner
        && (explicitMatch || (!recommendation && !row.length && (gallery || floorPlan)));
    return { listingOwned, ...(ownerSourceId ? { ownerSourceId } : {}), ...(ownerListingUrl ? { ownerListingUrl } : {}) };
}

export function extractPageEvidence(html, pageUrl) {
    const $ = cheerio.load(String(html || ''));
    const visible = $('body').clone(); visible.find('script,style,noscript,nav,footer,form').remove();
    const bodyText = visible.text().replace(/\s+/g, ' ').trim();
    if (BLOCKED.test(`${$('title').text()} ${bodyText}`)) return { title: first($('title').text()), canonicalUrl: normalizeUrl($('link[rel="canonical"]').attr('href'), pageUrl) || normalizeUrl(pageUrl, pageUrl), text: bodyText, links: [], assets: [], listing: null, blocked: true, blockedReason: 'challenge-or-access-block' };
    const canonicalUrl = normalizeUrl($('link[rel="canonical"]').attr('href'), pageUrl) || normalizeUrl(pageUrl, pageUrl);
    const scripts = jsonScripts($), records = scripts.flatMap(item => item?.['@graph'] || item);
    const record = records.find(item => { const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']]; return types.some(type => ['Product', 'Apartment', 'RealEstateListing', 'Residence'].includes(type)) && (!item.url || sameDocumentUrl(item.url, canonicalUrl, pageUrl) || sameDocumentUrl(item.url, pageUrl, pageUrl)); }) || {};
    const address = record.address && typeof record.address === 'object' ? first(record.address.streetAddress, record.address.name) : null;
    const geo = record.geo || record.location?.geo;
    const propertyMap = $('#property-map[data-lat][data-lng]').first();
    const lat = number(first(geo?.latitude, propertyMap.attr('data-lat'))), lng = number(first(geo?.longitude, propertyMap.attr('data-lng')));
    const text = `${bodyText} ${$('meta[name="description"]').attr('content') || ''}`;
    const listingTitle = first(record.name, $('meta[property="og:title"]').attr('content'), $('h1').first().text());
    const floor = first(record.floorLevel, record.floor, $('[data-floor]').first().attr('data-floor'));
    const recordId = first(record.identifier?.value, typeof record.identifier === 'object' ? null : record.identifier, record.sku);
    const propertyElement = $('#property-view[data-propertyid], #property-view[data-property-id]').first();
    const wordpressPropertyId = $('body.single-property').attr('class')?.match(/(?:^|\s)postid-(\d+)(?:\s|$)/)?.[1] || null;
    const listing = (record['@type'] || record.url || address || record.identifier || propertyElement.length || wordpressPropertyId) ? {
        title: listingTitle, sourceId: first(recordId, propertyElement.attr('data-propertyid'), propertyElement.attr('data-property-id'), wordpressPropertyId),
        address, coordinates: lat !== null && lng !== null ? { lat, lng } : null, floor,
        unitId: first(record.unitId, record.unitNumber, $('[data-unit-id]').first().attr('data-unit-id')),
        areaM2: number(first(record.floorSize?.value, record.floorSize, record.floorArea, record.size, record.floorSpace, $('[data-area]').first().attr('data-area'))),
        newBuild: /novograd|new\s*build|new\s*construction/i.test(`${listingTitle || ''} ${$('meta[name=description]').attr('content') || ''}`) ? true : null,
        projectName: first(record.isPartOf?.name, record.projectName, $('[data-project-name]').first().attr('data-project-name')),
        projectUrl: normalizeUrl(record.isPartOf?.url, pageUrl),
        locality: first(record.address?.addressLocality, record.address?.addressRegion)
    } : null;
    const links = [], assets = [];
    $('a[href]').each((_, el) => { const url = normalizeUrl($(el).attr('href'), pageUrl); if (url) links.push({ url, text: $(el).text().replace(/\s+/g, ' ').trim(), kind: kindFor(url, $(el).text()) }); });
    const assetsByUrl = new Map();
    const addAsset = (el, raw, forcedKind = null) => {
        const url = normalizeUrl(raw, pageUrl), element = $(el);
        if (!url) return;
        const label = `${element.attr('alt') || ''} ${element.text()}`.trim();
        if (!forcedKind && !/\.(?:pdf|png|jpe?g|webp|avif)(?:$|[?#])/i.test(url) && !PLAN_WORD.test(`${url} ${label}`)) return;
        const pdf = /\.pdf(?:$|[?#])/i.test(url);
        const gallery = element.closest('[class*=gallery],[class*=Gallery],[class*=carousel],[class*=swiper],[class*=slider]').length > 0;
        const planAsset = PLAN_WORD.test(`${url} ${label}`) || PLAN_LABEL.test(`${url} ${label}`);
        const kind = forcedKind || (pdf ? (planAsset ? 'floor-plan' : 'document') : imageKind(url, label));
        const asset = { url, kind, evidence: label || null,
            ...assetOwnership($, el, listing, pageUrl, url, label, forcedKind), ...(gallery ? { listingGallery: true } : {}) };
        const previous = assetsByUrl.get(url);
        // The same image can appear in both a card and the main gallery.
        if (!previous || asset.listingOwned && !previous.listingOwned) assetsByUrl.set(url, asset);
    };
    $('img[src], img[data-src], source[srcset], source[data-srcset], a[href]').each((_, el) => {
        const element = $(el);
        const raw = element.attr('src') || element.attr('data-src') || element.attr('href') || (element.attr('srcset') || element.attr('data-srcset') || '').split(',')[0].trim().split(' ')[0];
        addAsset(el, raw);
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
    assets.push(...assetsByUrl.values());
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
