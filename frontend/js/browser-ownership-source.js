// The public ownership fallback keeps its native retry/parse policy behind a browser reader.
(function (root, factory) {
    const api = factory(root?.SourceRuntime || (typeof require === 'function' ? require('./source-runtime.js') : null));
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OssOwnershipSource = api;
})(typeof window !== 'undefined' ? window : null, function (Runtime) {
    'use strict';
    const sourceId = 'hr-oss-public-fallback';
    const registry = Runtime.createRegistry({ abstraction: 'ownership', runtime: 'browser', required: ['lookup'],
        adapters: { 'hr-oss-public-fallback': { custom: false,
            create: (config, { buildRequestUrls, fetchWithRetry, extractOwners, warn = console.warn }) => ({
                async lookup(parcelId) {
                    const candidates = buildRequestUrls(parcelId, config.endpoint);
                    if (!candidates.length) return [];
                    let payload = null;
                    let lastError = null;
                    for (const url of candidates) {
                        try {
                            const response = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 1, 500);
                            if (!response.ok) {
                                lastError = new Error(`OSS ownership lookup failed (${response.status})`);
                                continue;
                            }
                            payload = await response.json();
                            lastError = null;
                            break;
                        } catch (error) {
                            lastError = error;
                            warn('OSS ownership fetch candidate failed', url, error);
                        }
                    }
                    if (!payload) throw lastError || new Error('OSS ownership lookup failed');
                    return extractOwners(payload);
                }
            })
        } }, sources: [Runtime.source('ownership', 'hr-oss-public-fallback', {
            endpoint: 'https://oss.uredjenazemlja.hr/oss/public/cad/parcel-info'
        }, { id: sourceId })] });
    return Object.freeze({ sourceId, registry });
});
