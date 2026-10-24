// Geometry-only source references are application display labels, not cadastral numbers.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const parcelIds = require('../../frontend/js/proposals/parcel-id.js');
const parcelMenu = require('../../frontend/js/ui/parcel-menu-model.js');
const openGround = require('../../frontend/js/proposals/open-ground.js');
const format = require('../../frontend/js/format.js');
const financials = require('../../frontend/js/financials.js');
const CityMoney = require('../../frontend/js/city-money.js');
const ParcelPriceModel = {
    buildEstimate: financials.buildParcelPriceEstimate,
    aggregate: financials.aggregateParcelPriceEstimates
};
const panelSource = readFileSync(new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url), 'utf8');
// Every stylesheet: the parcel id clamp is shared by several surfaces and must live in one of them.
const cssDir = new URL('../../frontend/css/', import.meta.url);
const allCss = readdirSync(cssDir).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(new URL(name, cssDir), 'utf8')).join('\n');

class Element {
    constructor(id = '') {
        this.id = id;
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.children = [];
        this.listeners = {};
        this.hidden = false;
        this.classList = {
            add() {}, remove() {}, toggle() {}, contains() { return false; }
        };
        this._textContent = '';
        this.innerHTML = '';
    }
    set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
    get textContent() { return this._textContent + this.children.map(child => child.textContent || '').join(''); }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key] || ''; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

function renderParcelPanel(properties, { currency = 'EUR', id = 'test-city' } = {}) {
    const cityConfig = { id, parcels: { ownership: false }, currency: { code: currency } };
    const ids = [
        'parcel-info-panel', 'parcel-info-title', 'info-content', 'propose-content', 'proposals-content',
        'parcel-owners-count', 'tools-tab', 'measureAsRoadButton', 'roadMeasurements', 'parcel-plans-content'
    ];
    const elements = new Map(ids.map(id => [id, new Element(id)]));
    const copied = [];
    const document = {
        getElementById: id => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createTextNode: text => Object.assign(new Element(), { _textContent: String(text) }),
        createElement: () => new Element()
    };
    const scope = {
        document,
        console,
        CbFormat: format,
        ParcelMenuModel: parcelMenu,
        __openGround: openGround,
        CityMoney: { currentLandPriceOptions: kind => CityMoney.landPriceOptions(cityConfig, kind) },
        ParcelPriceModel,
        ClickStack: { isDriving: () => true },
        getParcelId: parcelIds.getParcelIdFromFeature,
        getParcelDisplayNumberFromProperties: parcelIds.getParcelDisplayNumberFromProperties,
        getParcelDisplayNumberFromFeature: parcelIds.getParcelDisplayNumberFromFeature,
        copyTextWithFeedback: value => copied.push(value),
        tParcel: (_key, _params, fallback) => fallback,
        i18n: { applyTranslations() {} },
        CityConfigManager: {
            getCurrentCityConfig: () => cityConfig,
            applyFeatureVisibility() {}
        },
        requestAnimationFrame: callback => callback(),
        ParcelSetProposals: { renderPublishedOnly() {} },
        // The Proposals tab's Plans view (cdc103eb); these tests look at the title and Info tab only.
        ProposalPlans: {
            decorateParcelRows() {}, bindPlanRows() {}, current: plans => plans, planRowsHtml: () => '',
            parcelPlans: () => Promise.resolve({ plans: [] })
        },
        escapeHtml: text => String(text),
        resetParcelMintStatusState() {},
        window: null
    };
    scope.window = scope;
    runInContext(panelSource, createContext(scope));
    scope.ParcelsUIParcelPanel.showParcelInfoPanel({ type: 'Feature', geometry: null, properties });
    return {
        title: elements.get('parcel-info-title').textContent,
        titleElement: elements.get('parcel-info-title'),
        copied,
        info: elements.get('info-content').innerHTML
    };
}

describe('geometry-derived parcel references', () => {
    const canonicalId = 'in-source:sha256:0123456789abcdef0123456789abcdef';
    const displayId = 'G1-0123456789ab';

    it('uses the short geometry display id only for geometry-hash identities', () => {
        expect(parcelIds.getParcelDisplayNumberFromProperties({
            parcelIdentityKind: 'geometry-sha256-v1', parcelId: canonicalId, geometryDisplayId: displayId
        })).toBe(displayId);
        expect(parcelIds.getParcelDisplayNumberFromProperties({
            parcelIdentityKind: 'registry', parcelId: canonicalId, geometryDisplayId: displayId
        })).toBe(canonicalId);
    });

    it('keeps the full geometry identity out of the parcel click menu', () => {
        expect(parcelMenu.displayParcelId({
            parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: displayId
        }, canonicalId)).toBe(displayId);
        expect(parcelMenu.displayParcelId({
            parcelIdentityKind: 'registry', geometryDisplayId: displayId
        }, 'native-123')).toBe('native-123');
    });

    it('labels the selected parcel as an application reference and avoids showing the full hash id', () => {
        const rendered = renderParcelPanel({
            parcelId: canonicalId,
            parcelIdentityKind: 'geometry-sha256-v1',
            sourceParcelId: null,
            parcelNumber: null,
            geometryDisplayId: displayId,
            sourceGeometryHash: '0123456789abcdef0123456789abcdef'
        });

        expect(rendered.title).toContain(displayId);
        expect(rendered.title).not.toContain(canonicalId);
        expect(rendered.title).not.toContain('0123456789abcdef0123456789abcdef');
        expect(rendered.info).toContain('role="note"');
        expect(rendered.info).toContain('panel.parcel.geometryReferenceNote');
        expect(rendered.info).toContain('Application reference derived from geometry. Source registry number unavailable; boundary changes create a new reference.');
    });

    it('does not show the geometry note for a parcel with another identity kind', () => {
        const rendered = renderParcelPanel({
            parcelId: 'native-123', parcelIdentityKind: 'registry', parcelNumber: '123'
        });
        expect(rendered.info).not.toContain('geometryReferenceNote');
    });

    it('labels unchanged source ground without asserting cadastral authority', () => {
        const rendered = renderParcelPanel({ parcelId: 'tax-123', cadastreParcelIds: ['tax-123'] });
        expect(rendered.title).toBe('Source parcel tax-123');
        expect(rendered.info).not.toContain('identity.formedNote');
    });

    it('labels a source component separately from a proposed formation', () => {
        const rendered = renderParcelPanel({
            parcelId: 'part-A', cadastreParcelIds: ['source-A'], cadastralPart: true,
            parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: 'G1-source'
        });
        expect(rendered.title).toBe('Source parcel part part-A');
        expect(rendered.info).toContain('identity.sourcePartNote');
        expect(rendered.info).not.toContain('geometryReferenceNote');
    });

    it.each([false, true])('identifies a plot piece, including on open ground (%s)', onOpenGround => {
        const rendered = renderParcelPanel({
            parcelId: 'plot-piece', producedByProposalId: 'design',
            cadastreParcelIds: onOpenGround ? [] : ['source'],
            ...(onOpenGround ? { groundIds: ['ground:' + 'a'.repeat(64)] } : {}),
            readjustmentPiece: { role: 'plot', plotFingerprint: 'plot-a' }
        });
        expect(rendered.title).toBe('Plot piece plot-piece');
        expect(rendered.info).toContain('identity.plotNote');
        expect(rendered.info).not.toContain('identity.formedNote');
    });

    it('labels readjustment leftover ground separately from authored plot pieces', () => {
        const rendered = renderParcelPanel({
            parcelId: 'rest', producedByProposalId: 'design', cadastreParcelIds: ['source'],
            readjustmentPiece: { role: 'remainder' }
        });
        expect(rendered.title).toBe('Ground remainder rest');
        expect(rendered.info).toContain('identity.remainderNote');
    });

    it('shows and copies the formed piece identity instead of inherited source metadata', () => {
        const rendered = renderParcelPanel({
            parcelId: 'piece-A', cadastreParcelIds: ['source-A'], producedByProposalId: 'design-A',
            parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: 'G1-source',
            BROJ_CESTICE: '7', MATICNI_BROJ_KO: '99'
        });
        expect(rendered.title).toBe('Formed ground piece piece-A');
        expect(rendered.info).toContain('identity.formedNote');
        expect(rendered.info).not.toContain('geometryReferenceNote');
        const copyTarget = rendered.titleElement.children.find(child => child.className === 'parcel-title-id');
        copyTarget.listeners.click();
        expect(rendered.copied).toEqual(['piece-A']);
    });

    it('keeps the normalised parcel id even when the feature also carries a cadastral number and KO', () => {
        const rendered = renderParcelPanel({
            parcelId: 'native-123', parcelIdentityKind: 'registry', BROJ_CESTICE: '7', MATICNI_BROJ_KO: '99'
        });
        const copyTarget = rendered.titleElement.children.find(child => child.className === 'parcel-title-id');
        expect(copyTarget.textContent).toBe('native-123');
    });

    it('builds HR-<KO>-<number> only for a feature without an id', () => {
        const rendered = renderParcelPanel({ BROJ_CESTICE: '7', MATICNI_BROJ_KO: '99' });
        const copyTarget = rendered.titleElement.children.find(child => child.className === 'parcel-title-id');
        expect(copyTarget.textContent).toBe('HR-99-7');
    });

    it('keeps long parcel ids complete for copy while clamping only their visual layout', () => {
        const canonicalId = 'KE-NAIROBI-NM-g1~368402797~-12643572~hash#chain_0123456789abcdef-2';
        const rendered = renderParcelPanel({ parcelId: canonicalId, parcelIdentityKind: 'registry' });
        const copyTarget = rendered.titleElement.children.find(child => child.className === 'parcel-title-id');

        expect(copyTarget.textContent).toBe(canonicalId);
        expect(copyTarget.listeners.click).toBeTypeOf('function');
        copyTarget.listeners.click();
        expect(rendered.copied).toEqual([canonicalId]);
    });

    // KNOWN BUG (reported, not fixed here): the clamp lived in css/parcel-menu.css, which the click
    // stack change deleted with the popover. The parcel panel title id and every .parcel-id-text
    // (claims, history card, proposal card, 3D panel) lost their two-line clamp. Flip to it() once
    // the rule is back in a stylesheet that is still loaded.
    it('clamps long parcel ids to two lines in the parcel panel and every parcel-id-text', () => {
        expect(allCss).toMatch(/#parcel-info-panel \.parcel-title-id-value\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
        expect(allCss).toMatch(/\.parcel-id-text[\s\S]*?word-break:\s*break-all;[\s\S]*?line-clamp:\s*2;/s);
    });

    it('does not assign a currency to a raw price without its own currency field', () => {
        const rendered = renderParcelPanel({
            parcelId: 'p-1', calculatedArea: 100, estimatedMarketPrice: 500, currency: 'USD'
        });
        expect(rendered.info).toContain('Est. Mkt. Price:');
        expect(rendered.info).toContain('N/A');
        expect(rendered.info).not.toContain('500 USD');
    });

    it('labels the known area-price fallback as a EUR model', () => {
        const rendered = renderParcelPanel({ parcelId: 'p-1', calculatedArea: 100 }, { currency: 'EUR' });
        const normalized = rendered.info.replace(/[\u00a0\u202f]/g, ' ');
        expect(normalized).toContain('Modeled area estimate (133 EUR/m²):');
        expect(normalized).toContain('13,300 EUR');
    });

    // A UK city prices land at its local authority's rate (js/uk-land-rates.js), in pounds.
    it('labels a UK parcel without a source price as a sterling area model', () => {
        const rendered = renderParcelPanel({ parcelId: 'p-1', calculatedArea: 100 }, { currency: 'GBP', id: 'birmingham' });
        const normalized = rendered.info.replace(/[\u00a0\u202f]/g, ' ');
        expect(normalized).toContain('Modeled area estimate (688 GBP/m²):');
        expect(normalized).toContain('68,800 GBP');
        expect(normalized).not.toContain('EUR');
    });

    it('shows a UK source price in sterling', () => {
        const rendered = renderParcelPanel({ parcelId: 'p-1', calculatedArea: 100, estimatedMarketPrice: 250000, estimatedMarketPriceCurrency: 'GBP' }, { currency: 'GBP' });
        expect(rendered.info.replace(/[\u00a0\u202f]/g, ' ')).toContain('250,000 GBP');
    });
});
