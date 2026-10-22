// The bet link codec (frontend/js/bets/bets-link.js): the shareable path form, the app's query
// form, and the agreement account each one names (a bet is named by the agreement's chain account,
// the market's subject, never by its CID).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BetsLink = require('../../frontend/js/bets/bets-link.js');

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
// An agreement's CID (CIDv1 raw, base32): what /agreements/<cid> shares, not what a bet link names.
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

describe('BetsLink.parse', () => {
    it('reads the shareable path form with its city and language', () => {
        expect(BetsLink.parse({ pathname: `/bets/${ACCOUNT}`, search: '?city=zg&lang=hr' }))
            .toEqual({ account: ACCOUNT, city: 'zg', lang: 'hr' });
        expect(BetsLink.parse({ pathname: `/bets/${ACCOUNT}/`, search: '' }))
            .toEqual({ account: ACCOUNT, city: null, lang: null });
    });

    it('reads the app query form', () => {
        expect(BetsLink.parse({ pathname: '/', search: `?city=san_francisco&bets=${ACCOUNT}&reduceMotion=1` }))
            .toEqual({ account: ACCOUNT, city: 'san_francisco', lang: null });
    });

    it('is null for anything that is not a bet link', () => {
        expect(BetsLink.parse({ pathname: '/', search: '?city=zg' })).toBeNull();
        expect(BetsLink.parse({ pathname: '/bets/', search: '' })).toBeNull();
        expect(BetsLink.parse({ pathname: '/bets/not-an-account', search: '' })).toBeNull();
        expect(BetsLink.parse({ pathname: '/', search: '?bets=0OIl' })).toBeNull();   // not base58
        expect(BetsLink.parse({ pathname: `/bets/${CID}`, search: '' })).toBeNull();   // a CID is not an account
        expect(BetsLink.parse({ pathname: '/', search: `?bets=${CID}` })).toBeNull();
        expect(BetsLink.parse({ pathname: `/agreements/${CID}`, search: '' })).toBeNull();
        expect(BetsLink.parse(null)).toBeNull();
    });

    it('drops a city or language that is not one', () => {
        expect(BetsLink.parse({ pathname: '/', search: `?bets=${ACCOUNT}&city=<script>&lang=javascript:` }))
            .toEqual({ account: ACCOUNT, city: null, lang: null });
    });
});

describe('BetsLink.build and appHref', () => {
    it('builds the shareable link on an origin', () => {
        expect(BetsLink.build({ origin: 'https://urbangametheory.xyz/', city: 'zg', account: ACCOUNT }))
            .toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zg`);
        expect(BetsLink.build({ origin: 'http://localhost:5650', city: 'san_francisco', account: ACCOUNT, lang: 'es' }))
            .toBe(`http://localhost:5650/bets/${ACCOUNT}?city=san_francisco&lang=es`);
    });

    it('refuses to build without the account of a minted agreement', () => {
        expect(() => BetsLink.build({ origin: 'https://urbangametheory.xyz', city: 'zg', account: 'row-790' })).toThrow(/minted agreement/);
        expect(() => BetsLink.build({ origin: 'https://urbangametheory.xyz', city: 'zg', account: CID })).toThrow(/minted agreement/);
        expect(() => BetsLink.build({ origin: 'https://urbangametheory.xyz', city: 'zg' })).toThrow(/minted agreement/);
    });

    it('round-trips through parse', () => {
        const href = BetsLink.build({ origin: 'https://urbangametheory.xyz', city: 'zg', account: ACCOUNT, lang: 'hr' });
        const url = new URL(href);
        expect(BetsLink.parse(url)).toEqual({ account: ACCOUNT, city: 'zg', lang: 'hr' });
    });

    it('builds the app form the server redirects to', () => {
        expect(BetsLink.appHref({ city: 'zg', account: ACCOUNT })).toBe(`/?city=zg&bets=${ACCOUNT}`);
        expect(BetsLink.appHref({ city: 'zg', account: ACCOUNT, lang: 'hr' })).toBe(`/?city=zg&bets=${ACCOUNT}&lang=hr`);
        expect(BetsLink.appHref({ city: 'zg', account: 'unknown' })).toBe('/?city=zg');
        expect(BetsLink.appHref({})).toBe('/');
    });
});
