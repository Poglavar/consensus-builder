// FreeformGroundBefore.replayScope: which applied designs and cadastral parcels the land review
// replays to read the ground under a design as it stood before that design.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { replayScope } = require('../../frontend/js/freeform-ground-before.js');

const design = (proposalId, cadastreParcelIds) => ({ proposalId, cadastreParcelIds });

describe('the replay behind the land review', () => {
    it('takes every other design on the parcels, and the parcels those designs reach, until nothing new is reached', () => {
        const layout = design('layout', ['C']);
        const road = design('road', ['C', 'D']);
        const park = design('park', ['D', 'E']);
        const far = design('far', ['Z']);
        const tower = design('tower', ['C']);
        const scope = replayScope([layout, road, park, far, tower], ['C'], 'tower');
        expect(scope.designs).toEqual([layout, road, park]);
        expect(scope.ids).toEqual(['C', 'D', 'E']);
    });
    it('leaves the design under edit out, and a design with no parcels', () => {
        const tower = design('tower', ['C']);
        expect(replayScope([tower, design('drawn', [])], ['C'], 'tower')).toEqual({ ids: ['C'], designs: [] });
    });
    it('reads no ground, without a replay, under a design moved off every parcel', async () => {
        const refused = () => { throw new Error('Cadastral replacement scope cannot be empty.'); };
        const window = {
            proposalStorage: { getAllProposals: () => [design('tower', ['C'])] }, isApplied: () => true,
            CadastralParcelRepository: { ensureIds: refused, getMany: refused }, AgreementHeadless: { materialize: refused }
        };
        vm.runInNewContext(readFileSync(new URL('../../frontend/js/freeform-ground-before.js', import.meta.url), 'utf8'), { window, console });
        await expect(window.FreeformGroundBefore.read({ ownId: 'tower', cadastreIds: [] })).resolves.toEqual({ ids: [], pieces: [] });
    });
});
