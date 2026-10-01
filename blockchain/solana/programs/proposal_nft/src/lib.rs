//! Urban Game Theory Proposal NFT - Solana Program
//! Equivalent to EVM ProposalNFT.sol - proposals for parcel development
//!
//! v2, the lens model (lens-model.md): a proposal executes only through attestations. Its `lens`
//! lists the SAS issuers it trusts; a lens member's ParcelOwnership-v1 attestation names a parcel's
//! owner wallet, that wallet signs `accept_with_attestations`, and one acceptance record per
//! attested owner completes the parcel. A lens member's ProposalVerdict-v1 attestation can expire
//! the proposal (or execute it, only when minted with `verdict_may_execute`). Parcel anchors carry
//! no ownership and nothing here reads their `owner`.
//!
//! v3, parcel-optional proposals (PARCEL-OPTIONAL.md, lens-model.md "proposal_nft v3"): a proposal
//! is about a site (`site_hash`, sha256 of its canonical MultiPolygon) and its parcel list is the
//! site's cadastral binding, which may be empty. `open_ground` says part of the site lies on no
//! bound parcel, so no owner can consent for it: such a proposal also needs an `executed` verdict
//! from a lens member, and an empty binding executes only through one. Execution:
//! by consent  ⇔ parcels non-empty ∧ every parcel accepted ∧ (¬open_ground ∨ open ground cleared)
//! by verdict  ⇔ verdict_may_execute ∧ ¬(open_ground ∧ parcels non-empty)
//! where an `executed` verdict on an open-ground proposal with parcels clears the open ground (it
//! does not stand in for the owners), in either order with the owners' consent.
//! Every v3 mint stamps `layout_version` = 3; a v1/v2 account reads 0 there (zero padding) and
//! keeps 0 when this program rewrites it, so readers can tell a legacy account from a v3 mint
//! without a site (both hold a zero `site_hash`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use sas_attestation::{PayloadReader, SasError, SAS_PROGRAM_ID};

declare_id!("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");

const PARCEL_NFT_PROGRAM_ID: Pubkey = pubkey!("4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1");

/// SAS schema names and version the lens attestations are issued under. Each lens member issues
/// under its own credential, so the schema address is PDA(["schema", credential, name, [1]]) and
/// the program recomputes it instead of trusting the attestation's schema field.
pub const OWNERSHIP_SCHEMA_NAME: &[u8] = b"ParcelOwnership";
pub const VERDICT_SCHEMA_NAME: &[u8] = b"ProposalVerdict";
pub const LENS_SCHEMA_VERSION: u8 = 1;

/// Stamped into `Proposal.layout_version` by every mint. v1/v2 accounts read 0 (zero padding).
pub const PROPOSAL_LAYOUT_VERSION: u8 = 3;

/// Longest parcel id a tally or record can hold (also the PDA seed limit).
pub const MAX_PARCEL_ID_LEN: usize = 32;

#[program]
pub mod proposal_nft {
    use super::*;

    /// Initialize the proposal counter (one-time, program authority)
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.proposal_counter.count = 0;
        Ok(())
    }

    /// Create and fund a proposal
    pub fn mint_and_fund(
        ctx: Context<MintAndFund>,
        parcel_ids: Vec<String>,
        is_conditional: bool,
        image_uri: String,
        sol_amount: u64,
        lens: Vec<Pubkey>,
        verdict_may_execute: bool,
        site_hash: [u8; 32],
        open_ground: bool,
    ) -> Result<()> {
        // v3: an empty binding is allowed only for a proposal about a site, and is all open ground.
        require!(!parcel_ids.is_empty() || site_hash != [0u8; 32], ProposalError::NoParcels);
        require!(!parcel_ids.is_empty() || open_ground, ProposalError::EmptyBindingIsOpenGround);
        require!(!open_ground || site_hash != [0u8; 32], ProposalError::OpenGroundNeedsSite);
        require!(!lens.is_empty(), ProposalError::NoLens);

        let proposal_id = ctx.accounts.proposal_counter.count;
        ctx.accounts.proposal_counter.count += 1;

        // Transfer SOL before taking mutable borrow on proposal
        if sol_amount > 0 {
            let proposal_key = ctx.accounts.proposal.key();
            let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.owner.key(),
                &proposal_key,
                sol_amount,
            );
            anchor_lang::solana_program::program::invoke(
                &transfer_ix,
                &[
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.proposal.to_account_info(),
                ],
            )?;
        }

        let proposal = &mut ctx.accounts.proposal;
        proposal.proposal_id = proposal_id;
        proposal.parcel_ids = parcel_ids;
        proposal.is_conditional = is_conditional;
        proposal.image_uri = image_uri;
        proposal.acceptance_possible = true;
        proposal.status = ProposalStatus::Active;
        proposal.sol_balance = sol_amount;
        proposal.token_balance = 0;
        proposal.acceptance_count = 0;
        proposal.lens = lens;
        proposal.owner = ctx.accounts.owner.key();
        proposal.bump = ctx.bumps.proposal;
        proposal.verdict_may_execute = verdict_may_execute;
        proposal.site_hash = site_hash;
        proposal.open_ground = open_ground;
        proposal.open_ground_cleared = false;
        proposal.layout_version = PROPOSAL_LAYOUT_VERSION;

        Ok(())
    }

    /// Contribute SOL to a proposal
    pub fn contribute_funds(ctx: Context<ContributeFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, ProposalError::ZeroAmount);
        require!(
            ctx.accounts.proposal.acceptance_possible,
            ProposalError::AcceptanceClosed
        );

        let proposal_key = ctx.accounts.proposal.key();
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.contributor.key(),
            &proposal_key,
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.contributor.to_account_info(),
                ctx.accounts.proposal.to_account_info(),
            ],
        )?;

        ctx.accounts.proposal.sol_balance += amount;

        Ok(())
    }

    /// Record one attested owner's yes for one parcel. `ownership` is a lens member's
    /// ParcelOwnership-v1 SAS attestation naming `owner`; `owner` signs this transaction. A parcel
    /// completes when every owner the member recognises (`ownerCount`) has a record; the proposal
    /// executes when every parcel is complete. A second acceptance by the same owner fails at the
    /// `record` init (account already in use).
    pub fn accept_with_attestations(
        ctx: Context<AcceptWithAttestations>,
        parcel_id: String,
        payout: Option<Pubkey>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let proposal_key = ctx.accounts.proposal.key();
        let accounts = &mut *ctx.accounts;
        let proposal = &mut accounts.proposal;

        require!(proposal.status == ProposalStatus::Active, ProposalError::NotActive);
        require!(proposal.acceptance_possible, ProposalError::AcceptanceClosed);
        require!(proposal.parcel_ids.contains(&parcel_id), ProposalError::ParcelNotInProposal);
        require!(!proposal.accepted_parcels.contains(&parcel_id), ProposalError::AlreadyAccepted);
        require_parcel_anchor(&accounts.parcel, &parcel_id)?;

        let ownership_data = accounts.ownership.try_borrow_data()?;
        let attestation = verify_attestation(
            &accounts.ownership,
            &ownership_data,
            &accounts.ownership_credential,
            OWNERSHIP_SCHEMA_NAME,
            now,
        )?;
        let member = attestation.authority;
        require!(proposal.lens.contains(&member), ProposalError::MemberNotInLens);

        let ownership = parse_ownership(attestation.payload)?;
        require!(ownership.parcel_uid == parcel_id.as_bytes(), ProposalError::WrongParcel);
        require!(ownership.owner_count >= 1, ProposalError::InvalidOwnerCount);
        require_keys_eq!(accounts.owner.key(), ownership.owner, ProposalError::OwnerMismatch);
        require!(ownership.source_observed_at <= now, ProposalError::AttestationFromFuture);

        let tally = &mut accounts.tally;
        if tally.required == 0 {
            // Fresh from init_if_needed: this member's owner count defines the parcel's owner set.
            tally.proposal = proposal_key;
            tally.parcel_id = parcel_id.clone();
            tally.member = member;
            tally.required = ownership.owner_count;
            tally.accepted = 0;
            tally.bump = ctx.bumps.tally;
        } else {
            require!(tally.required == ownership.owner_count, ProposalError::OwnerCountMismatch);
            require_keys_eq!(tally.member, member, ProposalError::TallyMemberMismatch);
        }
        tally.accepted = tally.accepted.checked_add(1).ok_or(ProposalError::ArithmeticOverflow)?;

        let record = &mut accounts.record;
        record.proposal = proposal_key;
        record.parcel_id = parcel_id.clone();
        record.owner = accounts.owner.key();
        record.member = member;
        record.ownership_attestation = accounts.ownership.key();
        record.ownership_hash = hash(&ownership_data).to_bytes();
        record.payout = payout.unwrap_or_default();
        record.accepted_at = now;
        record.bump = ctx.bumps.record;

        if tally.accepted == tally.required {
            proposal.accepted_parcels.push(parcel_id);
            proposal.acceptance_count += 1;
            // Consent complete executes unless open ground still waits for its verdict; then the
            // proposal stays Active (and open to contributions) until that verdict arrives.
            if proposal.consent_complete() && (!proposal.open_ground || proposal.open_ground_cleared) {
                proposal.acceptance_possible = false;
                proposal.status = ProposalStatus::Executed;
            }
        }

        Ok(())
    }

    /// Settle an Active proposal from a lens member's ProposalVerdict-v1 attestation: `expired`
    /// sets Expired; `executed` needs a proposal minted with `verdict_may_execute` (a verdict
    /// cannot skip per-parcel consent otherwise) and then executes it, except on an open-ground
    /// proposal with parcels: there it clears the open ground, and the proposal executes now if
    /// every parcel is already accepted, or at the last acceptance otherwise.
    pub fn settle_with_verdict(ctx: Context<SettleWithVerdict>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let proposal_key = ctx.accounts.proposal.key();
        let accounts = &mut *ctx.accounts;
        let proposal = &mut accounts.proposal;
        require!(proposal.status == ProposalStatus::Active, ProposalError::NotActive);

        let verdict_data = accounts.verdict.try_borrow_data()?;
        let attestation = verify_attestation(
            &accounts.verdict,
            &verdict_data,
            &accounts.verdict_credential,
            VERDICT_SCHEMA_NAME,
            now,
        )?;
        let member = attestation.authority;
        require!(proposal.lens.contains(&member), ProposalError::MemberNotInLens);

        let verdict = parse_verdict(attestation.payload)?;
        require_keys_eq!(verdict.proposal_account, proposal_key, ProposalError::WrongProposal);
        require!(verdict.source_observed_at <= now, ProposalError::AttestationFromFuture);

        // `verdict_kind` is what the record keeps (1 executed, 3 expired); `status` is where the
        // proposal ends up, which stays Active for an open-ground clearance awaiting consent.
        let (verdict_kind, status) = if verdict.verdict == b"expired" {
            (ProposalStatus::Expired, ProposalStatus::Expired)
        } else if verdict.verdict == b"executed" {
            // No `acceptance_count == parcel_ids.len()` shortcut: with an empty list that read
            // 0 == 0 and let any executed verdict execute a parcel-less proposal.
            require!(proposal.verdict_may_execute, ProposalError::VerdictCannotSkipConsent);
            if proposal.open_ground && !proposal.parcel_ids.is_empty() {
                proposal.open_ground_cleared = true;
                if proposal.consent_complete() {
                    (ProposalStatus::Executed, ProposalStatus::Executed)
                } else {
                    (ProposalStatus::Executed, ProposalStatus::Active)
                }
            } else {
                (ProposalStatus::Executed, ProposalStatus::Executed)
            }
        } else {
            return err!(ProposalError::InvalidVerdict);
        };
        if status != ProposalStatus::Active {
            proposal.acceptance_possible = false;
        }
        proposal.status = status;

        let verdict_hash = hash(&verdict_data).to_bytes();
        let record = &mut accounts.verdict_record;
        record.proposal = proposal_key;
        record.member = member;
        record.verdict_attestation = accounts.verdict.key();
        record.verdict_hash = verdict_hash;
        record.verdict = verdict_kind as u8;
        record.settled_at = now;
        record.bump = ctx.bumps.verdict_record;

        emit!(VerdictSettled {
            proposal: proposal_key,
            verdict_attestation: accounts.verdict.key(),
            verdict_hash,
            member,
            status: status as u8,
            settled_at: now,
            verdict: verdict_kind as u8,
        });
        Ok(())
    }

    /// Distribute the locked SOL of an Executed proposal over its acceptance records: each
    /// accepted parcel gets an equal share, split equally between that parcel's records. A
    /// record's share goes to its `payout`; a record without one pays the proposal owner.
    /// Remaining accounts, per accepted parcel in `accepted_parcels` order: the parcel's tally,
    /// then `tally.accepted` pairs of (acceptance record, recipient). Rounding dust goes to the
    /// first recipient of the first parcel. A proposal Executed by verdict with no accepted parcel
    /// has no records: the whole balance returns to the proposal owner, passed as the only
    /// remaining account.
    pub fn distribute_funds(ctx: Context<DistributeFunds>) -> Result<()> {
        let proposal_key = ctx.accounts.proposal.key();
        let (accepted_parcels, amount, proposal_owner) = {
            let proposal = &mut ctx.accounts.proposal;
            require!(
                proposal.status == ProposalStatus::Executed,
                ProposalError::NotExecuted
            );
            require!(proposal.sol_balance > 0, ProposalError::ZeroAmount);

            let accepted_parcels = proposal.accepted_parcels.clone();
            let amount = proposal.sol_balance;
            proposal.sol_balance = 0;
            (accepted_parcels, amount, proposal.owner)
        };

        let remaining = ctx.remaining_accounts;
        if accepted_parcels.is_empty() {
            require!(remaining.len() == 1, ProposalError::InvalidDistributionAccounts);
            let owner = &remaining[0];
            require_keys_eq!(owner.key(), proposal_owner, ProposalError::InvalidDistributionAccounts);
            require!(owner.is_writable, ProposalError::InvalidDistributionAccounts);
            return transfer_program_lamports(&ctx.accounts.proposal.to_account_info(), owner, amount);
        }
        let parcel_count = accepted_parcels.len() as u64;
        let parcel_base = amount / parcel_count;
        let parcel_remainder = amount % parcel_count;
        let mut cursor = 0usize;

        for (parcel_index, parcel_id) in accepted_parcels.iter().enumerate() {
            let tally_info = remaining.get(cursor).ok_or(ProposalError::InvalidDistributionAccounts)?;
            cursor += 1;
            let tally: ConsentTally = read_program_account(tally_info)?;
            require!(
                tally.proposal == proposal_key
                    && tally.parcel_id == *parcel_id
                    && tally.accepted > 0
                    && tally.accepted == tally.required,
                ProposalError::InvalidDistributionAccounts
            );

            let parcel_share = parcel_base + if parcel_index == 0 { parcel_remainder } else { 0 };
            let owners = tally.accepted as u64;
            let record_base = parcel_share / owners;
            let record_remainder = parcel_share % owners;
            let mut seen_owners: Vec<Pubkey> = Vec::with_capacity(tally.accepted as usize);

            for record_index in 0..tally.accepted as usize {
                let record_info = remaining.get(cursor).ok_or(ProposalError::InvalidDistributionAccounts)?;
                let recipient = remaining.get(cursor + 1).ok_or(ProposalError::InvalidDistributionAccounts)?;
                cursor += 2;

                let record: AcceptanceRecord = read_program_account(record_info)?;
                require!(
                    record.proposal == proposal_key && record.parcel_id == *parcel_id,
                    ProposalError::InvalidDistributionAccounts
                );
                require!(!seen_owners.contains(&record.owner), ProposalError::InvalidDistributionAccounts);
                seen_owners.push(record.owner);

                let expected_recipient = if record.payout == Pubkey::default() {
                    proposal_owner
                } else {
                    record.payout
                };
                require_keys_eq!(recipient.key(), expected_recipient, ProposalError::InvalidDistributionAccounts);
                require!(recipient.is_writable, ProposalError::InvalidDistributionAccounts);

                let share = record_base + if record_index == 0 { record_remainder } else { 0 };
                transfer_program_lamports(&ctx.accounts.proposal.to_account_info(), recipient, share)?;
            }
        }
        require!(cursor == remaining.len(), ProposalError::InvalidDistributionAccounts);

        Ok(())
    }

    /// Return the locked SOL of an Expired proposal to its creator (cancel_and_refund stays
    /// Active-only, so this is the only exit for funds on an expired proposal).
    pub fn reclaim_expired_funds(ctx: Context<ReclaimExpiredFunds>) -> Result<()> {
        let amount = {
            let proposal = &mut ctx.accounts.proposal;
            require!(proposal.status == ProposalStatus::Expired, ProposalError::NotExpired);
            require!(proposal.sol_balance > 0, ProposalError::ZeroAmount);
            let amount = proposal.sol_balance;
            proposal.sol_balance = 0;
            amount
        };
        transfer_program_lamports(
            &ctx.accounts.proposal.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            amount,
        )
    }

    /// Cancel an active proposal and return locked SOL to its creator.
    pub fn cancel_and_refund(ctx: Context<CancelAndRefund>) -> Result<()> {
        let amount = {
            let proposal = &mut ctx.accounts.proposal;
            require!(
                proposal.status == ProposalStatus::Active,
                ProposalError::NotActive
            );

            proposal.acceptance_possible = false;
            proposal.status = ProposalStatus::Cancelled;
            let amount = proposal.sol_balance;
            proposal.sol_balance = 0;
            amount
        };

        if amount > 0 {
            transfer_program_lamports(
                &ctx.accounts.proposal.to_account_info(),
                &ctx.accounts.owner.to_account_info(),
                amount,
            )?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintAndFund<'info> {
    #[account(
        init,
        payer = owner,
        space = PROPOSAL_ACCOUNT_SPACE,
        seeds = [b"proposal", &proposal_counter.count.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        mut,
        seeds = [b"proposal_counter"],
        bump
    )]
    pub proposal_counter: Account<'info, ProposalCounter>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ContributeFunds<'info> {
    #[account(
        mut,
        constraint = proposal.acceptance_possible
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(mut)]
    pub contributor: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(parcel_id: String)]
pub struct AcceptWithAttestations<'info> {
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,

    /// CHECK: the parcel_nft anchor PDA for `parcel_id`; owner and address checked in the handler.
    pub parcel: UncheckedAccount<'info>,

    /// CHECK: SAS ParcelOwnership-v1 attestation; owner, layout, credential, schema, expiry, lens
    /// membership and payload are checked in the handler.
    pub ownership: UncheckedAccount<'info>,

    /// CHECK: SAS credential the ownership attestation was issued under; owner, layout and
    /// authority are checked in the handler.
    pub ownership_credential: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ConsentTally::INIT_SPACE,
        seeds = [b"consent", proposal.key().as_ref(), parcel_id.as_bytes()],
        bump
    )]
    pub tally: Box<Account<'info, ConsentTally>>,

    #[account(
        init,
        payer = payer,
        space = 8 + AcceptanceRecord::INIT_SPACE,
        seeds = [b"acceptance", proposal.key().as_ref(), parcel_id.as_bytes(), owner.key().as_ref()],
        bump
    )]
    pub record: Box<Account<'info, AcceptanceRecord>>,

    /// The attested owner saying yes; must equal the ownership payload's `owner`.
    pub owner: Signer<'info>,

    /// Pays rent for the tally and the record; may be the owner.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleWithVerdict<'info> {
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,

    /// CHECK: SAS ProposalVerdict-v1 attestation; checked in the handler.
    pub verdict: UncheckedAccount<'info>,

    /// CHECK: SAS credential the verdict was issued under; checked in the handler.
    pub verdict_credential: UncheckedAccount<'info>,

    /// Permanent evidence of the settlement. `init`, so replaying the same attestation fails with
    /// "already in use" before the handler runs.
    #[account(
        init,
        payer = submitter,
        space = 8 + VerdictRecord::INIT_SPACE,
        seeds = [b"verdict", proposal.key().as_ref(), verdict.key().as_ref()],
        bump
    )]
    pub verdict_record: Box<Account<'info, VerdictRecord>>,

    /// Pays rent for the verdict record.
    #[account(mut)]
    pub submitter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeFunds<'info> {
    /// Remaining accounts carry, per accepted parcel, its tally and (record, recipient) pairs.
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct ReclaimExpiredFunds<'info> {
    #[account(
        mut,
        has_one = owner
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAndRefund<'info> {
    #[account(
        mut,
        has_one = owner
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 8,
        seeds = [b"proposal_counter"],
        bump
    )]
    pub proposal_counter: Account<'info, ProposalCounter>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct ProposalCounter {
    pub count: u64,
}

#[account]
pub struct Proposal {
    pub proposal_id: u64,
    pub owner: Pubkey,
    pub parcel_ids: Vec<String>,
    pub is_conditional: bool,
    pub image_uri: String,
    pub acceptance_possible: bool,
    pub status: ProposalStatus,
    pub sol_balance: u64,
    pub token_balance: u64,
    pub acceptance_count: u64,
    pub accepted_parcels: Vec<String>,
    pub lens: Vec<Pubkey>,
    pub bump: u8,
    pub verdict_may_execute: bool,
    // v3 (appended after v2's tail so prefix readers keep working; v1/v2 accounts hold zero bytes
    // here, which read as no site, no open ground, not cleared: exactly their v2 behaviour).
    /// sha256 of the canonical site encoding (frontend/js/proposals/site-hash.js); zero = no site.
    pub site_hash: [u8; 32],
    /// Part of the site lies on no bound parcel: execution also needs an executed verdict.
    pub open_ground: bool,
    /// An executed verdict has cleared the open ground (only meaningful with `open_ground`).
    pub open_ground_cleared: bool,
    /// Account layout the mint wrote: PROPOSAL_LAYOUT_VERSION (3) for a v3 mint, 0 for a v1/v2
    /// account (zero padding; only the mint sets it, so it stays 0). Tells a legacy account from a v3
    /// mint without a site, which both hold a zero `site_hash`.
    pub layout_version: u8,
}

impl Proposal {
    /// Every parcel of a non-empty binding is accepted. Never true for an empty binding.
    pub fn consent_complete(&self) -> bool {
        !self.parcel_ids.is_empty() && self.acceptance_count == self.parcel_ids.len() as u64
    }
}

/// The fixed account size every Proposal lives in. It always has room: everything variable comes
/// from one mint_and_fund instruction, whose data a 1232-byte transaction caps at about 1.1 KB, so
/// the proposal plus a full `accepted_parcels` copy of its parcel ids stays under about 2.4 KB.
pub const PROPOSAL_ACCOUNT_SPACE: usize = 4096;

/// One lens member's view of one parcel's owner set within one proposal:
/// PDA ["consent", proposal, parcel_id].
#[account]
#[derive(InitSpace)]
pub struct ConsentTally {
    pub proposal: Pubkey,
    #[max_len(32)]
    pub parcel_id: String,
    pub member: Pubkey,
    pub required: u8,
    pub accepted: u8,
    pub bump: u8,
}

/// One attested owner's yes: PDA ["acceptance", proposal, parcel_id, owner]. Keeps the ownership
/// attestation's key and the sha256 of its whole account bytes, so the evidence outlives the SAS
/// account.
#[account]
#[derive(InitSpace)]
pub struct AcceptanceRecord {
    pub proposal: Pubkey,
    #[max_len(32)]
    pub parcel_id: String,
    pub owner: Pubkey,
    pub member: Pubkey,
    pub ownership_attestation: Pubkey,
    pub ownership_hash: [u8; 32],
    pub payout: Pubkey,
    pub accepted_at: i64,
    pub bump: u8,
}

/// One settled verdict: PDA ["verdict", proposal, verdict_attestation]. Keeps the verdict
/// attestation's key and the sha256 of its whole account bytes, so the evidence outlives the SAS
/// account (and the transaction logs that carry `VerdictSettled`). `verdict` is what the verdict
/// said: 1 executed, 3 expired. An executed verdict on an open-ground proposal with parcels clears
/// the open ground and may leave the proposal Active until the last owner accepts.
#[account]
#[derive(InitSpace)]
pub struct VerdictRecord {
    pub proposal: Pubkey,
    pub member: Pubkey,
    pub verdict_attestation: Pubkey,
    pub verdict_hash: [u8; 32],
    pub verdict: u8,
    pub settled_at: i64,
    pub bump: u8,
}

#[event]
pub struct VerdictSettled {
    pub proposal: Pubkey,
    pub verdict_attestation: Pubkey,
    pub verdict_hash: [u8; 32],
    pub member: Pubkey,
    /// The proposal's status after the settlement (0 Active for an open-ground clearance).
    pub status: u8,
    pub settled_at: i64,
    /// What the verdict said: 1 executed, 3 expired.
    pub verdict: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProposalStatus {
    Active = 0,
    Executed = 1,
    Cancelled = 2,
    Expired = 3,
}

#[error_code]
pub enum ProposalError {
    #[msg("Must include at least one parcel, or a site_hash for a proposal on open ground")]
    NoParcels,
    #[msg("Must include at least one lens")]
    NoLens,
    #[msg("Parcel not in proposal")]
    ParcelNotInProposal,
    #[msg("Parcel already accepted")]
    AlreadyAccepted,
    #[msg("Acceptance not possible")]
    AcceptanceClosed,
    #[msg("Not conditional")]
    NotConditional,
    #[msg("Proposal not active")]
    NotActive,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Signer does not own the parcel")]
    UnauthorizedParcelOwner,
    #[msg("Invalid parcel account")]
    InvalidParcelAccount,
    #[msg("Invalid parcel program")]
    InvalidParcelProgram,
    #[msg("Acceptance not found")]
    AcceptanceNotFound,
    #[msg("Proposal is not executed")]
    NotExecuted,
    #[msg("Invalid distribution accounts")]
    InvalidDistributionAccounts,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrowBalance,
    #[msg("The attestation issuer is not in this proposal's lens")]
    MemberNotInLens,
    #[msg("The account is not a valid SAS attestation or credential")]
    InvalidAttestation,
    #[msg("The attestation has expired")]
    AttestationExpired,
    #[msg("The attestation was issued under a different credential")]
    WrongCredential,
    #[msg("The credential's authority did not sign the attestation")]
    CredentialAuthorityMismatch,
    #[msg("The attestation is not under the expected lens schema")]
    WrongSchema,
    #[msg("The attestation payload does not match its schema")]
    InvalidAttestationPayload,
    #[msg("The ownership attestation is about a different parcel")]
    WrongParcel,
    #[msg("The ownership attestation's ownerCount must be at least 1")]
    InvalidOwnerCount,
    #[msg("The signer is not the attested owner")]
    OwnerMismatch,
    #[msg("The attestation's source time is in the future")]
    AttestationFromFuture,
    #[msg("The attestation's ownerCount differs from the parcel's tally")]
    OwnerCountMismatch,
    #[msg("Another lens member already opened this parcel's tally")]
    TallyMemberMismatch,
    #[msg("The verdict is about a different proposal")]
    WrongProposal,
    #[msg("The verdict must be executed or expired")]
    InvalidVerdict,
    #[msg("An executed verdict cannot skip per-parcel consent")]
    VerdictCannotSkipConsent,
    #[msg("Proposal is not expired")]
    NotExpired,
    #[msg("A proposal without parcels is all open ground: open_ground must be set")]
    EmptyBindingIsOpenGround,
    #[msg("Open ground needs a site: site_hash must be set")]
    OpenGroundNeedsSite,
}

/// The parcel anchor must exist: owned by parcel_nft at PDA ["parcel", parcel_id].
fn require_parcel_anchor(parcel: &AccountInfo, parcel_id: &str) -> Result<()> {
    require_keys_eq!(*parcel.owner, PARCEL_NFT_PROGRAM_ID, ProposalError::InvalidParcelAccount);
    let (expected, _) =
        Pubkey::find_program_address(&[b"parcel", parcel_id.as_bytes()], &PARCEL_NFT_PROGRAM_ID);
    require_keys_eq!(parcel.key(), expected, ProposalError::InvalidParcelAccount);
    Ok(())
}

fn sas_error(error: SasError) -> Error {
    match error {
        SasError::InvalidPayload => error!(ProposalError::InvalidAttestationPayload),
        SasError::WrongCredential => error!(ProposalError::WrongCredential),
        SasError::InvalidAccount | SasError::SchemaPaused => error!(ProposalError::InvalidAttestation),
    }
}

/// The attestation checks shared by acceptance and verdict: SAS-owned, discriminator 2, not
/// expired (expiry strictly after now), issued under `credential`, whose authority is the
/// attestation's signer, under this credential's `schema_name` v1 schema PDA.
fn verify_attestation<'a>(
    attestation_account: &AccountInfo,
    data: &'a [u8],
    credential: &AccountInfo,
    schema_name: &[u8],
    now: i64,
) -> Result<sas_attestation::Attestation<'a>> {
    require_keys_eq!(*attestation_account.owner, SAS_PROGRAM_ID, ProposalError::InvalidAttestation);
    let attestation = sas_attestation::parse_attestation(data).map_err(sas_error)?;
    require!(attestation.expiry > now, ProposalError::AttestationExpired);
    require_keys_eq!(attestation.credential, credential.key(), ProposalError::WrongCredential);
    require_keys_eq!(*credential.owner, SAS_PROGRAM_ID, ProposalError::InvalidAttestation);
    let credential_authority = {
        let credential_data = credential.try_borrow_data()?;
        sas_attestation::parse_credential_authority(&credential_data).map_err(sas_error)?
    };
    require_keys_eq!(credential_authority, attestation.authority, ProposalError::CredentialAuthorityMismatch);
    require_keys_eq!(
        attestation.schema,
        sas_attestation::schema_address(&credential.key(), schema_name, LENS_SCHEMA_VERSION),
        ProposalError::WrongSchema
    );
    Ok(attestation)
}

/// ParcelOwnership-v1: string parcelUid, string owner, uint8 ownerCount, string evidenceRef,
/// int64 sourceObservedAt.
struct OwnershipPayload<'a> {
    parcel_uid: &'a [u8],
    owner: Pubkey,
    owner_count: u8,
    source_observed_at: i64,
}

fn parse_ownership(payload: &[u8]) -> Result<OwnershipPayload<'_>> {
    let mut reader = PayloadReader::new(payload);
    let parcel_uid = reader.string().map_err(sas_error)?;
    let owner = sas_attestation::parse_pubkey_string(reader.string().map_err(sas_error)?).map_err(sas_error)?;
    let owner_count = reader.u8().map_err(sas_error)?;
    let _evidence_ref = reader.string().map_err(sas_error)?;
    let source_observed_at = reader.i64().map_err(sas_error)?;
    reader.finish().map_err(sas_error)?;
    Ok(OwnershipPayload { parcel_uid, owner, owner_count, source_observed_at })
}

/// ProposalVerdict-v1: string proposalAccount, string verdict, string evidenceRef,
/// int64 sourceObservedAt.
struct VerdictPayload<'a> {
    proposal_account: Pubkey,
    verdict: &'a [u8],
    source_observed_at: i64,
}

fn parse_verdict(payload: &[u8]) -> Result<VerdictPayload<'_>> {
    let mut reader = PayloadReader::new(payload);
    let proposal_account =
        sas_attestation::parse_pubkey_string(reader.string().map_err(sas_error)?).map_err(sas_error)?;
    let verdict = reader.string().map_err(sas_error)?;
    let _evidence_ref = reader.string().map_err(sas_error)?;
    let source_observed_at = reader.i64().map_err(sas_error)?;
    reader.finish().map_err(sas_error)?;
    Ok(VerdictPayload { proposal_account, verdict, source_observed_at })
}

/// Deserialize an account this program owns (owner and Anchor discriminator checked).
fn read_program_account<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    require_keys_eq!(*info.owner, crate::ID, ProposalError::InvalidDistributionAccounts);
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    T::try_deserialize(&mut slice).map_err(|_| error!(ProposalError::InvalidDistributionAccounts))
}

fn transfer_program_lamports<'from, 'to>(
    from: &AccountInfo<'from>,
    to: &AccountInfo<'to>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let from_lamports = from.lamports();
    require!(
        from_lamports >= amount,
        ProposalError::InsufficientEscrowBalance
    );
    let to_lamports = to.lamports();

    **from.try_borrow_mut_lamports()? = from_lamports
        .checked_sub(amount)
        .ok_or(ProposalError::ArithmeticOverflow)?;
    **to.try_borrow_mut_lamports()? = to_lamports
        .checked_add(amount)
        .ok_or(ProposalError::ArithmeticOverflow)?;

    Ok(())
}
