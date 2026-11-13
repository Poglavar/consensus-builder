// The Share box for a published design, plan, agreement or bet: its link (copied as the box opens),
// Copy, Post on X (a prefilled compose page, no API), the device's own Share… sheet where there is
// one, and an X search for posts that carry the link. The link and post builders are pure, for tests.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.ShareDialog = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const X_ACCOUNT = 'urbangametheory';
    const KINDS = Object.freeze(['design', 'plan', 'agreement', 'bet']);

    // X's compose page, prefilled; `via` appends "via @urbangametheory".
    function postOnXUrl({ text = '', url }) {
        const query = new URLSearchParams();
        if (text) query.set('text', text);
        query.set('url', url);
        query.set('via', X_ACCOUNT);
        return `https://x.com/intent/post?${query}`;
    }

    // Posts that carry this record's link. X's url: operator matches the link's host and path; the
    // query (city, view, language) differs from one sharer to the next, so it is left out.
    function postsAboutUrl(link) {
        const url = new URL(link);
        const query = new URLSearchParams({ q: `url:"${url.host}${url.pathname}"`, f: 'live' });
        return `https://x.com/search?${query}`;
    }

    function interpolate(text, params = {}) {
        return String(text).replace(/\{\{(\w+)\}\}/g, (match, name) => (params[name] == null ? match : String(params[name])));
    }

    function translator(win) {
        return (key, fallback, params = {}) => {
            const value = win?.i18n?.t?.(`share.${key}`, params);
            return value && value !== `share.${key}` ? value : interpolate(fallback, params);
        };
    }

    const POST_TEXT = Object.freeze({
        design: ['postText.design', 'Design: {{title}}'],
        plan: ['postText.plan', 'Plan: {{title}}'],
        agreement: ['postText.agreement', 'Proposed agreement: {{title}}'],
        bet: ['postText.bet', '{{title}}']
    });
    const UNTITLED = Object.freeze({
        design: ['untitled.design', 'A design'],
        plan: ['untitled.plan', 'A plan'],
        agreement: ['untitled.agreement', 'An agreement'],
        bet: ['untitled.bet', 'A bet']
    });
    const LINK_LABELS = Object.freeze({
        design: ['linkLabel.design', 'Design link'],
        plan: ['linkLabel.plan', 'Plan link'],
        agreement: ['linkLabel.agreement', 'Agreement link'],
        bet: ['linkLabel.bet', 'Bet link']
    });
    const TITLES = Object.freeze({
        design: ['title.design', 'Share design'],
        plan: ['title.plan', 'Share plan'],
        agreement: ['title.agreement', 'Share agreement'],
        bet: ['title.bet', 'Share bet']
    });

    // The post's text: the record's kind and title, in the reader's language.
    function postText(kind, title, t = translator(null)) {
        const name = String(title || '').trim() || t(...UNTITLED[kind]);
        return t(POST_TEXT[kind][0], POST_TEXT[kind][1], { title: name });
    }

    const pure = { X_ACCOUNT, KINDS, postOnXUrl, postsAboutUrl, postText };
    if (!root || !root.document) return Object.freeze(pure);

    const log = (...args) => console.info(`[${new Date().toISOString()}] [share]`, ...args);

    function node(tag, className, text) {
        const element = root.document.createElement(tag);
        if (className) element.className = className;
        if (text != null) element.textContent = text;
        return element;
    }

    function external(className, text, href) {
        const link = node('a', className, text);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    }

    async function copy(link) {
        if (root.DesignSync?.copyLink) return root.DesignSync.copyLink(link);
        try { await root.navigator.clipboard.writeText(link); return true; } catch (_) { return false; }
    }

    // The link row and the ways to share it, for a surface that already is a dialog (the plan's).
    // `copied`: whether the copy just tried put the link on the clipboard.
    function render({ kind, title, link, copied = false }) {
        if (!KINDS.includes(kind)) throw new TypeError(`ShareDialog: unknown kind ${kind}`);
        const t = translator(root);
        const wrap = node('div', 'share-panel');
        wrap.dataset.shareKind = kind;
        const field = node('div', 'share-panel__field');
        const input = node('input', 'design-link__input share-panel__link');
        input.type = 'text';
        input.readOnly = true;
        input.value = link;
        input.setAttribute('aria-label', t(...LINK_LABELS[kind]));
        input.addEventListener('focus', () => input.select());
        const copyButton = node('button', 'btn share-panel__copy');
        copyButton.type = 'button';
        copyButton.dataset.shareAction = 'copy';
        const copyIcon = node('i', 'fas fa-copy');
        copyIcon.setAttribute('aria-hidden', 'true');
        copyButton.append(copyIcon, node('span', '', t('copy', 'Copy link')));
        field.append(input, copyButton);
        const status = node('p', 'share-panel__status');
        status.setAttribute('role', 'status');
        status.textContent = copied ? t('copied', 'Link copied.') : t('copyByHand', 'Copy the link above.');
        copyButton.addEventListener('click', async () => {
            const ok = await copy(link);
            status.textContent = ok ? t('copied', 'Link copied.') : t('copyByHand', 'Copy the link above.');
            if (!ok) { input.focus(); input.select(); }
        });

        const actions = node('div', 'cb-actions share-panel__actions');
        const post = external('btn btn-primary share-panel__post', t('postOnX', 'Post on X'), postOnXUrl({ text: postText(kind, title, t), url: link }));
        post.dataset.shareAction = 'post-x';
        post.addEventListener('click', () => {
            log(`posting ${kind} ${link} on X`);
            root.AppDiagnostics?.event('share', 'post-x', { entity: kind, context: { surface: 'share-dialog' } });
        });
        actions.append(post);
        if (typeof root.navigator.share === 'function') {
            const native = node('button', 'btn share-panel__native');
            native.type = 'button';
            native.dataset.shareAction = 'native';
            const icon = node('i', 'fas fa-share-alt');
            icon.setAttribute('aria-hidden', 'true');
            native.append(icon, node('span', '', t('native', 'Share…')));
            native.addEventListener('click', async () => {
                try {
                    await root.navigator.share({ title: postText(kind, title, t), url: link });
                } catch (error) {
                    if (error?.name !== 'AbortError') {
                        console.warn(`[${new Date().toISOString()}] [share] the device's share sheet failed`, error);
                        status.textContent = t('nativeFailed', 'The share sheet could not open. Copy the link instead.');
                    }
                }
            });
            actions.append(native);
        }
        const posts = external('cb-link share-panel__posts', t('postsAbout', 'Posts about this on X'), postsAboutUrl(link));
        posts.dataset.shareAction = 'posts-x';
        wrap.append(field, status, actions, posts);
        return wrap;
    }

    const PUBLISHED = Object.freeze({
        design: ['published.design', 'Design published.'],
        plan: ['published.plan', 'Plan published.'],
        agreement: ['published.agreement', 'Agreement proposed.'],
        bet: ['published.bet', '']
    });

    // The Share box: copies the link first (unless the caller already did), then opens.
    // `published`: this Share just published the record, which the box says above the link.
    async function open({ kind, title = '', link, copied = null, published = false }) {
        const t = translator(root);
        const done = copied == null ? await copy(link) : copied;
        const body = node('div', 'share-dialog');
        const intro = published ? t(...PUBLISHED[kind]) : '';
        if (intro) body.append(node('p', 'share-dialog__intro', intro));
        const panel = render({ kind, title, link, copied: done });
        body.append(panel);
        const input = panel.querySelector('.share-panel__link');
        log(`${kind} ${link} (${done ? 'copied' : 'not copied'})`);
        return root.CbDialog.open({
            title: t(...TITLES[kind]),
            size: 'sm',
            // `share-modal` / `share-modal-overlay`: the share boxes' hooks (css/modals.css, the e2e specs).
            className: 'share-modal share-dialog-box',
            overlayClassName: 'share-modal-overlay',
            body,
            // A link the clipboard refused is focused, selected, for copying by hand.
            initialFocus: done ? panel.querySelector('.share-panel__post') : input,
            actions: [{ label: root.i18n?.t?.('modal.common.close') || 'Close', role: 'secondary' }]
        });
    }

    return Object.freeze({ ...pure, render, open });
});
