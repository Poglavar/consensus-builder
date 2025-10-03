// Environment detection and environment-driven UI defaults
(function () {
    try {
        const protocol = window.location.protocol;
        const hostname = (window.location.hostname || '').toLowerCase();

        const isFileProtocol = protocol === 'file:';
        const isLocalHostname = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local');

        const isDevelopment = isFileProtocol || isLocalHostname;
        window.current_environment = isDevelopment ? 'development' : 'production';

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

        // UI tweaks after DOM is ready
        document.addEventListener('DOMContentLoaded', function () {
            try {
                // Show/hide small Development badge in header
                const badge = document.getElementById('dev-badge');
                if (badge) {
                    if (isDevelopment) {
                        badge.style.display = 'inline-block';
                    } else {
                        badge.style.display = 'none';
                    }
                }

                // Set default Data Source depending on environment
                const dataSelect = document.getElementById('data-source-select');
                if (dataSelect) {
                    const defaultValue = isDevelopment ? 'localhost' : 'oss.uredjenazemlja.hr';
                    if (Array.from(dataSelect.options).some(o => o.value === defaultValue)) {
                        dataSelect.value = defaultValue;
                    }
                }
            } catch (_) { }
        });
    } catch (_) {
        // In case of any unexpected error, default to production
        window.current_environment = 'production';
    }
})();


