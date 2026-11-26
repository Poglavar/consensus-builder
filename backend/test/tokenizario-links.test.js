// Tokenizario links exist only where the live site has a page: a Solana key on devnet.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { walletPageUrl, isSolanaKey } = createRequire(import.meta.url)('../../frontend/js/tokenizario-links.js');
const KEY = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';

describe('Tokenizario wallet page links', () => {
    it('links a Solana key on devnet to its wallet page, naming the network', () => {
        expect(walletPageUrl(KEY, 'devnet')).toBe(`https://tokenizario.app/address/${KEY}?chain=devnet`);
        expect(walletPageUrl(`  ${KEY} `, 'devnet')).toBe(`https://tokenizario.app/address/${KEY}?chain=devnet`);
    });
    it('gives no link for an address the live site has no page for', () => {
        expect(walletPageUrl('0x1111111111111111111111111111111111111111', 'devnet')).toBeNull();
        expect(walletPageUrl('notary01', 'devnet')).toBeNull();
        expect(walletPageUrl('', 'devnet')).toBeNull();
        expect(walletPageUrl(null, 'devnet')).toBeNull();
    });
    it('gives no link on a cluster the live site does not serve', () => {
        expect(walletPageUrl(KEY, 'mainnet-beta')).toBeNull();
        expect(walletPageUrl(KEY, undefined)).toBeNull();
    });
    it('recognises base58 keys only', () => {
        expect(isSolanaKey(KEY)).toBe(true);
        expect(isSolanaKey('0OIl' + KEY.slice(4))).toBe(false);
    });
});
