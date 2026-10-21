// The parcel menu's Proposals tab (frontend/js/ui/parcel-menu-model.js): offered on every cadastral
// parcel, right after Details, and never on open ground.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MenuModel = require('../../frontend/js/ui/parcel-menu-model.js');

describe('the parcel menu offers the Proposals tab', () => {
    const facts = overrides => ({ parcelId: 'p1', isRoad: false, multiSelectActive: false, selectionCount: 0, historyIds: ['HR-1-1'], blocksEnabled: true, ...overrides });

    it('on every cadastral parcel, after Details', () => {
        const actions = MenuModel.availableActions(facts());
        expect(actions.indexOf('proposals')).toBe(actions.indexOf('details') + 1);
    });

    it('not on open ground, where no proposal declares a parcel', () => {
        expect(MenuModel.availableActions(facts({ isGround: true }))).not.toContain('proposals');
    });
});
