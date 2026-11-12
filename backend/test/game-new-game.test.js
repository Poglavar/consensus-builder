// Settings → Simulation → New game (frontend/js/game.js resetGameState): it says that every design
// goes too, deletes them through ProposalManager.clearAllProposals (one change that unapplies them
// first, never a raw storage clear), and resets nothing when that fails.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testI18n } from './helpers/i18n.js';

const source = readFileSync(new URL('../../frontend/js/game.js', import.meta.url), 'utf8');

function loadGame({ cleared = { ok: true, count: 2 }, confirmed = true } = {}) {
    const order = [];
    const dialog = { confirm: [], alert: [] };
    const window = {
        i18n: testI18n('en'),
        location: { search: '' },
        addEventListener() {},
        AgentActionEngine: { createActivitySource: () => ({}) },
        CbDialog: {
            confirm: async (message, options) => { dialog.confirm.push({ message, options }); return confirmed; },
            alert: async message => { dialog.alert.push(message); }
        }
    };
    const document = { readyState: 'loading', addEventListener() {} };
    const ProposalManager = { clearAllProposals: vi.fn(async () => { order.push('designs'); return cleared; }) };
    const proposalStorage = { clear: vi.fn() };
    const PersistentStorage = { ensureReady() {} };
    const updateStatus = vi.fn();
    const console = { log() {}, error() {}, warn() {} };
    const api = new Function('window', 'document', 'ProposalManager', 'proposalStorage', 'PersistentStorage', 'updateStatus', 'console',
        `${source}\nreturn { resetGameState, gameState };`)(window, document, ProposalManager, proposalStorage, PersistentStorage, updateStatus, console);
    api.gameState.reset = vi.fn(() => order.push('game'));
    return { ...api, order, dialog, ProposalManager, proposalStorage };
}

describe('New game', () => {
    it('says every design is deleted, deletes them as one change, then resets the game', async () => {
        const game = loadGame();
        await game.resetGameState(true);
        expect(game.dialog.confirm[0].message).toBe('Are you sure you want to start a NEW game? This will delete all agents, game progress, parcel ownership data and every design saved in this browser. Published designs stay available through their links.');
        expect(game.dialog.confirm[0].options).toEqual({ destructive: true });
        expect(game.ProposalManager.clearAllProposals).toHaveBeenCalledTimes(1);
        expect(game.proposalStorage.clear).not.toHaveBeenCalled();
        expect(game.order).toEqual(['designs', 'game']);
        expect(game.gameState.reset).toHaveBeenCalledWith(true);
    });

    it('resets nothing and says so when the designs cannot be deleted', async () => {
        const game = loadGame({ cleared: false });
        await game.resetGameState(true);
        expect(game.gameState.reset).not.toHaveBeenCalled();
        expect(game.dialog.alert).toEqual(['Error clearing design data. Please try again.']);
    });

    it('deletes nothing when the question is cancelled', async () => {
        const game = loadGame({ confirmed: false });
        await game.resetGameState(true);
        expect(game.ProposalManager.clearAllProposals).not.toHaveBeenCalled();
        expect(game.gameState.reset).not.toHaveBeenCalled();
    });
});
