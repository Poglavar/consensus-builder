// The lens schema registration script: usage without parameters, and a dry run that prints the
// derived PDAs and exact layouts without sending anything.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/register-lens-schemas.mjs', import.meta.url));
const KEY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';

describe('register-lens-schemas.mjs', () => {
    it('prints usage and does nothing without parameters', () => {
        const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
        expect(out).toMatch(/^Usage:/);
        expect(out).not.toContain('credential PDA');
    });

    it('dry-runs by default with the sas-lib-derived PDAs and frozen layouts', () => {
        const out = execFileSync(process.execPath, [SCRIPT, '--authority', KEY], { encoding: 'utf8' });
        expect(out).toContain('(dry run)');
        expect(out).toContain('credential PDA:  8xXFCwX7ktNopNTi2LxNrNwAUhnpCjzU76V8KetnFAMJ');
        expect(out).toContain('Hzs9t2CcHVNSJYxrgcBY7sCpr8MoY6VM95Xm5K54m7pv');
        // AgreementDecision v1 under the same credential, as sas-lib 1.0.10 deriveSchemaPda derives it.
        expect(out).toContain('7JfxNayp1sLAWjpUvvQnbnSmiPLsKHrMv6BpPPyhjP3T');
        expect(out).toContain('string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt');
        expect(out).toContain('string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt');
        expect(out).toContain('SAS layout:    [12, 12, 12, 12, 8]');
        expect(out).toContain('nothing sent');
    });

    it('registers only the schemas asked for, and refuses one that does not exist', () => {
        const out = execFileSync(process.execPath, [SCRIPT, '--authority', KEY, '--schemas', 'decision'], { encoding: 'utf8' });
        expect(out).toContain('AgreementDecision-v1');
        expect(out).not.toContain('ParcelOwnership-v1');
        const run = spawnSync(process.execPath, [SCRIPT, '--authority', KEY, '--schemas', 'verdict'], { encoding: 'utf8' });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('unknown schema verdict');
    });

    it('refuses --live without a keypair', () => {
        const run = spawnSync(process.execPath, [SCRIPT, '--authority', KEY, '--live'], { encoding: 'utf8' });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('--live needs --keypair');
    });
});
