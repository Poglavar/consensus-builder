//! Urban Game Theory Parcel NFT - Solana Program
//! Equivalent to EVM ParcelNFT.sol - mints parcel representations as NFTs

use anchor_lang::prelude::*;

declare_id!("ParcelNFT11111111111111111111111111111111");

#[program]
pub mod parcel_nft {
    use super::*;

    /// Mint a single parcel
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
        parcel.owner = ctx.accounts.owner.key();
        parcel.bump = ctx.bumps.parcel;

        Ok(())
    }

    /// Update parcel metadata URI (owner only)
    pub fn set_parcel_metadata_uri(
        ctx: Context<UpdateParcelMetadata>,
        metadata_uri: String,
    ) -> Result<()> {
        require!(!metadata_uri.is_empty(), ParcelError::InvalidMetadataUri);
        ctx.accounts.parcel.metadata_uri = metadata_uri;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(parcel_id: String)]
pub struct MintParcel<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 4 + 256 + 4 + 256 + 32 + 1,
        seeds = [b"parcel", parcel_id.as_bytes()],
        bump
    )]
    pub parcel: Account<'info, Parcel>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateParcelMetadata<'info> {
    #[account(
        mut,
        has_one = owner
    )]
    pub parcel: Account<'info, Parcel>,

    pub owner: Signer<'info>,
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
