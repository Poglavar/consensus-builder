// Stored-XSS guard for shared land-readjustment plans: owner names, keys and colours restored from
// a saved plan are rendered into the legend tables, so crafted values must come out inert. The
// editor itself is opened on a crafted plan (helpers/reparcellization-env.js), whose DOM parses
// every innerHTML it is given, so a live tag would show up as an element.
import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeEditor, box } from './helpers/reparcellization-env.js';

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
        expect(html).toContain('value="12.4"');
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
    let env = null;
    afterEach(() => { env?.dispose(); env = null; });

    // A shared plan whose every owner field is hostile, reopened the way the design draft reopens it.
    async function openCraftedPlan() {
        const plan = {
            algorithm: 'manual',
            parcelIds: ['P1'],
            poolGeometry: box(0, 0, 40, 50),
            polygons: [
                { ownerKey: ATTR_BREAKOUT, displayName: PAYLOAD, color: CSS_BREAKOUT, geometry: box(0, 0, 20, 50) },
                // Public land keeps the name the plan gives it (owner ids are relabelled Owner A, B…).
                { ownerKey: 'public-land', displayName: PAYLOAD, color: '#123456', geometry: box(20, 0, 40, 50),
                    owners: [{ ownerKey: 'public-land', displayName: PAYLOAD, color: 'red;background:url(x)', share: 1 }] }
            ],
            ownerShares: [{ ownerKey: ATTR_BREAKOUT, displayName: PAYLOAD, color: CSS_BREAKOUT, contributedArea: 2000, contributedValue: 1 }]
        };
        env = makeEditor({
            parcels: [{ id: 'P1', geometry: box(0, 0, 40, 50), properties: { calculatedArea: 2000 } }],
            selection: null,
            pendingPlan: plan
        });
        expect(await env.editor.openReparcellizationModal({
            algorithm: plan.algorithm, initialPolygons: plan.polygons, poolGeometry: plan.poolGeometry
        })).toBe(true);
        return env;
    }

    it('never interpolates plan-derived owner fields raw into markup', async () => {
        const rawInMarkup = source.split('\n')
            .filter(line => line.includes('<') && /\$\{\s*(entry|o|owner|slice)\.(displayName|ownerKey|color)/.test(line));
        expect(rawInMarkup).toEqual([]);
        // And what the editor actually renders from a crafted plan: no element came from a payload.
        const w = await openCraftedPlan();
        expect(w.state.modal.querySelectorAll('img')).toEqual([]);
        expect(w.state.newPlotsListEl.textContent).toContain(PAYLOAD);   // shown as text, not markup
        const cash = w.state.legendListEl.querySelector('.cash-offer-input');
        expect(cash.getAttribute('data-owner-key')).toBe(ATTR_BREAKOUT);
        w.state.modal.querySelectorAll('.legend-color').forEach(swatch => {
            expect(swatch.getAttribute('style')).toMatch(/^background:#[0-9a-f]{3,8}(;border:1px solid #9ca3af)?$/i);
        });
    });

    it('escapes Leaflet string tooltips (Leaflet renders them as HTML)', async () => {
        const w = await openCraftedPlan();
        const tips = w.plotLayers().map(layer => layer.tooltip);
        expect(tips).toHaveLength(2);
        tips.forEach(expectInert);
        expect(tips[1]).toBe('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('sanitises colours when hydrating a saved plan', async () => {
        const w = await openCraftedPlan();
        expect(w.state.slices[0].color).toBe('#cccccc');
        expect(w.state.slices[0].owners[0].color).toBe('#cccccc');
        // An owner's own hostile colour falls back to its plot's colour.
        expect(w.state.slices[1].color).toBe('#123456');
        expect(w.state.slices[1].owners[0].color).toBe('#123456');
    });
});
