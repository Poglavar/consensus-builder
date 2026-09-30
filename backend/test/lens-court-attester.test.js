// The court oracle's trusted attester is configuration (env COURT_ATTESTER) with a documented
// default, not a bare constant in the recipe builder.

import { describe, expect, it } from 'vitest';
import { COURT_ATTESTER, courtAttesterFromEnv, DEFAULT_COURT_ATTESTER } from '../oracle/court-parcel-operation.js';

describe('court attester configuration', () => {
    it('defaults to the documented key when COURT_ATTESTER is unset or blank', () => {
        expect(courtAttesterFromEnv({})).toBe(DEFAULT_COURT_ATTESTER);
        expect(courtAttesterFromEnv({ COURT_ATTESTER: '  ' })).toBe(DEFAULT_COURT_ATTESTER);
        expect(DEFAULT_COURT_ATTESTER).toBe('AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ');
    });

    it('uses a configured key and refuses anything that is not a base58 public key', () => {
        expect(courtAttesterFromEnv({ COURT_ATTESTER: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg' }))
            .toBe('G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg');
        expect(() => courtAttesterFromEnv({ COURT_ATTESTER: 'not-a-key' })).toThrow(/base58/);
    });

    it('resolves the module constant from the environment at load', () => {
        expect(COURT_ATTESTER).toBe(courtAttesterFromEnv(process.env));
    });
});
