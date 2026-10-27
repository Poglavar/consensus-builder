import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { makeDocument, makeEvent } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const BusyControl = require('../../frontend/js/ui/busy-control.js');
const claimSource = readFileSync(new URL('../../frontend/js/parcels/ui/claim.js', import.meta.url), 'utf8');
const start = claimSource.indexOf('function setParcelMintStatusIndicator(');
const end = claimSource.indexOf('\n    function resetParcelMintStatusState', start);
const indicatorSource = claimSource.slice(start, end);

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function harness(pending) {
    const document = makeDocument();
    const indicator = document.createElement('div');
    indicator.id = 'parcelMintStatus';
    document.body.appendChild(indicator);
    const console = { error: vi.fn() };
    const host = { document, BusyControl, console };
    const context = createContext({ global: host, deferred: pending, console });
    runInContext(`
        let activeMintStatusRetry = null;
        let currentParcelMintStatusCache = null;
        function getParcelMintStatusElement() { return global.document.getElementById('parcelMintStatus'); }
        function formatChainLabel(value) { return value || null; }
        function tParcel(_key, _params, fallback) { return fallback; }
        function setParcelClaimButtonsState() {}
        function recheckParcelMintStatus(event) {
            event.stopPropagation(); event.preventDefault();
            setParcelMintStatusIndicator('Checking NFT status...', 'loading');
            return deferred.promise.then(
                () => setParcelMintStatusIndicator('NFT minted', 'minted'),
                () => { setParcelMintStatusIndicator('Status check failed', 'error'); throw new Error('deferred status failure'); }
            );
        }
        ${indicatorSource}
        global.setParcelMintStatusIndicator = setParcelMintStatusIndicator;
    `, context);
    return { indicator, console, setStatus: host.setParcelMintStatusIndicator };
}

describe('parcel NFT status retry control', () => {
    it.each(['resolve', 'reject'])('keeps the native retry button busy through a deferred %s check', async outcome => {
        const pending = deferred();
        const { indicator, console, setStatus } = harness(pending);
        setStatus('NFT not found. Click to check again.', 'not-minted', 'testnet');
        const retry = indicator.firstChild;

        expect(retry.tagName).toBe('BUTTON');
        expect(retry.classList.contains('btn')).toBe(true);
        expect(indicator.listeners.has('click')).toBe(false);
        expect(indicator.onclick).toBeUndefined();

        retry.dispatchEvent(makeEvent('click'));
        expect(indicator.firstChild).toBe(retry);
        expect(retry.textContent).toContain('Checking NFT status');
        expect(retry.getAttribute('aria-busy')).toBe('true');
        expect(retry.classList.contains('cb-busy')).toBe(true);

        outcome === 'resolve' ? pending.resolve() : pending.reject(new Error('network failure'));
        await vi.waitFor(() => expect(indicator.firstChild).not.toBe(retry));
        expect(retry.getAttribute('aria-busy')).toBeNull();
        expect(retry.classList.contains('cb-busy')).toBe(false);
        if (outcome === 'resolve') {
            expect(indicator.textContent).toBe('NFT minted');
            expect(indicator.children).toHaveLength(0);
        } else {
            expect(indicator.firstChild.tagName).toBe('BUTTON');
            expect(indicator.textContent).toContain('Status check failed');
            expect(console.error).toHaveBeenCalled();
        }
    });

    it('keeps neutral and minted states as plain text', () => {
        const { indicator, setStatus } = harness(deferred());
        setStatus('Status not checked', 'neutral');
        expect(indicator.children).toHaveLength(0);
        expect(indicator.textContent).toBe('Status not checked');
        setStatus('NFT minted', 'minted');
        expect(indicator.children).toHaveLength(0);
        expect(indicator.textContent).toBe('NFT minted');
        expect(indicator.listeners.has('click')).toBe(false);
    });
});
