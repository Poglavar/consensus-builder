// Stored-XSS guard for shared land-readjustment plans: owner names, keys and colours restored from
// a saved plan are rendered into the legend tables, so crafted values must come out inert.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
    safePlanColor,
    ownerLegendCellHtml,
    cashOfferInputHtml,
    newPlotOwnerHtml
} = require('../../frontend/js/reparcellization-ui-state.js');
const source = readFileSync(new URL('../../frontend/js/reparcellization.js', import.meta.url), 'utf8');

const PAYLOAD = '<img src=x onerror=alert(1)>';
const ATTR_BREAKOUT = '"><img src=x onerror=alert(1)>';
const CSS_BREAKOUT = 'red"></span><img src=x onerror=alert(1)><span style="';

// No live tag and no attribute break-out may survive: every `<` and `"` from the payload is escaped.
function expectInert(html) {
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/"\s*>\s*<img/i);
    expect(html).not.toMatch(/onerror=alert\(1\)"/);
}

describe('safePlanColor', () => {
    it('keeps hex colours and rejects anything else', () => {
        expect(safePlanColor('#1B998B')).toBe('#1B998B');
        expect(safePlanColor('#fff')).toBe('#fff');
        expect(safePlanColor('#ffffff80')).toBe('#ffffff80');
        expect(safePlanColor(CSS_BREAKOUT)).toBe('#cccccc');
        expect(safePlanColor('red;background:url(x)', '#123')).toBe('#123');
        expect(safePlanColor(null, '#abc')).toBe('#abc');
        expect(safePlanColor({ toString: () => '#fff' })).toBe('#cccccc');
    });
});

describe('legend HTML from a crafted plan', () => {
    it('Owners cell escapes the name and drops a hostile colour', () => {
        const html = ownerLegendCellHtml({ displayName: PAYLOAD }, CSS_BREAKOUT);
        expectInert(html);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('style="background:#cccccc"');
    });

    it('cash-offer input keeps a hostile ownerKey inside its attribute', () => {
        const html = cashOfferInputHtml(ATTR_BREAKOUT, 12.4);
        expectInert(html);
        expect(html).toContain('data-owner-key="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
        expect(html).toContain('value="12"');
        expect(cashOfferInputHtml('k', 'NaN"><img')).toContain('value="0"');
    });

    it('New plots owner chip escapes name and colour', () => {
        const html = newPlotOwnerHtml(
            { ownerKey: ATTR_BREAKOUT, displayName: PAYLOAD, color: CSS_BREAKOUT },
            { publicKey: '__public__', unassignedLabel: 'Unassigned' }
        );
        expectInert(html);
        expect(html).toContain('&lt;img');
        expect(html).toContain('background:#cccccc');
    });

    it('New plots owner chip still borders white/public swatches', () => {
        expect(newPlotOwnerHtml({ ownerKey: '__public__', displayName: 'Public', color: '#ffffff' }, { publicKey: '__public__' }))
            .toContain(';border:1px solid #9ca3af');
        expect(newPlotOwnerHtml({}, { unassignedLabel: 'Nedodijeljeno' })).toContain('Nedodijeljeno');
    });
});

describe('reparcellization.js wiring', () => {
    it('never interpolates plan-derived owner fields raw into markup', () => {
        const rawInMarkup = source.split('\n')
            .filter(line => line.includes('<') && /\$\{\s*(entry|o|owner|slice)\.(displayName|ownerKey|color)/.test(line));
        expect(rawInMarkup).toEqual([]);
        expect(source).toContain('ownerLegendCellHtml(entry, color)');
        expect(source).toContain('cashOfferInputHtml(entry.ownerKey, cashOffer)');
        expect(source).toContain('newPlotOwnerHtml(o,');
    });

    it('escapes Leaflet string tooltips (Leaflet renders them as HTML)', () => {
        const tooltips = source.split('\n').filter(line => line.includes('.bindTooltip('));
        expect(tooltips.length).toBeGreaterThan(0);
        tooltips
            .filter(call => !call.includes('eraseTooltipFor'))
            .forEach(call => expect(call).toMatch(/\.bindTooltip\(escapeHtml\(/));
    });

    it('sanitises colours when hydrating a saved plan', () => {
        const hydrate = source.slice(source.indexOf('function hydrateSlicesFromPolygons'), source.indexOf('function carvePlotIntoPlan'));
        expect(hydrate).toContain("safePlanColor(polygon.color, '#cccccc')");
        expect(hydrate).toContain('safePlanColor(owner.color, color)');
    });
});
