(function attachParcelSourceProgress(root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelSourceProgress = api;
})(typeof window !== 'undefined' ? window : globalThis, function createParcelSourceProgress() {
    'use strict';

    function format(detail, { language = 'en', translate } = {}) {
        if (!detail || typeof detail !== 'object') return null;
        const authority = String(detail.authority || '');
        const message = (key, fallback, params = {}) => {
            const fullKey = `status.messages.${key}`;
            const translated = translate?.(fullKey, params);
            return translated && translated !== fullKey ? translated : fallback;
        };
        const count = (value, digits = 0) => new Intl.NumberFormat(language, {
            minimumFractionDigits: digits, maximumFractionDigits: digits
        }).format(value);
        switch (detail.phase) {
        case 'source-download': {
            const { loadedBytes, totalBytes } = detail;
            if (!authority || !Number.isFinite(loadedBytes) || loadedBytes < 0
                || !Number.isFinite(totalBytes) || totalBytes <= 0 || loadedBytes > totalBytes) return null;
            const loaded = count(loadedBytes / 1e6, 1), total = count(totalBytes / 1e6, 1);
            return message('parcel_source_downloading', `Downloading ${authority}… ${loaded} / ${total} MB`, { authority, loaded, total });
        }
        case 'source-decompress':
            return authority ? message('parcel_source_decompressing', `Decompressing ${authority}…`, { authority }) : null;
        case 'source-process': {
            const { processedFeatures, totalFeatures } = detail;
            if (!authority || !Number.isSafeInteger(processedFeatures) || processedFeatures < 0
                || !Number.isSafeInteger(totalFeatures) || totalFeatures < 1 || processedFeatures > totalFeatures) return null;
            const done = count(processedFeatures), total = count(totalFeatures);
            return message('parcel_source_processing', `Unpacking and processing ${authority}… ${done} / ${total} parcels`, { authority, done, total });
        }
        case 'source-cache':
            return authority ? message('parcel_source_cached', `Loading cached parcels for ${authority}…`, { authority }) : null;
        case 'source-prepare':
            return message('parcel_source_preparing', 'Preparing parcels for the map…');
        default:
            return null;
        }
    }
    return Object.freeze({ format });
});
