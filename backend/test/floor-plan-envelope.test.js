// Envelope step 2a: storey formulas from ads and permits become a storey stack with provenance.
import { describe, expect, it } from 'vitest';
import { buildEnvelope, chooseStoreys, parseStoreys, storeyHeightsFromElevations, storeyStack } from '../floor-plans/envelope.js';

describe('storey formulas', () => {
    it.each([
        ['P+4', { below: 0, upper: 4, top: null }],
        ['Po+Pr+3+Uk', { below: 1, upper: 3, top: 'recessed' }],
        ['Su+P+2+Pk', { below: 1, upper: 2, top: 'attic' }],
        ['Pr+1k', { below: 0, upper: 1, top: null }],
        ['prizemlje, dva kata i uvučeni kat', { below: 0, upper: 2, top: 'recessed' }],
        ['prizemlje, 1. kat i uvučeni kat', { below: 0, upper: 1, top: 'recessed' }],
        ['prizemlje i kat', { below: 0, upper: 1, top: null }],
        ['2 nadzemne etaže', { below: 0, upper: 1, top: null }],
        ['zgrada ima podrum, prizemlje i 4 kata', { below: 1, upper: 4, top: null }],
    ])('reads %s', (text, expected) => {
        expect(parseStoreys(text)).toMatchObject({ ground: 1, ...expected });
    });

    it('returns null when no storey count is stated, never a guessed default', () => {
        expect(parseStoreys('Moderan stan u novogradnji, 3 sobe, 80 m2')).toBeNull();
        expect(parseStoreys('1.80 m')).toBeNull();
        expect(parseStoreys('')).toBeNull();
    });
});

describe('storey stack and envelope', () => {
    it('stacks storeys from the ground floor at 0 m and marks a recessed top floor', () => {
        const stack = storeyStack(parseStoreys('Po+Pr+2+Uk'));
        expect(stack.map(s => [s.level, s.label, s.elevationM, s.outline])).toEqual([
            [-1, 'Po', -3, 'footprint'], [0, 'Pr', 0, 'footprint'], [1, '1. kat', 3.2, 'footprint'], [2, '2. kat', 6.2, 'footprint'], [3, 'Uk', 9.2, 'recessed']]);
        expect(stack.every(s => s.heightBasis === 'estimated')).toBe(true);
    });

    it('prefers the first source and records a contradicting one as a conflict', () => {
        const choice = chooseStoreys([{ kind: 'permit', text: 'prizemlje, dva kata i uvučeni kat' }, { kind: 'listing', text: 'P+4' }]);
        expect(choice).toMatchObject({ source: 'permit', conflicts: [{ source: 'listing' }] });
    });

    it('derives storey heights from printed elevations: Avenue V has 3.3 m storeys over a 5.2 m ground floor', () => {
        const heights = storeyHeightsFromElevations([{ level: 5, elevationM: 18.4 }, { level: 6, elevationM: 21.7 }, { level: 7, elevationM: 25 }, { level: 5, elevationM: 18.4 }]);
        expect(heights).toMatchObject({ upper: 3.3, ground: 5.2, plausible: true });
        const envelope = buildEnvelope({ footprint: null, footprintSource: 'permit', storeySources: [{ kind: 'plans', text: 'P+7' }],
            elevations: [{ level: 5, elevationM: 18.4 }, { level: 6, elevationM: 21.7 }, { level: 7, elevationM: 25 }] });
        expect(envelope.storeys.find(s => s.level === 5)).toMatchObject({ elevationM: 18.4, heightM: 3.3 });
        expect(envelope.storeys.find(s => s.level === 0)).toMatchObject({ elevationM: 0, heightM: 5.2 });
        expect(envelope.heightBasis).toMatch(/3 printed elevations/);
    });

    it('spreads one elevation evenly and refuses implausible storeys as a conflict', () => {
        expect(storeyHeightsFromElevations([{ level: 4, elevationM: 12.4 }])).toMatchObject({ upper: 3.1, ground: 3.1 });
        const envelope = buildEnvelope({ footprint: null, footprintSource: null, storeySources: [{ kind: 'plans', text: 'P+2' }], elevations: [{ level: 2, elevationM: 40 }] });
        expect(envelope.heightBasis).toBe('estimated');
        expect(envelope.conflicts[0].source).toBe('elevations');
        expect(storeyHeightsFromElevations([{ level: 0, elevationM: 0 }, { level: 3, elevationM: null }])).toBeNull();
    });

    it('falls back to the surveyed height for an existing building with no stated storeys', () => {
        const envelope = buildEnvelope({ footprint: { type: 'Polygon', coordinates: [] }, footprintSource: 'survey', surveyHeightM: 13.5 });
        expect(envelope).toMatchObject({ role: 'reconstructed-building-envelope', planningCompliance: 'not-evaluated', storeySource: 'survey-height', storeys: expect.arrayContaining([expect.objectContaining({ level: 3 })]) });
        expect(buildEnvelope({ footprint: null, footprintSource: null }).storeys).toEqual([]);
    });
});
