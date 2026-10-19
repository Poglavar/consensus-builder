// Merge source-backed apartment facts and reviewed plans for one located project. Language aliases
// are one posting; absent measurements and conflicting construction years remain unknown.
import { createHash } from 'node:crypto';
import { listingIdentity } from './explicit-location.js';
import { extractPropertyFacts } from './property-facts.js';
import { hasUsableGeometry, listingUnitId, normalizeUnitId } from './original-plan-sources.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = value => finite(value) !== null && value > 0 ? value : null;
const one = values => { const unique = [...new Set(values.filter(v => v !== null && v !== undefined && v !== ''))]; return unique.length === 1 ? unique[0] : null; };
const details = facts => facts.propertyDetails || extractPropertyFacts({ title: facts.title || '', sourceType: facts.sourceType });
const identity = row => {
    const url = new URL(row.url), id = url.pathname.match(/\/(\d{5,10})\/?$/)?.[1];
    // Eurovilla changes the translated slug and route, retaining its own numeric property ID.
    if (url.hostname.replace(/^www\./, '') === 'eurovilla.hr' && id && String(row.facts?.sourceId) === id)
        return `eurovilla:${id}`;
    return listingIdentity(row.url, row.facts?.sourceId) || row.url;
};
const floorNumber = value => Number.isInteger(value) ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : null;
const languageRank = row => /\/nekretnina\/|\/hr\//.test(new URL(row.url).pathname) ? 0 : /\/en\//.test(new URL(row.url).pathname) ? 2 : /^\/[a-z]{2}\//.test(new URL(row.url).pathname) ? 3 : 1;
const sourceOrder = (a, b) => languageRank(a) - languageRank(b) || a.url.localeCompare(b.url);

export function projectSources(postings) {
    const sources = new Map();
    for (const posting of [...postings].sort(sourceOrder)) {
        const key = identity(posting);
        if (!sources.has(key)) sources.set(key, { url: posting.url, label: posting.facts?.title || new URL(posting.url).hostname });
    }
    return [...sources.values()];
}

export function constructionSummary(postings, { year = new Date().getUTCFullYear() } = {}) {
    const evidence = postings.map(row => ({ ...details(row.facts || {}), url: row.url, advertisedNew: row.facts?.newBuild }));
    const constructionYear = one(evidence.map(p => p.constructionYear));
    const completionYear = one(evidence.map(p => p.completionYear));
    const explicitNew = evidence.some(p => p.newBuild === true || p.advertisedNew === true);
    const explicitOld = evidence.some(p => p.newBuild === false);
    // A dated older building cannot become a new build just because a posting says "new".
    // Recent completion alone is not evidence that a resale is advertised as a new build.
    const datedOld = constructionYear !== null && constructionYear < year - 5;
    const kind = datedOld || (explicitOld && !explicitNew) ? 'existing'
        : explicitNew || (completionYear !== null && completionYear >= year) ? 'new_build'
            : constructionYear !== null && constructionYear < year ? 'existing' : 'unknown';
    return { kind, constructionYear, completionYear,
        yearEvidence: evidence.filter(p => p.constructionYear || p.completionYear).map(p => ({ url: p.url,
            constructionYear: p.constructionYear, completionYear: p.completionYear, evidence: p.evidence })),
        conflicts: [new Set(evidence.map(p => p.constructionYear).filter(Boolean)).size > 1 ? 'conflicting-construction-years' : null,
            explicitNew && datedOld ? 'new-build-claim-on-older-building' : null].filter(Boolean) };
}

export function projectInventory(postings, plans, options = {}) {
    const groups = new Map(), planGroups = new Map();
    for (const posting of postings) {
        const key = identity(posting);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(posting);
    }
    for (const plan of plans) {
        if (plan.model?.scope === 'floor' || (!plan.model?.unitId && plan.model?.scope !== 'unit')) continue;
        const listing = postings.find(p => p.url === plan.listing_url);
        const key = listing ? identity(listing) : plan.listing_url || plan.id;
        if (!groups.has(key)) groups.set(key, []);
        if (!planGroups.has(key)) planGroups.set(key, []);
        planGroups.get(key).push(plan);
    }
    const apartments = [];
    for (const [key, aliases] of groups) {
        aliases.sort(sourceOrder);
        const facts = aliases.map(p => ({ ...p.facts, propertyDetails: details(p.facts || {}) }));
        const ownedPlans = [...(planGroups.get(key) || [])].sort((a, b) => {
            const rank = plan => hasUsableGeometry(plan.model) ? (plan.kind === 'reviewed' ? 0 : 1) : plan.kind === 'original' ? 2 : 3;
            return rank(a) - rank(b) || Number(Boolean(b.model?.unitId)) - Number(Boolean(a.model?.unitId))
                || (b.byte_count || 0) - (a.byte_count || 0) || a.id.localeCompare(b.id);
        });
        // Commercial premises, houses and portfolio building pages are not apartment offers.
        if (!ownedPlans.length && !facts.some(f => f.propertyDetails.propertyType === 'apartment')) continue;
        const choices = ownedPlans.length ? ownedPlans : [null];
        for (const plan of choices) {
            const model = plan?.model || {};
            const sameSourceUnits = ownedPlans.filter(p => p.sha256 === plan?.sha256
                && (p.model?.source?.page || 1) === (model.source?.page || 1)).map(p => p.model?.unitId);
            const listingUnit = one(aliases.map(p => listingUnitId(p.facts, p.url)));
            // Unreviewed region names are not public apartment identities when the offer names it.
            const generatedUnit = plan?.kind !== 'reviewed' && /^(?:plan|unit|apartment|region)[\s_-]/i.test(model.unitId || '');
            const establishedUnit = listingUnit || one(ownedPlans.filter(p => ['original', 'reviewed'].includes(p.kind)).map(p => p.model?.unitId));
            // A reader's sole generic region name does not rename an unnamed apartment offer.
            // Retain the original's null unit and stable link when its geometry becomes available.
            const unnamedOriginal = !establishedUnit && (generatedUnit || plan?.kind === 'original')
                && ownedPlans.some(p => p.kind === 'original' && !p.model?.unitId)
                && new Set(ownedPlans.map(p => p.model?.unitId).filter(Boolean)).size === 1
                && ownedPlans.map(p => p.model?.unitId).filter(Boolean).every(unit => /^(?:plan|unit|apartment|region)[\s_-]/i.test(unit));
            const candidateUnit = unnamedOriginal ? null
                : (generatedUnit && establishedUnit ? establishedUnit : model.unitId) || listingUnit || one(sameSourceUnits)
                    || one(ownedPlans.map(p => p.model?.unitId));
            const equivalent = kind => ownedPlans.find(p => p.kind === kind && p.model?.unitId
                && normalizeUnitId(p.model.unitId) === normalizeUnitId(candidateUnit))?.model.unitId;
            // Reviewed spelling wins; otherwise preserve an original's published ID across machine
            // casing/punctuation variants. Geometry-only records keep their historical raw IDs.
            const unit = equivalent('reviewed') || (plan?.kind !== 'reviewed' && equivalent('original')) || candidateUnit;
            const id = hash(`${key}|${unit || 'apartment'}`);
            const hasGeometry = hasUsableGeometry(model);
            const property = facts.map(f => f.propertyDetails);
            const marketedArea = one(facts.map(f => positive(f.areaM2)));
            const physicalNetAreaM2 = positive(model.physicalNetAreaM2);
            const area = marketedArea ?? positive(model.areaM2) ?? physicalNetAreaM2;
            const sources = [...new Set(aliases.map(p => p.url).concat(plan?.listing_url || []).filter(Boolean))];
            const apartment = { id, label: unit ? `Stan ${unit}` : 'Stan', unitId: unit || null,
                areaM2: area, areaBasis: marketedArea !== null ? 'advertised' : positive(model.areaM2) ? 'plan' : 'net-plan',
                marketedAreaM2: marketedArea, physicalNetAreaM2,
                rooms: one(property.map(p => positive(p.roomCount))),
                orientation: [...new Set(property.flatMap(p => p.orientation || []))].sort(),
                floor: floorNumber(model.floor) ?? one(facts.map(f => floorNumber(f.floor))),
                hasPlan: hasGeometry || plan?.kind === 'original', hasGeometry, planId: plan?.id || null,
                architecture: hasGeometry ? model.architecture : null, roomSchedule: model.rooms || [],
                source: plan ? { url: model.source?.url || null, sha256: plan.sha256,
                    page: model.source?.page || 1, assetUrl: null } : null,
                originalSources: plan?.kind === 'original' ? [{ url: model.source?.url, sha256: plan.sha256,
                    page: model.source?.page || 1, mediaType: plan.media_type || null }] : [],
                sourceUrls: sources, postingUrl: sources[0] || null, sourceTitle: facts.find(f => f.title)?.title || null,
                reviewStatus: plan?.reviewStatus || (plan?.kind === 'reviewed' ? 'reviewed' : plan ? 'needs_review' : null),
                issues: model.quality?.issues || [], scaleEstimated: model.source?.scaleEstimated === true,
                scaleBasis: model.source?.scaleBasis || null };
            const previous = apartments.find(a => a.id === id);
            if (!previous) apartments.push(apartment);
            else {
                previous.sourceUrls = [...new Set([...previous.sourceUrls, ...sources])];
                previous.originalSources.push(...apartment.originalSources.filter(source => !previous.originalSources.some(existing =>
                    existing.url === source.url && existing.sha256 === source.sha256 && existing.page === source.page)));
            }
        }
    }
    const propertyTypes = postings.map(p => details(p.facts || {}).propertyType);
    const residential = apartments.length > 0 || propertyTypes.some(t => ['residential', 'house'].includes(t));
    const excludedUse = !residential && propertyTypes.length > 0 && propertyTypes.every(t => ['commercial', 'other'].includes(t));
    return { ...constructionSummary(postings, options), residential, excludedUse,
        name: one(postings.map(p => p.facts?.projectName)) || null,
        titles: [...new Set(postings.map(p => p.facts?.title).filter(Boolean))].slice(0, 30),
        sourceCount: groups.size, apartments: apartments.sort((a, b) => a.label.localeCompare(b.label, 'hr') || a.id.localeCompare(b.id)) };
}
