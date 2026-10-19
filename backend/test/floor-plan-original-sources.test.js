import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { listingIdentity } from '../floor-plans/explicit-location.js';
import { currentOriginalPlans, hasUsableGeometry, listingUnitId, originalPlanSource, sourceUnitMatches } from '../floor-plans/original-plan-sources.js';
import { projectInventory } from '../floor-plans/project-inventory.js';
import { sitePlans, siteModel } from '../floor-plans/site-model.js';

const sha = 'a'.repeat(64), listingUrl = 'https://example.test/stan-s10-73m2/';
const sourceUrl = 'https://example.test/images/plan-s10.png';
const source = (overrides = {}) => ({ listing_url: listingUrl, source_url: sourceUrl,
    sha256: sha, current_sha256: sha, image_classified_sha256: sha,
    bytes_available: true, media_type: 'image/png', location_status: 'located',
    asset: { url: sourceUrl, listingOwned: true }, facts: { title: 'Stan', propertyDetails: { propertyType: 'apartment' } },
    image_kind: 'floor_plan', image_status: 'complete', reading: { kind: 'floor_plan', containsPlan: true, confidence: 'high' }, ...overrides });
const architecture = { dimensionsM: [10, 10], slabs: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]],
    walls: [[[[0, 0], [1, 0], [1, .02], [0, .02]]]], openings: [] };
const geometry = (model = {}) => ({ id: 'geometry', kind: 'machine', listing_url: listingUrl, sha256: sha,
    model: { scope: 'unit', unitId: 'S10', architecture, source: { url: sourceUrl, page: 1 }, ...model } });
const posting = { url: listingUrl, facts: source().facts };

describe('current original plan eligibility', () => {
    it('distinguishes marketed square metres from a unit identifier in real offer titles', () => {
        const facts = { title: 'Trosoban stan 73 m² na 3. katu - Bolnička cesta 37, Vrapče' };
        expect(listingUnitId(facts, listingUrl)).toBe('S10');
        expect(listingUnitId({ title: 'Stan 73m2' })).toBeNull();
        expect(sourceUnitMatches(facts, listingUrl, 'https://example.test/s3-438x280.jpg')).toBe(false);
        expect(sourceUnitMatches(facts, listingUrl, 'https://example.test/s10-1800x1150.jpg')).toBe(true);
        expect(originalPlanSource(source({ facts: { ...facts, propertyDetails: { propertyType: 'apartment' } },
            source_url: 'https://example.test/s3-438x280.jpg', asset: { url: 'https://example.test/s3-438x280.jpg', listingOwned: true } }))).toBeNull();
    });
    it.each([
        'https://eurovilla.hr/nekretnina/zagreb-maksimir-stan-80-58-m2/123456/',
        'https://eurovilla.hr/en/property/zagreb-apartment-80-58-m2/123456/',
        'https://eurovilla.hr/nekretnina/zagreb-stan-73-m2/123456/',
        'https://eurovilla.hr/nekretnina/zagreb-stan-80,58-m2/123456/',
    ])('does not invent a unit from Eurovilla marketed area in %s', url => {
        expect(listingUnitId({ title: 'Zagreb, stan 80,58 m²' }, url)).toBeNull();
        expect(sourceUnitMatches({}, url, 'https://example.test/s2.png')).toBe(true);
    });
    it('keeps Nobel S2 when an adjacent marketed area is scrubbed from its slug', () => {
        const url = 'https://gradnja.nobelgrupa.hr/stan-s2-80-58-m2/';
        expect(listingUnitId({ title: 'Stan 80,58 m²' }, url)).toBe('S2');
        expect(sourceUnitMatches({}, url, 'https://example.test/s2-1800x1150.jpg')).toBe(true);
        expect(sourceUnitMatches({}, url, 'https://example.test/s3-1800x1150.jpg')).toBe(false);
    });
    it('admits a retained classified apartment drawing and derives explicit listing URL unit identity', () => {
        expect(originalPlanSource(source())).toMatchObject({ kind: 'original', sha256: sha, reviewStatus: 'source_only',
            model: { scope: 'unit', unitId: 'S10', architecture: null, source: { url: sourceUrl, sha256: sha, page: 1 } } });
    });
    it.each([
        { current_sha256: 'b'.repeat(64) }, { bytes_available: false }, { image_classified_sha256: 'b'.repeat(64) },
        { image_kind: 'uncertain' }, { image_status: 'needs_review' }, { reading: { kind: 'floor_plan', containsPlan: true, confidence: 'low' } },
        { reading: { kind: 'photo', containsPlan: true, confidence: 'high' } }, { reading: null },
        { asset: { url: sourceUrl, listingOwned: false } }, { asset: { url: 'https://example.test/other', listingOwned: true } },
        { location_status: 'unlocated' }, { facts: { sourceEvidenceStatus: 'excluded', propertyDetails: { propertyType: 'apartment' } } },
        { facts: { sourceEvidenceStatus: 'not-a-listing', propertyDetails: { propertyType: 'apartment' } } },
        { facts: { sourceType: 'developer-project', propertyDetails: { propertyType: 'residential' } } },
        { facts: { sourceType: 'architecture-project', propertyDetails: { propertyType: 'apartment' } } },
        { facts: { sourceType: 'developer-project', propertyDetails: { propertyType: 'apartment' } } },
        { facts: { propertyDetails: { propertyType: 'commercial' } } },
        { reviewed_model: { scope: 'floor' } }, { asset: { url: sourceUrl, listingOwned: true, scope: 'building' } },
    ])('rejects stale, untrusted, unrelated-use or whole-floor evidence: %j', override => {
        expect(originalPlanSource(source(override))).toBeNull();
    });
    it.each(['s3', 's6', 's9', 'garage', 'garrage-1800x1150', 'garaza', 'floor'])('rejects related %s drawings owned by the S10 posting', name => {
        const url = `https://example.test/images/${name}.png`;
        expect(originalPlanSource(source({ source_url: url, asset: { url, listingOwned: true } }))).toBeNull();
    });
    it.each(['s1-2d-floor-plan-1800x1150.jpg', 's1-3d-floor-plan-1800x1150.jpg'])('admits the explicitly named apartment floor plan %s', name => {
        const url = `https://example.test/images/${name}`;
        const row = source({ listing_url: 'https://example.test/stan-s1-50m2/', source_url: url,
            asset: { url, listingOwned: true } });
        expect(originalPlanSource(row)).toMatchObject({ model: { unitId: 'S1', scope: 'unit' } });
        expect(originalPlanSource({ ...row, listing_url: listingUrl })).toBeNull();
        expect(originalPlanSource({ ...row, asset: { ...row.asset, scope: 'floor' } })).toBeNull();
    });
    it('allows an unnumbered source owned by an apartment offer without inventing a unit number', () => {
        const row = source({ listing_url: 'https://example.test/apartment/123', source_url: 'https://example.test/plan.png',
            asset: { url: 'https://example.test/plan.png', listingOwned: true } });
        expect(originalPlanSource(row).model.unitId).toBeNull();
    });
    it('requires reviewed unit and explicit page evidence for PDFs', () => {
        const pdf = source({ media_type: 'application/pdf' });
        expect(originalPlanSource(pdf)).toBeNull();
        expect(originalPlanSource({ ...pdf, review_status: 'reviewed', reviewed_model: { scope: 'unit', unitId: 'S10', source: { page: 2 } } }))
            .toMatchObject({ model: { unitId: 'S10', source: { page: 2 } } });
        expect(originalPlanSource({ ...pdf, review_status: 'reviewed', reviewed_model: { scope: 'unit', unitId: 'S10' } })).toBeNull();
        expect(originalPlanSource({ ...pdf, review_status: 'reviewed', reviewed_model: { scope: 'floor', unitId: 'S10', source: { page: 2 } } })).toBeNull();
    });
    it('queries current listing ownership, retention, exclusions and the current classifier within the requested URLs', async () => {
        const calls = [], db = { async query(sql, params) { calls.push([sql, params]); return { rows: sql.includes('CROSS JOIN LATERAL') ? [source(), source(), source({ bytes_available: false })] : [] }; } };
        expect(await currentOriginalPlans(db, [])).toEqual([]);
        expect(calls).toHaveLength(0);
        expect(await currentOriginalPlans(db, [listingUrl])).toHaveLength(1);
        expect(calls[0][1]).toEqual([[listingUrl], 'listing-image-kind-v2']);
        expect(calls[0][0]).toContain("l.location_status IN ('located','probable')");
        expect(calls[0][0]).toContain('AND b.bytes_available');
        expect(calls[0][0]).toContain('floor_plan.exclusion');
    });
});

describe('original and geometry inventory selection', () => {
    it('keeps an unnumbered alternate drawing of the same apartment offer with its sole identified unit', () => {
        const url = 'https://example.test/apartment/123';
        const original = originalPlanSource(source({ listing_url: url, source_url: 'https://example.test/plan.png',
            asset: { url: 'https://example.test/plan.png', listingOwned: true } }));
        const numbered = { ...geometry({ unitId: 'S1-3' }), listing_url: url };
        const inventory = projectInventory([{ ...posting, url }], [original, numbered]);
        expect(inventory.apartments).toHaveLength(1);
        expect(inventory.apartments[0]).toMatchObject({ unitId: 'S1-3', hasPlan: true });
    });
    it('prefers the full original over a smaller gallery thumbnail of the same unit', () => {
        const original = originalPlanSource(source({ byte_count: 200000 }));
        const thumbnail = { ...original, id: 'original-0000', sha256: 'b'.repeat(64), byte_count: 20000 };
        const apartment = projectInventory([posting], [thumbnail, original]).apartments[0];
        expect(apartment.source.sha256).toBe(sha);
        expect(apartment.originalSources).toHaveLength(2);
    });
    it('preserves existing hyphenated geometry apartment deep-link IDs', () => {
        const key = listingIdentity(posting.url, posting.facts.sourceId) || posting.url;
        const expected = createHash('sha256').update(`${key}|A-5-2`).digest('hex').slice(0, 16);
        expect(projectInventory([posting], [geometry({ unitId: 'A-5-2' })]).apartments[0].id).toBe(expected);
    });
    it('inherits the exact intrinsic source unit from current processed evidence even when its geometry is held', async () => {
        const url = 'https://example.test/apartment/123', imageUrl = 'https://example.test/189201.png';
        const row = source({ listing_url: url, source_url: imageUrl, asset: { url: imageUrl, listingOwned: true } });
        const held = { ...geometry({ unitId: 'S1-3', floor: 1, quality: { issues: ['Wall geometry extends outside the slab outline.'] } }),
            source_sha256: sha, listing_url: url, page: 1 };
        const db = { async query() { return { rows: [row] }; } };
        const [original] = await currentOriginalPlans(db, [url], { processedPlans: [held] });
        expect(original.model.unitId).toBe('S1-3');
        expect(original.model.floor).toBe(1);
        const offer = { ...posting, url };
        const before = projectInventory([offer], [held, original]).apartments;
        const after = projectInventory([offer], [{ ...held, model: { ...held.model, quality: { issues: [] } } }, original]).apartments;
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ unitId: 'S1-3', hasPlan: true, hasGeometry: false });
        expect(after[0]).toMatchObject({ id: before[0].id, unitId: 'S1-3', hasGeometry: true });
        expect(before[0].issues).toEqual(['Wall geometry extends outside the slab outline.']);
        expect(await currentOriginalPlans(db, [url], { processedPlans: [{ ...held, source_sha256: 'b'.repeat(64) }] }))
            .toMatchObject([{ model: { unitId: null } }]);
        const conflict = source({ processed_model: held.model });
        expect(originalPlanSource(conflict)).toMatchObject({ model: { unitId: 'S10' } });
        expect(originalPlanSource({ ...conflict, reviewed_model: held.model })).toBeNull();
    });
    it.each(['plan-1', 'unit-S2'])('keeps published S2 identity after reconstruction uses %s', async generatedId => {
        const url = 'https://gradnja.nobelgrupa.hr/stan-s2-80-58-m2/', imageUrl = 'https://gradnja.nobelgrupa.hr/images/s2.png';
        const row = source({ listing_url: url, source_url: imageUrl, asset: { url: imageUrl, listingOwned: true } });
        const model = { ...geometry({ unitId: generatedId }), source_sha256: sha, listing_url: url, page: 1 };
        const db = { async query() { return { rows: [row] }; } };
        const [beforeSource] = await currentOriginalPlans(db, [url], { processedPlans: [] });
        const [afterSource] = await currentOriginalPlans(db, [url], { processedPlans: [model] });
        expect(afterSource).toMatchObject({ id: beforeSource.id, model: { unitId: 'S2' } });
        const offer = { ...posting, url };
        const before = projectInventory([offer], [beforeSource]).apartments[0];
        const after = projectInventory([offer], [afterSource, model]).apartments;
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id: before.id, unitId: 'S2', hasGeometry: true });
    });
    it.each(['s2', 'S-2'])('preserves original-established S2 through equivalent machine spelling %s', async unitId => {
        const url = 'https://gradnja.nobelgrupa.hr/stan-s2-80-58-m2/', imageUrl = 'https://example.test/s2.png';
        const row = source({ listing_url: url, source_url: imageUrl, asset: { url: imageUrl, listingOwned: true } });
        const model = { ...geometry({ unitId }), source_sha256: sha, listing_url: url, page: 1 };
        const db = { async query() { return { rows: [row] }; } };
        const [beforeSource] = await currentOriginalPlans(db, [url], { processedPlans: [] });
        const [afterSource] = await currentOriginalPlans(db, [url], { processedPlans: [model] });
        expect(afterSource).toMatchObject({ id: beforeSource.id, model: { unitId: 'S2' } });
        const offer = { ...posting, url };
        const before = projectInventory([offer], [beforeSource]).apartments[0];
        for (const plans of [[afterSource, model], [model, afterSource]]) {
            const after = projectInventory([offer], plans).apartments;
            expect(after).toHaveLength(1);
            expect(after[0]).toMatchObject({ id: before.id, unitId: 'S2', hasGeometry: true });
        }
    });
    it('retains geometry-only raw spelling but lets reviewed spelling win over equivalent originals', () => {
        const offer = { ...posting, facts: { ...posting.facts, unitId: 'A52' } };
        const machine = geometry({ unitId: 'A-5-2' });
        const key = listingIdentity(offer.url, offer.facts.sourceId) || offer.url;
        const expected = createHash('sha256').update(`${key}|A-5-2`).digest('hex').slice(0, 16);
        expect(projectInventory([offer], [machine]).apartments[0]).toMatchObject({ id: expected, unitId: 'A-5-2' });
        const url = 'https://example.test/curated.png';
        const original = originalPlanSource(source({ facts: offer.facts, source_url: url, asset: { url, listingOwned: true } }));
        expect(projectInventory([offer], [machine, original]).apartments).toMatchObject([{ unitId: 'A52' }]);
        const reviewed = { ...machine, kind: 'reviewed' };
        const apartments = projectInventory([offer], [original, reviewed]).apartments;
        expect(apartments).toHaveLength(1);
        expect(apartments[0]).toMatchObject({ id: expected, unitId: 'A-5-2' });
    });
    it('preserves a curated raw unit ID equivalent to the explicit listing unit', () => {
        const offer = { ...posting, facts: { ...posting.facts, unitId: 'A52' } };
        const curated = { ...geometry({ unitId: 'A-5-2' }), kind: 'reviewed' };
        const key = listingIdentity(offer.url, offer.facts.sourceId) || offer.url;
        const expected = createHash('sha256').update(`${key}|A-5-2`).digest('hex').slice(0, 16);
        expect(projectInventory([offer], [curated]).apartments[0]).toMatchObject({ id: expected, unitId: 'A-5-2' });
        const url = 'https://example.test/curated.png';
        expect(originalPlanSource(source({ facts: offer.facts, source_url: url, asset: { url, listingOwned: true },
            reviewed_model: curated.model })).model.unitId).toBe('A-5-2');
    });
    it('keeps apartment identity when reconstruction becomes available and prefers geometry in either input order', () => {
        const original = originalPlanSource(source()), reconstructed = geometry();
        const before = projectInventory([posting], [original]).apartments[0];
        expect(before).toMatchObject({ hasPlan: true, hasGeometry: false, architecture: null });
        for (const plans of [[original, reconstructed], [reconstructed, original]]) {
            const apartments = projectInventory([posting], plans).apartments;
            expect(apartments).toHaveLength(1);
            expect(apartments[0]).toMatchObject({ id: before.id, hasPlan: true, hasGeometry: true, planId: 'geometry' });
            expect(apartments[0].originalSources).toEqual([{ url: sourceUrl, sha256: sha, page: 1, mediaType: 'image/png' }]);
        }
    });
    it('keeps an unnamed offer link when the reader calls its only region plan-1', async () => {
        const url='https://example.test/nekretnina/trosoban-stan/', offer={url,facts:posting.facts};
        const input=source({listing_url:url,source_url:'https://example.test/drawing.png',
            asset:{url:'https://example.test/drawing.png',listingOwned:true}});
        const beforeSource=originalPlanSource(input), before=projectInventory([offer],[beforeSource]).apartments[0];
        const model={...geometry({unitId:'plan-1'}),listing_url:url,source_sha256:sha,page:1};
        const afterSource=(await currentOriginalPlans({query:async()=>({rows:[input]})},[url],{processedPlans:[model]}))[0];
        expect(afterSource.model.unitId).toBeNull();
        for(const plans of [[afterSource,model],[model,afterSource]]) {
            const apartments=projectInventory([offer],plans).apartments;
            expect(apartments).toHaveLength(1);
            expect(apartments[0]).toMatchObject({id:before.id,unitId:null,hasGeometry:true});
        }
    });
    it('suppresses measured outside-slab walls and uses the independent confirmed drawing', () => {
        const unsafe = geometry({ architecture: { ...architecture, walls: [[[[2, 2], [3, 2], [3, 3], [2, 3]]]] } });
        expect(hasUsableGeometry(unsafe.model)).toBe(false);
        expect(projectInventory([posting], [unsafe]).apartments[0]).toMatchObject({ hasPlan: false, hasGeometry: false, architecture: null });
        expect(projectInventory([posting], [unsafe, originalPlanSource(source())]).apartments[0])
            .toMatchObject({ hasPlan: true, hasGeometry: false, architecture: null });
    });
    it('retains source-only review metadata and does not transfer originals onto an identified different unit', () => {
        const original = originalPlanSource(source({ review_status: 'reviewed', reviewed_model: { unitId: 'S10', quality: { issues: ['Measured boundary needs review.'] } } }));
        const inventory = projectInventory([posting], [geometry({ unitId: 'S6' }), original]);
        expect(inventory.apartments).toHaveLength(2);
        expect(inventory.apartments.find(a => a.unitId === 'S10')).toMatchObject({ hasPlan: true, hasGeometry: false,
            reviewStatus: 'reviewed', issues: ['Measured boundary needs review.'] });
    });
    it('retains usable geometry with non-boundary review notes', () => {
        expect(hasUsableGeometry(geometry({ quality: { issues: ['Window type uncertain.'] } }).model)).toBe(true);
        expect(hasUsableGeometry(geometry({ quality: { boundaryValid: false } }).model)).toBe(false);
    });
});

describe('site-model originals', () => {
    it('collects independent originals even when a geometry reading exists', async () => {
        const { kind: _kind, ...reviewed } = geometry();
        const db = { async query(sql) {
            if (sql.includes('SELECT DISTINCT ON (e.sha256)')) return { rows: [reviewed] };
            if (sql.includes('CROSS JOIN LATERAL jsonb_array_elements')) return { rows: [source()] };
            return { rows: [] };
        } };
        expect((await sitePlans(db, [listingUrl])).map(p => p.kind)).toEqual(['reviewed', 'original']);
    });
    it('includes an original in inventory without creating a geometry placement', async () => {
        const candidate = { permits: [{ caseId: 'P1' }], featureIds: ['eDozvola_building_polygon.1'] };
        const listing = { ...posting, location_status: 'located', location: { candidates: [candidate] } };
        const db = { async query(sql) {
            if (sql.includes('CROSS JOIN LATERAL jsonb_array_elements')) return { rows: [source()] };
            if (sql.includes('SELECT url, facts, location')) return { rows: [listing] };
            return { rows: [] };
        } };
        const referencesDb = { async query() { return { rows: [{ g: { type: 'Polygon', coordinates: [[[15, 45], [15.001, 45], [15.001, 45.001], [15, 45]]] }, area: 100 }] }; } };
        const result = await siteModel(db, listingUrl, { referencesDb });
        expect(result.placements).toEqual([]);
        expect(result.inventory.apartments[0]).toMatchObject({ hasPlan: true, hasGeometry: false });
    });
});
