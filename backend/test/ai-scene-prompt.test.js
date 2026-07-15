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
        expect(p).not.toContain(' in ');
    });

    it('emphasizes the proposed building when a proposal is isolated', () => {
        const p = buildScenePrompt({ cityLabel: 'Split, Croatia', isolatedProposal: true });
        expect(p.toLowerCase()).toContain('highlighted proposed building');
        expect(p).not.toContain('grey massing blocks');
    });

    it('falls back to the generic massing description with no isolated proposal', () => {
        const p = buildScenePrompt({ isolatedProposal: false });
        expect(p).toContain('grey massing blocks');
    });

    it('always instructs the model to stay faithful to the geometry', () => {
        for (const s of [undefined, {}, { cityLabel: 'X', isolatedProposal: true }]) {
            const p = buildScenePrompt(s);
            expect(typeof p).toBe('string');
            expect(p).toMatch(/do not add, move, or resize/i);
        }
    });
});
