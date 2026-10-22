// The Bets sheet's agreement row carries the before picture (the same ground without the agreement's
// designs) beside the thumbnail (dividers.md, M3), so the bet dialog can put the two under a divider.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { row } = require('../../frontend/js/bets/bets-model.js');

describe('bets-model row pictures', () => {
    it('keeps the before picture when the contest entry has one, null otherwise', () => {
        const entry = { cid: 'bafkrei-infill', account: null, title: 'Infill', designTitles: ['Infill'], status: 'active', parcelIds: ['HR-1'],
            screenshotUrl: '/uploads/images/t.png', screenshotBeforeUrl: '/uploads/images/b.png' };
        expect(row(entry)).toMatchObject({ screenshotUrl: '/uploads/images/t.png', screenshotBeforeUrl: '/uploads/images/b.png' });
        expect(row({ ...entry, screenshotBeforeUrl: undefined })).toMatchObject({ screenshotUrl: '/uploads/images/t.png', screenshotBeforeUrl: null });
    });
});
