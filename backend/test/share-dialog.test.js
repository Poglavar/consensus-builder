// The Share box's links (frontend/js/ui/share-dialog.js): X's compose page with the record's text and
// link, and the X search for posts that carry the link whatever its query.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ShareDialog = require('../../frontend/js/ui/share-dialog.js');
const LINK = 'https://urbangametheory.xyz/plans/bafkreiabc?city=zg&3d&lang=hr';

describe('Post on X', () => {
    it('opens X\'s compose page with the text, the link and the account', () => {
        const url = new URL(ShareDialog.postOnXUrl({ text: 'Plan: Riverside & Co', url: LINK }));
        expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
        expect(url.searchParams.get('text')).toBe('Plan: Riverside & Co');
        expect(url.searchParams.get('url')).toBe(LINK);
        expect(url.searchParams.get('via')).toBe('urbangametheory');
    });
    it('leaves the text out when there is none', () => {
        expect(new URL(ShareDialog.postOnXUrl({ url: LINK })).searchParams.has('text')).toBe(false);
    });
    it('names the record by its kind and title, and an untitled one by its kind', () => {
        expect(ShareDialog.postText('design', 'Pocket park')).toBe('Design: Pocket park');
        expect(ShareDialog.postText('agreement', '  ')).toBe('Proposed agreement: An agreement');
        expect(ShareDialog.postText('bet', 'Will it be built by 2027?')).toBe('Will it be built by 2027?');
    });
});

describe('Posts about this on X', () => {
    it('searches the link\'s host and path, newest first, without its query', () => {
        const url = new URL(ShareDialog.postsAboutUrl(LINK));
        expect(url.origin + url.pathname).toBe('https://x.com/search');
        expect(url.searchParams.get('q')).toBe('url:"urbangametheory.xyz/plans/bafkreiabc"');
        expect(url.searchParams.get('f')).toBe('live');
    });
});

describe('the strings', () => {
    it('exist in every language for every kind', () => {
        for (const lang of ['en', 'hr', 'sr', 'es', 'fr', 'pt', 'ar']) {
            const share = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${lang}.json`, import.meta.url), 'utf8')).share;
            for (const kind of ShareDialog.KINDS) {
                expect(share.title[kind], `${lang} title.${kind}`).toBeTruthy();
                expect(share.linkLabel[kind], `${lang} linkLabel.${kind}`).toBeTruthy();
                expect(share.postText[kind], `${lang} postText.${kind}`).toContain('{{title}}');
            }
            for (const key of ['copy', 'copied', 'copyByHand', 'postOnX', 'native', 'nativeFailed', 'postsAbout']) expect(share[key], `${lang} ${key}`).toBeTruthy();
        }
    });
});
