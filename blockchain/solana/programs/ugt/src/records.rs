//! Design and plan records (blockchain-flows.md, "The objects on chain"): a record per CID at PDA
//! ["record", kind, sha256(cid)] saying "this content exists, since this time, minted by this key",
//! and the Metaplex Core asset at PDA ["asset", kind, sha256(cid)] minted to the publisher so a
//! wallet shows it (decided 2026-11-09). The record confers nothing: not ownership of land, not of
//! the design. First-create-wins is harmless, so a second minter of the same CID is refused and
//! nothing is lost. Readers verify content by hashing what they fetch, never by trusting the record.
//! Fixed fields come first, so `getProgramAccounts` with a memcmp on `kind` at byte 8 lists the
//! designs or the plans, and every account has the same size (RECORD_ACCOUNT_SPACE).

use anchor_lang::prelude::*;

use crate::mpl_core::{self, CreateAsset};
use crate::{cid_seed, require_valid_cid, UgtError, MAX_CID_LEN};

pub const RECORD_SEED: &[u8] = b"record";
pub const ASSET_SEED: &[u8] = b"asset";
pub const KIND_DESIGN: u8 = 1;
pub const KIND_PLAN: u8 = 2;
/// The asset's on-chain name (the design's or plan's title) and metadata URI (a data: URI with the
/// wallet-facing metadata; cosmetic, nothing reads content from it).
pub const MAX_NAME_LEN: usize = 100;
pub const MAX_URI_LEN: usize = 1000;

#[account]
#[derive(InitSpace)]
pub struct Record {
    /// KIND_DESIGN (1) or KIND_PLAN (2); byte 8 of the account.
    pub kind: u8,
    /// The publisher: signed the create, paid the rent, owns the asset.
    pub minter: Pubkey,
    /// Chain time of the create.
    pub created_at: i64,
    /// The Metaplex Core asset minted for this record.
    pub asset: Pubkey,
    pub bump: u8,
    pub asset_bump: u8,
    /// The CIDv1 (`bafkrei…`) of the design/v1 or plan/v1 object this record commits to.
    #[max_len(MAX_CID_LEN)]
    pub cid: String,
}

/// 8-byte discriminator + Record::INIT_SPACE: every record has this size (a `dataSize` filter).
pub const RECORD_ACCOUNT_SPACE: usize = 8 + Record::INIT_SPACE;
/// Byte offset of `kind`, the memcmp filter that lists designs or plans.
pub const RECORD_KIND_OFFSET: usize = 8;

#[derive(Accounts)]
#[instruction(kind: u8, cid: String)]
pub struct CreateRecord<'info> {
    #[account(
        init,
        payer = minter,
        space = RECORD_ACCOUNT_SPACE,
        seeds = [RECORD_SEED, &[kind], &cid_seed(&cid)],
        bump
    )]
    pub record: Account<'info, Record>,

    /// CHECK: the Metaplex Core asset at ["asset", kind, sha256(cid)]; Metaplex Core creates it in
    /// the CPI (this program signs for the PDA), so it must not exist yet.
    #[account(mut, seeds = [ASSET_SEED, &[kind], &cid_seed(&cid)], bump)]
    pub asset: UncheckedAccount<'info>,

    /// The publisher: pays the rent of the record and the asset, receives the asset.
    #[account(mut)]
    pub minter: Signer<'info>,

    /// CHECK: the Metaplex Core program, by address.
    #[account(address = mpl_core::MPL_CORE_ID @ UgtError::WrongProgram)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct RecordCreated {
    pub record: Pubkey,
    pub asset: Pubkey,
    pub kind: u8,
    pub cid: String,
    pub minter: Pubkey,
    pub created_at: i64,
}

pub fn handle_create_record(ctx: Context<CreateRecord>, kind: u8, cid: String, name: String, uri: String) -> Result<()> {
    require!(kind == KIND_DESIGN || kind == KIND_PLAN, UgtError::InvalidKind);
    require_valid_cid(&cid)?;
    require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, UgtError::InvalidName);
    require!(!uri.is_empty() && uri.len() <= MAX_URI_LEN, UgtError::InvalidUri);
    require!(ctx.accounts.asset.data_is_empty(), UgtError::AssetExists);

    let now = Clock::get()?.unix_timestamp;
    let seed = cid_seed(&cid);
    let asset_bump = ctx.bumps.asset;
    let minter = ctx.accounts.minter.key();
    let asset = ctx.accounts.asset.key();
    let record_key = ctx.accounts.record.key();
    mpl_core::create_soulbound_asset(
        CreateAsset {
            asset: &ctx.accounts.asset.to_account_info(),
            payer: &ctx.accounts.minter.to_account_info(),
            owner: &ctx.accounts.minter.to_account_info(),
            update_authority: &ctx.accounts.record.to_account_info(),
            mpl_core_program: &ctx.accounts.mpl_core_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        &name,
        &uri,
        &[ASSET_SEED, &[kind], &seed, &[asset_bump]],
    )?;

    let record = &mut ctx.accounts.record;
    record.kind = kind;
    record.minter = minter;
    record.created_at = now;
    record.asset = asset;
    record.bump = ctx.bumps.record;
    record.asset_bump = asset_bump;
    record.cid = cid.clone();

    emit!(RecordCreated { record: record_key, asset, kind, cid, minter, created_at: now });
    Ok(())
}
