// The introduction is requested explicitly; arriving at the app never requires a tour.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldShowSiteIntro } = require('../../frontend/js/site-intro.js');

describe('site intro opt-in policy', () => {
    it.each(['', '?city=nairobi', '?lang=hr', '?at=-1.264,36.840,17'])('does not interrupt an arrival at %s', search => {
        expect(shouldShowSiteIntro(search)).toBe(false);
    });

    it.each(['activity', 'focusProposal', 'bets', 'parcel', 'scene', 'model', 'mode3d', 'photo'])('leaves %s links uninterrupted', name => {
        expect(shouldShowSiteIntro(`?${name}=destination`)).toBe(false);
    });

    it.each(['?intro', '?intro=1', '?city=nairobi&intro=1'])('honors an explicit tour request at %s', search => {
        expect(shouldShowSiteIntro(search)).toBe(true);
    });

    it.each(['?intro=0', '?intro=false', '?intro=invalid'])('does not mistake %s for a tour request', search => {
        expect(shouldShowSiteIntro(search)).toBe(false);
    });
});
