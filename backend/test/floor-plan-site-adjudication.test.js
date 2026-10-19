// LLM site adjudication: lenient parsing of paid answers, and the reading as one more weighted clue.
import { describe, expect, it, vi } from 'vitest';
import { applySiteReading, buildSiteRequest, parseSiteReading, prepareSiteEvidence, SITE_SCHEMA } from '../floor-plans/site-adjudication.js';

const html = '<html><head><title>Avenue V</title></head><body><main><p>Zagreb, Strojarska - Vukovarska, AVENUE V, novogradnja, trosoban stan.</p></main></body></html>';
const location = {
    schema: 'listing-site-location.v1', status: 'ambiguous', signals: { schema: 'listing-location-signals.v1', streets: [{ street: 'Strojarska cesta' }] },
    candidates: [
        { id: 'S7', score: 0.43, reasons: [{ code: 'permit-street' }], permits: [{ kind: 'Građevinska dozvola', works: 'građenje zgrade', streets: ['Strojarska cesta 19'] }], parcels: [{ kc: '381/1', koName: 'Trnje' }], pinDistanceM: 64 },
        { id: 'S2', score: 0.38, reasons: [{ code: 'permit-street' }], permits: [{ kind: 'Građevinska dozvola', streets: ['Ulica grada Vukovara 49'] }], parcels: [], pinDistanceM: 230 },
    ],
};
const task = { id: 't1', context: prepareSiteEvidence({ url: 'https://agency.test/avenue-v', sha256: 'a'.repeat(64), html, facts: { title: 'Avenue V' }, location }) };
const answer = (overrides = {}) => ({ schema: 'ad-site-reading.v1', isListing: true, isBuildingProject: true, newBuild: true, candidateId: 'S1',
    confidence: 'high', rationale: 'Residential new-build permit on Strojarska.', quotes: ['Strojarska - Vukovarska', 'AVENUE V'], issues: [], ...overrides });

describe('site adjudication', () => {
    it('sends the posting text and summarized candidates, never the internal candidate keys', () => {
        const llm = { batchRequest: vi.fn((id, request) => request) };
        const request = buildSiteRequest(llm, task);
        const packet = JSON.parse(request.content[0]);
        expect(packet.candidates.map(c => c.id)).toEqual(['S1', 'S2']);
        expect(packet.candidates[0]).toMatchObject({ parcels: ['381/1 k.o. Trnje'], pinDistanceM: 64 });
        expect(packet).not.toHaveProperty('candidateMap');
        expect(request.schema).toBe(SITE_SCHEMA);
    });

    it('maps the pick to the stored candidate and drops quotes the posting does not contain', () => {
        const reading = parseSiteReading(answer({ quotes: ['AVENUE V', 'invented sentence'] }), task, { model: 'm' });
        expect(reading).toMatchObject({ candidateId: 'S1', candidateKey: 'S7', quotes: ['AVENUE V'] });
        expect(reading.issues.join(' ')).toMatch(/dropped/);
        expect(parseSiteReading(answer({ candidateId: 'S9' }), task, { model: 'm' })).toMatchObject({ candidateId: null });
    });

    it('a confident pick lifts a close call to located; a low-confidence one leaves it open', () => {
        const high = applySiteReading(location, parseSiteReading(answer(), task, { model: 'm' }));
        expect(high).toMatchObject({ status: 'located', adjudication: { candidateId: 'S7', confidence: 'high' } });
        expect(high.candidates[0].reasons.at(-1)).toMatchObject({ code: 'adjudicated' });
        const low = applySiteReading(location, parseSiteReading(answer({ confidence: 'low' }), task, { model: 'm' }));
        expect(low.status).toBe('ambiguous');
    });

    it('an exhibition or a non-listing stays unresolved whatever the scores', () => {
        expect(applySiteReading(location, parseSiteReading(answer({ isBuildingProject: false }), task, { model: 'm' })).status).toBe('unresolved');
        expect(applySiteReading(location, parseSiteReading(answer({ isListing: false, candidateId: null }), task, { model: 'm' })).status).toBe('unresolved');
    });
});
