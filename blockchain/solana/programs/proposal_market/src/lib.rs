// proposal_market: a parimutuel prediction market per agreement (an Agreement account of the
// agreement program), staked in one SPL token (devnet USDC for the hackathon), with NO deadline. A
// market resolves only when its agreement reaches a terminal on-chain state: Executed → YES,
// Cancelled or Expired → NO. Anyone may create the market, stake, resolve and claim. The agreement
// is read directly from its account by agreement::read_agreement_view (owner, discriminator, status
// at offset 136), never through CPI; proposal_nft is not read at all. The program keeps its name and
// id, and its accounts and fields keep the word `proposal` (the IDL interface is unchanged), which
// now names the agreement account: renaming is a deploy-time matter.
//
// The same program also hosts the LMSR market (lmsr-market.md, handlers in lmsr_market.rs): dated
// markets priced by an automated market maker whose worst-case loss the creator deposits, settled
// from the agreement's state or from MarketEvidence-v1 attestations. The parimutuel instructions and
// the Market, ExternalMarket and Position layouts above stay as deployed.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sas_attestation::SasError;

/// Fixed-point market maker shared with the JavaScript reference (lmsr-market.md).
pub mod lmsr;
/// LMSR market accounts and handlers (lmsr-market.md); the instructions are declared below.
pub mod lmsr_market;
pub use lmsr_market::*;

declare_id!("GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB");

/// Solana Attestation Service program used by the court oracle on devnet. External markets do not
/// trust an API response: they parse an account owned by this program and pin its credential,
/// schema, issuer, parcel and outcome value against commitments made before staking starts.
pub const SAS_PROGRAM_ID: Pubkey = sas_attestation::SAS_PROGRAM_ID;

/// agreement::AgreementStatus codes, the status byte a market reads (the codes proposal_nft used).
pub const STATUS_ACTIVE: u8 = agreement::AgreementStatus::Active as u8;
pub const STATUS_EXECUTED: u8 = agreement::AgreementStatus::Executed as u8;
pub const STATUS_CANCELLED: u8 = agreement::AgreementStatus::Cancelled as u8;
/// Set by the agreement program's `expire` once the agreement's deadline has passed.
pub const STATUS_EXPIRED: u8 = agreement::AgreementStatus::Expired as u8;

pub const SIDE_NO: u8 = 0;
pub const SIDE_YES: u8 = 1;

pub const MARKET_SEED: &[u8] = b"market";
pub const EXTERNAL_MARKET_SEED: &[u8] = b"external_market";
pub const POSITION_SEED: &[u8] = b"position";

pub const SAS_CREDENTIAL_DISCRIMINATOR: u8 = sas_attestation::CREDENTIAL_DISCRIMINATOR;
pub const SAS_SCHEMA_DISCRIMINATOR: u8 = sas_attestation::SCHEMA_DISCRIMINATOR;
pub const SAS_ATTESTATION_DISCRIMINATOR: u8 = sas_attestation::ATTESTATION_DISCRIMINATOR;

#[program]
pub mod proposal_market {
    use super::*;

    /// Open the (single) market for an agreement (the `proposal` account). Only an Active agreement
    /// can get a market: a market on an already-terminal one would resolve instantly and take no
    /// stakes.
    pub fn create_market(ctx: Context<CreateMarket>) -> Result<()> {
        let status = read_subject(&ctx.accounts.proposal, None)?.status;
        require!(status == STATUS_ACTIVE, MarketError::ProposalNotActive);

        let market = &mut ctx.accounts.market;
        market.proposal = ctx.accounts.proposal.key();
        market.stake_mint = ctx.accounts.stake_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.yes_pool = 0;
        market.no_pool = 0;
        market.resolved = false;
        market.outcome = SIDE_NO;
        market.bump = ctx.bumps.market;
        Ok(())
    }

    /// Stake `amount` of the market's token on `side` (1 = YES the agreement executes, 0 = NO it is
    /// cancelled or expires). Allowed only while the agreement is still Active and the market
    /// unresolved. Stakes are locked until resolution: no early exit, because the visible decision
    /// tally would make late exits gameable.
    pub fn stake(ctx: Context<Stake>, side: u8, amount: u64) -> Result<()> {
        require!(side == SIDE_YES || side == SIDE_NO, MarketError::InvalidSide);
        require!(amount > 0, MarketError::ZeroAmount);
        require!(!ctx.accounts.market.resolved, MarketError::MarketResolved);

        let status = read_subject(&ctx.accounts.proposal, Some(&ctx.accounts.market.proposal))?.status;
        require!(status == STATUS_ACTIVE, MarketError::ProposalNotActive);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staker_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
        )?;

        let market_key = ctx.accounts.market.key();
        let position = &mut ctx.accounts.position;
        if position.amount == 0 {
            // Fresh (init_if_needed just created it) — the PDA seeds pin market, owner and side.
            position.market = market_key;
            position.owner = ctx.accounts.staker.key();
            position.side = side;
            position.claimed = false;
            position.bump = ctx.bumps.position;
        }
        position.amount = position.amount.checked_add(amount).ok_or(MarketError::MathOverflow)?;

        let market = &mut ctx.accounts.market;
        if side == SIDE_YES {
            market.yes_pool = market.yes_pool.checked_add(amount).ok_or(MarketError::MathOverflow)?;
        } else {
            market.no_pool = market.no_pool.checked_add(amount).ok_or(MarketError::MathOverflow)?;
        }
        Ok(())
    }

    /// Permissionless. Reads the agreement's on-chain status: Executed → YES, Cancelled or Expired
    /// → NO, anything else → NotTerminal. There is no clock: an Active agreement keeps the market
    /// open.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        require!(!ctx.accounts.market.resolved, MarketError::MarketResolved);
        let status = read_subject(&ctx.accounts.proposal, Some(&ctx.accounts.market.proposal))?.status;
        let outcome = match status {
            STATUS_EXECUTED => SIDE_YES,
            STATUS_CANCELLED | STATUS_EXPIRED => SIDE_NO,
            _ => return err!(MarketError::NotTerminal),
        };
        let market = &mut ctx.accounts.market;
        market.resolved = true;
        market.outcome = outcome;
        Ok(())
    }

    /// Pay out one position: `amount * (yes_pool + no_pool) / winning_pool` to a winner, the
    /// stake back to everyone when nobody staked the winning side, nothing to a loser.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.resolved, MarketError::MarketNotResolved);
        require!(!ctx.accounts.position.claimed, MarketError::AlreadyClaimed);

        let position = &ctx.accounts.position;
        let payout = payout_amount(position.side, position.amount, market.yes_pool, market.no_pool, market.outcome)?;
        require!(payout > 0, MarketError::NothingToClaim);

        ctx.accounts.position.claimed = true;

        let subject_key = market.proposal;
        let seeds: &[&[u8]] = &[MARKET_SEED, subject_key.as_ref(), &[market.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.claimer_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;
        Ok(())
    }

    /// Open a market whose resolution rule is committed before trading. The recipe document lives
    /// off-chain, but its sha256 digest and every security-sensitive input are stored on-chain.
    /// `subject_hash` is sha256(parcelUid); the outcome hashes are sha256(operation) values from the
    /// court oracle's SAS schema.
    ///
    /// Optional remaining account 0: an agreement. When passed, the market is bound to that
    /// agreement's authority choice: `trusted_attester` must be its lens. The binding is checked at
    /// creation only; the ExternalMarket layout is unchanged.
    pub fn create_external_market(
        ctx: Context<CreateExternalMarket>,
        recipe_hash: [u8; 32],
        subject_hash: [u8; 32],
        yes_value_hash: [u8; 32],
        no_value_hash: [u8; 32],
        trusted_attester: Pubkey,
        closes_at: i64,
    ) -> Result<()> {
        require!(recipe_hash != [0; 32], MarketError::EmptyCommitment);
        require!(subject_hash != [0; 32], MarketError::EmptyCommitment);
        require!(yes_value_hash != no_value_hash, MarketError::AmbiguousOutcomes);
        require!(closes_at > Clock::get()?.unix_timestamp, MarketError::InvalidCloseTime);
        validate_sas_schema(&ctx.accounts.credential, &ctx.accounts.schema)?;
        if let Some(subject) = ctx.remaining_accounts.first() {
            let view = read_subject(subject, None)?;
            require_keys_eq!(view.lens, trusted_attester, MarketError::AttesterNotInProposalLens);
        }

        let market = &mut ctx.accounts.market;
        market.stake_mint = ctx.accounts.stake_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.recipe_hash = recipe_hash;
        market.subject_hash = subject_hash;
        market.yes_value_hash = yes_value_hash;
        market.no_value_hash = no_value_hash;
        market.credential = ctx.accounts.credential.key();
        market.schema = ctx.accounts.schema.key();
        market.trusted_attester = trusted_attester;
        market.yes_pool = 0;
        market.no_pool = 0;
        market.closes_at = closes_at;
        market.resolved = false;
        market.outcome = SIDE_NO;
        market.evidence = Pubkey::default();
        market.evidence_hash = [0; 32];
        market.resolved_at = 0;
        market.bump = ctx.bumps.market;
        Ok(())
    }

    /// Stake on a recipe-bound market. Trading closes before evidence can settle the outcome, so a
    /// transaction cannot observe the evidence and then place a risk-free stake in the same slot.
    pub fn stake_external(ctx: Context<StakeExternal>, side: u8, amount: u64) -> Result<()> {
        require!(side == SIDE_YES || side == SIDE_NO, MarketError::InvalidSide);
        require!(amount > 0, MarketError::ZeroAmount);
        require!(!ctx.accounts.market.resolved, MarketError::MarketResolved);
        require!(Clock::get()?.unix_timestamp < ctx.accounts.market.closes_at, MarketError::MarketClosed);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staker_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
        )?;

        let market_key = ctx.accounts.market.key();
        let position = &mut ctx.accounts.position;
        if position.amount == 0 {
            position.market = market_key;
            position.owner = ctx.accounts.staker.key();
            position.side = side;
            position.claimed = false;
            position.bump = ctx.bumps.position;
        }
        position.amount = position.amount.checked_add(amount).ok_or(MarketError::MathOverflow)?;

        let market = &mut ctx.accounts.market;
        if side == SIDE_YES {
            market.yes_pool = market.yes_pool.checked_add(amount).ok_or(MarketError::MathOverflow)?;
        } else {
            market.no_pool = market.no_pool.checked_add(amount).ok_or(MarketError::MathOverflow)?;
        }
        Ok(())
    }

    /// Permissionless resolution from a real SAS account. The outcome is derived from the
    /// attestation payload rather than accepted as a caller argument.
    pub fn resolve_external(ctx: Context<ResolveExternal>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, MarketError::MarketResolved);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.closes_at, MarketError::MarketStillOpen);

        require_keys_eq!(ctx.accounts.schema.key(), market.schema, MarketError::WrongEvidenceSchema);
        validate_sas_schema_data(&ctx.accounts.schema, &market.credential)?;
        let evidence = read_sas_court_evidence(&ctx.accounts.attestation)?;
        require_keys_eq!(evidence.credential, market.credential, MarketError::WrongEvidenceCredential);
        require_keys_eq!(evidence.schema, market.schema, MarketError::WrongEvidenceSchema);
        require_keys_eq!(evidence.authority, market.trusted_attester, MarketError::UntrustedAttester);
        require!(evidence.expiry > now, MarketError::ExpiredEvidence);
        require!(evidence.subject_hash == market.subject_hash, MarketError::WrongEvidenceSubject);
        validate_source_chronology(evidence.source_observed_at, market.closes_at, now)?;

        let outcome = if evidence.value_hash == market.yes_value_hash {
            SIDE_YES
        } else if evidence.value_hash == market.no_value_hash {
            SIDE_NO
        } else {
            return err!(MarketError::UnsupportedEvidenceValue);
        };

        market.resolved = true;
        market.outcome = outcome;
        market.evidence = ctx.accounts.attestation.key();
        market.evidence_hash = evidence.account_hash;
        market.resolved_at = now;

        emit!(ExternalMarketResolved {
            market: market.key(),
            recipe_hash: market.recipe_hash,
            evidence: market.evidence,
            evidence_hash: market.evidence_hash,
            outcome,
            resolved_at: now,
        });
        Ok(())
    }

    pub fn claim_external(ctx: Context<ClaimExternal>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.resolved, MarketError::MarketNotResolved);
        require!(!ctx.accounts.position.claimed, MarketError::AlreadyClaimed);

        let position = &ctx.accounts.position;
        let payout = payout_amount(position.side, position.amount, market.yes_pool, market.no_pool, market.outcome)?;
        require!(payout > 0, MarketError::NothingToClaim);
        ctx.accounts.position.claimed = true;

        let seeds: &[&[u8]] = &[EXTERNAL_MARKET_SEED, market.recipe_hash.as_ref(), &[market.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.claimer_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;
        Ok(())
    }

    // ========================
    // LMSR market (lmsr-market.md); handlers in lmsr_market.rs
    // ========================

    /// Open the LMSR market of an Active agreement (kind 0, PDA ["lmsr", agreement]). Anyone may
    /// open it; the creator deposits the seed max_loss(b) and reclaims what the payouts leave.
    /// Trading closes at `closes_at`; an agreement still Active settles NO after
    /// `closes_at + grace_seconds`.
    /// `max_position` caps shares per wallet per side (0: no cap).
    pub fn create_lmsr_market(
        ctx: Context<CreateLmsrMarket>,
        b: u64,
        closes_at: i64,
        grace_seconds: u32,
        max_position: u64,
    ) -> Result<()> {
        lmsr_market::handle_create_lmsr_market(ctx, b, closes_at, grace_seconds, max_position)
    }

    /// Open a recipe-bound LMSR market (kind 1, PDA ["lmsr", recipe_hash]) that settles from
    /// MarketEvidence-v1 attestations against these commitments, as create_external_market does
    /// for the court schema. Optional remaining account 0: an agreement whose lens must be
    /// `trusted_attester`; it is stored, and its sponsor and lens may not trade.
    #[allow(clippy::too_many_arguments)]
    pub fn create_lmsr_external_market(
        ctx: Context<CreateLmsrExternalMarket>,
        recipe_hash: [u8; 32],
        subject_hash: [u8; 32],
        yes_value_hash: [u8; 32],
        no_value_hash: [u8; 32],
        trusted_attester: Pubkey,
        b: u64,
        closes_at: i64,
        grace_seconds: u32,
        max_position: u64,
    ) -> Result<()> {
        lmsr_market::handle_create_lmsr_external_market(
            ctx,
            recipe_hash,
            subject_hash,
            yes_value_hash,
            no_value_hash,
            trusted_attester,
            b,
            closes_at,
            grace_seconds,
            max_position,
        )
    }

    /// Buy `shares` of `side` at the maker's price; fails if the quote exceeds `max_cost` (the
    /// client's slippage guard). `proposal` is market.proposal, the agreement (the System Program
    /// id when an external market is unbound).
    pub fn buy(ctx: Context<Buy>, side: u8, shares: u64, max_cost: u64) -> Result<()> {
        lmsr_market::handle_buy(ctx, side, shares, max_cost)
    }

    /// Sell `shares` of a held position back to the maker; fails if the return is below
    /// `min_return`. Same open-market and insider checks as buy.
    pub fn sell(ctx: Context<Sell>, side: u8, shares: u64, min_return: u64) -> Result<()> {
        lmsr_market::handle_sell(ctx, side, shares, min_return)
    }

    /// Permissionless. Kind 0 settles from the agreement's status; kind 1 from the MarketEvidence-v1
    /// attestations passed as remaining accounts (one settles, two that disagree void). Without a
    /// settling state or evidence, NO once `closes_at + grace_seconds` has passed.
    pub fn resolve_lmsr(ctx: Context<ResolveLmsr>) -> Result<()> {
        lmsr_market::handle_resolve_lmsr(ctx)
    }

    /// Pay a resolved position: one unit per winning share, or one half per share, floored, on VOID.
    pub fn claim_lmsr(ctx: Context<ClaimLmsr>) -> Result<()> {
        lmsr_market::handle_claim_lmsr(ctx)
    }

    /// Creator only, after resolution: everything in the vault beyond what unclaimed positions are
    /// owed goes back to the creator.
    pub fn reclaim_seed(ctx: Context<ReclaimSeed>) -> Result<()> {
        lmsr_market::handle_reclaim_seed(ctx)
    }
}

/// Parimutuel payout, in u128 so `amount * total` cannot overflow. Floors, so the sum of all
/// payouts never exceeds the vault; rounding dust stays behind.
pub fn payout_amount(side: u8, amount: u64, yes_pool: u64, no_pool: u64, outcome: u8) -> Result<u64> {
    let (winning_pool, losing_pool) = if outcome == SIDE_YES { (yes_pool, no_pool) } else { (no_pool, yes_pool) };
    if winning_pool == 0 {
        // Nobody backed the outcome: every position is refunded in full.
        return Ok(amount);
    }
    if side != outcome {
        return Ok(0);
    }
    let total = (winning_pool as u128) + (losing_pool as u128);
    let payout = (amount as u128)
        .checked_mul(total)
        .ok_or(MarketError::MathOverflow)?
        / (winning_pool as u128);
    u64::try_from(payout).map_err(|_| error!(MarketError::MathOverflow))
}

/// Read `subject` as an Agreement of the agreement program (owner, discriminator and layout are
/// agreement::read_agreement_view's checks) and, when `expected` is given, require it to be the
/// market's own. Returns the sponsor, lens and status byte that resolution, kind 0 trading and the
/// LMSR insider rule read.
pub(crate) fn read_subject(subject: &AccountInfo, expected: Option<&Pubkey>) -> Result<agreement::AgreementView> {
    if let Some(expected_key) = expected {
        require_keys_eq!(subject.key(), *expected_key, MarketError::InvalidProposalAccount);
    }
    agreement::read_agreement_view(subject).ok_or_else(|| error!(MarketError::InvalidProposalAccount))
}

/// Map a shared SAS parser error onto this program's error codes.
fn sas_error(error: SasError) -> Error {
    match error {
        SasError::InvalidAccount => error!(MarketError::InvalidSasAccount),
        SasError::InvalidPayload => error!(MarketError::InvalidEvidencePayload),
        SasError::WrongCredential => error!(MarketError::WrongEvidenceCredential),
        SasError::SchemaPaused => error!(MarketError::SchemaPaused),
    }
}

fn validate_sas_schema(credential: &AccountInfo, schema: &AccountInfo) -> Result<()> {
    require_keys_eq!(*credential.owner, SAS_PROGRAM_ID, MarketError::InvalidSasAccount);
    let credential_data = credential.try_borrow_data()?;
    require!(credential_data.first() == Some(&SAS_CREDENTIAL_DISCRIMINATOR), MarketError::InvalidSasAccount);
    validate_sas_schema_data(schema, &credential.key())
}

fn validate_sas_schema_data(schema: &AccountInfo, expected_credential: &Pubkey) -> Result<()> {
    require_keys_eq!(*schema.owner, SAS_PROGRAM_ID, MarketError::InvalidSasAccount);
    let schema_data = schema.try_borrow_data()?;
    validate_sas_schema_bytes(&schema_data, expected_credential)
}

fn validate_sas_schema_bytes(schema_data: &[u8], expected_credential: &Pubkey) -> Result<()> {
    sas_attestation::validate_schema_bytes(schema_data, expected_credential).map_err(sas_error)
}

struct SasCourtEvidence {
    credential: Pubkey,
    schema: Pubkey,
    authority: Pubkey,
    expiry: i64,
    subject_hash: [u8; 32],
    value_hash: [u8; 32],
    source_observed_at: Option<i64>,
    account_hash: [u8; 32],
}

fn read_sas_court_evidence(attestation: &AccountInfo) -> Result<SasCourtEvidence> {
    require_keys_eq!(*attestation.owner, SAS_PROGRAM_ID, MarketError::InvalidSasAccount);
    let data = attestation.try_borrow_data()?;
    parse_sas_court_evidence(&data)
}

fn parse_sas_court_evidence(data: &[u8]) -> Result<SasCourtEvidence> {
    let attestation = sas_attestation::parse_attestation(data).map_err(sas_error)?;

    // CourtParcelOperationV1: string parcelUid, string decisionUuid, string operation,
    // string decisionLink.
    // CourtParcelOperationV2 appends int64 sourceObservedAt. The schema account bound into the
    // market determines which payload SAS can issue; accepting both shapes keeps already-created
    // V1 markets resolvable while V2 markets gain an on-chain temporal-integrity check.
    let mut payload = sas_attestation::PayloadReader::new(attestation.payload);
    let parcel_uid = payload.string().map_err(sas_error)?;
    let _decision_uuid = payload.string().map_err(sas_error)?;
    let operation = payload.string().map_err(sas_error)?;
    let _decision_link = payload.string().map_err(sas_error)?;
    let source_observed_at = if payload.is_at_end() {
        None
    } else {
        let timestamp = payload.i64().map_err(sas_error)?;
        payload.finish().map_err(sas_error)?;
        require!(timestamp > 0, MarketError::InvalidEvidencePayload);
        Some(timestamp)
    };

    Ok(SasCourtEvidence {
        credential: attestation.credential,
        schema: attestation.schema,
        authority: attestation.authority,
        expiry: attestation.expiry,
        subject_hash: hash(parcel_uid).to_bytes(),
        value_hash: hash(operation).to_bytes(),
        source_observed_at,
        account_hash: hash(data).to_bytes(),
    })
}

fn validate_source_chronology(source_observed_at: Option<i64>, closes_at: i64, now: i64) -> Result<()> {
    if let Some(observed_at) = source_observed_at {
        require!(observed_at >= closes_at, MarketError::EvidencePredatesMarketClose);
        require!(observed_at <= now, MarketError::EvidenceFromFuture);
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub proposal: Pubkey,
    pub stake_mint: Pubkey,
    pub vault: Pubkey,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub resolved: bool,
    pub outcome: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ExternalMarket {
    pub stake_mint: Pubkey,
    pub vault: Pubkey,
    pub recipe_hash: [u8; 32],
    pub subject_hash: [u8; 32],
    pub yes_value_hash: [u8; 32],
    pub no_value_hash: [u8; 32],
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub trusted_attester: Pubkey,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub closes_at: i64,
    pub resolved: bool,
    pub outcome: u8,
    pub evidence: Pubkey,
    pub evidence_hash: [u8; 32],
    pub resolved_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, proposal.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: the agreement (an agreement-program Agreement); owner, discriminator and status are
    /// verified in the handler.
    pub proposal: UncheckedAccount<'info>,
    pub stake_mint: Account<'info, Mint>,
    // init_if_needed: the vault ATA's address is predictable, so anyone can create it first; `init`
    // would then fail forever and block the market. Anchor still verifies mint and authority.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = stake_mint,
        associated_token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct Stake<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.proposal.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: verified against market.proposal in the handler.
    pub proposal: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), staker.key().as_ref(), &[side]],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = market.stake_mint, token::authority = staker)]
    pub staker_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.proposal.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: verified against market.proposal in the handler.
    pub proposal: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [MARKET_SEED, market.proposal.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), claimer.key().as_ref(), &[position.side]],
        bump = position.bump,
        has_one = market @ MarketError::InvalidPosition,
        constraint = position.owner == claimer.key() @ MarketError::InvalidPosition
    )]
    pub position: Account<'info, Position>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = market.stake_mint, token::authority = claimer)]
    pub claimer_token_account: Account<'info, TokenAccount>,
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(recipe_hash: [u8; 32])]
pub struct CreateExternalMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + ExternalMarket::INIT_SPACE,
        seeds = [EXTERNAL_MARKET_SEED, recipe_hash.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, ExternalMarket>>,
    pub stake_mint: Account<'info, Mint>,
    // init_if_needed: the vault ATA's address is predictable, so anyone can create it first; `init`
    // would then fail forever and block the market. Anchor still verifies mint and authority.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = stake_mint,
        associated_token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: owner, discriminator and key embedded in schema are checked in the handler.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: owner, discriminator and embedded credential are checked in the handler.
    pub schema: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct StakeExternal<'info> {
    #[account(mut, seeds = [EXTERNAL_MARKET_SEED, market.recipe_hash.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, ExternalMarket>>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), staker.key().as_ref(), &[side]],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = market.stake_mint, token::authority = staker)]
    pub staker_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveExternal<'info> {
    #[account(mut, seeds = [EXTERNAL_MARKET_SEED, market.recipe_hash.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, ExternalMarket>>,
    /// CHECK: SAS owner, discriminator and complete relevant payload are checked in the handler.
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: key, SAS owner, credential relation, layout and paused state are checked in handler.
    pub schema: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimExternal<'info> {
    #[account(seeds = [EXTERNAL_MARKET_SEED, market.recipe_hash.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, ExternalMarket>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), claimer.key().as_ref(), &[position.side]],
        bump = position.bump,
        has_one = market @ MarketError::InvalidPosition,
        constraint = position.owner == claimer.key() @ MarketError::InvalidPosition
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = market.stake_mint, token::authority = claimer)]
    pub claimer_token_account: Account<'info, TokenAccount>,
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct ExternalMarketResolved {
    pub market: Pubkey,
    pub recipe_hash: [u8; 32],
    pub evidence: Pubkey,
    pub evidence_hash: [u8; 32],
    pub outcome: u8,
    pub resolved_at: i64,
}

#[error_code]
pub enum MarketError {
    #[msg("The proposal account is not an agreement-program Agreement (or not this market's)")]
    InvalidProposalAccount,
    #[msg("The agreement is not Active")]
    ProposalNotActive,
    #[msg("The agreement has not reached a terminal state (Executed, Cancelled or Expired)")]
    NotTerminal,
    #[msg("Side must be 0 (NO) or 1 (YES)")]
    InvalidSide,
    #[msg("Stake amount must be positive")]
    ZeroAmount,
    #[msg("The market is already resolved")]
    MarketResolved,
    #[msg("The market is not resolved yet")]
    MarketNotResolved,
    #[msg("This position was already claimed")]
    AlreadyClaimed,
    #[msg("This position did not win and the winning pool is not empty")]
    NothingToClaim,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The position does not belong to this market and claimer")]
    InvalidPosition,
    #[msg("The market commitment cannot be empty")]
    EmptyCommitment,
    #[msg("YES and NO cannot commit to the same evidence value")]
    AmbiguousOutcomes,
    #[msg("The market close time must be in the future")]
    InvalidCloseTime,
    #[msg("Trading on this market has closed")]
    MarketClosed,
    #[msg("The market is still open for trading")]
    MarketStillOpen,
    #[msg("The supplied account is not a valid SAS account")]
    InvalidSasAccount,
    #[msg("The attestation was issued under a different credential")]
    WrongEvidenceCredential,
    #[msg("The attestation uses a different schema")]
    WrongEvidenceSchema,
    #[msg("The attestation issuer is not in this market's Lens")]
    UntrustedAttester,
    #[msg("The attestation has expired")]
    ExpiredEvidence,
    #[msg("The attestation schema is paused")]
    SchemaPaused,
    #[msg("The attestation is about a different subject")]
    WrongEvidenceSubject,
    #[msg("The attestation value maps to neither committed outcome")]
    UnsupportedEvidenceValue,
    #[msg("The attestation payload does not match CourtParcelOperationV1 or V2")]
    InvalidEvidencePayload,
    #[msg("The source record was observed before this market closed")]
    EvidencePredatesMarketClose,
    #[msg("The source-observation timestamp is in the future")]
    EvidenceFromFuture,
    #[msg("The trusted attester is not the bound agreement's lens")]
    AttesterNotInProposalLens,
    // LMSR market (lmsr-market.md). Appended after the deployed variants so their codes stay fixed.
    #[msg("Liquidity b must be positive")]
    ZeroLiquidity,
    #[msg("Liquidity b exceeds the market maker's bound of 10^16")]
    LiquidityTooLarge,
    #[msg("The creator's token balance cannot fund the seed, max_loss(b)")]
    SeedTooSmall,
    #[msg("The buy costs more than max_cost")]
    CostExceedsMax,
    #[msg("The sale returns less than min_return")]
    ReturnBelowMin,
    #[msg("The position holds fewer shares than this sale")]
    SellExceedsPosition,
    #[msg("The position would exceed this market's per-wallet cap")]
    PositionCapExceeded,
    #[msg("The agreement's sponsor, its lens and the market's attester cannot trade it")]
    InsiderTrade,
    #[msg("No settling state or evidence, and the deadline plus grace has not passed")]
    GraceNotElapsed,
    #[msg("The attestation answers a different recipe")]
    WrongEvidenceRecipe,
    #[msg("The attestation payload does not match MarketEvidence-v1")]
    InvalidMarketEvidencePayload,
    #[msg("The attested event happened after the market's deadline")]
    EventAfterDeadline,
    #[msg("The source was observed before the event it reports")]
    EvidenceObservedBeforeEvent,
    #[msg("Pass at most two evidence attestations")]
    TooMuchEvidence,
    #[msg("This position pays nothing under the market's outcome")]
    PositionPaysNothing,
    #[msg("Only the market's creator can reclaim its seed")]
    NotCreator,
    #[msg("The vault holds nothing beyond what open positions are owed")]
    NothingToReclaim,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn borsh_string(value: &str) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4 + value.len());
        bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
        bytes
    }

    fn sas_attestation(parcel_uid: &str, operation: &str) -> (Vec<u8>, Pubkey, Pubkey, Pubkey) {
        sas_attestation_with_source_time(parcel_uid, operation, None)
    }

    fn sas_attestation_with_source_time(
        parcel_uid: &str,
        operation: &str,
        source_observed_at: Option<i64>,
    ) -> (Vec<u8>, Pubkey, Pubkey, Pubkey) {
        let credential = Pubkey::new_from_array([4; 32]);
        let schema = Pubkey::new_from_array([5; 32]);
        let authority = Pubkey::new_from_array([6; 32]);
        let mut payload = Vec::new();
        for value in [parcel_uid, "decision-42", operation, "https://court.example/42"] {
            payload.extend_from_slice(&borsh_string(value));
        }
        if let Some(timestamp) = source_observed_at {
            payload.extend_from_slice(&timestamp.to_le_bytes());
        }
        let mut data = vec![0; 101];
        data[0] = SAS_ATTESTATION_DISCRIMINATOR;
        data[33..65].copy_from_slice(credential.as_ref());
        data[65..97].copy_from_slice(schema.as_ref());
        data[97..101].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        data.extend_from_slice(&payload);
        data.extend_from_slice(authority.as_ref());
        data.extend_from_slice(&2_000_000_000i64.to_le_bytes());
        (data, credential, schema, authority)
    }

    fn sas_schema(credential: &Pubkey, paused: bool) -> Vec<u8> {
        let mut data = vec![SAS_SCHEMA_DISCRIMINATOR];
        data.extend_from_slice(credential.as_ref());
        for value in ["CourtParcelOperation", "Court decision parcel operation", "layout", "fields"] {
            data.extend_from_slice(&borsh_string(value));
        }
        data.push(u8::from(paused));
        data.push(1);
        data
    }

    #[test]
    fn accepts_active_sas_schema_and_rejects_paused_or_wrong_credential() {
        let credential = Pubkey::new_from_array([4; 32]);
        assert!(validate_sas_schema_bytes(&sas_schema(&credential, false), &credential).is_ok());
        assert!(validate_sas_schema_bytes(&sas_schema(&credential, true), &credential).is_err());
        assert!(validate_sas_schema_bytes(&sas_schema(&credential, false), &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn parses_and_hashes_the_court_sas_payload_used_for_resolution() {
        let (data, credential, schema, authority) = sas_attestation("HR-335347-1208/3", "transfer");
        let evidence = parse_sas_court_evidence(&data).unwrap();
        assert_eq!(evidence.credential, credential);
        assert_eq!(evidence.schema, schema);
        assert_eq!(evidence.authority, authority);
        assert_eq!(evidence.expiry, 2_000_000_000);
        assert_eq!(evidence.subject_hash, hash(b"HR-335347-1208/3").to_bytes());
        assert_eq!(evidence.value_hash, hash(b"transfer").to_bytes());
        assert_eq!(evidence.source_observed_at, None);
        assert_eq!(evidence.account_hash, hash(&data).to_bytes());
    }

    #[test]
    fn parses_v2_source_time_and_enforces_prospective_chronology() {
        let (data, _, _, _) = sas_attestation_with_source_time(
            "HR-335347-1208/3",
            "transfer",
            Some(1_900_000_100),
        );
        let evidence = parse_sas_court_evidence(&data).unwrap();
        assert_eq!(evidence.source_observed_at, Some(1_900_000_100));
        assert!(validate_source_chronology(evidence.source_observed_at, 1_900_000_000, 1_900_000_200).is_ok());
        assert!(validate_source_chronology(evidence.source_observed_at, 1_900_000_101, 1_900_000_200).is_err());
        assert!(validate_source_chronology(evidence.source_observed_at, 1_900_000_000, 1_900_000_099).is_err());
    }

    #[test]
    fn rejects_truncated_or_schema_extended_sas_payloads() {
        let (mut truncated, _, _, _) = sas_attestation("HR-335347-1208/3", "transfer");
        truncated.truncate(truncated.len() - 45);
        assert!(parse_sas_court_evidence(&truncated).is_err());

        let (mut extended, _, _, _) = sas_attestation("HR-335347-1208/3", "transfer");
        let payload_len = u32::from_le_bytes(extended[97..101].try_into().unwrap()) as usize;
        extended[97..101].copy_from_slice(&((payload_len + 1) as u32).to_le_bytes());
        extended.insert(101 + payload_len, 0);
        assert!(parse_sas_court_evidence(&extended).is_err());
    }

    #[test]
    fn winners_split_the_whole_pot_pro_rata() {
        // YES pool 300 (a: 100, b: 200), NO pool 600, outcome YES → total 900.
        assert_eq!(payout_amount(SIDE_YES, 100, 300, 600, SIDE_YES).unwrap(), 300);
        assert_eq!(payout_amount(SIDE_YES, 200, 300, 600, SIDE_YES).unwrap(), 600);
        assert_eq!(payout_amount(SIDE_NO, 600, 300, 600, SIDE_YES).unwrap(), 0);
    }

    #[test]
    fn everyone_on_the_winning_side_gets_exactly_their_stake_back_when_nobody_lost() {
        assert_eq!(payout_amount(SIDE_NO, 50, 0, 50, SIDE_NO).unwrap(), 50);
    }

    #[test]
    fn empty_winning_pool_refunds_every_position() {
        assert_eq!(payout_amount(SIDE_YES, 70, 70, 0, SIDE_NO).unwrap(), 70);
        assert_eq!(payout_amount(SIDE_NO, 40, 0, 40, SIDE_YES).unwrap(), 40);
    }

    #[test]
    fn payouts_floor_and_never_exceed_the_vault() {
        // YES pool 3 (1 + 2), NO pool 1, outcome YES → total 4: 1*4/3 = 1, 2*4/3 = 2, sum 3 ≤ 4.
        let a = payout_amount(SIDE_YES, 1, 3, 1, SIDE_YES).unwrap();
        let b = payout_amount(SIDE_YES, 2, 3, 1, SIDE_YES).unwrap();
        assert_eq!((a, b), (1, 2));
        assert!(a + b <= 4);
    }

    #[test]
    fn large_pools_do_not_overflow() {
        let big = u64::MAX / 2;
        assert_eq!(payout_amount(SIDE_YES, big, big, big, SIDE_YES).unwrap(), big * 2);
    }
}
