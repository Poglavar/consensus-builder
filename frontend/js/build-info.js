(function () {
    var globalScope = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    var PLACEHOLDER_PREFIX = '__BUILD_';

    function isPlaceholder(value) {
        return typeof value === 'string' && value.indexOf(PLACEHOLDER_PREFIX) === 0;
    }

    function resolveValue(value, fallback) {
        if (value === undefined || value === null || isPlaceholder(value)) {
            return fallback;
        }
        return value;
    }

    var rawInfo = {
        buildId: '__BUILD_ID__',
        buildNumber: '__BUILD_NUMBER__',
        generatedAt: '__BUILD_GENERATED_AT__',
        cacheToken: '__BUILD_CACHE_TOKEN__'
    };

    var info = {
        buildId: String(resolveValue(rawInfo.buildId, 'dev')),
        buildNumber: Number(resolveValue(rawInfo.buildNumber, 0)) || 0,
        generatedAt: String(resolveValue(rawInfo.generatedAt, 'local-dev')),
        cacheToken: resolveValue(rawInfo.cacheToken, null)
    };

    if (!info.cacheToken) {
        info.cacheToken = info.buildId && info.buildId !== 'dev'
            ? info.buildId
            : String(Date.now());
    }

    globalScope.__BUILD_INFO = Object.assign({}, info, globalScope.__BUILD_INFO || {});

    if (typeof globalScope.getCacheBustToken !== 'function') {
        globalScope.getCacheBustToken = function getCacheBustToken() {
            var buildInfo = globalScope.__BUILD_INFO || {};
            if (buildInfo.cacheToken) {
                return buildInfo.cacheToken;
            }
            if (buildInfo.buildId) {
                return buildInfo.buildId;
            }
            if (typeof buildInfo.buildNumber !== 'undefined') {
                return buildInfo.buildNumber;
            }
            if (Array.isArray(globalScope.APP_VERSIONS) && globalScope.APP_VERSIONS.length > 0) {
                var head = globalScope.APP_VERSIONS[0];
                if (head && head.version_number) {
                    return head.version_number;
                }
            }
            return Date.now();
        };
    }
})();
