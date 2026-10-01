// The explorer's "Actor: X" scope must use the same identity rule as the API's ?actor= filter: an
// agent appears under its persona id in run events and under its wallet in chain/x402 events, and the
// server returns both for ?actor=<persona>. Matching actor.id alone hid every on-chain action.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { matchesActivityFilters } from '../routes/agent-activity.js';

const require = createRequire(import.meta.url);
const { matchesActivity } = require('../../frontend/js/agent-action-engine.js');

const runEvent = { source: 'live', actor: { id: 'densifier-01', name: 'densifier-01', wallet: 'G4R6wallet' }, action: { type: 'run_status' } };
const chainEvent = { source: 'live', actor: { id: 'G4R6wallet', name: 'densifier-01', wallet: 'G4R6wallet' }, action: { type: 'stake' } };
const otherEvent = { source: 'live', actor: { id: 'FoPmwallet', name: 'supporter-01', wallet: 'FoPmwallet' }, action: { type: 'stake' } };

describe('activity actor scope', () => {
    it('keeps an agent\'s run and chain events under either of its identities', () => {
        for (const actorId of ['densifier-01', 'G4R6wallet']) {
            expect([runEvent, chainEvent, otherEvent].filter(event => matchesActivity(event, { actorId }))).toEqual([runEvent, chainEvent]);
        }
    });

    it('agrees with the server-side ?actor= filter', () => {
        for (const actor of ['densifier-01', 'G4R6wallet', 'supporter-01', 'nobody']) {
            for (const event of [runEvent, chainEvent, otherEvent]) {
                expect(matchesActivity(event, { actorId: actor })).toBe(matchesActivityFilters(event, { actor }));
            }
        }
    });
});
