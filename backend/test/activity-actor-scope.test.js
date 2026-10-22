// The explorer's scopes must use the same rules as the API's filters: an agent appears under its persona
// id in run events and under its wallet in chain events, and the server returns both for ?actor=<persona>
// (matching actor.id alone hid every on-chain action); and an agreement scope keeps the events whose
// entity is that agreement or whose action names it (?agreement=<cid> on the server, agreementCid in the
// browser's filter, frontend/js/agent-action-engine.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { matchesActivityFilters } from '../routes/agent-activity.js';

const require = createRequire(import.meta.url);
const { matchesActivity } = require('../../frontend/js/agent-action-engine.js');

const CID = 'bafkreiagreementaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bafkreiagreementbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const runEvent = { source: 'live', actor: { id: 'densifier-01', name: 'densifier-01', wallet: 'G4R6wallet' }, action: { type: 'run_status' } };
const chainEvent = { source: 'live', actor: { id: 'G4R6wallet', name: 'densifier-01', wallet: 'G4R6wallet' }, action: { type: 'stake', agreementCid: CID }, entity: { type: 'agreement', id: CID } };
const otherEvent = { source: 'live', actor: { id: 'FoPmwallet', name: 'supporter-01', wallet: 'FoPmwallet' }, action: { type: 'stake', agreementCid: OTHER }, entity: { type: 'agreement', id: OTHER } };
const designEvent = { source: 'live', actor: { id: 'densifier-01', name: 'densifier-01' }, action: { type: 'design', designCid: 'bafkreidesign' }, entity: { type: 'design', id: 'bafkreidesign' } };
const events = [runEvent, chainEvent, otherEvent, designEvent];

describe('activity actor scope', () => {
    it('keeps an agent\'s run and chain events under either of its identities', () => {
        for (const actorId of ['densifier-01', 'G4R6wallet']) {
            expect([runEvent, chainEvent, otherEvent].filter(event => matchesActivity(event, { actorId }))).toEqual([runEvent, chainEvent]);
        }
    });

    it('agrees with the server-side ?actor= filter', () => {
        for (const actor of ['densifier-01', 'G4R6wallet', 'supporter-01', 'nobody']) {
            for (const event of events) {
                expect(matchesActivity(event, { actorId: actor })).toBe(matchesActivityFilters(event, { actor }));
            }
        }
    });
});

describe('activity agreement scope', () => {
    it('keeps the events of one agreement, by entity or by the action\'s agreementCid, on both sides', () => {
        expect(events.filter(event => matchesActivity(event, { agreementCid: CID }))).toEqual([chainEvent]);
        const bySide = { ...otherEvent, entity: null, action: { type: 'claim', agreementCid: CID } };
        for (const agreement of [CID, OTHER, 'bafkreinone']) {
            for (const event of [...events, bySide]) {
                expect(matchesActivity(event, { agreementCid: agreement })).toBe(matchesActivityFilters(event, { agreement }));
            }
        }
    });
});
