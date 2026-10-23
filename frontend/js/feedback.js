(function attachFeedback(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.FeedbackForm = api;
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.init(root), { once: true });
        else api.init(root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function pageLink(value) {
        try {
            const url = new URL(value);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
            url.hash = '';
            // Carry useful map context, without private fragments or arbitrary query parameters.
            for (const key of [...url.searchParams.keys()]) if (!['city', 'at'].includes(key)) url.searchParams.delete(key);
            return url.href.length <= 2048 ? url.href : '';
        } catch { return ''; }
    }
    function init(global) {
        const doc = global.document, form = doc.getElementById('feedback-form');
        if (!form || form.dataset.ready) return;
        form.dataset.ready = 'true';
        const result = doc.getElementById('feedback-result'), submit = doc.getElementById('feedback-submit');
        const locale = doc.getElementById('feedback-language');
        const tr = (key, params) => global.i18n.t(`feedback.${key}`, params);
        locale.value = global.i18n.getLocale();
        locale.addEventListener('change', () => global.i18n.setLanguage(locale.value));
        global.i18n.applyTranslations(doc);
        form.elements.pageUrl.value = pageLink(new URLSearchParams(global.location.search).get('page') || doc.referrer);
        let pending = null;
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const fields = { kind: form.elements.kind.value, message: form.elements.message.value.trim(), pageUrl: form.elements.pageUrl.value.trim(), source: 'web' };
            if (!fields.message || !form.reportValidity()) return;
            const fingerprint = JSON.stringify(fields);
            if (pending?.fingerprint !== fingerprint) pending = { fingerprint, reportId: global.crypto.randomUUID() };
            submit.disabled = true; submit.removeAttribute('data-i18n-key'); submit.textContent = tr('sending'); result.textContent = '';
            try {
                const response = await global.fetch(`${global.getBackendBase().replace(/\/+$/, '')}/feedback`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
                    body: JSON.stringify({ ...fields, reportId: pending.reportId })
                });
                if (!response.ok) throw Object.assign(new Error('Report not confirmed'), { status: response.status });
                const value = await response.json();
                if (value.report?.status !== 'received' || value.report.id !== pending.reportId) throw new Error('Missing report receipt');
                result.textContent = tr('received', { id: value.report.id });
                form.elements.message.value = ''; pending = null;
            } catch (error) { result.textContent = tr(error.status === 429 ? 'rateLimited' : 'unavailable'); }
            finally { submit.disabled = false; submit.setAttribute('data-i18n-key', 'feedback.send'); submit.textContent = tr('send'); }
        });
    }
    return { pageLink, init };
});
