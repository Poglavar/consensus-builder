//! Urban Game Theory Agreement - Solana Program (plan-design-agreement.md, M3)
//!
//! One account per agreement: the chain's commitment to an `agreement/v1` object on IPFS (its CIDv1),
//! naming its lens (1-8 member keys and how many of them must confirm), an optional contribution
//! target, a deadline, an escrow and the account the escrow is released to. It replaces
//! proposal_nft's per-proposal consent machinery (simplification 7): no parcels, owner lists,
//! acceptance records, withdrawals or vote variants on chain. Owner decisions are signed documents
//! the approval engine counts off-chain; the agreement's lens members attest the outcome, and this
//! program checks those attestations plus the escrow.
//!
//! Settlement conditions, both frozen at create:
//!   lens     `lens_threshold` distinct members of the lens each record an AgreementDecision
//!            (`attest`, once per member). Threshold 1 is "any one of the listed keys".
//!   funding  the agreement's proposal_pledge donation escrow holds credited contributions (donated
//!            less refunded) of at least `required_funding` in `funding_mint`, and its vault backs
//!            them (`confirm_funding`, permissionless: the program reads the escrow itself, so no
//!            lens is needed for "the money arrived"). An agreement may have a target and no lens.
//! The decision becomes Satisfied in the instruction that completes the last condition.
//!
//! Lifecycle: create → fund* → attest* / confirm_funding → execute, or cancel (the authority,
//! while the decision is Pending) or expire (anyone, after the deadline). The lens never refuses:
//! members attest only a satisfied decision, and an agreement whose conditions are not met by its
//! deadline expires.
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
//! schema PDA; signer is a lens member whose confirmation is not yet recorded; agreementCid ==
//! agreement.cid; sponsor == agreement.authority; decision == "satisfied"; sourceObservedAt <= now;
//! every payload byte consumed. Each member counts once, and a recorded confirmation is final. The
//! lens takes `sponsor` from the agreement object, never from whoever asks for the attestation.
//! Any key may be a member, the sponsor's own included: the people who enter an agreement judge its
//! lens.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use sas_attestation::{PayloadReader, SasError, SAS_PROGRAM_ID};

// Placeholder id, never deployed. Whoever deploys generates the program keypair and replaces it here,
// in Anchor.toml and in frontend/js/solana/agreement-client.js (programs/agreement/README.md, "Program id").
declare_id!("ESJ1w3rpzXtUXcZFgRfzHYRBzcrT7HeCychLNXvdBeYH");

pub const AGREEMENT_SEED: &[u8] = b"agreement";
/// Longest CID an agreement can store (a raw sha2-256 CIDv1 in base32 is 59 bytes).
pub const MAX_CID_LEN: usize = 64;
/// `deadline` value meaning "no deadline": such an agreement never expires. `create` refuses it, so
/// only accounts created before the deadline became mandatory carry it; readers still honour it.
pub const NO_DEADLINE: i64 = 0;

/// SAS schema the lens decision is issued under. Each lens member issues under its own credential,
/// so the schema address is PDA(["schema", credential, name, [version]]); the program recomputes it
/// instead of trusting the attestation's schema field.
pub const DECISION_SCHEMA_NAME: &[u8] = b"AgreementDecision";
pub const DECISION_SCHEMA_VERSION: u8 = 1;

/// Most lens members an agreement can name (one confirmation bit each in `lens_confirmed`).
pub const MAX_LENSES: usize = 8;
/// Lens members after the first (`more_lenses` slots).
pub const MORE_LENSES: usize = MAX_LENSES - 1;

/// proposal_pledge, whose donation escrow `confirm_funding` reads. That program depends on this
/// crate, so its id and the escrow layout are restated here; proposal_pledge's tests assert they
/// match its own (proposal_pledge::tests).
pub const PLEDGE_PROGRAM_ID: Pubkey = pubkey!("5RvXB53atCdCkDEydpvgUDz4Ph6uFUVyMgpjdSzNwXAq");
pub const DONATION_ESCROW_SEED: &[u8] = b"donation_escrow";
/// DonationEscrow: discriminator, then proposal, beneficiary, mint, vault (4 × 32), then
/// total_donated, total_released, total_refunded, donation_count, donor_count (5 × u64), released.
pub const ESCROW_PROPOSAL_OFFSET: usize = 8;
pub const ESCROW_MINT_OFFSET: usize = 8 + 2 * 32;
pub const ESCROW_VAULT_OFFSET: usize = 8 + 3 * 32;
pub const ESCROW_TOTAL_DONATED_OFFSET: usize = 8 + 4 * 32;
pub const ESCROW_TOTAL_REFUNDED_OFFSET: usize = ESCROW_TOTAL_DONATED_OFFSET + 2 * 8;
pub const ESCROW_RELEASED_OFFSET: usize = ESCROW_TOTAL_DONATED_OFFSET + 5 * 8;
/// The SPL Token program, owner of the escrow's vault (a 165-byte token account: mint, owner,
/// amount at 0, 32, 64; state at 108, 1 = Initialized).
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_ACCOUNT_LEN: usize = 165;

#[program]
pub mod agreement {
    use super::*;

    /// Commit an agreement to the chain at PDA ["agreement", authority, sha256(cid)], the signing
    /// authority being its sponsor. `lenses` are the 0-8 distinct member keys whose
    /// AgreementDecision attestations settle it, and `lens_threshold` how many of them must confirm
    /// (1..=members; 0 with no members). No members is allowed only with a contribution target.
    /// `deadline` is unix seconds in the future (mandatory: an agreement that can never expire
    /// would lock its escrow and any market on it once a decision is recorded); `open_ground`
    /// records that the agreement's land includes open ground (read by indexers, no effect here);
    /// `required_lamports` is the escrow execution needs (0: none); `payout` receives the whole
    /// escrow at execution (the agreement's settlement account); `required_funding` is the credited
    /// proposal_pledge contributions in `funding_mint` the agreement needs (0: none, and then the
    /// mint is the default key).
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        ctx: Context<Create>,
        cid: String,
        lenses: Vec<Pubkey>,
        lens_threshold: u8,
        deadline: i64,
        open_ground: bool,
        required_lamports: u64,
        payout: Pubkey,
        funding_mint: Pubkey,
        required_funding: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_valid_cid(&cid)?;
        require_valid_lens(&lenses, lens_threshold, required_funding)?;
        require!(
            (required_funding == 0) == (funding_mint == Pubkey::default()),
            AgreementError::InvalidFundingTarget
        );
        let agreement_key = ctx.accounts.agreement.key();
        // The default key cannot be written to, and the agreement paying itself would lock the
        // escrow forever.
        require!(
            payout != Pubkey::default() && payout != agreement_key,
            AgreementError::InvalidPayout
        );
        require!(deadline > now, AgreementError::DeadlinePassed);

        let authority = ctx.accounts.authority.key();
        let agreement = &mut ctx.accounts.agreement;
        agreement.authority = authority;
        agreement.lens = lenses.first().copied().unwrap_or_default();
        agreement.lens_count = lenses.len() as u8;
        agreement.lens_threshold = lens_threshold;
        agreement.lens_confirmed = 0;
        agreement.more_lenses = [Pubkey::default(); MORE_LENSES];
        for (slot, member) in agreement.more_lenses.iter_mut().zip(lenses.iter().skip(1)) {
            *slot = *member;
        }
        agreement.funding_mint = funding_mint;
        agreement.required_funding = required_funding;
        agreement.funding_met = false;
        agreement.funding_observed = 0;
        agreement.funding_met_at = 0;
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
            lenses,
            lens_threshold,
            payout,
            deadline,
            required_lamports,
            funding_mint,
            required_funding,
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

    /// Record one lens member's satisfied decision from its AgreementDecision-v1 SAS attestation
    /// (checks in the module docs). Permissionless: the outcome comes from the attestation, never
    /// from the caller. Each member is counted once, while Active, Pending and before the deadline.
    /// The confirmation that reaches the threshold is kept as the decision's evidence (its key and
    /// the sha256 of its whole account bytes, so the evidence outlives the SAS account); the
    /// decision becomes Satisfied once any contribution target is also confirmed.
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
        let member = agreement.member_index(&attestation.authority).ok_or(AgreementError::WrongLens)?;
        // The lens is already met and only the contribution target is outstanding.
        require!(!agreement.lens_met(), AgreementError::LensAlreadyConfirmed);
        let bit = 1u8 << member;
        require!(agreement.lens_confirmed & bit == 0, AgreementError::MemberAlreadyConfirmed);

        let payload = parse_decision(attestation.payload)?;
        require!(payload.agreement_cid == agreement.cid.as_bytes(), AgreementError::WrongAgreement);
        require_keys_eq!(payload.sponsor, agreement.authority, AgreementError::WrongSponsor);
        require!(payload.source_observed_at <= now, AgreementError::AttestationFromFuture);
        require!(payload.decision == b"satisfied", AgreementError::InvalidDecision);
        let evidence_ref = String::from_utf8(payload.evidence_ref.to_vec())
            .map_err(|_| error!(AgreementError::InvalidAttestationPayload))?;
        let attestation_hash = hash(&data).to_bytes();

        agreement.lens_confirmed |= bit;
        if agreement.lens_met() {
            agreement.decision_observed_at = payload.source_observed_at;
            agreement.decision_attestation = attestation_key;
            agreement.decision_hash = attestation_hash;
        }
        let satisfied = agreement.settle_if_ready(now);

        emit!(AgreementAttested {
            agreement: agreement_key,
            cid: agreement.cid.clone(),
            lens: attestation.authority,
            attestation: attestation_key,
            attestation_hash,
            evidence_ref,
            source_observed_at: payload.source_observed_at,
            confirmations: agreement.lens_confirmed.count_ones() as u8,
            lens_threshold: agreement.lens_threshold,
            satisfied,
            attested_at: now,
        });
        Ok(())
    }

    /// Confirm the contribution target from the agreement's own proposal_pledge donation escrow:
    /// credited contributions (donated less refunded) reach `required_funding` in `funding_mint`,
    /// and the escrow's vault holds at least that much. Permissionless and read-only towards the
    /// escrow; recorded once, while Active, Pending and before the deadline. Contributions cannot be
    /// refunded while the agreement is Active, so a confirmed target stays met.
    pub fn confirm_funding(ctx: Context<ConfirmFunding>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let agreement_key = ctx.accounts.agreement.key();
        let escrow_key = ctx.accounts.escrow.key();
        let (credited, vault_amount) = {
            let agreement = &ctx.accounts.agreement;
            require!(agreement.status == AgreementStatus::Active, AgreementError::NotActive);
            require!(agreement.decision == Decision::Pending, AgreementError::AlreadyAttested);
            require!(!agreement.deadline_passed(now), AgreementError::DeadlinePassed);
            require!(agreement.required_funding > 0, AgreementError::NoFundingTarget);
            require!(!agreement.funding_met, AgreementError::FundingAlreadyConfirmed);
            read_funding(
                &agreement_key,
                &agreement.funding_mint,
                &ctx.accounts.escrow,
                &ctx.accounts.vault,
            )?
        };
        let agreement = &mut ctx.accounts.agreement;
        require!(credited >= agreement.required_funding, AgreementError::FundingTargetNotMet);
        agreement.funding_met = true;
        agreement.funding_observed = credited;
        agreement.funding_met_at = now;
        let satisfied = agreement.settle_if_ready(now);

        emit!(AgreementFundingConfirmed {
            agreement: agreement_key,
            cid: agreement.cid.clone(),
            escrow: escrow_key,
            funding_mint: agreement.funding_mint,
            required_funding: agreement.required_funding,
            credited,
            vault_amount,
            satisfied,
            confirmed_at: now,
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

    /// Anyone expires an Active agreement whose deadline has passed (a legacy account without a
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
pub struct ConfirmFunding<'info> {
    #[account(
        mut,
        seeds = [AGREEMENT_SEED, agreement.authority.as_ref(), &cid_seed(&agreement.cid)],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,

    /// CHECK: proposal_pledge DonationEscrow at PDA ["donation_escrow", agreement]; owner, address,
    /// discriminator and fields are checked in read_funding.
    pub escrow: UncheckedAccount<'info>,

    /// CHECK: the escrow's token vault; owner, address, mint, owner field and state are checked in
    /// read_funding.
    pub vault: UncheckedAccount<'info>,
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
/// filters on authority, the first lens member or status work. The header up to `bump` keeps the
/// offsets proposal_market and proposal_pledge read.
#[account]
#[derive(InitSpace)]
pub struct Agreement {
    /// The sponsor (part of the address): pays the rent, is the only key that may fund or cancel,
    /// receives refunds.
    pub authority: Pubkey,
    /// The first lens member (the default key when the agreement has no lens); the others are in
    /// `more_lenses`.
    pub lens: Pubkey,
    /// Receives the whole escrow at execution.
    pub payout: Pubkey,
    /// Unix seconds; always in the future at create. NO_DEADLINE (0) only on accounts created
    /// before the deadline became mandatory.
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
    /// Lens members (0-8): `lens`, then the first `lens_count - 1` entries of `more_lenses`.
    pub lens_count: u8,
    /// How many distinct members must confirm (1..=lens_count; 0 with no lens).
    pub lens_threshold: u8,
    /// Bit i set once member i (0 = `lens`, i = `more_lenses[i - 1]`) has confirmed.
    pub lens_confirmed: u8,
    /// Lens members after the first; unused slots hold the default key.
    pub more_lenses: [Pubkey; MORE_LENSES],
    /// Token mint of the contribution target (the default key when there is none).
    pub funding_mint: Pubkey,
    /// Credited proposal_pledge contributions, in `funding_mint` base units, the agreement needs
    /// (0: no target).
    pub required_funding: u64,
    /// `confirm_funding` found the target met.
    pub funding_met: bool,
    /// Credited contributions it observed (0 until confirmed).
    pub funding_observed: u64,
    /// Chain time of that confirmation (0 until confirmed).
    pub funding_met_at: i64,
    /// The agreement's CIDv1 (`bafkrei…`), the IPFS object this account commits to.
    #[max_len(MAX_CID_LEN)]
    pub cid: String,
}

impl Agreement {
    pub fn deadline_passed(&self, now: i64) -> bool {
        self.deadline != NO_DEADLINE && now > self.deadline
    }

    /// The member keys, in order.
    pub fn lens_members(&self) -> impl Iterator<Item = &Pubkey> {
        std::iter::once(&self.lens)
            .chain(self.more_lenses.iter())
            .take(self.lens_count as usize)
    }

    /// Index of `key` among the members.
    pub fn member_index(&self, key: &Pubkey) -> Option<usize> {
        self.lens_members().position(|member| member == key)
    }

    /// Enough distinct members have confirmed (always true with no lens).
    pub fn lens_met(&self) -> bool {
        self.lens_confirmed.count_ones() >= u32::from(self.lens_threshold)
    }

    /// Mark the decision Satisfied once the lens and any contribution target are both met.
    /// Returns whether the decision is now Satisfied.
    fn settle_if_ready(&mut self, now: i64) -> bool {
        if self.lens_met() && (self.required_funding == 0 || self.funding_met) {
            self.decision = Decision::Satisfied;
            self.decision_attested_at = now;
            if self.lens_count == 0 {
                self.decision_observed_at = now;
            }
            return true;
        }
        false
    }
}

/// Byte offset of `lens` in an Agreement account: the discriminator (8), then `authority` (32).
pub const LENS_OFFSET: usize = 8 + 32;
/// Byte offset of `status` (136): the discriminator (8), `authority`, `lens` and `payout`
/// (3 × 32), then `deadline`, `created_at`, `required_lamports` and `escrow_lamports` (4 × 8).
pub const STATUS_OFFSET: usize = 8 + 3 * 32 + 4 * 8;
/// Byte offset of `executed_at`, following the status and decision fields in the fixed header.
pub const EXECUTED_AT_OFFSET: usize = STATUS_OFFSET + 1 + 1 + 1 + 8 + 8 + 32 + 32;
/// Byte offsets of the lens set, after `executed_at` and `bump`.
pub const LENS_COUNT_OFFSET: usize = EXECUTED_AT_OFFSET + 8 + 1;
pub const LENS_THRESHOLD_OFFSET: usize = LENS_COUNT_OFFSET + 1;
pub const LENS_CONFIRMED_OFFSET: usize = LENS_THRESHOLD_OFFSET + 1;
pub const MORE_LENSES_OFFSET: usize = LENS_CONFIRMED_OFFSET + 1;
/// End of the lens set: the view reads nothing past it.
pub const LENS_SET_END: usize = MORE_LENSES_OFFSET + MORE_LENSES * 32;

/// What proposal_market and proposal_pledge read of an Agreement account, without deserializing
/// it (they depend on this crate with `no-entrypoint`, so the id and layout live only here).
pub struct AgreementView {
    /// The sponsor.
    pub authority: Pubkey,
    /// The first lens member (default with no lens).
    pub lens: Pubkey,
    /// All lens members, `lens_count` of them used.
    pub lenses: [Pubkey; MAX_LENSES],
    pub lens_count: u8,
    /// AgreementStatus code: 0 Active, 1 Executed, 2 Cancelled, 3 Expired.
    pub status: u8,
    pub deadline: i64,
    /// Chain time of execution (0 unless Executed).
    pub executed_at: i64,
}

impl AgreementView {
    /// The member keys, in order.
    pub fn lens_members(&self) -> &[Pubkey] {
        &self.lenses[..(self.lens_count as usize).min(MAX_LENSES)]
    }

    /// `key` is one of the agreement's lens members.
    pub fn is_lens(&self, key: &Pubkey) -> bool {
        self.lens_members().contains(key)
    }
}

/// `account` read as an Agreement of this program: owner, discriminator and length are checked.
/// None when it is any other account.
pub fn read_agreement_view(account: &AccountInfo) -> Option<AgreementView> {
    if *account.owner != crate::ID {
        return None;
    }
    let data = account.try_borrow_data().ok()?;
    if data.len() < LENS_SET_END || data[..8] != Agreement::DISCRIMINATOR {
        return None;
    }
    let key_at = |offset: usize| -> Option<Pubkey> {
        let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
        Some(Pubkey::new_from_array(bytes))
    };
    let lens_count = data[LENS_COUNT_OFFSET];
    if lens_count as usize > MAX_LENSES {
        return None;
    }
    let mut lenses = [Pubkey::default(); MAX_LENSES];
    lenses[0] = key_at(LENS_OFFSET)?;
    for (index, slot) in lenses.iter_mut().enumerate().skip(1) {
        *slot = key_at(MORE_LENSES_OFFSET + (index - 1) * 32)?;
    }
    Some(AgreementView {
        authority: key_at(8)?,
        lens: lenses[0],
        lenses,
        lens_count,
        deadline: i64::from_le_bytes(data.get(8 + 3 * 32..8 + 3 * 32 + 8)?.try_into().ok()?),
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
    pub lenses: Vec<Pubkey>,
    pub lens_threshold: u8,
    pub payout: Pubkey,
    pub deadline: i64,
    pub required_lamports: u64,
    pub funding_mint: Pubkey,
    pub required_funding: u64,
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
    /// The member that confirmed.
    pub lens: Pubkey,
    pub attestation: Pubkey,
    /// sha256 of the attestation's whole account bytes.
    pub attestation_hash: [u8; 32],
    pub evidence_ref: String,
    pub source_observed_at: i64,
    /// Distinct members confirmed so far, and how many are needed.
    pub confirmations: u8,
    pub lens_threshold: u8,
    /// The decision became Satisfied with this confirmation.
    pub satisfied: bool,
    pub attested_at: i64,
}

#[event]
pub struct AgreementFundingConfirmed {
    pub agreement: Pubkey,
    pub cid: String,
    /// The proposal_pledge donation escrow that was read.
    pub escrow: Pubkey,
    pub funding_mint: Pubkey,
    pub required_funding: u64,
    /// Donated less refunded, as recorded by the escrow.
    pub credited: u64,
    /// The escrow vault's token balance.
    pub vault_amount: u64,
    /// The decision became Satisfied with this confirmation.
    pub satisfied: bool,
    pub confirmed_at: i64,
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
    #[msg("A lens has 1-8 distinct real keys and a threshold between 1 and their number")]
    InvalidLens,
    #[msg("A contribution target needs a mint, and a mint needs a target")]
    InvalidFundingTarget,
    #[msg("This lens member's confirmation is already recorded")]
    MemberAlreadyConfirmed,
    #[msg("Enough lens members have confirmed; only the contribution target is outstanding")]
    LensAlreadyConfirmed,
    #[msg("The agreement has no contribution target")]
    NoFundingTarget,
    #[msg("The contribution target is already confirmed")]
    FundingAlreadyConfirmed,
    #[msg("Credited contributions are below the agreement's target")]
    FundingTargetNotMet,
    #[msg("The account is not this agreement's donation escrow")]
    InvalidEscrow,
    #[msg("The account is not the donation escrow's vault, or it does not back the credited contributions")]
    InvalidVault,
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

/// 0-8 distinct, real member keys; threshold 1..=members, or 0 with no members, which only an
/// agreement with a contribution target may have.
fn require_valid_lens(lenses: &[Pubkey], threshold: u8, required_funding: u64) -> Result<()> {
    if lenses.is_empty() {
        require!(required_funding > 0, AgreementError::NoLens);
        require!(threshold == 0, AgreementError::InvalidLens);
        return Ok(());
    }
    require!(lenses.len() <= MAX_LENSES, AgreementError::InvalidLens);
    require!(threshold >= 1 && threshold as usize <= lenses.len(), AgreementError::InvalidLens);
    for (index, member) in lenses.iter().enumerate() {
        require!(*member != Pubkey::default(), AgreementError::InvalidLens);
        require!(!lenses[..index].contains(member), AgreementError::InvalidLens);
    }
    Ok(())
}

fn u64_at(data: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(data.get(offset..offset + 8)?.try_into().ok()?))
}

fn key_at(data: &[u8], offset: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

/// The agreement's proposal_pledge donation escrow, read without that crate: owned by
/// proposal_pledge at PDA ["donation_escrow", agreement], DonationEscrow discriminator, naming this
/// agreement and `mint`, not yet released; and its vault: the escrow's recorded vault, an
/// initialized SPL token account of `mint` owned by the escrow. Returns (credited, vault amount),
/// credited = donated less refunded; the vault must hold at least the credited amount.
fn read_funding(agreement: &Pubkey, mint: &Pubkey, escrow: &AccountInfo, vault: &AccountInfo) -> Result<(u64, u64)> {
    require_keys_eq!(*escrow.owner, PLEDGE_PROGRAM_ID, AgreementError::InvalidEscrow);
    let (expected, _) =
        Pubkey::find_program_address(&[DONATION_ESCROW_SEED, agreement.as_ref()], &PLEDGE_PROGRAM_ID);
    require_keys_eq!(escrow.key(), expected, AgreementError::InvalidEscrow);
    let (credited, vault_key) = {
        let data = escrow.try_borrow_data()?;
        let discriminator = &hash(b"account:DonationEscrow").to_bytes()[..8];
        require!(
            data.len() > ESCROW_RELEASED_OFFSET && &data[..8] == discriminator,
            AgreementError::InvalidEscrow
        );
        let field = |value: Option<Pubkey>| value.ok_or(AgreementError::InvalidEscrow);
        require_keys_eq!(field(key_at(&data, ESCROW_PROPOSAL_OFFSET))?, *agreement, AgreementError::InvalidEscrow);
        require_keys_eq!(field(key_at(&data, ESCROW_MINT_OFFSET))?, *mint, AgreementError::InvalidEscrow);
        require!(data[ESCROW_RELEASED_OFFSET] == 0, AgreementError::InvalidEscrow);
        let donated = u64_at(&data, ESCROW_TOTAL_DONATED_OFFSET).ok_or(AgreementError::InvalidEscrow)?;
        let refunded = u64_at(&data, ESCROW_TOTAL_REFUNDED_OFFSET).ok_or(AgreementError::InvalidEscrow)?;
        let credited = donated.checked_sub(refunded).ok_or(AgreementError::InvalidEscrow)?;
        (credited, field(key_at(&data, ESCROW_VAULT_OFFSET))?)
    };
    require_keys_eq!(vault.key(), vault_key, AgreementError::InvalidVault);
    require_keys_eq!(*vault.owner, TOKEN_PROGRAM_ID, AgreementError::InvalidVault);
    let data = vault.try_borrow_data()?;
    require!(data.len() == TOKEN_ACCOUNT_LEN && data[108] == 1, AgreementError::InvalidVault);
    require_keys_eq!(key_at(&data, 0).ok_or(AgreementError::InvalidVault)?, *mint, AgreementError::InvalidVault);
    require_keys_eq!(key_at(&data, 32).ok_or(AgreementError::InvalidVault)?, escrow.key(), AgreementError::InvalidVault);
    let amount = u64_at(&data, 64).ok_or(AgreementError::InvalidVault)?;
    require!(amount >= credited, AgreementError::InvalidVault);
    Ok((credited, amount))
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

    fn blank() -> Agreement {
        Agreement {
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
            lens_count: 0,
            lens_threshold: 0,
            lens_confirmed: 0,
            more_lenses: [Pubkey::default(); MORE_LENSES],
            funding_mint: Pubkey::default(),
            required_funding: 0,
            funding_met: false,
            funding_observed: 0,
            funding_met_at: 0,
            cid: String::new(),
        }
    }

    fn serialized(agreement: &Agreement) -> Vec<u8> {
        let mut data = Vec::new();
        agreement.try_serialize(&mut data).unwrap();
        data
    }

    #[test]
    fn agreement_view_reads_the_fixed_header_and_every_lens_member() {
        let mut agreement = blank();
        agreement.authority = Pubkey::new_from_array([0x11; 32]);
        agreement.lens = Pubkey::new_from_array([0x22; 32]);
        agreement.payout = Pubkey::new_from_array([0x33; 32]);
        agreement.deadline = 101;
        agreement.status = AgreementStatus::Executed;
        agreement.executed_at = 1234;
        agreement.lens_count = 3;
        agreement.lens_threshold = 2;
        agreement.more_lenses[0] = Pubkey::new_from_array([0x66; 32]);
        agreement.more_lenses[1] = Pubkey::new_from_array([0x77; 32]);
        agreement.cid = "bafkreiabc".to_owned();
        let mut data = serialized(&agreement);

        let view = read_view(&mut data, &crate::ID).unwrap();
        assert_eq!(view.authority, agreement.authority);
        assert_eq!(view.lens, agreement.lens);
        assert_eq!(view.status, AgreementStatus::Executed as u8);
        assert_eq!(view.deadline, 101);
        assert_eq!(view.executed_at, agreement.executed_at);
        assert_eq!(view.lens_members(), &[agreement.lens, agreement.more_lenses[0], agreement.more_lenses[1]]);
        assert!(view.is_lens(&agreement.more_lenses[1]));
        assert!(!view.is_lens(&Pubkey::default()));
        assert!(!view.is_lens(&agreement.authority));
    }

    #[test]
    fn lens_set_offsets_follow_the_bump() {
        let mut agreement = blank();
        agreement.bump = 0xab;
        agreement.lens_count = 2;
        agreement.lens_threshold = 1;
        agreement.lens_confirmed = 0b10;
        agreement.more_lenses[6] = Pubkey::new_from_array([0x99; 32]);
        let data = serialized(&agreement);
        assert_eq!(data[EXECUTED_AT_OFFSET + 8], 0xab);
        assert_eq!(data[LENS_COUNT_OFFSET], 2);
        assert_eq!(data[LENS_THRESHOLD_OFFSET], 1);
        assert_eq!(data[LENS_CONFIRMED_OFFSET], 0b10);
        assert_eq!(&data[LENS_SET_END - 32..LENS_SET_END], &[0x99; 32]);
    }

    #[test]
    fn agreement_view_rejects_short_accounts_and_impossible_lens_counts() {
        let mut data = serialized(&blank());
        data.truncate(LENS_SET_END - 1);
        assert!(read_view(&mut data, &crate::ID).is_none());

        let mut agreement = blank();
        agreement.lens_count = MAX_LENSES as u8 + 1;
        let mut data = serialized(&agreement);
        assert!(read_view(&mut data, &crate::ID).is_none());
    }

    #[test]
    fn agreement_view_rejects_wrong_owner_and_discriminator() {
        let mut data = serialized(&blank());
        assert!(read_view(&mut data, &Pubkey::new_unique()).is_none());

        data[0] ^= 0xff;
        assert!(read_view(&mut data, &crate::ID).is_none());
    }

    #[test]
    fn lens_rules_admit_one_to_eight_distinct_members_and_a_reachable_threshold() {
        let keys: Vec<Pubkey> = (1..=9u8).map(|byte| Pubkey::new_from_array([byte; 32])).collect();
        assert!(require_valid_lens(&keys[..1], 1, 0).is_ok());
        assert!(require_valid_lens(&keys[..3], 2, 0).is_ok());
        assert!(require_valid_lens(&keys[..8], 8, 0).is_ok());
        assert!(require_valid_lens(&keys[..9], 1, 0).is_err());
        assert!(require_valid_lens(&keys[..3], 0, 0).is_err());
        assert!(require_valid_lens(&keys[..3], 4, 0).is_err());
        assert!(require_valid_lens(&[keys[0], keys[0]], 1, 0).is_err());
        assert!(require_valid_lens(&[Pubkey::default()], 1, 0).is_err());
        // No lens: only with a contribution target, and then no threshold.
        assert!(require_valid_lens(&[], 0, 0).is_err());
        assert!(require_valid_lens(&[], 0, 5).is_ok());
        assert!(require_valid_lens(&[], 1, 5).is_err());
    }

    #[test]
    fn the_decision_settles_when_the_threshold_and_the_target_are_both_met() {
        let mut agreement = blank();
        agreement.lens = Pubkey::new_from_array([1; 32]);
        agreement.more_lenses[0] = Pubkey::new_from_array([2; 32]);
        agreement.more_lenses[1] = Pubkey::new_from_array([3; 32]);
        agreement.lens_count = 3;
        agreement.lens_threshold = 2;
        agreement.required_funding = 10;
        assert_eq!(agreement.member_index(&Pubkey::new_from_array([3; 32])), Some(2));
        assert_eq!(agreement.member_index(&Pubkey::default()), None);

        agreement.lens_confirmed = 0b001;
        assert!(!agreement.lens_met());
        assert!(!agreement.settle_if_ready(5));
        agreement.lens_confirmed = 0b101;
        assert!(agreement.lens_met());
        assert!(!agreement.settle_if_ready(6), "the target is still outstanding");
        agreement.funding_met = true;
        assert!(agreement.settle_if_ready(7));
        assert!(agreement.decision == Decision::Satisfied);
        assert_eq!(agreement.decision_attested_at, 7);
    }

    #[test]
    fn a_target_only_agreement_settles_on_its_funding_alone() {
        let mut agreement = blank();
        agreement.required_funding = 10;
        assert!(agreement.lens_met());
        assert!(!agreement.settle_if_ready(5));
        agreement.funding_met = true;
        assert!(agreement.settle_if_ready(9));
        assert_eq!(agreement.decision_observed_at, 9);
    }
}
