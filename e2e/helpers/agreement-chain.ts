// A minted agreement's chain account as the agreement program stores it (frontend/js/solana/
// agreement-client.js readAgreement; blockchain/solana/programs/agreement/README.md), served to the
// page's Solana RPC reads so the agreement panel reads it as it would read devnet. Wallet transactions
// are out of scope: every other account reads as absent, so the program itself reads as not deployed.
import { Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { routeSolanaReads } from './blockchain';
import { AGREEMENT_PROGRAM_ID } from './mocks/shared-server';

const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const { PublicKey } = backendRequire('@solana/web3.js');

// sha256("account:Agreement")[..8] and the account's size (8 + Agreement::INIT_SPACE), as the client copies them.
const AGREEMENT_DISCRIMINATOR = [83, 212, 5, 110, 225, 249, 197, 84];
const AGREEMENT_ACCOUNT_SPACE = 296;
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

export const STATUS = { active: 0, executed: 1, cancelled: 2, expired: 3 } as const;
export const DECISION = { pending: 0, satisfied: 1 } as const;

/** The agreement's account: PDA ["agreement", sponsor, sha256(cid)] under the agreement program. */
export function agreementAccountAddress(cid: string, sponsor: string): string {
  const seed = createHash('sha256').update(cid, 'utf8').digest();
  return PublicKey.findProgramAddressSync([Buffer.from('agreement'), new PublicKey(sponsor).toBytes(), seed], new PublicKey(AGREEMENT_PROGRAM_ID))[0].toBase58();
}

export interface AgreementAccount {
  cid: string; authority: string; lens: string; payout: string;
  /** Unix seconds; 0 = no deadline. */
  deadline?: number;
  requiredLamports?: bigint; escrowLamports?: bigint;
  status?: number; decision?: number;
}

/** The account's bytes, field by field in the program's order, zero-padded to the account's size. */
export function encodeAgreementAccount(account: AgreementAccount): Buffer {
  const key = (value: string) => Buffer.from(new PublicKey(value).toBytes());
  const u8 = (value: number) => Buffer.from([value]);
  const i64 = (value: number | bigint) => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
  const u64 = (value: number | bigint) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
  const cid = Buffer.from(account.cid, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(cid.length);
  const satisfied = account.decision === DECISION.satisfied;
  const bytes = Buffer.concat([
    Buffer.from(AGREEMENT_DISCRIMINATOR),
    key(account.authority), key(account.lens), key(account.payout),
    i64(account.deadline ?? 0), i64(Math.floor(Date.now() / 1000) - 3600),
    u64(account.requiredLamports ?? 0n), u64(account.escrowLamports ?? 0n),
    u8(account.status ?? STATUS.active), u8(0), u8(account.decision ?? DECISION.pending),
    // decision_attested_at, decision_observed_at, decision_attestation, decision_hash
    i64(satisfied ? Math.floor(Date.now() / 1000) - 60 : 0), i64(satisfied ? Math.floor(Date.now() / 1000) - 120 : 0),
    key(DEFAULT_PUBKEY), Buffer.alloc(32, satisfied ? 7 : 0),
    i64(0), u8(254), length, cid,
  ]);
  return Buffer.concat([bytes, Buffer.alloc(Math.max(0, AGREEMENT_ACCOUNT_SPACE - bytes.length))]);
}

/**
 * Answers the page's Solana JSON-RPC reads from `accounts` (address → the bytes the agreement program
 * owns there); any other account, the program's own included, is absent. Change the map to change the
 * chain the next read sees.
 */
export async function serveAgreementAccounts(page: Page, accounts: Map<string, Buffer>): Promise<void> {
  const info = (address: string) => {
    const data = accounts.get(address);
    return data ? { data: [data.toString('base64'), 'base64'], executable: false, lamports: 2_400_000, owner: AGREEMENT_PROGRAM_ID, rentEpoch: 0, space: data.length } : null;
  };
  const context = { slot: 4242 };
  const answer = (request: any) => {
    const params = Array.isArray(request.params) ? request.params : [];
    switch (request.method) {
      case 'getAccountInfo': return { result: { context, value: info(String(params[0])) } };
      case 'getMultipleAccounts': return { result: { context, value: (params[0] || []).map((address: string) => info(String(address))) } };
      case 'getProgramAccounts': return { result: [] };
      case 'getSignaturesForAddress': return { result: [] };
      case 'getBalance': return { result: { context, value: 0 } };
      case 'getLatestBlockhash': return { result: { context, value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1 } } };
      default: return { error: { code: -32602, message: `Invalid param: could not find account (${request.method})` } };
    }
  };
  await routeSolanaReads(page, async (route: Route) => {
    const body = route.request().postDataJSON();
    const replies = (Array.isArray(body) ? body : [body]).map(request => ({ jsonrpc: '2.0', id: request.id, ...answer(request) }));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? replies : replies[0]) });
  });
}
