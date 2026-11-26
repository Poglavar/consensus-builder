// supporter-picker.js support.focusCities: an open agreement in a focus city is supported before any
// other; with none open there, the supporter picks among all as before.
import { describe, expect, it } from 'vitest';
import { selectSupportAction } from '../agents/supporter-picker.js';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const agreement = (cid, city) => ({ cid, city, name: cid, account: `acct-${cid}`, author: 'someone', sponsor: 'Sponsor1111111111111111111111111111111111',
    chainStatus: 'active', deadline: '2026-11-29T12:00:00Z', createdAt: '2026-11-25T12:00:00Z' });
const persona = focusCities => ({ name: 'supporter-t', support: { actions: ['donate'], amountUsdc: '0.10', ...(focusCities ? { focusCities } : {}) } });
const agreements = ['a', 'b', 'c', 'd', 'e', 'f'].map(cid => agreement(`zg-${cid}`, 'zagreb')).concat([agreement('al-1', 'alatau')]);

describe('supporting a focus city first', () => {
    it('picks the focus city\'s open agreement whatever the daily ranking says', () => {
        for (const day of ['2026-11-26', '2026-11-27', '2026-11-28']) {
            expect(selectSupportAction({ day, persona: persona(['alatau']), agreements, now: NOW }).selected.agreementCid).toBe('al-1');
        }
        const unfocused = ['2026-11-26', '2026-11-27', '2026-11-28'].map(day => selectSupportAction({ day, persona: persona(), agreements, now: NOW }).selected.agreementCid);
        expect(unfocused.some(cid => cid !== 'al-1')).toBe(true);
    });
    it('falls back to every open agreement when the focus city has none', () => {
        expect(selectSupportAction({ day: '2026-11-26', persona: persona(['alatau']), agreements: agreements.slice(0, 6), now: NOW }).selected.agreementCid).toMatch(/^zg-/);
    });
});
