// Environment detection and environment-driven UI defaults
(function () {
    try {
        const protocol = window.location.protocol;
        const hostname = (window.location.hostname || '').toLowerCase();

        const isFileProtocol = protocol === 'file:';
        const isLocalHostname = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local');

        const isDevelopment = isFileProtocol || isLocalHostname;
        window.current_environment = isDevelopment ? 'development' : 'production';

        // Storage backend for NFT metadata/images. Defaults to 'ipfs' (IPFS/Pinata).
        // Other options: 'walrus' (Sui decentralized storage) | 'local', or '' to fall back
        // to the legacy chain-id heuristic. Override before this script runs to change it per deployment.
        if (typeof window.STORAGE_PROVIDER === 'undefined') {
            window.STORAGE_PROVIDER = 'ipfs';
        }
        // Walrus aggregator used to resolve walrus://<blobId> for display. Defaults to public testnet.
        if (typeof window.WALRUS_AGGREGATOR_URL === 'undefined') {
            window.WALRUS_AGGREGATOR_URL = 'https://aggregator.walrus-testnet.walrus.space';
        }

        // The version badge shows the ACTUAL running build, stamped into build-info.js at deploy
        // (buildId "deploy-N" / buildNumber N). Locally there is no stamp, so it reads "dev".
        // This is deliberately NOT the hand-maintained changelog head (APP_VERSIONS) — that value
        // is a release note and goes stale; the badge is meant to identify the code you're running.
        const getBuildVersionLabel = () => {
            try {
                const info = window.__BUILD_INFO || {};
                const isRealBuild = info.buildId && info.buildId !== 'dev';
                if (isRealBuild) {
                    return info.buildNumber ? `build ${info.buildNumber}` : String(info.buildId);
                }
                return 'dev';
            } catch (_) {
                return 'dev';
            }
        };

        // Mark body with environment class as early as possible
        const applyEnvClass = () => {
            try {
                if (!document || !document.body) return;
                document.body.classList.add(isDevelopment ? 'env-development' : 'env-production');
            } catch (_) { }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyEnvClass, { once: true });
        } else {
            applyEnvClass();
        }

        function resolveDefaultDataSource() {
            if (isDevelopment) {
                return 'localhost';
            }

            try {
                const cityManager = window.CityConfigManager;
                if (cityManager && typeof cityManager.getCurrentCityConfig === 'function') {
                    const cityConfig = cityManager.getCurrentCityConfig();
                    if (cityConfig && cityConfig.parcels && cityConfig.parcels.requiresBackend) {
                        return 'api.urbangametheory.xyz';
                    }
                    if (typeof cityManager.getCurrentCityId === 'function') {
                        const cityId = cityManager.getCurrentCityId();
                        if (cityId === 'buenos_aires') {
                            return 'api.urbangametheory.xyz';
                        }
                    }
                }
            } catch (_) { }

            return 'api.urbangametheory.xyz';
        }

        function updateBadgeVisibility() {
            try {
                const badge = document.getElementById('dev-badge');
                const debugBadge = document.getElementById('debug-badge');
                const versionBadge = document.getElementById('version-badge');
                const container = badge ? badge.closest('.sidebar-badge-bar') : (debugBadge ? debugBadge.closest('.sidebar-badge-bar') : null);
                const isDebug = document.body.classList.contains('debug-mode');

                // If not in debug mode, hide entire bar and exit early
                if (!isDebug) {
                    if (badge) badge.style.display = 'none';
                    if (debugBadge) debugBadge.style.display = 'none';
                    if (versionBadge) versionBadge.style.display = 'none';
                    if (container) container.style.display = 'none';
                    return;
                }

                const versionLabel = getBuildVersionLabel();
                if (badge) {
                    // Show dev badge only in real development environment
                    badge.style.display = isDevelopment ? 'inline-flex' : 'none';
                }
                if (debugBadge) {
                    debugBadge.style.display = 'inline-flex';
                }
                if (versionBadge) {
                    if (versionLabel) {
                        versionBadge.textContent = versionLabel;
                        versionBadge.title = versionLabel;
                        versionBadge.style.display = 'inline-flex';
                    } else {
                        versionBadge.style.display = 'none';
                    }
                }
                if (container) {
                    const anyVisible = (badge && badge.style.display !== 'none')
                        || (debugBadge && debugBadge.style.display !== 'none')
                        || (versionBadge && versionBadge.style.display !== 'none');
                    container.style.display = anyVisible ? 'flex' : 'none';
                }
            } catch (_) { }
        }

        // UI tweaks after DOM is ready
        document.addEventListener('DOMContentLoaded', function () {
            try {
                updateBadgeVisibility();

                // Set default Data Source depending on environment & city
                const dataSelect = document.getElementById('data-source-select');
                if (dataSelect) {
                    const defaultValue = resolveDefaultDataSource();
                    if (Array.from(dataSelect.options).some(o => o.value === defaultValue)) {
                        dataSelect.value = defaultValue;
                    }
                }
            } catch (_) { }
        });

        // Expose for other modules
        window.updateBadgeVisibility = updateBadgeVisibility;
    } catch (_) {
        // In case of any unexpected error, default to production
        window.current_environment = 'production';
    }
})();


