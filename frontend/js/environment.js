// Environment detection and environment-driven UI defaults
(function () {
    try {
        const protocol = window.location.protocol;
        const hostname = (window.location.hostname || '').toLowerCase();

        const isFileProtocol = protocol === 'file:';
        const isLocalHostname = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local');

        const isDevelopment = isFileProtocol || isLocalHostname;
        window.current_environment = isDevelopment ? 'development' : 'production';

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

        function updateBadgeVisibility() {
            try {
                const badge = document.getElementById('dev-badge');
                const debugBadge = document.getElementById('debug-badge');
                const versionBadge = document.getElementById('version-badge');
                const container = badge ? badge.closest('.settings-badge-bar') : (debugBadge ? debugBadge.closest('.settings-badge-bar') : null);
                const isDebug = document.body.classList.contains('debug-mode');

                // The badges (cb-badge) and their bar show and hide with the hidden attribute.
                // If not in debug mode, hide entire bar and exit early
                if (!isDebug) {
                    if (badge) badge.hidden = true;
                    if (debugBadge) debugBadge.hidden = true;
                    if (versionBadge) versionBadge.hidden = true;
                    if (container) container.hidden = true;
                    return;
                }

                const versionLabel = getBuildVersionLabel();
                if (badge) {
                    // Show dev badge only in real development environment
                    badge.hidden = !isDevelopment;
                }
                if (debugBadge) {
                    debugBadge.hidden = false;
                }
                if (versionBadge) {
                    if (versionLabel) {
                        versionBadge.textContent = versionLabel;
                        versionBadge.title = versionLabel;
                        versionBadge.hidden = false;
                    } else {
                        versionBadge.hidden = true;
                    }
                }
                if (container) {
                    const anyVisible = (badge && !badge.hidden)
                        || (debugBadge && !debugBadge.hidden)
                        || (versionBadge && !versionBadge.hidden);
                    container.hidden = !anyVisible;
                }
            } catch (_) { }
        }

        document.addEventListener('DOMContentLoaded', updateBadgeVisibility);

        // Expose for other modules
        window.updateBadgeVisibility = updateBadgeVisibility;
    } catch (_) {
        // In case of any unexpected error, default to production
        window.current_environment = 'production';
    }
})();


