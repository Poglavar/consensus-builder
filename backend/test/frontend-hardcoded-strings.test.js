// Every user-facing string is an i18n key (docs/design-language.md). The status bar used to be
// English in every language because 217 `updateStatus('…')` calls passed raw literals, 114 of which
// already existed word for word in en.json. This ratchet counts, per JS file, calls to a UI sink
// (updateStatus, showEphemeralMessage, alert, confirm, styled alert/confirm) whose first argument is a
// plain English literal of three or more words, and compares against the baseline in
// backend/test/fixtures/design-baselines.json: a file may only lose literals, and a file not in the
// baseline may have none. Rerun `node backend/test/helpers/design-audit.mjs --write` after lowering.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND, auditNow, readBaseline, hardcodedSinkLiterals } from './helpers/design-audit.mjs';

const baseline = readBaseline();
const now = auditNow();

describe('English literals in UI sinks', () => {
    it('has a baseline', () => {
        expect(baseline && baseline.js).toBeTruthy();
    });

    it('no file writes more raw literals into a UI sink than before', () => {
        const ceilings = (baseline && baseline.js) || {};
        const over = {};
        Object.entries(now.js).forEach(([file, count]) => {
            const ceiling = ceilings[file] || 0;
            if (count > ceiling) {
                const sample = hardcodedSinkLiterals(readFileSync(path.join(FRONTEND, file), 'utf8')).slice(0, 5);
                over[file] = { count, ceiling, sample };
            }
        });
        expect(over).toEqual({});
    });
});
