(function (global) {
    'use strict';

    var LISTENERS_ATTACHED_KEY = 'parcelActivityBound';
    var CLASS_NAME = 'fetching-parcels';

    function getBool(fn) {
        try { return !!fn(); } catch (_) { return false; }
    }

    function isFetching(opts) {
        if (opts && typeof opts.getIsFetching === 'function') {
            return getBool(opts.getIsFetching);
        }
        if (global.ParcelsState && typeof global.ParcelsState.isFetchingParcels === 'function') {
            return getBool(global.ParcelsState.isFetchingParcels);
        }
        return false;
    }

    function isMerging(opts) {
        if (opts && typeof opts.getIsMerging === 'function') {
            return getBool(opts.getIsMerging);
        }
        if (typeof global.isParcelMergeInProgress === 'function') {
            return getBool(global.isParcelMergeInProgress);
        }
        return false;
    }

    function isInternalFetching(opts) {
        if (opts && typeof opts.getInternalFlag === 'function') {
            return getBool(opts.getInternalFlag);
        }
        return !!global._fetchParcelDataInProgress;
    }

    function computeActive(opts) {
        return isFetching(opts) || isMerging(opts) || isInternalFetching(opts);
    }

    function updateCursorState(mapElement, opts) {
        var active = computeActive(opts);
        if (active) {
            mapElement.classList.add(CLASS_NAME);
        } else {
            mapElement.classList.remove(CLASS_NAME);
        }
    }

    function attach(mapElement, opts) {
        if (!mapElement || !global || typeof global.addEventListener !== 'function') {
            return;
        }
        if (mapElement.dataset && mapElement.dataset[LISTENERS_ATTACHED_KEY] === '1') {
            return;
        }
        if (mapElement.dataset) {
            mapElement.dataset[LISTENERS_ATTACHED_KEY] = '1';
        }

        var update = function () { updateCursorState(mapElement, opts); };
        var events = ['parcelFetchStarted', 'parcelFetchFinished', 'parcelMergeStarted', 'parcelMergeFinished'];
        events.forEach(function (evt) {
            global.addEventListener(evt, update, { passive: true });
        });

        var intervalMs = (opts && Number.isFinite(opts.intervalMs)) ? opts.intervalMs : 120;
        var intervalId = global.setInterval(update, intervalMs);

        try {
            global.addEventListener('beforeunload', function () {
                try { clearInterval(intervalId); } catch (_) { }
            });
        } catch (_) { /* ignore */ }

        update();
    }

    global.ParcelActivityListener = {
        init: attach
    };
})(typeof window !== 'undefined' ? window : globalThis);
