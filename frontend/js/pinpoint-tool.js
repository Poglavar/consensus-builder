// Pinpoint: read the coordinates under the cursor, and ask what is on the ground there.
//
// Written for one recurring problem — an area of the map with nothing to click. Answering that needs
// a lat/lng, and until now the only way to get one was to pan the spot to the centre of the map and
// call whatIsHere() with no arguments. This makes the coordinates readable directly, and a click
// hands them to whatIsHere(), which says which of the four cases it is: parcels present, parcels
// hidden with pieces missing, a structure that razed the fabric, or ground the cadastre never
// surveyed as a parcel (see unsurveyed-ground.md).
//
// The live readout deliberately does NOT go through updateStatus: that appends to the status log,
// and a mousemove handler would fill two thousand lines of it in seconds. It gets its own chip; only
// a CLICK is worth a status line.
(function attachPinpointTool(global) {
    'use strict';

    let active = false;
    let readout = null;

    function t(key, fallback) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, {});
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        return fallback;
    }

    function ensureReadout() {
        if (readout) return readout;
        readout = document.createElement('div');
        readout.className = 'pinpoint-readout';
        readout.setAttribute('aria-live', 'polite');
        document.body.appendChild(readout);
        return readout;
    }

    // Six decimals is about 11 cm — the precision at which a coordinate is worth reading aloud, and
    // well past anything the cadastre resolves.
    const format = latlng => `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;

    function onMove(event) {
        if (!event || !event.latlng) return;
        ensureReadout().textContent = format(event.latlng);
    }

    async function onClick(event) {
        if (!event || !event.latlng) return;
        const text = format(event.latlng);
        const line = t('sidebar.measurement.pinpointCopied', 'Pinpoint') + `: ${text}`;
        if (typeof global.updateStatus === 'function') global.updateStatus(line);
        try {
            if (typeof global.copyTextWithFeedback === 'function') await global.copyTextWithFeedback(text);
        } catch (_) { }
        // The point of the tool: not the number, but what is under it.
        try {
            if (typeof global.whatIsHere === 'function') await global.whatIsHere(event.latlng.lat, event.latlng.lng);
        } catch (error) {
            console.warn('[pinpoint] whatIsHere failed', error);
        }
    }

    function onKeydown(event) {
        if (event.key === 'Escape' && active) togglePinpointTool();
    }

    function togglePinpointTool() {
        if (typeof global.map === 'undefined' || !global.map) return false;
        active = !active;
        const button = document.getElementById('pinpointButton');
        const container = global.map.getContainer();

        if (active) {
            if (button) button.classList.add('active-black-border');
            container.classList.add('crosshairs-cursor');
            container.style.cursor = 'crosshair';
            global.map.on('mousemove', onMove);
            global.map.on('click', onClick);
            document.addEventListener('keydown', onKeydown);
            ensureReadout().textContent = t('sidebar.measurement.pinpointHint', 'Move over the map to read coordinates');
            readout.style.display = 'block';
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(t('sidebar.measurement.pinpointHint', 'Move over the map to read coordinates'));
            }
        } else {
            if (button) button.classList.remove('active-black-border');
            container.classList.remove('crosshairs-cursor');
            container.style.cursor = '';
            global.map.off('mousemove', onMove);
            global.map.off('click', onClick);
            document.removeEventListener('keydown', onKeydown);
            if (readout) readout.style.display = 'none';
        }
        return active;
    }

    global.togglePinpointTool = togglePinpointTool;
    global.pinpointToolIsActive = () => active;
})(typeof window !== 'undefined' ? window : globalThis);
