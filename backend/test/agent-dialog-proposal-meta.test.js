// The agent dialog badges each proposal Minted or Local. It used to call every id that did not start
// with "local-" minted, so once local ids became content hashes (p-…) every proposal the simulation
// agents created showed as Minted. The badge must follow isProposalMinted, as the rest of the app does.
import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';

function functionSources(file, names) {
    const source = readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script' });
    return names.map(name => {
        const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
        if (!node) throw new Error(`${name} not found in ${file}`);
        return source.slice(node.start, node.end);
    }).join('\n');
}

const code = [
    functionSources('proposals/core.js', ['isLocalProposalId']),
    functionSources('proposals/chain.js', ['getProposalNftInfo', 'isProposalMinted']),
    functionSources('agents.js', ['getProposalChainLabel', 'getProposalDisplayMeta'])
].join('\n');
const getProposalDisplayMeta = new Function(`${code}\nreturn getProposalDisplayMeta;`)();

describe('agent dialog proposal meta', () => {
    it('treats a local hash-id proposal as local and shows its id as is', () => {
        expect(getProposalDisplayMeta({ proposalId: 'p-1gtz1npm44n' })).toMatchObject({ minted: false, displayId: 'p-1gtz1npm44n' });
    });

    it('treats a proposal with an NFT or on-chain transaction as minted', () => {
        expect(getProposalDisplayMeta({ proposalId: 'p-abc', nft: { chain: 'solana-devnet', contract: 'Prog', tokenId: 'Mint' } }).minted).toBe(true);
        expect(getProposalDisplayMeta({ proposalId: 'p-abc', onchain: { transactionHash: '0x1' } }).minted).toBe(true);
        expect(getProposalDisplayMeta({ proposalId: 'p-abc', isMinted: true }).minted).toBe(true);
    });

    it('keeps the cached-id fallbacks: numeric means minted, legacy local numbers read local-<n>', () => {
        expect(getProposalDisplayMeta(null, '42')).toMatchObject({ minted: true, displayId: '42' });
        expect(getProposalDisplayMeta(null, 'p-xyz')).toMatchObject({ minted: false, displayId: 'p-xyz' });
        expect(getProposalDisplayMeta({ proposalId: 'local-7' })).toMatchObject({ minted: false, displayId: 'local-7' });
    });
});
