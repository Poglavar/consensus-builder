import { describe, expect, it } from 'vitest';
import { extractPropertyFacts } from '../floor-plans/property-facts.js';
import { extractPageEvidence } from '../floor-plans/page-evidence.js';

describe('extractPropertyFacts', () => {
    it('parses explicit Croatian listing labels and schema facts with quotes', () => {
        const result = extractPropertyFacts({
            record: { numberOfRooms: 3 }, title: 'Novogradnja, trosoban stan',
            text: 'Godina izgradnje: 2024. Završetak gradnje: 2025. Orijentacija: sjeverozapad. Broj soba: 3.'
        });
        expect(result).toMatchObject({ constructionYear: 2024, completionYear: 2025, roomCount: 3, orientation: ['NW'], propertyType: 'apartment', newBuild: true });
        expect(result.evidence).toMatchObject({ constructionYear: 'Godina izgradnje: 2024', completionYear: 'Završetak gradnje: 2025', roomCount: 'Broj soba: 3', orientation: 'Orijentacija: sjeverozapad' });
    });

    it('keeps renovation, design, permit and copyright years out of construction year', () => {
        const result = extractPropertyFacts({ title: 'House', text: 'Projekt arhitekture 2018. Građevinska dozvola 2020. Renovirano 2022. © 2024.' });
        expect(result).toMatchObject({ constructionYear: null, renovationYear: 2022, completionYear: null });
    });

    it('does not infer rooms from bedrooms or bathrooms, and flags conflicting facts as unknown', () => {
        expect(extractPropertyFacts({ record: { numberOfBedrooms: 2 }, text: '2 kupaonice' }).roomCount).toBeNull();
        expect(extractPropertyFacts({ text: '2 bedroom apartment' }).roomCount).toBeNull();
        expect(extractPropertyFacts({ text: 'Broj soba: 2. Broj soba: 3.' }).roomCount).toBeNull();
        expect(extractPropertyFacts({ text: 'Godina izgradnje: 2001. Year built: 2004.' }).constructionYear).toBeNull();
    });

    it('reads schema yearBuilt and Croatian construction phrasing with source quotes', () => {
        expect(extractPropertyFacts({ record: { yearBuilt: '1980' } })).toMatchObject({ constructionYear: 1980, evidence: { constructionYear: 'yearBuilt: 1980' } });
        expect(extractPropertyFacts({ text: 'Kuća je izgrađena 1980.' })).toMatchObject({ constructionYear: 1980, evidence: { constructionYear: 'izgrađena 1980' } });
        expect(extractPropertyFacts({ text: 'Zgrada je izgrađena je 1980.' }).constructionYear).toBe(1980);
        expect(extractPropertyFacts({ record: { yearBuilt: 1980 }, text: 'Godina izgradnje: 1981.' }).constructionYear).toBeNull();
    });

    it('reads Croatian room counts from titles and descriptions, including half rooms', () => {
        expect(extractPropertyFacts({ title: 'Trosoban stan' }).roomCount).toBe(3);
        expect(extractPropertyFacts({ title: 'Dvosobni stan' }).roomCount).toBe(2);
        expect(extractPropertyFacts({ text: 'Prodaje se stan od 2,5-soban.' }).roomCount).toBe(2.5);
        expect(extractPropertyFacts({ title: 'Three-room flat' }).roomCount).toBe(3);
    });

    it('uses canonical eight-way orientation codes and preserves cardinal pairs', () => {
        expect(extractPropertyFacts({ text: 'Orijentacija: sjeveroistok.' }).orientation).toEqual(['NE']);
        expect(extractPropertyFacts({ text: 'Facing north-east.' }).orientation).toEqual(['NE']);
        expect(extractPropertyFacts({ text: 'Orijentacija: sjever-jug.' }).orientation).toEqual(['N', 'S']);
        expect(extractPropertyFacts({ text: 'Orijentacija: jugozapad.' }).orientation).toEqual(['SW']);
    });

    it('keeps listing type classification anchored to the title and architecture project kind', () => {
        expect(extractPropertyFacts({ title: 'Stan u centru', text: 'Nearby: Hotel Central and offices.' }).propertyType).toBe('apartment');
        expect(extractPropertyFacts({ title: 'Residential building', text: 'Ground-floor apartment and hotel nearby.', sourceType: 'architecture-project' }).propertyType).toBe('residential');
        expect(extractPropertyFacts({ title: 'Riverfront development', text: 'Apartment units, hotel and offices.', sourceType: 'architecture-project' }).propertyType).toBe('unknown');
    });

    it('parses labeled orientation only, and limits new-build evidence to page content', () => {
        expect(extractPropertyFacts({ title: 'ZagrebNorth stan', text: 'Sjever na karti. Broj katova: 8.' }).orientation).toEqual([]);
        const evidence = extractPageEvidence('<script type="application/ld+json">{"@type":"Product","name":"Stan","url":"https://agency.test/stan/1"}</script><header>Novogradnja</header><main><h1>Stan</h1><p>Godina izgradnje: 2023</p></main><footer>Novogradnja</footer>', 'https://agency.test/stan/1');
        expect(evidence.listing.propertyDetails).toMatchObject({ constructionYear: 2023, newBuild: null, propertyType: 'apartment' });
    });

    it('does not confuse project or commercial titles with apartments', () => {
        expect(extractPropertyFacts({ title: 'Muzej suvremene umjetnosti', text: 'Projekt dovršen 2010.' }).propertyType).toBe('commercial');
        expect(extractPropertyFacts({ title: 'Residential building', text: '' }).propertyType).toBe('residential');
    });
});
