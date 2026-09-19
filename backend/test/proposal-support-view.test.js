import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const supportView = require('../../frontend/js/proposals/support-view.js');

describe('proposal support action presentation', () => {
    it('asks disconnected visitors to connect instead of showing impossible actions', () => {
        expect(supportView.actionKeys({ lifecycle: 'Active', walletConnected: false })).toEqual(['connect']);
        expect(supportView.actionKeys({ lifecycle: 'Executed', walletConnected: false })).toEqual(['connect']);
    });

    it('shows active support actions and only offers revoke for an active personal pledge', () => {
        expect(supportView.actionKeys({ lifecycle: 'Active', walletConnected: true })).toEqual(['donate', 'pledge']);
        expect(supportView.actionKeys({
            lifecycle: 'Active', walletConnected: true, summaryReady: true,
            summary: { myPledge: { status: 0, amount: 25n } }
        })).toEqual(['donate', 'pledge', 'revokePledge']);
    });

    it('only shows settlement actions backed by the connected wallet state', () => {
        expect(supportView.actionKeys({
            lifecycle: 'Cancelled', walletConnected: true, summaryReady: true,
            summary: { myDonations: [{ amount: 10n, refunded: false }], myPledge: { status: 0, amount: 25n } }
        })).toEqual(['refundMyDonations', 'voidPledge']);
        expect(supportView.actionKeys({
            lifecycle: 'Executed', walletConnected: true, summaryReady: true,
            summary: {
                donations: { totalDonated: 10n, totalRefunded: 0n, released: false },
                myPledge: { status: 1, amount: 25n }
            }
        })).toEqual(['releaseDonations']);
    });
});
