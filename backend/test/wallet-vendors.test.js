import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/wallet-vendors.js', import.meta.url), 'utf8');

function page() {
    const requests = [];
    const win = { document: {
        createElement: () => ({ remove: vi.fn() }),
        head: { appendChild: script => requests.push(script) }
    } };
    vm.runInNewContext(source, { window: win });
    return { win, requests };
}

const evm = { name: 'evm', global: 'ethers', api: { BrowserProvider: class {}, Contract: class {} } };
const solana = { name: 'solana', global: 'solanaWeb3', api: { Connection: class {}, PublicKey: class {}, Transaction: class {} } };

it.each([
    { first: evm, second: solana },
    { first: solana, second: evm }
])('retries an incomplete $second.name SDK while $first.name stays ready', async ({ first, second }) => {
    const { win, requests } = page();
    const load = win.ensureWalletVendors;
    expect(requests).toHaveLength(0);
    const ready = load(first.name);
    const both = load();
    expect(requests).toHaveLength(2);

    win[first.global] = first.api;
    requests[0].onload();
    expect(await ready).toBe(true); // The second request is still pending.
    win[second.global] = {};
    requests[1].onload();
    expect(await both).toBe(false);
    expect(requests[1].remove).toHaveBeenCalledOnce();

    const retry = load(second.name);
    expect(load(second.name)).toBe(retry);
    expect(requests).toHaveLength(3);
    expect(requests[2].src).toBe(requests[1].src);
    win[second.global] = second.api;
    requests[2].onload();
    expect(await retry).toBe(true);
    expect(await load()).toBe(true);
    expect(requests).toHaveLength(3);
});
