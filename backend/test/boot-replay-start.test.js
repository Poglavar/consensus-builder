// The boot replay starts when the map core is ready (PersistentStorage ready + initializeMapCore),
// not on window `load`, which also waits for every basemap tile (proposal-manager.js
// startBootReplayWhenReady, map-core.js whenMapCoreReady).
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startBootReplayWhenReady } = require('../../frontend/js/proposal-manager.js');

function fakeRoot() {
    const listeners = new Map();
    let markReady;
    const mapCoreReady = new Promise(resolve => { markReady = resolve; });
    const on = (target, type, listener) => {
        const key = `${target}:${type}`;
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(listener);
    };
    const fire = key => (listeners.get(key) || []).forEach(listener => listener());
    const root = {
        document: { addEventListener: (type, listener) => on('document', type, listener) },
        addEventListener: (type, listener) => on('window', type, listener),
        whenMapCoreReady: () => mapCoreReady,
        ProposalManager: { reapplyAppliedProposals: vi.fn(() => Promise.resolve()) }
    };
    return { root, fire, markReady };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('boot replay start', () => {
    it('starts once the map core is ready, without window load', async () => {
        const { root, fire, markReady } = fakeRoot();
        startBootReplayWhenReady(root);

        fire('document:DOMContentLoaded');
        await settle();
        expect(root.ProposalManager.reapplyAppliedProposals).not.toHaveBeenCalled();

        markReady();
        await settle();
        expect(root.ProposalManager.reapplyAppliedProposals).toHaveBeenCalledTimes(1);
    });

    it('fails loudly when map-core did not provide the readiness promise', () => {
        const { root, fire } = fakeRoot();
        delete root.whenMapCoreReady;
        startBootReplayWhenReady(root);
        expect(() => fire('document:DOMContentLoaded')).toThrow(/whenMapCoreReady/);
    });
});
