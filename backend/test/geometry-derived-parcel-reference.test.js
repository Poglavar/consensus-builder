// Geometry-only source references are application display labels, not cadastral numbers.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const parcelIds = require('../../frontend/js/proposals/parcel-id.js');
const parcelMenu = require('../../frontend/js/ui/parcel-menu-model.js');
const format = require('../../frontend/js/format.js');
const panelSource = readFileSync(new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url), 'utf8');

class Element {
    constructor(id = '') {
        this.id = id;
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.children = [];
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
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

function renderParcelPanel(properties) {
    const ids = [
        'parcel-info-panel', 'parcel-info-title', 'info-content', 'proposals-content',
        'parcel-owners-count', 'tools-tab', 'measureAsRoadButton', 'roadMeasurements'
    ];
    const elements = new Map(ids.map(id => [id, new Element(id)]));
    const document = {
        getElementById: id => elements.get(id) || null,
        querySelectorAll: () => [],
        createTextNode: text => Object.assign(new Element(), { _textContent: String(text) }),
        createElement: () => new Element()
    };
    const scope = {
        document,
        console,
        CbFormat: format,
        SQM_AVG_PRICE: 0,
        getParcelId: parcelIds.getParcelIdFromFeature,
        getParcelDisplayNumberFromProperties: parcelIds.getParcelDisplayNumberFromProperties,
        getParcelDisplayNumberFromFeature: parcelIds.getParcelDisplayNumberFromFeature,
        tParcel: (_key, _params, fallback) => fallback,
        i18n: { applyTranslations() {} },
        CityConfigManager: {
            getCurrentCityConfig: () => ({ parcels: { ownership: false } }),
            applyFeatureVisibility() {}
        },
        requestAnimationFrame: callback => callback(),
        resetParcelMintStatusState() {},
        window: null
    };
    scope.window = scope;
    runInContext(panelSource, createContext(scope));
    scope.ParcelsUIParcelPanel.showParcelInfoPanel({ type: 'Feature', geometry: null, properties });
    return { title: elements.get('parcel-info-title').textContent, info: elements.get('info-content').innerHTML };
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
});
