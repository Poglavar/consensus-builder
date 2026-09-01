// A boot replay materializes the applied-set snapshot. It is not another proposal-state writer.
// The former corridor sweep changed 298 stored applied records to 296 during Šibenik replay,
// restarted the complete derivation, and left the shared-route loader to apply those two again.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manager = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
const tunnel = readFileSync(new URL('../../frontend/js/corridor-tunnel.js', import.meta.url), 'utf8');

describe('boot replay owns no proposal-state transition', () => {
    it('takes one standing snapshot and performs one pass', () => {
        const rebuild = manager.slice(
            manager.indexOf('    async rebuildAppliedFabric(options = {}) {'),
            manager.indexOf('    _orderedStandingProposals() {')
        );

        expect(rebuild).toContain('const standing = appliedNow();');
        expect(rebuild).toContain('this._rebuildPass(standing');
        expect(rebuild).toContain('preserveAppliedSet: true');
        expect(rebuild).not.toContain('for (let pass');
        expect(rebuild).not.toContain('while (');
    });

    it('uses the canonical formation resolver after the corridor fabric exists', () => {
        const pass = manager.slice(
            manager.indexOf('    async _rebuildPass(appliedList, opts) {'),
            manager.indexOf('    _clearDerivedRecordState(proposal) {')
        );

        expect(pass).toContain('await this._deriveCorridorFabric');
        expect(pass).toContain('await this.applyProposal(key, replayOptions)');
        expect(pass).not.toContain('groundSweep');
        expect(pass).not.toContain('invalidatedIds');
    });

    it('does not let supersession or demolition mutate the snapshot', () => {
        expect(manager).toContain('if (result && applyOptions.preserveAppliedSet !== true)');
        expect(tunnel).toContain('if (options.preserveAppliedSet === true) continue;');
    });
});
