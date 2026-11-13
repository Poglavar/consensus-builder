//! Parcel anchors (blockchain-flows.md, "The objects on chain"): an ownerless account per cadastral
//! parcel at PDA ["parcel", parcel_id], the parcel's on-chain identity and inbox, with a fixed
//! metadata URI (the parcel's app page). Created once by anyone, who pays the rent and owns nothing;
//! never transferred, never closed. Ownership reaches the chain only as a lens attestation.
//! `anchor_parcels` takes several ids and skips the anchored ones, so a resumed batch never fails
//! on its own earlier work (the EVM ParcelAnchor.anchorBatch behaviour).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};

use crate::UgtError;

pub const PARCEL_SEED: &[u8] = b"parcel";
/// A parcel id is the PDA's seed, so it is at most one seed long.
pub const MAX_PARCEL_ID_LEN: usize = 32;
pub const MAX_METADATA_URI_LEN: usize = 200;
/// Ids per call: a transaction holds the ids, URIs and one account key per parcel.
pub const MAX_ANCHORS_PER_CALL: usize = 16;

/// One parcel anchor. Fixed fields first, so readers find `anchored_by` and `anchored_at` at the
/// same offsets in every account; the account's size varies with its strings.
#[account]
pub struct ParcelAnchor {
    /// Who paid the rent (not an owner).
    pub anchored_by: Pubkey,
    /// Chain time of the anchoring.
    pub anchored_at: i64,
    pub bump: u8,
    /// The cadastral parcel id (the PDA seed).
    pub parcel_id: String,
    /// Fixed at creation: the parcel's public page.
    pub metadata_uri: String,
}

#[derive(Accounts)]
pub struct AnchorParcels<'info> {
    /// Pays the rent of every anchor this call creates.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct ParcelAnchored {
    pub parcel: Pubkey,
    pub parcel_id: String,
    pub anchored_by: Pubkey,
    pub anchored_at: i64,
}

pub fn handle_anchor_parcels<'info>(
    ctx: Context<'_, '_, 'info, 'info, AnchorParcels<'info>>,
    parcel_ids: Vec<String>,
    metadata_uris: Vec<String>,
) -> Result<()> {
    require!(
        !parcel_ids.is_empty() && parcel_ids.len() <= MAX_ANCHORS_PER_CALL && parcel_ids.len() == metadata_uris.len(),
        UgtError::InvalidAnchorBatch
    );
    require!(ctx.remaining_accounts.len() == parcel_ids.len(), UgtError::InvalidAnchorBatch);
    let now = Clock::get()?.unix_timestamp;
    let payer = &ctx.accounts.payer;
    let rent = Rent::get()?;

    for (index, (parcel_id, metadata_uri)) in parcel_ids.iter().zip(metadata_uris.iter()).enumerate() {
        require!(!parcel_id.is_empty() && parcel_id.len() <= MAX_PARCEL_ID_LEN, UgtError::InvalidParcelId);
        require!(!metadata_uri.is_empty() && metadata_uri.len() <= MAX_METADATA_URI_LEN, UgtError::InvalidMetadataUri);
        let account = &ctx.remaining_accounts[index];
        let (expected, bump) = Pubkey::find_program_address(&[PARCEL_SEED, parcel_id.as_bytes()], ctx.program_id);
        require_keys_eq!(account.key(), expected, UgtError::WrongParcelAccount);
        require!(account.is_writable, UgtError::WrongParcelAccount);
        // Anchored already (only this program can create an account at this address): nothing to do.
        if account.owner == ctx.program_id && !account.data_is_empty() {
            continue;
        }
        require!(account.owner == &system_program::ID && account.data_is_empty(), UgtError::WrongParcelAccount);

        let anchor = ParcelAnchor {
            anchored_by: payer.key(),
            anchored_at: now,
            bump,
            parcel_id: parcel_id.clone(),
            metadata_uri: metadata_uri.clone(),
        };
        let space = 8 + anchor.try_to_vec()?.len();
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount { from: payer.to_account_info(), to: account.clone() },
                &[&[PARCEL_SEED, parcel_id.as_bytes(), &[bump]]],
            ),
            rent.minimum_balance(space),
            space as u64,
            ctx.program_id,
        )?;
        {
            let mut data = account.try_borrow_mut_data()?;
            let mut cursor: &mut [u8] = &mut data;
            anchor.try_serialize(&mut cursor)?;
        }
        emit!(ParcelAnchored { parcel: account.key(), parcel_id: parcel_id.clone(), anchored_by: payer.key(), anchored_at: now });
    }
    Ok(())
}
