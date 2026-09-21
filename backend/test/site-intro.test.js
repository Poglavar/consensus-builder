// Unit coverage for the first-visit decision without requiring a browser DOM.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { STORAGE_KEY, shouldShowSiteIntro } = require('../../frontend/js/site-intro.js');

describe('site intro first-visit policy', () => {
    it('shows once before the versioned seen flag is stored', () => {
        expect(STORAGE_KEY).toBe('cb_site_intro_seen_v1');
        expect(shouldShowSiteIntro('', null)).toBe(true);
        expect(shouldShowSiteIntro('', '1')).toBe(false);
    });

    it('supports an explicit preview query after the intro has been seen', () => {
        expect(shouldShowSiteIntro('?city=zg&intro=1', '1')).toBe(true);
        expect(shouldShowSiteIntro('?city=zg&intro', '1')).toBe(true);
    });
});
