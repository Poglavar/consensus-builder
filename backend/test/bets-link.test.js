// The bet link codec (frontend/js/bets/bets-link.js): the shareable path form, the app's query
// form, and what each one names.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BetsLink = require('../../frontend/js/bets/bets-link.js');

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';

describe('BetsLink.parse', () => {
    it('reads the shareable path form with its city and language', () => {
        expect(BetsLink.parse({ pathname: `/bets/${ACCOUNT}`, search: '?city=zg&lang=hr' }))
            .toEqual({ proposalAccount: ACCOUNT, city: 'zg', lang: 'hr' });
        expect(BetsLink.parse({ pathname: `/bets/${ACCOUNT}/`, search: '' }))
            .toEqual({ proposalAccount: ACCOUNT, city: null, lang: null });
    });

    it('reads the app query form', () => {
        expect(BetsLink.parse({ pathname: '/', search: `?city=san_francisco&bets=${ACCOUNT}&reduceMotion=1` }))
            .toEqual({ proposalAccount: ACCOUNT, city: 'san_francisco', lang: null });
    });

    it('is null for anything that is not a bet link', () => {
        expect(BetsLink.parse({ pathname: '/', search: '?city=zg' })).toBeNull();
        expect(BetsLink.parse({ pathname: '/bets/', search: '' })).toBeNull();
        expect(BetsLink.parse({ pathname: '/bets/not-an-account', search: '' })).toBeNull();
        expect(BetsLink.parse({ pathname: '/', search: '?bets=0OIl' })).toBeNull();   // not base58
        expect(BetsLink.parse({ pathname: '/proposals/12', search: '' })).toBeNull();
        expect(BetsLink.parse(null)).toBeNull();
    });

    it('drops a city or language that is not one', () => {
        expect(BetsLink.parse({ pathname: '/', search: `?bets=${ACCOUNT}&city=<script>&lang=javascript:` }))
            .toEqual({ proposalAccount: ACCOUNT, city: null, lang: null });
    });
});

describe('BetsLink.build and appHref', () => {
    it('builds the shareable link on an origin', () => {
        expect(BetsLink.build({ origin: 'https://urbangametheory.xyz/', city: 'zg', proposalAccount: ACCOUNT }))
            .toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zg`);
        expect(BetsLink.build({ origin: 'http://localhost:5650', city: 'san_francisco', proposalAccount: ACCOUNT, lang: 'es' }))
            .toBe(`http://localhost:5650/bets/${ACCOUNT}?city=san_francisco&lang=es`);
    });

    it('refuses to build without a proposal account', () => {
        expect(() => BetsLink.build({ origin: 'https://urbangametheory.xyz', city: 'zg', proposalAccount: 'row-790' })).toThrow();
    });

    it('round-trips through parse', () => {
        const href = BetsLink.build({ origin: 'https://urbangametheory.xyz', city: 'zg', proposalAccount: ACCOUNT, lang: 'hr' });
        const url = new URL(href);
        expect(BetsLink.parse(url)).toEqual({ proposalAccount: ACCOUNT, city: 'zg', lang: 'hr' });
    });

    it('builds the app form the server redirects to', () => {
        expect(BetsLink.appHref({ city: 'zg', proposalAccount: ACCOUNT })).toBe(`/?city=zg&bets=${ACCOUNT}`);
        expect(BetsLink.appHref({ city: 'zg', proposalAccount: 'unknown' })).toBe('/?city=zg');
        expect(BetsLink.appHref({})).toBe('/');
    });
});
