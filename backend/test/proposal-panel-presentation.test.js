import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Presentation = require('../../frontend/js/proposals/panel-presentation.js');
const detailsSource = readFileSync(new URL('../../frontend/js/proposals/details-panel.js', import.meta.url), 'utf8');

function extractBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end).trim();
}

describe('proposal panel presentation', () => {
    it('keeps source loading independent of observed map replacement', () => {
        expect(Presentation.parcelReferenceState()).toBe('unloaded');
        expect(Presentation.parcelReferenceState({ hasGeometry: true })).toBe('available');
        expect(Presentation.parcelReferenceState({ replacedInModel: true })).toBe('replaced');
        expect(Presentation.parcelReferenceState({ hasGeometry: true, replacedInModel: true })).toBe('replaced');
    });

    it('opens unloaded source details and only uses location focus for a replaced source', () => {
        const source = readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
        const clickSource = extractBetween(source, 'function handleProposalParcelClick(', '\nfunction setProposalCreateButtonState(');
        const details = vi.fn(), location = vi.fn();
        const click = vm.runInNewContext(`${clickSource}; handleProposalParcelClick;`, {
            Node: { TEXT_NODE: 3 }, returnToParcelInfo: details, focusOnRemovedParcelLocation: location
        });
        const event = replaced => {
            const row = { getAttribute: key => key === 'data-parcel-replaced' && replaced ? 'true' : null };
            return { target: row, currentTarget: row, stopPropagation: vi.fn(), preventDefault: vi.fn() };
        };
        const unloaded = event(false);
        click('source-1', unloaded);
        expect(details).toHaveBeenCalledWith('source-1', unloaded);
        expect(location).not.toHaveBeenCalled();
        details.mockClear();
        const replaced = event(true);
        click('source-1', replaced);
        expect(location).toHaveBeenCalledWith('source-1', replaced.currentTarget);
        expect(details).not.toHaveBeenCalled();
    });

    it('keeps a minimized same-proposal refresh compact while new and explicit requests choose their mode', () => {
        expect(Presentation.resolve({ sameProposal: true, visible: true, minimized: true })).toBe('compact');
        expect(Presentation.resolve({ sameProposal: true, visible: false, minimized: true })).toBe('details');
        expect(Presentation.resolve({ sameProposal: true, visible: true, minimized: false })).toBe('details');
        expect(Presentation.resolve({ sameProposal: false, visible: true, minimized: true })).toBe('details');
        expect(Presentation.resolve({ requested: 'details', sameProposal: true, visible: true, minimized: true })).toBe('details');
        expect(Presentation.resolve({ requested: 'compact', sameProposal: true, visible: true, minimized: false })).toBe('compact');
        expect(Presentation.resolve()).toBe('details');
    });

    it('forwards an explicit presentation from focusProposalDetails into proposal selection', async () => {
        const proposal = { proposalId: 'proposal-7', cadastreParcelIds: ['parcel-3'] };
        const select = vi.fn();
        const context = {
            proposalStorage: {},
            getProposalByIdOrHash: vi.fn(() => proposal),
            getProposalKey: item => item.proposalId,
            resolveProposalIdKey: value => value,
            selectAndHighlightProposal: select,
            window: {}
        };
        const focusSource = extractBetween(detailsSource, 'async function focusProposalDetails(', '\nfunction showProposalInfo(');
        const focusProposalDetails = vm.runInNewContext(`${focusSource}; focusProposalDetails;`, context);

        await focusProposalDetails('proposal-7', {
            parcelId: 'parcel-9', centerOnProposal: false, showDetails: true, presentation: 'compact'
        });

        expect(select).toHaveBeenCalledWith('proposal-7', 'parcel-9', false, true, false, { presentation: 'compact' });

        await focusProposalDetails('proposal-7');
        expect(select).toHaveBeenNthCalledWith(2, 'proposal-7', 'parcel-3', true, true, false, { presentation: 'details' });
    });

    it('can minimize and expand on a phone without hiding the action footer and updates the toggle state', () => {
        const classes = new Set();
        const body = { hidden: false };
        const footer = { hidden: true };
        const toggle = { setAttribute: vi.fn(), innerHTML: '' };
        const close = { setAttribute: vi.fn() };
        const panel = {
            classList: {
                toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
                contains: name => classes.has(name)
            },
            querySelector: selector => ({
                '.panel-body': body,
                '.panel-footer': footer,
                '#proposal-details-minimize': toggle,
                '#proposal-details-close': close
            })[selector] || null
        };
        const labels = { minimizeLabel: 'Minimize', expandLabel: 'Expand', closeLabel: 'Close' };
        const setterSource = extractBetween(detailsSource, 'function setProposalDetailsPanelMinimized(', '\nfunction toggleProposalDetailsPanelMinimized(');
        const setMinimized = new Function('window', `${setterSource}; return setProposalDetailsPanelMinimized;`)({
            matchMedia: () => ({ matches: true })
        });

        setMinimized(panel, true, labels);
        expect(classes.has('is-minimized')).toBe(true);
        expect(body.hidden).toBe(true);
        expect(footer.hidden).toBe(false);
        expect(toggle.setAttribute).toHaveBeenCalledWith('aria-expanded', 'false');
        expect(toggle.setAttribute).toHaveBeenCalledWith('aria-label', 'Expand');

        setMinimized(panel, false, labels);
        expect(classes.has('is-minimized')).toBe(false);
        expect(body.hidden).toBe(false);
        expect(footer.hidden).toBe(false);
        expect(toggle.setAttribute).toHaveBeenCalledWith('aria-expanded', 'true');
        expect(toggle.setAttribute).toHaveBeenCalledWith('aria-label', 'Minimize');
    });
});
