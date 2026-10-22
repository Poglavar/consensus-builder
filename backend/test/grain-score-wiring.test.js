// Cheap integration guardrails for a feature spread across the static shell, translations and
// binary cues. The browser test exercises the motion; these catch missing wires.
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = relative => fileURLToPath(new URL(relative, import.meta.url));
const read = relative => readFileSync(here(relative), 'utf8');
const index = read('../../frontend/index.html');
const scoreSource = read('../../frontend/js/proposals/grain-score.js');
const locales = ['en', 'hr', 'es', 'sr'];

function lookup(object, path) {
    return path.split('.').reduce((value, key) => value && value[key], object);
}

describe('grain score wiring', () => {
    it('puts one plan-level action beside Plan Stats and loads its code and styles', () => {
        expect(index).toContain('id="planStatsButton"');
        expect(index).toContain('id="roosterScoreButton"');
        expect(index.indexOf('id="roosterScoreButton"')).toBeGreaterThan(index.indexOf('id="planStatsButton"'));
        expect(index).toContain("'css/grain-score.css'");
        expect(index).toContain("'js/proposals/grain-score-rules.js'");
        expect(index).toContain("'js/proposals/grain-score.js'");
    });

    it('ships only the two approved parcel cues, with no completion effect', () => {
        expect(scoreSource).toContain('rooster-check-fail.wav');
        expect(scoreSource).toContain('rooster-check-success.wav');
        expect(scoreSource).not.toContain('rooster-score-complete');
        expect(statSync(here('../../frontend/audio/grain-rooster/rooster-check-fail.wav')).size).toBeGreaterThan(5000);
        expect(statSync(here('../../frontend/audio/grain-rooster/rooster-check-success.wav')).size).toBeGreaterThan(20000);
    });

    // Every string the score card asks for (grain-score.js), plus the sidebar button's (index.html).
    // The card scores the applied composition only: named plans and their scope strings are gone (M2).
    const cardKeys = [...new Set([...scoreSource.matchAll(/'sidebar\.proposals\.grainScore\.([A-Za-z]+)'/g)].map(match => match[1]))];

    it('reads its strings from one key family, and none of the retired named-plan ones', () => {
        expect(cardKeys.length).toBeGreaterThan(20);
        expect(cardKeys).toEqual(expect.arrayContaining(['title', 'appliedComposition', 'localScope', 'countTitle', 'fineTitle', 'methodologyBody',
            'missingGeometry', 'soundOn', 'soundOff', 'progress', 'complete']));
        for (const retired of ['namedScope', 'exactMembersRequired', 'otherApplied', 'fabricChanged']) expect(cardKeys).not.toContain(retired);
    });

    it.each(locales)('%s carries every score-card string family', locale => {
        const dictionary = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        const block = lookup(dictionary, 'sidebar.proposals.grainScore');
        expect(block).toBeTruthy();
        ['buttonLabel', 'buttonHint', 'buttonEmpty', ...cardKeys].forEach(key => expect(block[key], `${locale}.${key}`).toBeTruthy());
    });
});
