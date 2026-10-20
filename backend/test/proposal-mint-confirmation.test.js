// Mint confirmation displays a qualified chain reference and navigates only by a local key.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ChainProposalRef = require('../../frontend/js/proposals/chain-ref.js');
const source = readFileSync(new URL('../../frontend/js/proposals/chain.js', import.meta.url), 'utf8');
const chainRef = { chainType: 'evm', chainId: '84532', contract: '0x1111111111111111111111111111111111111111', tokenId: '77' };

function setup() {
    let dialog;
    const showDetails = vi.fn();
    const context = vm.createContext({
        console,
        document: { createElement: () => ({ style: {}, children: [], appendChild(child) { this.children.push(child); } }) },
        window: { ChainProposalRef, CbDialog: { open: options => { dialog = options; return { overlay: {} }; } } },
        getExplorerBaseUrlForChain: () => null,
        getProposalI18nHelper: () => (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key]),
        showProposalDetailsModal: showDetails
    });
    vm.runInContext(source, context);
    return { show: context.showProposalMintSuccessModal, getDialog: () => dialog, showDetails };
}

describe('proposal mint confirmation identities', () => {
    it('shows every chain-reference component and opens the separate local record on close', () => {
        const ui = setup();
        ui.show({ localProposalId: 'local-draft', chainRef, chainId: '84532' });
        const dialog = ui.getDialog();
        expect(dialog.body.children.map(line => line.textContent)).toEqual([
            'Chain: evm / 84532', `Contract/program: ${chainRef.contract}`, 'Token/account: 77'
        ]);
        dialog.onClose();
        expect(ui.showDetails).toHaveBeenCalledExactlyOnceWith('local-draft');
    });

    it('never uses a chain token as a fallback local navigation key', () => {
        const ui = setup();
        ui.show({ chainRef, chainId: '84532' });
        ui.getDialog().onClose();
        expect(ui.showDetails).not.toHaveBeenCalled();
    });

    it('preserves the creation callback and does not display an incomplete reference as an identity', () => {
        const ui = setup();
        const onClose = vi.fn();
        ui.show({ localProposalId: 'local-draft', chainRef: { tokenId: '77' }, onClose });
        expect(ui.getDialog().body.children).toEqual([]);
        ui.getDialog().onClose();
        expect(onClose).toHaveBeenCalledOnce();
        expect(ui.showDetails).not.toHaveBeenCalled();
    });
});
