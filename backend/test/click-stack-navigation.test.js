// Shared tab routing keeps authoring first, preserves contextual controls and routes rich pages.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';

function fixture(html, kind = 'parcels') {
    const document = makeDocument();
    const body = document.createElement('div'); body.id = 'inspector-body';
    document.body.appendChild(body); body.innerHTML = html;
    const window = { i18n: { t: key => key.split('.').pop() },
        MutationObserver: class { observe() {} disconnect() {} } };
    vm.runInNewContext(readFileSync(new URL('../../frontend/js/click-stack/click-stack-navigation.js', import.meta.url), 'utf8'), { window, document });
    window.ClickStackNavigation.content(body, kind, 'one');
    return { body, select: key => window.ClickStackNavigation.selectPage(body, key),
        tabs: () => [...body.querySelectorAll('.click-stack__content-tabs [data-page]')].map(tab => tab.dataset.page) };
}

describe('inspector content routing', () => {
    it('opens authoring first and keeps selection controls outside the pages', () => {
        const f = fixture(`<div data-stack-persistent><button>Clear</button><button>Done</button></div>
            <div id="parcel-info-panel">
                <button data-parcel-tab-id="info-tab" aria-label="Info"></button>
                <button data-parcel-tab-id="propose-tab" aria-selected="true"></button>
                <button data-parcel-tab-id="tools-tab" aria-label="Tools"></button>
            </div>`, 'selection');
        expect(f.tabs()).toEqual(['actions', 'parcel-info-tab', 'parcel-tools-tab']);
        expect(f.body.querySelector('[data-page="actions"]').getAttribute('aria-selected')).toBe('true');
        f.select('parcel-tools-tab');
        expect(f.body.querySelector('[data-stack-persistent]').hasAttribute('data-stack-hidden')).toBe(false);
        expect(f.body.children[0].hasAttribute('data-stack-persistent')).toBe(true);
    });

    it('uses the rich native Designs list instead of a second relationship list', () => {
        const f = fixture(`<div class="click-stack__choices" data-kind="designs"></div>
            <div id="parcel-info-panel"><button data-parcel-tab-id="proposals-tab"><span class="parcel-tab-count">3</span></button>
            <button data-parcel-tab-id="propose-tab" aria-selected="true"></button></div>`);
        expect(f.tabs()).toEqual(['actions', 'parcel-proposals-tab']);
        expect(f.body.querySelector('[data-page="parcel-proposals-tab"]').textContent).toBe('designs (3)');
        expect(f.body.querySelector('.click-stack__choices').hasAttribute('data-stack-hidden')).toBe(true);
    });

    it('routes explicit Info, Options and Stats inside an existing inspector without hiding its parent', () => {
        const f = fixture(`<div id="host"><div data-stack-page-key="stats" data-stack-page-label="Stats">Metrics</div>
            <div data-stack-page-key="info" data-stack-page-label="Info">Facts</div>
            <div data-stack-page-key="options" data-stack-page-label="Options">Configuration</div></div>
            <div class="click-stack__actions"><button>Edit</button></div>`, 'permitted');
        expect(f.tabs()).toEqual(['actions', 'info', 'stats', 'options']);
        f.select('stats');
        expect(f.body.querySelector('#host').hasAttribute('data-stack-hidden')).toBe(false);
        expect(f.body.querySelector('[data-stack-page-key="stats"]').hasAttribute('data-stack-hidden')).toBe(false);
        expect(f.body.querySelector('[data-stack-page-key="info"]').hasAttribute('data-stack-hidden')).toBe(true);
        expect(f.body.querySelector('.click-stack__actions').hasAttribute('data-stack-hidden')).toBe(true);
    });
});
