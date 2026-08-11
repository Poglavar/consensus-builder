// Pinpoint reads the coordinates under the cursor and asks what is on the ground there.
//
// It exists because answering "why is there nothing to click here" needs a lat/lng, and the only way
// to get one was to pan the spot to the centre of the map. The trap it has to avoid is its own
// readout: a mousemove handler that went through updateStatus would append to the status log, which
// keeps 2000 entries — a few seconds of moving the mouse and the whole log is coordinates.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tool = read('../../frontend/js/pinpoint-tool.js');
const html = read('../../frontend/index.html');
const css = read('../../frontend/css/utilities.css');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];

describe('the live readout does not go through the status log', () => {
    it('writes the moving coordinate to its own chip', () => {
        const move = tool.slice(tool.indexOf('function onMove(event)'), tool.indexOf('async function onClick'));
        expect(move).toContain('ensureReadout().textContent');
        expect(move).not.toContain('updateStatus');
        expect(css).toContain('.pinpoint-readout {');
    });

    it('spends a status line on a CLICK, which is worth remembering', () => {
        const click = tool.slice(tool.indexOf('async function onClick'), tool.indexOf('function onKeydown'));
        expect(click).toContain('updateStatus');
    });
});

describe('a click answers the question the tool exists for', () => {
    it('hands the point to whatIsHere', () => {
        const click = tool.slice(tool.indexOf('async function onClick'), tool.indexOf('function onKeydown'));
        expect(click).toContain('global.whatIsHere(event.latlng.lat, event.latlng.lng)');
    });

    it('copies the coordinate too, so it can be pasted somewhere', () => {
        const click = tool.slice(tool.indexOf('async function onClick'), tool.indexOf('function onKeydown'));
        expect(click).toContain('copyTextWithFeedback');
    });

    it('reads to a precision worth quoting', () => {
        // 6 decimals ≈ 11 cm.
        expect(tool).toContain('toFixed(6)');
    });
});

describe('turning it off puts everything back', () => {
    it('unbinds both map handlers and the key handler', () => {
        const off = tool.slice(tool.indexOf('} else {', tool.indexOf('function togglePinpointTool')));
        expect(off).toContain("global.map.off('mousemove', onMove)");
        expect(off).toContain("global.map.off('click', onClick)");
        expect(off).toContain("document.removeEventListener('keydown', onKeydown)");
        expect(off).toContain("container.style.cursor = ''");
    });

    it('leaves on Escape', () => {
        expect(tool).toContain("if (event.key === 'Escape' && active) togglePinpointTool();");
    });
});

describe('it is reachable', () => {
    it('sits in the Measurement section and is loaded', () => {
        expect(html).toContain('id="pinpointButton"');
        expect(html).toContain('onclick="togglePinpointTool()"');
        expect(html).toContain("'js/pinpoint-tool.js',");
        // In the Measurement accordion, next to Measure.
        const section = html.slice(html.indexOf('data-section="measurement"'), html.indexOf('data-section="info"'));
        expect(section).toContain('id="pinpointButton"');
    });

    it.each(locales)('%s can name it', locale => {
        const measurement = dictOf(locale).sidebar.measurement;
        ['pinpointButton', 'pinpointHint', 'pinpointCopied']
            .forEach(key => expect(measurement[key], `${locale} missing ${key}`).toBeTruthy());
    });
});
