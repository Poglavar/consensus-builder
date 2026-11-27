// Hippodamus's greeting choice, mood and gaze (frontend/js/chat/chat-persona.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const persona = require('../../frontend/js/chat/chat-persona.js');

describe('chat persona greeting', () => {
    it('asks the general question with nothing selected or open', () => {
        expect(persona.greeting()).toEqual({ key: 'chat.greeting', params: {} });
        expect(persona.greeting({ parcelCount: 0 })).toEqual({ key: 'chat.greeting', params: {} });
    });
    it('asks about selected parcels with their count', () => {
        expect(persona.greeting({ parcelCount: 3 })).toEqual({ key: 'chat.greetingParcels', params: { count: 3 } });
        expect(persona.greeting({ parcelCount: 1 })).toEqual({ key: 'chat.greetingParcels', params: { count: 1 } });
    });
    it('offers to explain an open tool before the parcels, by its title when it has one', () => {
        expect(persona.greeting({ toolOpen: true, toolTitle: ' Parcel layout ', parcelCount: 3 }))
            .toEqual({ key: 'chat.greetingTool', params: { tool: 'Parcel layout' } });
        expect(persona.greeting({ toolOpen: true, toolTitle: '' })).toEqual({ key: 'chat.greetingToolUnnamed', params: {} });
    });
});

describe('chat persona mood', () => {
    it('thinks while a turn runs, whatever the last reaction', () => {
        expect(persona.mood({ pending: true, reaction: 'frown' })).toBe('thinking');
    });
    it('shows the reaction after a turn, then idles', () => {
        expect(persona.mood({ reaction: 'smile' })).toBe('smile');
        expect(persona.mood({ reaction: 'frown' })).toBe('frown');
        expect(persona.mood({ reaction: null })).toBe('idle');
        expect(persona.mood({ reaction: 'shrug' })).toBe('idle');
    });
});

describe('chat persona gaze', () => {
    it('turns toward the point, growing with distance up to the reach', () => {
        expect(persona.gaze({ x: 0, y: 0 }, { x: 120, y: 0 })).toEqual({ x: 0.45, y: 0 });
        const far = persona.gaze({ x: 0, y: 0 }, { x: 0, y: -1000 });
        expect(far.x).toBeCloseTo(0);
        expect(far.y).toBeCloseTo(-0.9);
    });
    it('does not move for a missing point or the centre itself', () => {
        expect(persona.gaze({ x: 0, y: 0 }, null)).toEqual({ x: 0, y: 0 });
        expect(persona.gaze({ x: 0, y: 0 }, { x: null, y: 4 })).toEqual({ x: 0, y: 0 });
        expect(persona.gaze({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 0, y: 0 });
    });
});
