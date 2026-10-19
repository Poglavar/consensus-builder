import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/minted-proposals.js', import.meta.url), 'utf8');

function loadModule({ readyState = 'complete', status = 'connected' } = {}) {
    // The button starts hidden (the hidden attribute in index.html) and shows with a wallet.
    const button = { hidden: true };
    const documentListeners = new Map();
    const walletListeners = new Map();
    let currentStatus = status;
    const document = {
        readyState,
        addEventListener: vi.fn((name, callback) => documentListeners.set(name, callback)),
        getElementById: vi.fn(id => id === 'mintedProposalsButton' ? button : null)
    };
    const walletManager = {
        getState: vi.fn(() => ({ status: currentStatus, accounts: currentStatus === 'connected' ? ['0x1234'] : [] })),
        on: vi.fn((name, callback) => {
            walletListeners.set(name, callback);
            return () => walletListeners.delete(name);
        })
    };
    const window = { walletManager, location: { protocol: 'http:', hostname: 'localhost' } };
    vm.runInNewContext(source, { window, document, URL, console, setTimeout, clearTimeout });
    return { button, document, documentListeners, walletManager, walletListeners, setStatus: value => { currentStatus = value; } };
}

describe('minted proposal button wallet visibility', () => {
    it('initializes immediately when the deferred script loads after DOMContentLoaded', () => {
        const { button, document, walletManager, walletListeners } = loadModule({ readyState: 'complete' });

        expect(button.hidden).toBe(false);
        expect(walletManager.on).toHaveBeenCalledTimes(4);
        expect([...walletListeners.keys()]).toEqual(['stateChanged', 'connect', 'disconnect', 'accountsChanged']);
        expect(document.addEventListener).not.toHaveBeenCalledWith('DOMContentLoaded', expect.any(Function));
    });

    it('refreshes immediately on DOMContentLoaded while the document is still loading', () => {
        const { button, document, documentListeners, walletManager } = loadModule({ readyState: 'loading' });
        expect(button.hidden).toBe(true);
        expect(walletManager.on).not.toHaveBeenCalled();

        documentListeners.get('DOMContentLoaded')();

        expect(button.hidden).toBe(false);
        expect(walletManager.on).toHaveBeenCalledTimes(4);
    });

    it('updates visibility from connected and disconnected wallet state events', () => {
        const { button, walletListeners, setStatus } = loadModule({ readyState: 'complete', status: 'disconnected' });
        expect(button.hidden).toBe(true);

        setStatus('connected');
        const refresh = walletListeners.get('stateChanged');
        expect(refresh).toBeTypeOf('function');
        refresh();
        expect(button.hidden).toBe(false);
        setStatus('disconnected');
        refresh();
        expect(button.hidden).toBe(true);
    });
});
