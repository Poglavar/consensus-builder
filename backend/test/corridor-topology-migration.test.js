import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/corridor-topology-migration.js'),
    'utf8'
);

function runMigration(proposals, normalize) {
    const save = vi.fn();
    const info = vi.fn();
    const window = {
        proposalStorage: { getAllProposals: () => proposals, save },
        normalizeCorridorDefinitionTopology: normalize
    };
    vm.runInNewContext(migrationSource, { window, globalThis: window, console: { info, warn: vi.fn() } });
    return { save, info };
}

describe('local corridor topology migration', () => {
    it('repairs and persists local definitions while keeping their mirrors aligned', () => {
        const definition = { points: [[{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]] };
        const proposal = {
            isMinted: false,
            roadProposal: { definition },
            definition: { stale: true },
            geometry: { roadPlan: { stale: true } }
        };
        const normalize = vi.fn(value => {
            value.points.push([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]);
            return true;
        });

        const { save } = runMigration([proposal], normalize);

        expect(normalize).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
        expect(proposal.definition).toEqual(definition);
        expect(proposal.geometry.roadPlan).toEqual(definition);
        expect(proposal.definition).not.toBe(definition); // mirrors are snapshots, not aliases
    });

    it('never rewrites minted or on-chain corridor definitions', () => {
        const proposals = [
            { isMinted: true, roadProposal: { definition: { points: [] } } },
            { onchain: { transactionHash: '0xabc' }, roadProposal: { definition: { points: [] } } }
        ];
        const normalize = vi.fn(() => true);

        const { save } = runMigration(proposals, normalize);

        expect(normalize).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });
});
