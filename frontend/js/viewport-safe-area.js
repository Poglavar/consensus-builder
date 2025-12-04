(function initViewportSizing() {
    var root = document.documentElement;
    var viewport = window.visualViewport;
    var rafId = null;

    function updateVars() {
        rafId = null;
        var effectiveHeight = window.innerHeight;
        var safeBottom = 0;

        if (viewport) {
            effectiveHeight = viewport.height;
            safeBottom = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        }

        if (effectiveHeight > 0) {
            root.style.setProperty('--app-viewport-height', effectiveHeight + 'px');
        }
        root.style.setProperty('--app-safe-area-bottom', safeBottom + 'px');
    }

    function scheduleUpdate() {
        if (rafId !== null) {
            return;
        }
        rafId = window.requestAnimationFrame(updateVars);
    }

    if (viewport) {
        viewport.addEventListener('resize', scheduleUpdate);
        viewport.addEventListener('scroll', scheduleUpdate);
    } else {
        window.addEventListener('resize', scheduleUpdate);
    }

    window.addEventListener('orientationchange', scheduleUpdate);
    window.addEventListener('focus', scheduleUpdate);

    scheduleUpdate();
})();
