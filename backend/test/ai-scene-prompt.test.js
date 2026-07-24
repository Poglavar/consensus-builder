// Unit tests for the AI-scene caption builder (frontend/js/ai-scene.js). The screenshot carries
// the geometry; buildScenePrompt only adds the intent the pixels can't state — which building is
// the hero, where we are, and the "stay faithful to the massing" instruction. These pin that down.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildScenePrompt } = require('../../frontend/js/ai-scene.js');

describe('buildScenePrompt', () => {
    it('names the city when a label is present', () => {
        const p = buildScenePrompt({ cityLabel: 'Zagreb, Croatia', isolatedProposal: false });
        expect(p).toContain('in Zagreb, Croatia');
    });

    it('omits the location clause when there is no city label', () => {
        const p = buildScenePrompt({ isolatedProposal: false });
        // Assert the CLAUSE is gone, not that the word "in" is absent: banning a preposition from a
        // whole English paragraph makes every later sentence a landmine (it broke on "none in the
        // traffic lanes"), and it was never what this test meant to check.
        expect(p).toContain('Recreate this scene as a photorealistic');
        expect(p).not.toMatch(/Recreate this scene in /);
    });

    it('emphasizes the proposed building when a proposal is isolated', () => {
        const p = buildScenePrompt({ cityLabel: 'Split, Croatia', isolatedProposal: true });
        expect(p.toLowerCase()).toContain('highlighted proposed building');
    });

    it('references the height map and its scale only when one was captured', () => {
        const withMap = buildScenePrompt({ hasHeightMap: true, maxHeightM: 72 });
        expect(withMap).toMatch(/height map/i);
        expect(withMap).toContain('72 m');

        const noMap = buildScenePrompt({ hasHeightMap: false });
        expect(noMap).not.toMatch(/height map/i);
    });

    it('always frames the task as a structure-preserving edit', () => {
        for (const s of [undefined, {}, { cityLabel: 'X', isolatedProposal: true, hasHeightMap: true, maxHeightM: 50 }]) {
            const p = buildScenePrompt(s);
            expect(typeof p).toBe('string');
            expect(p).toMatch(/do not add, remove, move, or resize/i);
        }
    });

    it('asks for facade enhancement instead of invention', () => {
        const p = buildScenePrompt({});
        expect(p).toMatch(/facades are grainy/i);
        expect(p).toMatch(/do not invent completely new ones/i);
    });

    it('asks for photorealistic street lanes with preserved dimensions', () => {
        const p = buildScenePrompt({});
        expect(p).toMatch(/lanes into photorealistic lanes/i);
        expect(p).toMatch(/order, widths and proportions/i);
    });
});

// A model left to its own devices fills the street with traffic and parks cars on the new
// pavement — drawing today's street rather than the proposed one, and putting cars on the very
// footway the redesign creates. The ban is stated per-place because a bare "no cars" gets applied
// to the carriageway and ignored on the sidewalk.
describe('vehicles', () => {
    it('forbids cars everywhere, not just on the road', () => {
        const prompt = buildScenePrompt({ cityLabel: 'Zagreb' }).toLowerCase();
        expect(prompt).toContain('never generate any cars');
        expect(prompt).toContain('no cars anywhere');
        ['sidewalk', 'parking space', 'traffic lane', 'kerb'].forEach(place => {
            expect(prompt).toContain(place);
        });
    });

    it('bans them whatever else the scene asks for', () => {
        [{}, { hasHeightMap: true, maxHeightM: 40 }, { isolatedProposal: true }].forEach(summary => {
            expect(buildScenePrompt(summary)).toContain('No cars anywhere.');
        });
    });
});
