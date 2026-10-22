// backend/agents/record-builder.js: the recipe of one pick, a local design record of a building on its
// parcel (published as design/v1, which the index accepts and files under the same CID the browser
// computes) and the persona's agreement terms (title, deadline days, escrow lamports).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { DEFAULT_AGREEMENT_TERMS, agreementTerms, buildDesignRecord, buildRecipe } from '../agents/record-builder.js';
import { designObject } from '../agents/agreement-objects.js';
import { validateDesignContent } from '../routes/designs.js';
import { canonicalBytes, cidOf } from '../cid.js';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');

const MASSING_GEOMETRY = { type: 'Polygon', coordinates: [[[15.9341, 45.7971], [15.9349, 45.7971], [15.9349, 45.7979], [15.9341, 45.7979], [15.9341, 45.7971]]] };
const CANDIDATE = {
    candidateId: 'densifier-01:HR-335614-2178',
    parcelId: 'HR-335614-2178',
    koName: 'RUDEŠ',
    areaM2: 422.09,
    geometry: { type: 'Polygon', coordinates: [[[15.934, 45.797], [15.935, 45.797], [15.935, 45.798], [15.934, 45.798], [15.934, 45.797]]] },
    builtGfaM2: 295.3,
    rule: { maxFloors: 4, minSetbackM: 3, source: 'urban-rule' },
    allowedFloors: 4,
    massing: { type: 'Feature', properties: { floors: 3, height: 9, massing: false }, geometry: MASSING_GEOMETRY },
    proposedGfaM2: 900,
    gain: 2418800,
    offer: 725640,
    normalizedRule: { typology: 'parcelBased', kind: 'max', minDistance: 3, maxFloors: 4, minFloors: 0, minFootprintAreaM2: 0, floorHeightM: 3, minPlotAreaM2: 0 }
};
const PICK = { name: 'Four storeys on Rudeš 2178', rationale: 'The plan permits four storeys; the lot carries two outbuildings.' };
const PERSONA = { name: 'densifier-01', wallet: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg', agreement: { deadlineDays: 5, lamports: '2000000' } };
const AUTHORED_AT = '2026-10-22T09:00:00.000Z';

const build = (extra = {}) => buildDesignRecord({ candidate: CANDIDATE, pick: PICK, persona: PERSONA, city: 'zagreb', authoredAt: AUTHORED_AT, ...extra });

describe('buildDesignRecord: a building on its parcel', () => {
    const record = build();

    it('is a single-typology building design authored by the persona, its text from the pick', () => {
        expect(record).toMatchObject({
            goal: 'buildings', title: PICK.name, description: PICK.rationale, author: 'densifier-01', city: 'zagreb',
            site: null, toleranceM: null, origin: null, createdAt: AUTHORED_AT
        });
        expect(record.buildingProposal).toEqual({
            blockName: 'Parcel HR-335614-2178',
            typologyType: 'single',
            parameters: { height: 9, floors: 3, rotation: 0, typology: 'single', rule: CANDIDATE.normalizedRule }
        });
    });

    it('draws the massing as the one building the views read', () => {
        expect(record.geometry.buildings).toEqual([{
            type: 'Feature',
            geometry: MASSING_GEOMETRY,
            properties: { type: 'proposedBuildingSingle', block: 'Parcel HR-335614-2178', height: 9, floors: 3, title: PICK.name, author: 'densifier-01', rotation: 0 }
        }]);
    });

    it('carries no terms, cadastre ids, offer, wallet or record ids: a design is only its drawing', () => {
        const text = JSON.stringify(record);
        for (const word of ['cadastreParcelIds', 'offer', 'lamports', 'deadline', 'wallet', 'proposalId', 'onchain', 'lifecycle']) {
            expect(text).not.toContain(word);
        }
    });

    it('publishes as a design/v1 object the index accepts, under the CID the browser computes', () => {
        const { content, cid } = designObject(record);
        expect(content.schema).toBe('design/v1');
        expect(content.authoredAt).toBe(AUTHORED_AT);
        expect(validateDesignContent(content)).toEqual({ ok: true, site: null, toleranceM: 0 });
        expect(cid).toBe(Cid.cidOfObject(content));
        expect(cid).toBe(cidOf(canonicalBytes(content)));
        // The same pick at the same build time is the same CID; another build time is another design,
        // which is why the runner checkpoints the build time with the CID.
        expect(designObject(build()).cid).toBe(cid);
        expect(designObject(build({ authoredAt: '2026-10-22T09:00:01.000Z' })).cid).not.toBe(cid);
    });

    it('keeps an absent rationale null', () => {
        expect(build({ pick: { name: 'Bare' } }).description).toBeNull();
    });

    it('refuses to build without a massing, a pick name, a persona or an ISO build time', () => {
        expect(() => build({ candidate: { ...CANDIDATE, massing: null } })).toThrow(/massing/);
        expect(() => build({ pick: { rationale: 'x' } })).toThrow(/name/);
        expect(() => build({ persona: {} })).toThrow(/persona.name/);
        expect(() => build({ authoredAt: 'yesterday' })).toThrow(/authoredAt/);
        expect(() => build({ authoredAt: undefined })).toThrow(/authoredAt/);
    });
});

describe('agreement terms', () => {
    it('takes deadline days and escrow lamports from the persona, with defaults', () => {
        expect(agreementTerms(PERSONA)).toEqual({ deadlineDays: 5, lamports: '2000000' });
        expect(agreementTerms({ name: 'p' })).toEqual({ deadlineDays: DEFAULT_AGREEMENT_TERMS.deadlineDays, lamports: DEFAULT_AGREEMENT_TERMS.lamports });
        expect(DEFAULT_AGREEMENT_TERMS).toEqual({ deadlineDays: 7, lamports: '0' });
        expect(agreementTerms({ name: 'p', agreement: { lamports: 1500 } })).toEqual({ deadlineDays: 7, lamports: '1500' });
    });

    it.each([0, -1, 366, Number.NaN, '7'])('refuses deadlineDays %s', deadlineDays => {
        expect(() => agreementTerms({ name: 'p', agreement: { deadlineDays } })).toThrow(/p agreement.deadlineDays/);
    });

    it.each(['1.5', '-1', 'lots', '1e6'])('refuses lamports %s', lamports => {
        expect(() => agreementTerms({ name: 'p', agreement: { lamports } })).toThrow(/p agreement.lamports/);
    });
});

describe('buildRecipe', () => {
    it('pairs the design record with the terms its agreement is proposed under', () => {
        const recipe = buildRecipe({ candidate: CANDIDATE, pick: PICK, persona: PERSONA, city: 'zagreb', authoredAt: AUTHORED_AT });
        expect(recipe.design).toEqual(build());
        expect(recipe.agreement).toEqual({ title: PICK.name, deadlineDays: 5, lamports: '2000000' });
    });
});
