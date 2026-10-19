// Cheap integration guardrails for a feature spread across the static shell, route bootstrap,
// translations and binary cues. The browser test exercises the motion; these catch missing wires.
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = relative => fileURLToPath(new URL(relative, import.meta.url));
const read = relative => readFileSync(here(relative), 'utf8');
const index = read('../../frontend/index.html');
const core = read('../../frontend/js/proposals/core.js');
const scoreSource = read('../../frontend/js/proposals/grain-score.js');
const serveConfig = JSON.parse(read('../../frontend/serve.json'));
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

    it('hands /plans/<slug>/score to the score experience', () => {
        expect(core).toContain('parsePlanScorePath(pathname)');
        expect(core).toContain('openPlanGrainScoreRoute(planScoreRoute.slug)');
        expect(serveConfig.rewrites).toContainEqual({ source: '/plans/**', destination: '/index.html' });
    });

    it('scores only the named plan when unrelated proposals are already applied', () => {
        expect(scoreSource).toContain('function appliedProposalsInScope(scopeIds)');
        expect(scoreSource).toContain('prepareExperience(state.namedPlan, ids)');
        expect(scoreSource).toContain('plan.slug && Array.isArray(plan.proposalIds)');
    });

    it('refuses to score a named plan that only partly applied', () => {
        expect(scoreSource).toContain('loadResult.blocked');
        expect(scoreSource).toContain('loadResult.failed.length');
        locales.forEach(locale => {
            const dictionary = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
            expect(lookup(dictionary, 'sidebar.proposals.grainScore.incompletePlan')).toBeTruthy();
        });
    });

    it('ships only the two approved parcel cues, with no completion effect', () => {
        expect(scoreSource).toContain('rooster-check-fail.wav');
        expect(scoreSource).toContain('rooster-check-success.wav');
        expect(scoreSource).not.toContain('rooster-score-complete');
        expect(statSync(here('../../frontend/audio/grain-rooster/rooster-check-fail.wav')).size).toBeGreaterThan(5000);
        expect(statSync(here('../../frontend/audio/grain-rooster/rooster-check-success.wav')).size).toBeGreaterThan(20000);
    });

    it.each(locales)('%s carries every score-card string family', locale => {
        const dictionary = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        const block = lookup(dictionary, 'sidebar.proposals.grainScore');
        expect(block).toBeTruthy();
        [
            'buttonLabel', 'buttonHint', 'buttonEmpty', 'title', 'ready', 'start', 'countTitle',
            'fineTitle', 'methodologyBody', 'missingGeometry', 'soundOn', 'soundOff', 'progress', 'complete'
        ].forEach(key => expect(block[key], `${locale}.${key}`).toBeTruthy());
    });
});
