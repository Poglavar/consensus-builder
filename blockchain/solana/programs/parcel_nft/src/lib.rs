//! Urban Game Theory Parcel NFT - Solana Program
//! Equivalent to EVM ParcelNFT.sol - mints parcel representations as NFTs
//!
//! v2 (lens model, lens-model.md): a parcel account is an ownerless anchor, the on-chain identity
//! of a cadastral parcel. `owner` is always Pubkey::default() for new anchors (older anchors keep
//! whatever they had; nothing reads it). Real ownership reaches the chain only as a lens member's
//! ParcelOwnership-v1 attestation, checked by proposal_nft. The metadata URI is deterministic, so
//! there is no update instruction.

use anchor_lang::prelude::*;

declare_id!("4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1");

#[program]
pub mod parcel_nft {
    use super::*;

    /// Create the anchor for one parcel. Anyone may pay for it; nobody owns it.
    pub fn mint_parcel(
        ctx: Context<MintParcel>,
        parcel_id: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(!parcel_id.is_empty(), ParcelError::InvalidParcelId);
        require!(!metadata_uri.is_empty(), ParcelError::InvalidMetadataUri);

        let parcel = &mut ctx.accounts.parcel;
        parcel.parcel_id = parcel_id;
        parcel.metadata_uri = metadata_uri;
        parcel.owner = Pubkey::default();
        parcel.bump = ctx.bumps.parcel;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(parcel_id: String)]
pub struct MintParcel<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 4 + 256 + 4 + 256 + 32 + 1,
        seeds = [b"parcel", parcel_id.as_bytes()],
        bump
    )]
    pub parcel: Account<'info, Parcel>,

    /// Pays rent only; same account position as v1's `owner`, so raw-built instructions still work.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct Parcel {
    pub parcel_id: String,
    pub metadata_uri: String,
    pub owner: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum ParcelError {
    #[msg("Invalid parcel ID")]
    InvalidParcelId,
    #[msg("Invalid metadata URI")]
    InvalidMetadataUri,
    #[msg("Parcel already minted")]
    ParcelAlreadyMinted,
    #[msg("Parcel does not exist")]
    ParcelDoesNotExist,
}
