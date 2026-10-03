// Manual parcel-source information; metadata reads never participate in loading or eligibility.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.ParcelSourceNotice = api;
        root.openParcelSourceNotice = () => api.open(root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function safeLink(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
        } catch (_) { return null; }
    }
    function buildNotice(city = {}, sources = [], unavailable = false, translate = (_key, fallback) => fallback) {
        const t = (key, fallback) => translate('parcelSourceNotice.' + key, fallback);
        const parcels = city.parcels || {};
        const source = sources.find(item => item.id === parcels.sourceId)
            || sources.find(item => item.defaultForCity !== false && Array.isArray(item.cityIds) && item.cityIds.includes(city.id));
        const lines = [t('title', 'Parcel source information'),
            t('responsibility', 'You choose which parcel source to use and are responsible for checking its terms and your intended use.')];
        if (source) {
            lines.push(t('publisher', 'External publishers serve these source boundaries live. Their data may have coverage, accuracy and reuse limitations.'));
            lines.push(t('source', 'Source') + ': ' + String(source.name || source.id));
            if (source.scope) lines.push(t('scope', 'Coverage') + ': ' + source.scope);
            if (source.licenceNote) lines.push(t('terms', 'Source terms') + ': ' + source.licenceNote);
        } else {
            lines.push(t('unavailable', 'Detailed source metadata is unavailable. Check the source attribution on the map.'));
            lines.push(t('source', 'Source') + ': ' + String(parcels.sourceId || parcels.source || city.label || city.id || t('unknown', 'Unknown')));
        }
        if (unavailable && source) lines.push(t('unavailable', 'Detailed source metadata is unavailable. Check the source attribution on the map.'));
        const linkUrl = source && [source.licenceUrl, source.catalogueUrl, source.endpoint].map(safeLink).find(Boolean);
        if (linkUrl) lines.push('{{txLink}}');
        return { message: lines.join('\n\n'), options: linkUrl ? { linkUrl, linkText: t('link', 'Read source information and terms') } : {} };
    }
    async function open(global) {
        const city = global.CityConfigManager?.getCurrentCityConfig?.() || {};
        const translate = (key, fallback) => {
            const result = global.i18n?.t?.(key);
            return result && result !== key ? result : fallback;
        };
        let sources = [], unavailable = false;
        try {
            if (typeof global.getBackendBase !== 'function') throw new Error('Source metadata API unavailable');
            const base = String(global.getBackendBase()).replace(/\/+$/, '');
            const custom = city.parcels?.sourceId?.startsWith('custom.');
            const response = await global.fetch(base + (custom ? '/parcel-sources/' + encodeURIComponent(city.parcels.sourceId) + '/info' : '/parcel-sources'), { signal: AbortSignal.timeout(10000), cache: 'no-store' });
            if (!response.ok) throw new Error('Source metadata request failed');
            const catalog = await response.json();
            if (custom && catalog.source) sources = [catalog.source];
            else if (Array.isArray(catalog.sources)) sources = catalog.sources;
            else throw new Error('Invalid source metadata');
        } catch (_) { unavailable = true; }
        const notice = buildNotice(city, sources, unavailable, translate);
        return global.showStyledAlert(notice.message, notice.options);
    }
    return Object.freeze({ safeLink, buildNotice, open });
});
