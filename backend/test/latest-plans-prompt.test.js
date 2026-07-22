// Unit tests for frontend/js/latest-plans-prompt.js — the pure show/skip decision for the arrival
// "see the latest plans" nudge (the browser wiring is inert under node).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { latestPlansPromptDecision } = require('../../frontend/js/latest-plans-prompt.js');

describe('latestPlansPromptDecision', () => {
    it('shows when there are plans, not seen, and not a deep link', () => {
        expect(latestPlansPromptDecision({ total: 7, seen: false, isDeepLink: false })).toEqual({ show: true, count: 7 });
    });

    it('stays hidden once seen this session', () => {
        expect(latestPlansPromptDecision({ total: 7, seen: true, isDeepLink: false }).show).toBe(false);
    });

    it('stays hidden on a deep link (a shared proposal / latlng already has focus)', () => {
        expect(latestPlansPromptDecision({ total: 7, seen: false, isDeepLink: true }).show).toBe(false);
    });

    it('stays hidden when there are no plans', () => {
        expect(latestPlansPromptDecision({ total: 0, seen: false, isDeepLink: false }).show).toBe(false);
        expect(latestPlansPromptDecision({ total: NaN, seen: false, isDeepLink: false }).show).toBe(false);
        expect(latestPlansPromptDecision({ total: -3, seen: false, isDeepLink: false }).show).toBe(false);
    });
});
