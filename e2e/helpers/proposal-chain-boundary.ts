// Provide local wallet-provider RPC fixtures while keeping proposal-chain application logic real.
import { Page } from '@playwright/test';

export const PROPOSAL_EVM_ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678';
export const PROPOSAL_EVM_CONTRACT = '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709';
export const PARCEL_EVM_CONTRACT = '0x4f3c8ada0e7c4c49dfde8344216c5ec299ae0001';
export const PROPOSAL_MINT_TX = `0x${'f'.repeat(64)}`;

export type ProposalEvmBoundaryOptions = {
  /** Return an existing parcel token so the real prerequisite check permits proposal minting. */
  parcelAlreadyMinted?: boolean;
  /** Simulate an insufficient-gas-balance RPC failure during EIP-1193 transaction submission. */
  failProposalMint?: boolean;
  /** Return one real-shaped minted proposal from contract reads for the minted-proposals modal. */
  includeMintedProposal?: boolean;
};

/**
 * Keep app contracts/loaders/bridges intact while returning deterministic EIP-1193 and HTTP boundary
 * responses. The frontend still ABI-encodes calls, submits transactions, waits for receipts, reads
 * the minted list, and imports metadata through its production modules.
 */
export async function installProposalEvmBoundary(page: Page, options: ProposalEvmBoundaryOptions = {}): Promise<void> {
  await page.route('**/contracts/addresses.json', route => route.fulfill({ json: {
    '84532': { ProposalNFT: PROPOSAL_EVM_CONTRACT, ParcelNFT: PARCEL_EVM_CONTRACT },
    '0x14a34': { ProposalNFT: PROPOSAL_EVM_CONTRACT, ParcelNFT: PARCEL_EVM_CONTRACT },
  } }));
  await page.route('**/ipfs/upload', route => route.fulfill({ json: {
    metadataUri: 'ipfs://button-control-metadata',
    metadataGatewayUrl: 'https://gateway.invalid/button-control-metadata.json',
    imageUri: 'ipfs://button-control-image',
  } }));
  await page.route('**/uploads/metadata/proposal-11.json', route => route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' },
    json: { name: 'Modal garden', description: 'Saved on-chain metadata.' },
  }));

  await page.evaluate(({ account, contract, parcelContract, txHash, ...settings }) => {
    const w = window as any;
    const wallet = w.ethereum;
    if (!wallet || typeof wallet.request !== 'function') throw new Error('The EIP-1193 test wallet is not installed.');
    const originalRequest = wallet.request.bind(wallet);
    const proposalInterface = new w.ethers.Interface([
      'function totalSupply() view returns (uint256)',
      'function tokenByIndex(uint256 index) view returns (uint256)',
      'function getTokensByOwner(address owner) view returns (uint256[])',
      'function getProposalsBatch(uint256[] tokenIds) view returns (string[][] parcelIdsArray, bool[] isConditionalArray, string[] imageURIArray, bool[] acceptancePossibleArray, uint8[] statusArray, uint256[] ethBalanceArray, uint256[] tokenBalanceArray, uint256[] acceptanceCountArray, uint256[] expiryTimestampArray, uint256[] expiringPercentageArray)',
      'function getLens(uint256 tokenId) view returns (address[])',
      'function ownerOf(uint256 tokenId) view returns (address)',
      'function mintAndFund(address recipient, string[] parcelIds, bool isConditional, string imageURI, uint256 ethAmount, uint256 tokenAmount, address[] lens) payable returns (uint256)',
    ]);
    const parcelInterface = new w.ethers.Interface([
      'function tokenIdForParcelId(string parcelId) view returns (uint256)',
      'function parcelIdForTokenId(uint256 tokenId) view returns (string)',
      'function totalSupply() view returns (uint256)',
      'function tokenByIndex(uint256 index) view returns (uint256)',
    ]);
    const signature = txHash;
    const addressTopic = `0x${String(account).slice(2).toLowerCase().padStart(64, '0')}`;
    const transferTopics = [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${'0'.repeat(64)}`,
      addressTopic,
      `0x${BigInt(77).toString(16).padStart(64, '0')}`,
    ];
    const calls: string[] = [];
    let submittedTransaction: Record<string, string> | null = null;
    w.__proposalEvmBoundary = calls;

    wallet.request = async (args: any) => {
      calls.push(String(args.method));
      if (args.method === 'eth_call') {
        const tx = args.params?.[0] || {};
        const to = String(tx.to || '').toLowerCase();
        const data = String(tx.data || tx.input || '0x');
        if (to === String(parcelContract).toLowerCase()) {
          let parsed: any;
          try { parsed = parcelInterface.parseTransaction({ data }); } catch (_) { /* other parcel read */ }
          if (parsed?.name === 'totalSupply') return parcelInterface.encodeFunctionResult('totalSupply', [settings.parcelAlreadyMinted ? 1n : 0n]);
          if (parsed?.name === 'tokenByIndex') return parcelInterface.encodeFunctionResult('tokenByIndex', [1n]);
          if (parsed?.name === 'parcelIdForTokenId') return parcelInterface.encodeFunctionResult('parcelIdForTokenId', ['HR-335754-1234']);
          if (parsed?.name === 'tokenIdForParcelId') {
            if (settings.parcelAlreadyMinted) return parcelInterface.encodeFunctionResult('tokenIdForParcelId', [1n]);
            const error = new Error('execution reverted: parcel does not exist') as Error & { code?: number; data?: any };
            error.code = -32603;
            error.data = { message: 'parcel does not exist' };
            throw error;
          }
        }
        if (to === String(contract).toLowerCase()) {
          let parsed: any;
          try { parsed = proposalInterface.parseTransaction({ data }); } catch (_) { /* unrelated read */ }
          if (parsed?.name === 'totalSupply') return proposalInterface.encodeFunctionResult('totalSupply', [settings.includeMintedProposal ? 1n : 0n]);
          if (parsed?.name === 'tokenByIndex') return proposalInterface.encodeFunctionResult('tokenByIndex', [11n]);
          if (parsed?.name === 'getTokensByOwner') {
            return proposalInterface.encodeFunctionResult('getTokensByOwner', [settings.includeMintedProposal ? [11n] : []]);
          }
          if (parsed?.name === 'getProposalsBatch') {
            const tokenIds = (parsed.args[0] as any[]).map(value => BigInt(value).toString());
            return proposalInterface.encodeFunctionResult('getProposalsBatch', [
              tokenIds.map(() => ['HR-335754-1234']), tokenIds.map(() => false),
              tokenIds.map(() => '/uploads/metadata/proposal-11.json'), tokenIds.map(() => true),
              tokenIds.map(() => 1), tokenIds.map(() => 0n), tokenIds.map(() => 0n),
              tokenIds.map(() => 0n), tokenIds.map(() => 0n), tokenIds.map(() => 0n),
            ]);
          }
          if (parsed?.name === 'getLens') return proposalInterface.encodeFunctionResult('getLens', [[account]]);
          if (parsed?.name === 'ownerOf') return proposalInterface.encodeFunctionResult('ownerOf', [account]);
          if (parsed?.name === 'mintAndFund') return proposalInterface.encodeFunctionResult('mintAndFund', [77n]);
        }
        return '0x';
      }
      if (args.method === 'eth_getCode') return '0x60006000';
      if (args.method === 'eth_estimateGas') return '0x5208';
      if (args.method === 'eth_gasPrice' || args.method === 'eth_maxPriorityFeePerGas') return '0x1';
      if (args.method === 'eth_blockNumber') return '0x2';
      if (args.method === 'eth_sendTransaction') {
        if (settings.failProposalMint) {
          const error = new Error('insufficient funds for gas * price + value') as Error & { code?: number };
          error.code = -32000;
          throw error;
        }
        submittedTransaction = args.params?.[0] || {};
        return signature;
      }
      if (args.method === 'eth_getTransactionByHash') {
        if (!submittedTransaction) return null;
        return {
          hash: signature, nonce: '0x0', blockHash: `0x${'a'.repeat(64)}`,
          blockNumber: '0x1', transactionIndex: '0x0', from: account, to: contract,
          value: submittedTransaction.value || '0x0', gas: '0x5208', gasPrice: '0x1',
          input: submittedTransaction.data || '0x', chainId: '0x14a34', type: '0x0',
          v: '0x1b', r: `0x${'1'.padStart(64, '0')}`, s: `0x${'2'.padStart(64, '0')}`,
        };
      }
      if (args.method === 'eth_getTransactionReceipt') {
        return {
          transactionHash: signature, transactionIndex: '0x0', blockHash: `0x${'a'.repeat(64)}`,
          blockNumber: '0x1', from: account, to: contract, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
          contractAddress: null, logs: [{
            address: contract, topics: transferTopics, data: '0x', blockNumber: '0x1',
            transactionHash: signature, transactionIndex: '0x0', blockHash: `0x${'a'.repeat(64)}`,
            logIndex: '0x0', removed: false,
          }], logsBloom: `0x${'0'.repeat(512)}`, status: '0x1', type: '0x0', effectiveGasPrice: '0x1',
        };
      }
      if (args.method === 'eth_getBlockByNumber') {
        return {
          number: args.params?.[0] === 'latest' ? '0x2' : args.params?.[0],
          hash: `0x${'a'.repeat(64)}`, parentHash: `0x${'b'.repeat(64)}`,
          timestamp: '0x1', transactions: [], gasLimit: '0x100000', gasUsed: '0x5208',
          miner: account, difficulty: '0x0', extraData: '0x', baseFeePerGas: '0x1',
        };
      }
      return originalRequest(args);
    };
  }, {
    account: PROPOSAL_EVM_ACCOUNT, contract: PROPOSAL_EVM_CONTRACT,
    parcelContract: PARCEL_EVM_CONTRACT, txHash: PROPOSAL_MINT_TX, ...options,
  });
}
