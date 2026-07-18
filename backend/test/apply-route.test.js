// The pure apply-routing decision extracted from ProposalManager. Locks the goal→route contract that
// the dispatcher (ProposalManager.applyProposal) must keep honouring as the monolith is decomposed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeGoalKey, isBuildingGoal, classifyApplyRoute } = require('../../frontend/js/proposals/apply/route.js');

describe('normalizeGoalKey', () => {
    it('canonicalises road aliases', () => {
        for (const g of ['road', 'track', 'road-track', 'Road Track', 'ROAD/TRACK']) {
            expect(normalizeGoalKey(g)).toBe('road-track');
        }
    });
    it('canonicalises the remaining known goals', () => {
        expect(normalizeGoalKey('decide')).toBe('decide-later');
        expect(normalizeGoalKey('reparcellization')).toBe('reparcellization');
        expect(normalizeGoalKey('Park')).toBe('park');
        expect(normalizeGoalKey('Transit Station')).toBe('station');
        expect(normalizeGoalKey('residences')).toBe('buildings');
        expect(normalizeGoalKey('single-building')).toBe('single');
        expect(normalizeGoalKey('parcel-based')).toBe('parcelBased');
        expect(normalizeGoalKey('parcel')).toBe('parcel');
    });
    it('is empty for missing/blank and passes unknown through', () => {
        expect(normalizeGoalKey(null)).toBe('');
        expect(normalizeGoalKey('   ')).toBe('');
        expect(normalizeGoalKey('mystery')).toBe('mystery');
    });
});

describe('isBuildingGoal', () => {
    it('is true only for the building typologies', () => {
        ['buildings', 'single', 'row', 'parcelBased'].forEach(k => expect(isBuildingGoal(k)).toBe(true));
        ['road-track', 'park', 'reparcellization', 'decide-later', ''].forEach(k => expect(isBuildingGoal(k)).toBe(false));
    });
});

describe('classifyApplyRoute', () => {
    const route = (goal) => classifyApplyRoute({ goal }).route;

    it('routes each spatial type to its apply path', () => {
        expect(route('road-track')).toBe('road-track');
        expect(route('reparcellization')).toBe('reparcellization');
        expect(route('decide-later')).toBe('decide-later');
        expect(route('buildings')).toBe('building');
        expect(route('single')).toBe('building');
        expect(route('park')).toBe('structure');
        expect(route('square')).toBe('structure');
        expect(route('lake')).toBe('structure');
        expect(route('station')).toBe('structure');
    });

    it('treats parcel / ownership-transfer / to-buyer as an idempotent no-op', () => {
        expect(route('parcel')).toBe('noop');
        expect(route('to-buyer')).toBe('noop');
        expect(route('ownership-transfer-to-me')).toBe('noop');
        expect(route('ownership-transfer-from-me')).toBe('noop');
    });

    it('is unsupported for an unknown or missing goal', () => {
        expect(route('mystery')).toBe('unsupported');
        expect(route(undefined)).toBe('unsupported');
        expect(classifyApplyRoute({}).route).toBe('unsupported');
    });

    it('returns the normalised goalKey alongside the route', () => {
        expect(classifyApplyRoute({ goal: 'ROAD' })).toEqual({ route: 'road-track', goalKey: 'road-track' });
    });
});
