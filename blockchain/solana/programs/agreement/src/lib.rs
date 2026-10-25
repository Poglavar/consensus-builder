//! Urban Game Theory Agreement - Solana Program (plan-design-agreement.md, M3)
//!
//! One account per agreement: the chain's commitment to an `agreement/v1` object on IPFS (its CIDv1),
//! naming the lens member whose attestation settles it, a deadline, an escrow and the account the
//! escrow is released to. It replaces proposal_nft's per-proposal consent machinery
//! (simplification 7): no parcels, owner lists, acceptance records, withdrawals or vote variants on
//! chain. Owner decisions are signed documents the approval engine counts off-chain; the
//! agreement's lens attests the outcome, and this program checks that attestation plus the escrow.
//!
//! Lifecycle: create → fund* → attest → execute, or cancel (the authority, while no decision is
//! recorded) or expire (anyone, after the deadline). The lens never refuses: it attests only a
//! satisfied decision, and an agreement whose rule is not satisfied by its deadline expires.
//! Status codes are proposal_nft's ProposalStatus codes (0 Active, 1 Executed, 2 Cancelled,
//! 3 Expired), so market readers keep them.
//! Only the authority funds, and every refund returns to it. (A funder recorded at the first fund
//! would let any stranger pay first and lock the real sponsor out, and the sponsor cannot create
//! the agreement twice: its address is fixed by sponsor and CID.)
//!
//! PDA: ["agreement", authority, sha256(cid as UTF-8)]. The authority is the sponsor that publishes
//! the agreement (agreement/v1 carries its wallet as `sponsor`), so only it can create the account
//! and nobody can squat a CID. A CID (59 bytes for `bafkrei…`) is longer than one 32-byte seed, so
//! its sha256 is the seed. `create` derives the address from its signer and `cid` argument, and
//! every other instruction re-derives it from the stored authority and CID. The lens attestation
//! names both the CID and the sponsor, so it settles only PDA(sponsor, cid): another wallet's
//! account for the same CID can never record that decision.
//!
//! Escrow: the agreement account itself holds the funded lamports on top of its rent
//! (proposal_nft's pattern); `escrow_lamports` counts what `fund` brought in, and only that is paid
//! out: to `payout` at execution, back to the authority (the one wallet that paid) on cancel or
//! expiry.
//!
//! AgreementDecision-v1, the SAS attestation `attest` consumes. The lens member issues it under its
//! own credential, as it issues ParcelOwnership-v1 and ProposalVerdict-v1:
//!   schema name "AgreementDecision", version 1: PDA ["schema", credential, "AgreementDecision", [1]]
//!   layout: string agreementCid, string sponsor, string decision, string evidenceRef,
//!           int64 sourceObservedAt
//!     (SAS layout bytes [12, 12, 12, 12, 8]; borsh: u32 LE length + UTF-8 per string, i64 LE)
//!   agreementCid      the agreement's CID, byte for byte as stored on chain
//!   sponsor           base58 of the agreement's authority (agreement/v1 `sponsor`)
//!   decision          always "satisfied" (anything else is InvalidDecision)
//!   evidenceRef       what the lens counted (e.g. "sha256:<hex>" over the admitted decision receipts)
//!   sourceObservedAt  unix seconds at which the counted decisions gave this outcome
//! Checked here: owned by SAS, discriminator 2, expiry after now, issued under the passed credential,
//! whose authority is the attestation's signer, under that credential's AgreementDecision v1
//! schema PDA; signer == agreement.lens; agreementCid == agreement.cid; sponsor ==
//! agreement.authority; decision == "satisfied"; sourceObservedAt <= now; every payload byte
//! consumed. The first accepted attestation is final. The lens takes `sponsor` from the agreement
//! object, never from whoever asks for the attestation.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use sas_attestation::{PayloadReader, SasError, SAS_PROGRAM_ID};

// Placeholder id, never deployed. Whoever deploys generates the program keypair and replaces it here,
// in Anchor.toml and in frontend/js/solana/agreement-client.js (programs/agreement/README.md, "Program id").
declare_id!("GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ");

pub const AGREEMENT_SEED: &[u8] = b"agreement";
/// Longest CID an agreement can store (a raw sha2-256 CIDv1 in base32 is 59 bytes).
pub const MAX_CID_LEN: usize = 64;
/// `deadline` value meaning "no deadline": the agreement never expires.
pub const NO_DEADLINE: i64 = 0;

/// SAS schema the lens decision is issued under. Each lens member issues under its own credential,
/// so the schema address is PDA(["schema", credential, name, [version]]); the program recomputes it
/// instead of trusting the attestation's schema field.
pub const DECISION_SCHEMA_NAME: &[u8] = b"AgreementDecision";
pub const DECISION_SCHEMA_VERSION: u8 = 1;

#[program]
pub mod agreement {
    use super::*;

    /// Commit an agreement to the chain at PDA ["agreement", authority, sha256(cid)], the signing
    /// authority being its sponsor. `lens` is the lens member key whose AgreementDecision
    /// attestation settles it; `deadline` is unix seconds in the future, or NO_DEADLINE (0);
    /// `open_ground` records that the agreement's land includes open ground (read by indexers, no
    /// effect here); `required_lamports` is the escrow execution needs (0: none); `payout` receives
    /// the whole escrow at execution (the agreement's settlement account).
    pub fn create(
        ctx: Context<Create>,
        cid: String,
        lens: Pubkey,
        deadline: i64,
        open_ground: bool,
        required_lamports: u64,
        payout: Pubkey,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_valid_cid(&cid)?;
        require_keys_neq!(lens, Pubkey::default(), AgreementError::NoLens);
        let agreement_key = ctx.accounts.agreement.key();
        // The default key cannot be written to, and the agreement paying itself would lock the
        // escrow forever.
        require!(
            payout != Pubkey::default() && payout != agreement_key,
            AgreementError::InvalidPayout
        );
        require!(deadline == NO_DEADLINE || deadline > now, AgreementError::DeadlinePassed);

        let authority = ctx.accounts.authority.key();
        let agreement = &mut ctx.accounts.agreement;
        agreement.authority = authority;
        agreement.lens = lens;
        agreement.payout = payout;
        agreement.deadline = deadline;
        agreement.created_at = now;
        agreement.required_lamports = required_lamports;
        agreement.escrow_lamports = 0;
        agreement.status = AgreementStatus::Active;
        agreement.open_ground = open_ground;
        agreement.decision = Decision::Pending;
        agreement.decision_attested_at = 0;
        agreement.decision_observed_at = 0;
        agreement.decision_attestation = Pubkey::default();
        agreement.decision_hash = [0; 32];
        agreement.executed_at = 0;
        agreement.bump = ctx.bumps.agreement;
        agreement.cid = cid;

        emit!(AgreementCreated {
            agreement: agreement_key,
            cid: agreement.cid.clone(),
            authority,
            lens,
            payout,
            deadline,
            required_lamports,
            open_ground,
            created_at: now,
        });
        Ok(())
    }

    /// The authority moves `lamports` into the escrow, while the agreement is Active and before its
    /// deadline (also after the decision, to reach `required_lamports`).
    pub fn fund(ctx: Context<Fund>, lamports: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(lamports > 0, AgreementError::ZeroAmount);
        {
            let agreement = &ctx.accounts.agreement;
            require!(agreement.status == AgreementStatus::Active, AgreementError::NotActive);
            require!(!agreement.deadline_passed(now), AgreementError::DeadlinePassed);
        }

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.agreement.to_account_info(),
                },
            ),
            lamports,
        )?;

        let agreement_key = ctx.accounts.agreement.key();
        let agreement = &mut ctx.accounts.agreement;
        agreement.escrow_lamports = agreement
            .escrow_lamports
            .checked_add(lamports)
            .ok_or(AgreementError::ArithmeticOverflow)?;

        emit!(AgreementFunded {
            agreement: agreement_key,
            cid: agreement.cid.clone(),
            lamports,
            escrow_lamports: agreement.escrow_lamports,
            funded_at: now,
        });
        Ok(())
    }

    /// Record the lens's satisfied decision from its AgreementDecision-v1 SAS attestation (checks in
    /// the module docs). Permissionless: the outcome comes from the attestation, never from the
    /// caller. Only one decision is ever recorded, while Active and before the deadline. Keeps the
    /// attestation's key and the sha256 of its whole account bytes, so the evidence outlives the SAS
    /// account.
    pub fn attest(ctx: Context<Attest>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let accounts = &mut *ctx.accounts;
        let agreement_key = accounts.agreement.key();
        let attestation_key = accounts.attestation.key();
        let agreement = &mut accounts.agreement;
        require!(agreement.status == AgreementStatus::Active, AgreementError::NotActive);
        require!(agreement.decision == Decision::Pending, AgreementError::AlreadyAttested);
        require!(!agreement.deadline_passed(now), AgreementError::DeadlinePassed);

        let data = accounts.attestation.try_borrow_data()?;
        let attestation = verify_attestation(&accounts.attestation, &data, &accounts.credential, now)?;
        require_keys_eq!(attestation.authority, agreement.lens, AgreementError::WrongLens);

        let payload = parse_decision(attestation.payload)?;
        require!(payload.agreement_cid == agreement.cid.as_bytes(), AgreementError::WrongAgreement);
        require_keys_eq!(payload.sponsor, agreement.authority, AgreementError::WrongSponsor);
        require!(payload.source_observed_at <= now, AgreementError::AttestationFromFuture);
        require!(payload.decision == b"satisfied", AgreementError::InvalidDecision);
        let evidence_ref = String::from_utf8(payload.evidence_ref.to_vec())
            .map_err(|_| error!(AgreementError::InvalidAttestationPayload))?;
        let attestation_hash = hash(&data).to_bytes();

        agreement.decision = Decision::Satisfied;
        agreement.decision_attested_at = now;
        agreement.decision_observed_at = payload.source_observed_at;
        agreement.decision_attestation = attestation_key;
        agreement.decision_hash = attestation_hash;

        emit!(AgreementAttested {
            agreement: agreement_key,
            cid: agreement.cid.clone(),
            lens: agreement.lens,
            attestation: attestation_key,
            attestation_hash,
            evidence_ref,
            source_observed_at: payload.source_observed_at,
            attested_at: now,
        });
        Ok(())
    }

    /// Execute a satisfied agreement before its deadline: the escrow must hold `required_lamports`,
    /// and all of it goes to `payout`. Permissionless: the payout is fixed at create. Its
    /// AgreementExecuted is the one event the backend writes parcel history from.
    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let agreement_key = ctx.accounts.agreement.key();
        let (amount, event) = {
            let agreement = &mut ctx.accounts.agreement;
            require!(agreement.status == AgreementStatus::Active, AgreementError::NotActive);
            require!(agreement.decision == Decision::Satisfied, AgreementError::NotAttested);
            require!(!agreement.deadline_passed(now), AgreementError::DeadlinePassed);
            require!(
                agreement.escrow_lamports >= agreement.required_lamports,
                AgreementError::Underfunded
            );

            let amount = agreement.escrow_lamports;
            agreement.escrow_lamports = 0;
            agreement.status = AgreementStatus::Executed;
            agreement.executed_at = now;
            let event = AgreementExecuted {
                agreement: agreement_key,
                cid: agreement.cid.clone(),
                payout: agreement.payout,
                lamports: amount,
                lens: agreement.lens,
                decision_attestation: agreement.decision_attestation,
                executed_at: now,
            };
            (amount, event)
        };

        transfer_program_lamports(
            &ctx.accounts.agreement.to_account_info(),
            &ctx.accounts.payout.to_account_info(),
            amount,
        )?;
        emit!(event);
        Ok(())
    }

    /// The authority withdraws an Active agreement while no decision is recorded, and the escrow
    /// returns to it. Once the lens's satisfied decision is recorded the parties rely on the escrow:
    /// the agreement then executes, or expires after its deadline.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let agreement_key = ctx.accounts.agreement.key();
        let (amount, cid) = {
            let agreement = &mut ctx.accounts.agreement;
            require!(agreement.status == AgreementStatus::Active, AgreementError::NotActive);
            require!(agreement.decision == Decision::Pending, AgreementError::DecisionSatisfied);
            let amount = agreement.escrow_lamports;
            agreement.escrow_lamports = 0;
            agreement.status = AgreementStatus::Cancelled;
            (amount, agreement.cid.clone())
        };

        transfer_program_lamports(
            &ctx.accounts.agreement.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
            amount,
        )?;
        emit!(AgreementCancelled {
            agreement: agreement_key,
            cid,
            refunded_lamports: amount,
            cancelled_at: now,
        });
        Ok(())
    }

    /// Anyone expires an Active agreement whose deadline has passed (an agreement without a
    /// deadline never expires); the escrow returns to the authority.
    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let agreement_key = ctx.accounts.agreement.key();
        let (amount, cid) = {
            let agreement = &mut ctx.accounts.agreement;
            require!(agreement.status == AgreementStatus::Active, AgreementError::NotActive);
            require!(agreement.deadline_passed(now), AgreementError::DeadlineNotPassed);
            let amount = agreement.escrow_lamports;
            agreement.escrow_lamports = 0;
            agreement.status = AgreementStatus::Expired;
            (amount, agreement.cid.clone())
        };

        transfer_program_lamports(
            &ctx.accounts.agreement.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
            amount,
        )?;
        emit!(AgreementExpired {
            agreement: agreement_key,
            cid,
            refunded_lamports: amount,
            expired_at: now,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(cid: String)]
pub struct Create<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Agreement::INIT_SPACE,
        seeds = [AGREEMENT_SEED, authority.key().as_ref(), &cid_seed(&cid)],
        bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// The sponsor: part of the address, pays the rent, the only key that may fund or cancel, and
    /// the one every refund returns to.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(
        mut,
        has_one = authority @ AgreementError::Unauthorized,
        seeds = [AGREEMENT_SEED, agreement.authority.as_ref(), &cid_seed(&agreement.cid)],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// Pays the lamports in.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    #[account(
        mut,
        seeds = [AGREEMENT_SEED, agreement.authority.as_ref(), &cid_seed(&agreement.cid)],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// CHECK: SAS AgreementDecision-v1 attestation; owner, layout, credential, schema, expiry,
    /// issuer and payload are checked in the handler.
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: SAS credential the attestation was issued under; owner, layout and authority are
    /// checked in the handler.
    pub credential: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        mut,
        seeds = [AGREEMENT_SEED, agreement.authority.as_ref(), &cid_seed(&agreement.cid)],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// CHECK: receives the escrow; must be the payout recorded at create.
    #[account(mut, address = agreement.payout @ AgreementError::WrongPayout)]
    pub payout: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(
        mut,
        has_one = authority @ AgreementError::Unauthorized,
        seeds = [AGREEMENT_SEED, agreement.authority.as_ref(), &cid_seed(&agreement.cid)],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// Signs the cancellation and receives the refund.
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(
        mut,
        has_one = authority @ AgreementError::WrongAuthority,
        seeds = [AGREEMENT_SEED, agreement.authority.as_ref(), &cid_seed(&agreement.cid)],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// CHECK: receives the refund; must be the agreement's authority (has_one). Need not sign.
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,
}

/// One agreement: PDA ["agreement", authority, sha256(cid)]. Every fixed-size field comes before
/// `cid`, so their offsets are the same in every account (README, "Agreement account") and memcmp
/// filters on authority, lens or status work.
#[account]
#[derive(InitSpace)]
pub struct Agreement {
    /// The sponsor (part of the address): pays the rent, is the only key that may fund or cancel,
    /// receives refunds.
    pub authority: Pubkey,
    /// The lens member key whose AgreementDecision attestation settles the agreement.
    pub lens: Pubkey,
    /// Receives the whole escrow at execution.
    pub payout: Pubkey,
    /// Unix seconds; NO_DEADLINE (0) for none.
    pub deadline: i64,
    pub created_at: i64,
    /// Escrow execution needs (0: none).
    pub required_lamports: u64,
    /// Lamports brought in by `fund` and not yet paid out or refunded.
    pub escrow_lamports: u64,
    pub status: AgreementStatus,
    /// The agreement's land includes open ground (recorded for readers; no effect on execution).
    pub open_ground: bool,
    pub decision: Decision,
    /// Chain time the decision was recorded (0 while Pending).
    pub decision_attested_at: i64,
    /// The attestation's sourceObservedAt (0 while Pending).
    pub decision_observed_at: i64,
    /// The AgreementDecision attestation that was recorded (default key while Pending).
    pub decision_attestation: Pubkey,
    /// sha256 of that attestation's whole account bytes.
    pub decision_hash: [u8; 32],
    /// Chain time of execution (0 unless Executed).
    pub executed_at: i64,
    pub bump: u8,
    /// The agreement's CIDv1 (`bafkrei…`), the IPFS object this account commits to.
    #[max_len(MAX_CID_LEN)]
    pub cid: String,
}

impl Agreement {
    pub fn deadline_passed(&self, now: i64) -> bool {
        self.deadline != NO_DEADLINE && now > self.deadline
    }
}

/// Byte offset of `lens` in an Agreement account: the discriminator (8), then `authority` (32).
pub const LENS_OFFSET: usize = 8 + 32;
/// Byte offset of `status` (136): the discriminator (8), `authority`, `lens` and `payout`
/// (3 × 32), then `deadline`, `created_at`, `required_lamports` and `escrow_lamports` (4 × 8).
pub const STATUS_OFFSET: usize = 8 + 3 * 32 + 4 * 8;
/// Byte offset of `executed_at`, following the status and decision fields in the fixed header.
pub const EXECUTED_AT_OFFSET: usize = STATUS_OFFSET + 1 + 1 + 1 + 8 + 8 + 32 + 32;

/// What proposal_market and proposal_pledge read of an Agreement account, without deserializing
/// it (they depend on this crate with `no-entrypoint`, so the id and layout live only here).
pub struct AgreementView {
    /// The sponsor.
    pub authority: Pubkey,
    pub lens: Pubkey,
    /// AgreementStatus code: 0 Active, 1 Executed, 2 Cancelled, 3 Expired.
    pub status: u8,
    /// Chain time of execution (0 unless Executed).
    pub executed_at: i64,
}

/// `account` read as an Agreement of this program: owner, discriminator and length are checked.
/// None when it is any other account.
pub fn read_agreement_view(account: &AccountInfo) -> Option<AgreementView> {
    if *account.owner != crate::ID {
        return None;
    }
    let data = account.try_borrow_data().ok()?;
    if data.len() < EXECUTED_AT_OFFSET + 8 || data[..8] != Agreement::DISCRIMINATOR {
        return None;
    }
    let key_at = |offset: usize| -> Option<Pubkey> {
        let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
        Some(Pubkey::new_from_array(bytes))
    };
    Some(AgreementView {
        authority: key_at(8)?,
        lens: key_at(LENS_OFFSET)?,
        status: data[STATUS_OFFSET],
        executed_at: i64::from_le_bytes(data.get(EXECUTED_AT_OFFSET..EXECUTED_AT_OFFSET + 8)?.try_into().ok()?),
    })
}

/// Same codes as proposal_nft's ProposalStatus.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum AgreementStatus {
    Active = 0,
    Executed = 1,
    Cancelled = 2,
    Expired = 3,
}

/// The lens's recorded decision; Pending until `attest`. The lens never refuses, so there is no
/// other value: an agreement whose rule is not satisfied by its deadline expires.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Decision {
    Pending = 0,
    Satisfied = 1,
}

#[event]
pub struct AgreementCreated {
    pub agreement: Pubkey,
    pub cid: String,
    pub authority: Pubkey,
    pub lens: Pubkey,
    pub payout: Pubkey,
    pub deadline: i64,
    pub required_lamports: u64,
    pub open_ground: bool,
    pub created_at: i64,
}

#[event]
pub struct AgreementFunded {
    pub agreement: Pubkey,
    pub cid: String,
    pub lamports: u64,
    /// The escrow after this fund.
    pub escrow_lamports: u64,
    pub funded_at: i64,
}

#[event]
pub struct AgreementAttested {
    pub agreement: Pubkey,
    pub cid: String,
    pub lens: Pubkey,
    pub attestation: Pubkey,
    /// sha256 of the attestation's whole account bytes.
    pub attestation_hash: [u8; 32],
    pub evidence_ref: String,
    pub source_observed_at: i64,
    pub attested_at: i64,
}

#[event]
pub struct AgreementExecuted {
    pub agreement: Pubkey,
    pub cid: String,
    pub payout: Pubkey,
    /// The escrow released to `payout`.
    pub lamports: u64,
    pub lens: Pubkey,
    pub decision_attestation: Pubkey,
    pub executed_at: i64,
}

#[event]
pub struct AgreementCancelled {
    pub agreement: Pubkey,
    pub cid: String,
    /// Returned to the authority.
    pub refunded_lamports: u64,
    pub cancelled_at: i64,
}

#[event]
pub struct AgreementExpired {
    pub agreement: Pubkey,
    pub cid: String,
    /// Returned to the authority.
    pub refunded_lamports: u64,
    pub expired_at: i64,
}

#[error_code]
pub enum AgreementError {
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
}

/// The last PDA seed of an agreement: sha256 over its CID's UTF-8 bytes.
pub fn cid_seed(cid: &str) -> [u8; 32] {
    hash(cid.as_bytes()).to_bytes()
}

/// 1-64 ASCII letters and digits: every CID multibase this program will see, and nothing that
/// would hash to a second address for the same CID (whitespace, padding, look-alike characters).
fn require_valid_cid(cid: &str) -> Result<()> {
    require!(cid.len() <= MAX_CID_LEN, AgreementError::CidTooLong);
    require!(
        !cid.is_empty() && cid.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        AgreementError::InvalidCid
    );
    Ok(())
}

fn sas_error(error: SasError) -> Error {
    match error {
        SasError::InvalidPayload => error!(AgreementError::InvalidAttestationPayload),
        SasError::InvalidAccount | SasError::WrongCredential | SasError::SchemaPaused => {
            error!(AgreementError::InvalidAttestation)
        }
    }
}

/// proposal_nft's attestation checks under the AgreementDecision schema: SAS-owned, discriminator 2,
/// not expired (expiry strictly after now), issued under `credential`, whose authority is the
/// attestation's signer, under this credential's AgreementDecision v1 schema PDA.
fn verify_attestation<'a>(
    attestation_account: &AccountInfo,
    data: &'a [u8],
    credential: &AccountInfo,
    now: i64,
) -> Result<sas_attestation::Attestation<'a>> {
    require_keys_eq!(*attestation_account.owner, SAS_PROGRAM_ID, AgreementError::InvalidAttestation);
    let attestation = sas_attestation::parse_attestation(data).map_err(sas_error)?;
    require!(attestation.expiry > now, AgreementError::AttestationExpired);
    require_keys_eq!(attestation.credential, credential.key(), AgreementError::InvalidAttestation);
    require_keys_eq!(*credential.owner, SAS_PROGRAM_ID, AgreementError::InvalidAttestation);
    let credential_authority = {
        let credential_data = credential.try_borrow_data()?;
        sas_attestation::parse_credential_authority(&credential_data).map_err(sas_error)?
    };
    require_keys_eq!(credential_authority, attestation.authority, AgreementError::InvalidAttestation);
    require_keys_eq!(
        attestation.schema,
        sas_attestation::schema_address(&credential.key(), DECISION_SCHEMA_NAME, DECISION_SCHEMA_VERSION),
        AgreementError::WrongSchema
    );
    Ok(attestation)
}

/// AgreementDecision-v1: string agreementCid, string sponsor, string decision, string evidenceRef,
/// int64 sourceObservedAt. `sponsor` must be a base58 public key (else InvalidAttestationPayload).
struct DecisionPayload<'a> {
    agreement_cid: &'a [u8],
    sponsor: Pubkey,
    decision: &'a [u8],
    evidence_ref: &'a [u8],
    source_observed_at: i64,
}

fn parse_decision(payload: &[u8]) -> Result<DecisionPayload<'_>> {
    let mut reader = PayloadReader::new(payload);
    let agreement_cid = reader.string().map_err(sas_error)?;
    let sponsor =
        sas_attestation::parse_pubkey_string(reader.string().map_err(sas_error)?).map_err(sas_error)?;
    let decision = reader.string().map_err(sas_error)?;
    let evidence_ref = reader.string().map_err(sas_error)?;
    let source_observed_at = reader.i64().map_err(sas_error)?;
    reader.finish().map_err(sas_error)?;
    Ok(DecisionPayload { agreement_cid, sponsor, decision, evidence_ref, source_observed_at })
}

/// Move lamports out of an account this program owns (the escrow above the agreement's rent).
fn transfer_program_lamports<'from, 'to>(
    from: &AccountInfo<'from>,
    to: &AccountInfo<'to>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let from_lamports = from.lamports();
    require!(from_lamports >= amount, AgreementError::InsufficientEscrowBalance);
    let to_lamports = to.lamports();

    **from.try_borrow_mut_lamports()? = from_lamports
        .checked_sub(amount)
        .ok_or(AgreementError::ArithmeticOverflow)?;
    **to.try_borrow_mut_lamports()? = to_lamports
        .checked_add(amount)
        .ok_or(AgreementError::ArithmeticOverflow)?;

    Ok(())
}

#[cfg(test)]
mod agreement_view_tests {
    use super::*;

    fn read_view(data: &mut [u8], owner: &Pubkey) -> Option<AgreementView> {
        let key = Pubkey::new_unique();
        let mut lamports = 1;
        let account = AccountInfo::new(&key, false, false, &mut lamports, data, owner, false, 0);
        read_agreement_view(&account)
    }

    #[test]
    fn agreement_view_reads_executed_at_at_its_fixed_offset() {
        let agreement = Agreement {
            authority: Pubkey::new_from_array([0x11; 32]),
            lens: Pubkey::new_from_array([0x22; 32]),
            payout: Pubkey::new_from_array([0x33; 32]),
            deadline: 101,
            created_at: 102,
            required_lamports: 103,
            escrow_lamports: 104,
            status: AgreementStatus::Executed,
            open_ground: true,
            decision: Decision::Satisfied,
            decision_attested_at: 105,
            decision_observed_at: 106,
            decision_attestation: Pubkey::new_from_array([0x44; 32]),
            decision_hash: [0x55; 32],
            executed_at: 1234,
            bump: 7,
            cid: "bafkreiabc".to_owned(),
        };
        let mut data = Vec::new();
        agreement.try_serialize(&mut data).unwrap();

        let view = read_view(&mut data, &crate::ID).unwrap();
        assert_eq!(view.authority, agreement.authority);
        assert_eq!(view.lens, agreement.lens);
        assert_eq!(view.status, AgreementStatus::Executed as u8);
        assert_eq!(view.executed_at, agreement.executed_at);
    }

    #[test]
    fn agreement_view_rejects_missing_execution_timestamp_bytes() {
        let agreement = Agreement {
            authority: Pubkey::default(),
            lens: Pubkey::default(),
            payout: Pubkey::default(),
            deadline: 0,
            created_at: 0,
            required_lamports: 0,
            escrow_lamports: 0,
            status: AgreementStatus::Active,
            open_ground: false,
            decision: Decision::Pending,
            decision_attested_at: 0,
            decision_observed_at: 0,
            decision_attestation: Pubkey::default(),
            decision_hash: [0; 32],
            executed_at: 0,
            bump: 0,
            cid: String::new(),
        };
        let mut data = Vec::new();
        agreement.try_serialize(&mut data).unwrap();
        data.truncate(EXECUTED_AT_OFFSET + 7);
        assert!(read_view(&mut data, &crate::ID).is_none());
    }

    #[test]
    fn agreement_view_rejects_wrong_owner_and_discriminator() {
        let agreement = Agreement {
            authority: Pubkey::default(),
            lens: Pubkey::default(),
            payout: Pubkey::default(),
            deadline: 0,
            created_at: 0,
            required_lamports: 0,
            escrow_lamports: 0,
            status: AgreementStatus::Active,
            open_ground: false,
            decision: Decision::Pending,
            decision_attested_at: 0,
            decision_observed_at: 0,
            decision_attestation: Pubkey::default(),
            decision_hash: [0; 32],
            executed_at: 0,
            bump: 0,
            cid: String::new(),
        };
        let mut data = Vec::new();
        agreement.try_serialize(&mut data).unwrap();
        assert!(read_view(&mut data, &Pubkey::new_unique()).is_none());

        data[0] ^= 0xff;
        assert!(read_view(&mut data, &crate::ID).is_none());
    }
}
