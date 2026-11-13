//! Urban Game Theory - the one Solana program (docs/blockchain-flows.md, "Chain contracts").
//!
//! Three kinds of account, one deploy, one IDL and one client:
//! - `ParcelAnchor` at PDA ["parcel", parcel_id] (anchors.rs): the ownerless on-chain identity of a
//!   cadastral parcel, created by anyone (pays rent only), never transferred, never closed.
//!   `anchor_parcels` creates several per transaction and skips the ones that exist.
//! - `Record` at PDA ["record", kind, sha256(cid)] (records.rs): a design (kind 1) or plan (kind 2)
//!   record per CID, with a Metaplex Core asset at PDA ["asset", kind, sha256(cid)] minted to the
//!   publisher so wallets show it. Soulbound (permanently frozen), first-create-wins, confers nothing.
//! - `Agreement` at PDA ["agreement", sponsor, sha256(cid)] (agreement.rs): the retired agreement
//!   program's account and lifecycle (create → fund* → attest → execute, or cancel, or expire), plus
//!   the sha256 of the plan it names and its input parcel count, at fixed offsets for readers.
//!
//! Error codes keep the retired agreement program's order, so its clients' error names still match.
//! proposal_market and proposal_pledge depend on this crate (no-entrypoint) for the program id and
//! `read_agreement_view`.

use anchor_lang::prelude::*;

pub mod agreement;
pub mod anchors;
pub mod mpl_core;
pub mod records;

pub use agreement::*;
pub use anchors::*;
pub use records::*;

// The devnet program id (keypair outside the repo, ~/.config/solana/program-keys/ugt.json); pinned
// in Anchor.toml, idl/ugt.json, frontend/js/solana/ugt-client.js and frontend/contracts/addresses.json.
declare_id!("95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9");

#[program]
pub mod ugt {
    use super::*;

    /// Create the anchors of `parcel_ids` (each with its fixed metadata URI) that do not exist yet,
    /// one remaining account per id: the PDA ["parcel", parcel_id], writable. Anyone pays; nobody owns.
    pub fn anchor_parcels<'info>(
        ctx: Context<'_, '_, 'info, 'info, AnchorParcels<'info>>,
        parcel_ids: Vec<String>,
        metadata_uris: Vec<String>,
    ) -> Result<()> {
        anchors::handle_anchor_parcels(ctx, parcel_ids, metadata_uris)
    }

    /// Record `cid` as a design (kind 1) or plan (kind 2) published by the signer, and mint its
    /// Metaplex Core asset (`name`, `uri`) to the signer. Refused when the record exists.
    pub fn create_record(ctx: Context<CreateRecord>, kind: u8, cid: String, name: String, uri: String) -> Result<()> {
        records::handle_create_record(ctx, kind, cid, name, uri)
    }

    /// Commit an agreement to the chain (agreement.rs: `create`).
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        ctx: Context<Create>,
        cid: String,
        plan_cid: String,
        input_count: u16,
        lens: Pubkey,
        deadline: i64,
        open_ground: bool,
        required_lamports: u64,
        payout: Pubkey,
    ) -> Result<()> {
        agreement::handle_create(ctx, cid, plan_cid, input_count, lens, deadline, open_ground, required_lamports, payout)
    }

    /// The authority moves `lamports` into the escrow.
    pub fn fund(ctx: Context<Fund>, lamports: u64) -> Result<()> {
        agreement::handle_fund(ctx, lamports)
    }

    /// Record the lens's satisfied decision from its AgreementDecision-v1 attestation.
    pub fn attest(ctx: Context<Attest>) -> Result<()> {
        agreement::handle_attest(ctx)
    }

    /// Pay the escrow of a satisfied, funded agreement to its payout.
    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        agreement::handle_execute(ctx)
    }

    /// The authority withdraws an agreement whose decision is not recorded; the escrow returns to it.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        agreement::handle_cancel(ctx)
    }

    /// Anyone expires an agreement past its deadline; the escrow returns to the authority.
    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        agreement::handle_expire(ctx)
    }
}

/// One error enum for the program (Anchor numbers one enum from 6000). The agreement variants come
/// first, in the retired agreement program's order, so their codes and names are unchanged.
#[error_code]
pub enum UgtError {
    #[msg("The agreement is not Active")]
    NotActive,
    #[msg("No decision has been attested for this agreement")]
    NotAttested,
    #[msg("The agreement's deadline has passed")]
    DeadlinePassed,
    #[msg("The agreement's deadline has not passed, or it has none")]
    DeadlineNotPassed,
    #[msg("The escrow holds less than the agreement's required funding")]
    Underfunded,
    #[msg("The attestation was not issued by the agreement's lens")]
    WrongLens,
    #[msg("The account is not a valid SAS attestation or credential, or the credential's authority did not sign it")]
    InvalidAttestation,
    #[msg("Only the agreement's authority may do this")]
    Unauthorized,
    #[msg("The CID is longer than 64 bytes")]
    CidTooLong,
    #[msg("The CID must be 1-64 ASCII letters and digits")]
    InvalidCid,
    #[msg("A lens key is required")]
    NoLens,
    #[msg("The payout must be a real account other than the agreement itself")]
    InvalidPayout,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The account is not the agreement's authority")]
    WrongAuthority,
    #[msg("The account is not the agreement's payout account")]
    WrongPayout,
    #[msg("A decision is already recorded for this agreement")]
    AlreadyAttested,
    #[msg("The lens attested the decision as satisfied: the agreement can no longer be cancelled")]
    DecisionSatisfied,
    #[msg("The attestation has expired")]
    AttestationExpired,
    #[msg("The attestation is not under its credential's AgreementDecision v1 schema")]
    WrongSchema,
    #[msg("The attestation payload does not match the AgreementDecision-v1 layout")]
    InvalidAttestationPayload,
    #[msg("The attestation is about a different agreement")]
    WrongAgreement,
    #[msg("The attested decision must be satisfied")]
    InvalidDecision,
    #[msg("The attestation's source time is in the future")]
    AttestationFromFuture,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrowBalance,
    #[msg("The attestation names a different sponsor than the agreement's authority")]
    WrongSponsor,
    // Parcel anchors
    #[msg("A parcel id must be 1-32 bytes")]
    InvalidParcelId,
    #[msg("A metadata URI must be 1-200 bytes")]
    InvalidMetadataUri,
    #[msg("anchor_parcels takes 1-16 parcel ids, as many metadata URIs, and one writable remaining account per id")]
    InvalidAnchorBatch,
    #[msg("A remaining account is not the writable anchor PDA of its parcel id")]
    WrongParcelAccount,
    // Records
    #[msg("A record kind is 1 (design) or 2 (plan)")]
    InvalidKind,
    #[msg("An asset name must be 1-100 bytes")]
    InvalidName,
    #[msg("An asset URI must be 1-1000 bytes")]
    InvalidUri,
    #[msg("The record's asset account already exists")]
    AssetExists,
    #[msg("The account is not the Metaplex Core program")]
    WrongProgram,
}

/// The last PDA seed of a record or agreement: sha256 over its CID's UTF-8 bytes. A CID (59 bytes
/// for `bafkrei…`) is longer than one 32-byte seed.
pub fn cid_seed(cid: &str) -> [u8; 32] {
    anchor_lang::solana_program::hash::hash(cid.as_bytes()).to_bytes()
}

/// Longest CID a record or agreement can store (a raw sha2-256 CIDv1 in base32 is 59 bytes).
pub const MAX_CID_LEN: usize = 64;

/// 1-64 ASCII letters and digits: every CID multibase this program will see, and nothing that
/// would hash to a second address for the same CID (whitespace, padding, look-alike characters).
pub fn require_valid_cid(cid: &str) -> Result<()> {
    require!(cid.len() <= MAX_CID_LEN, UgtError::CidTooLong);
    require!(
        !cid.is_empty() && cid.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        UgtError::InvalidCid
    );
    Ok(())
}
