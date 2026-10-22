// The LMSR market of proposal_market (design of record: lmsr-market.md at the repository root):
// dated yes/no markets priced by the fixed-point maker in lmsr.rs, seeded by their creator with the
// maker's worst-case loss, settled from an agreement's on-chain state (kind 0) or from
// MarketEvidence-v1 attestations against committed recipe hashes (kind 1). The instructions are
// declared in lib.rs's #[program] module and delegate to the handlers here.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sas_attestation::{PayloadReader, SasError};

use crate::lmsr::{self, LmsrError};
use crate::{
    read_subject, sas_error, validate_sas_schema, validate_sas_schema_data, MarketError, Position, SAS_PROGRAM_ID,
    SIDE_NO, SIDE_YES, STATUS_ACTIVE, STATUS_CANCELLED, STATUS_EXECUTED, STATUS_EXPIRED,
};

/// LmsrMarket PDA: ["lmsr", agreement] for kind 0, ["lmsr", recipe_hash] for kind 1.
pub const LMSR_SEED: &[u8] = b"lmsr";
/// LMSR positions reuse the Position layout under their own prefix, so they can never collide
/// with a parimutuel position: ["lmsr_position", market, owner, [side]].
pub const LMSR_POSITION_SEED: &[u8] = b"lmsr_position";

/// `LmsrMarket.kind`: settles from the status of the agreement (the `proposal` account).
pub const KIND_PROPOSAL: u8 = 0;
/// `LmsrMarket.kind`: settles from MarketEvidence-v1 attestations against the committed recipe.
pub const KIND_RECIPE: u8 = 1;

/// `LmsrMarket.outcome`: SIDE_NO (0) and SIDE_YES (1), or VOID, which pays one half per share.
pub const OUTCOME_VOID: u8 = 2;

/// One qualifying attestation settles a kind 1 market; two with different values void it.
pub const MAX_EVIDENCE: usize = 2;

#[account]
#[derive(InitSpace)]
pub struct LmsrMarket {
    /// KIND_PROPOSAL or KIND_RECIPE.
    pub kind: u8,
    /// The agreement for kind 0; for kind 1 the optional bound agreement (default when unbound).
    pub proposal: Pubkey,
    /// Deposited the seed and reclaims what the payouts leave.
    pub creator: Pubkey,
    pub stake_mint: Pubkey,
    pub vault: Pubkey,
    /// Liquidity, in the stake token's atomic units.
    pub b: u64,
    /// Outstanding shares per side; a winning share pays one atomic unit.
    pub q_yes: u64,
    pub q_no: u64,
    /// The creator's deposit, max_loss(b).
    pub seed: u64,
    /// Last trade, and the question's deadline.
    pub closes_at: i64,
    /// After closes_at + grace_seconds, absence of evidence settles NO.
    pub grace_seconds: u32,
    /// Shares per wallet per side, 0 for no cap.
    pub max_position: u64,
    /// Kind 1 commitments, as in ExternalMarket (zero for kind 0).
    pub recipe_hash: [u8; 32],
    pub subject_hash: [u8; 32],
    pub yes_value_hash: [u8; 32],
    pub no_value_hash: [u8; 32],
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub trusted_attester: Pubkey,
    pub resolved: bool,
    /// SIDE_NO, SIDE_YES or OUTCOME_VOID once resolved.
    pub outcome: u8,
    pub resolved_at: i64,
    /// The (first) attestation a kind 1 market settled on and the sha256 of its account bytes;
    /// default and zero for kind 0 and for NO by absence. A second attestation is in the event.
    pub evidence: Pubkey,
    pub evidence_hash: [u8; 32],
    /// Claims paid so far, for the creator's reclaim.
    pub paid_out: u64,
    pub bump: u8,
}

impl LmsrMarket {
    /// The second PDA seed: the agreement for kind 0, the recipe hash for kind 1.
    pub fn seed_key(&self) -> [u8; 32] {
        if self.kind == KIND_PROPOSAL {
            self.proposal.to_bytes()
        } else {
            self.recipe_hash
        }
    }

    /// From this instant absence of evidence settles NO (creation rejects an overflowing sum).
    pub fn grace_ends_at(&self) -> i64 {
        self.closes_at.saturating_add(i64::from(self.grace_seconds))
    }
}

/// What a resolved position collects: one atomic unit per share on the winning side, nothing on
/// the other, and one half per share, floored, on either side of a VOID.
pub fn lmsr_payout(side: u8, shares: u64, outcome: u8) -> u64 {
    if outcome == OUTCOME_VOID {
        shares / 2
    } else if side == outcome {
        shares
    } else {
        0
    }
}

/// What the vault owes every position together once resolved: the winning side's shares, or for a
/// VOID one half of each side, floored per side, which covers every position's floored half.
pub fn lmsr_obligation(q_yes: u64, q_no: u64, outcome: u8) -> u64 {
    match outcome {
        SIDE_YES => q_yes,
        SIDE_NO => q_no,
        _ => q_yes / 2 + q_no / 2,
    }
}

/// Kind 0 settlement policy (lmsr-market.md "Cancellation: decided VOID, with a refinement to
/// confirm"): Executed → YES, Expired → NO, Cancelled → VOID per the 2026-10-12 decision
/// (streamline B2). The doc's open alternative, NO with a cancellation notice period, is a change
/// to the Cancelled arm only. None: not terminal, so only the deadline plus grace can settle it.
pub fn proposal_outcome(status: u8) -> Option<u8> {
    match status {
        STATUS_EXECUTED => Some(SIDE_YES),
        STATUS_EXPIRED => Some(SIDE_NO),
        STATUS_CANCELLED => Some(OUTCOME_VOID),
        _ => None,
    }
}

fn lmsr_error(error: LmsrError) -> Error {
    match error {
        LmsrError::ZeroLiquidity => error!(MarketError::ZeroLiquidity),
        LmsrError::InputTooLarge => error!(MarketError::LiquidityTooLarge),
        LmsrError::InvalidSide => error!(MarketError::InvalidSide),
        LmsrError::Overflow => error!(MarketError::MathOverflow),
        LmsrError::SellExceedsHeld => error!(MarketError::SellExceedsPosition),
    }
}

/// The seed, max_loss(b), after checking the terms both kinds share: b > 0 and at most the maker's
/// MAX_LIQUIDITY, a close time in the future, and a grace end that fits in an i64.
fn check_market_terms(b: u64, closes_at: i64, grace_seconds: u32) -> Result<u64> {
    require!(b > 0, MarketError::ZeroLiquidity);
    let seed = lmsr::max_loss(b).map_err(lmsr_error)?;
    require!(closes_at > Clock::get()?.unix_timestamp, MarketError::InvalidCloseTime);
    require!(closes_at.checked_add(i64::from(grace_seconds)).is_some(), MarketError::InvalidCloseTime);
    Ok(seed)
}

fn deposit_seed<'info>(
    from: &Account<'info, TokenAccount>,
    vault: &Account<'info, TokenAccount>,
    creator: &Signer<'info>,
    token_program: &Program<'info, Token>,
    seed: u64,
) -> Result<()> {
    require!(from.amount >= seed, MarketError::SeedTooSmall);
    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: vault.to_account_info(),
                authority: creator.to_account_info(),
            },
        ),
        seed,
    )
}

/// Pay `amount` out of the vault, signed by the market PDA.
fn pay_from_vault<'info>(
    market: &Account<'info, LmsrMarket>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let key = market.seed_key();
    let bump = [market.bump];
    let seeds: &[&[u8]] = &[LMSR_SEED, key.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// The checks buy and sell share: the market is unresolved and before closes_at, `subject` is the
/// market's own agreement (the System Program id for an unbound kind 1 market), and the trader is
/// not an insider (streamline B3): the trusted attester of any kind 1 market, and the agreement's
/// sponsor and lens, read at trade time, for kind 0 and bound kind 1. Kind 0 also needs the
/// agreement still Active: once it is terminal the outcome is known and a trade would only take the
/// seed.
fn check_trade(market: &LmsrMarket, subject: &AccountInfo, trader: &Pubkey) -> Result<()> {
    require!(!market.resolved, MarketError::MarketResolved);
    require!(Clock::get()?.unix_timestamp < market.closes_at, MarketError::MarketClosed);
    require_keys_eq!(subject.key(), market.proposal, MarketError::InvalidProposalAccount);
    if market.kind == KIND_RECIPE {
        require_keys_neq!(*trader, market.trusted_attester, MarketError::InsiderTrade);
    }
    if market.kind == KIND_PROPOSAL || market.proposal != Pubkey::default() {
        let view = read_subject(subject, None)?;
        require_keys_neq!(*trader, view.authority, MarketError::InsiderTrade);
        require_keys_neq!(*trader, view.lens, MarketError::InsiderTrade);
        if market.kind == KIND_PROPOSAL {
            require!(view.status == STATUS_ACTIVE, MarketError::ProposalNotActive);
        }
    }
    Ok(())
}

pub(crate) fn handle_create_lmsr_market(
    ctx: Context<CreateLmsrMarket>,
    b: u64,
    closes_at: i64,
    grace_seconds: u32,
    max_position: u64,
) -> Result<()> {
    let seed = check_market_terms(b, closes_at, grace_seconds)?;
    let status = read_subject(&ctx.accounts.proposal, None)?.status;
    require!(status == STATUS_ACTIVE, MarketError::ProposalNotActive);
    deposit_seed(
        &ctx.accounts.creator_token_account,
        &ctx.accounts.vault,
        &ctx.accounts.creator,
        &ctx.accounts.token_program,
        seed,
    )?;

    let market = &mut ctx.accounts.market;
    market.kind = KIND_PROPOSAL;
    market.proposal = ctx.accounts.proposal.key();
    market.creator = ctx.accounts.creator.key();
    market.stake_mint = ctx.accounts.stake_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.b = b;
    market.q_yes = 0;
    market.q_no = 0;
    market.seed = seed;
    market.closes_at = closes_at;
    market.grace_seconds = grace_seconds;
    market.max_position = max_position;
    market.recipe_hash = [0; 32];
    market.subject_hash = [0; 32];
    market.yes_value_hash = [0; 32];
    market.no_value_hash = [0; 32];
    market.credential = Pubkey::default();
    market.schema = Pubkey::default();
    market.trusted_attester = Pubkey::default();
    market.resolved = false;
    market.outcome = SIDE_NO;
    market.resolved_at = 0;
    market.evidence = Pubkey::default();
    market.evidence_hash = [0; 32];
    market.paid_out = 0;
    market.bump = ctx.bumps.market;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_create_lmsr_external_market(
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
    require!(recipe_hash != [0; 32], MarketError::EmptyCommitment);
    require!(subject_hash != [0; 32], MarketError::EmptyCommitment);
    require!(yes_value_hash != [0; 32] && no_value_hash != [0; 32], MarketError::EmptyCommitment);
    require!(yes_value_hash != no_value_hash, MarketError::AmbiguousOutcomes);
    require!(trusted_attester != Pubkey::default(), MarketError::EmptyCommitment);
    let seed = check_market_terms(b, closes_at, grace_seconds)?;
    validate_sas_schema(&ctx.accounts.credential, &ctx.accounts.schema)?;
    // Optional remaining account 0, as in create_external_market: an agreement whose lens must be
    // the attester. Unlike ExternalMarket the binding is stored, because buy and sell read the
    // agreement's sponsor and lens from it to bar insiders.
    let proposal = match ctx.remaining_accounts.first() {
        Some(subject) => {
            let view = read_subject(subject, None)?;
            require_keys_eq!(view.lens, trusted_attester, MarketError::AttesterNotInProposalLens);
            subject.key()
        }
        None => Pubkey::default(),
    };
    deposit_seed(
        &ctx.accounts.creator_token_account,
        &ctx.accounts.vault,
        &ctx.accounts.creator,
        &ctx.accounts.token_program,
        seed,
    )?;

    let market = &mut ctx.accounts.market;
    market.kind = KIND_RECIPE;
    market.proposal = proposal;
    market.creator = ctx.accounts.creator.key();
    market.stake_mint = ctx.accounts.stake_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.b = b;
    market.q_yes = 0;
    market.q_no = 0;
    market.seed = seed;
    market.closes_at = closes_at;
    market.grace_seconds = grace_seconds;
    market.max_position = max_position;
    market.recipe_hash = recipe_hash;
    market.subject_hash = subject_hash;
    market.yes_value_hash = yes_value_hash;
    market.no_value_hash = no_value_hash;
    market.credential = ctx.accounts.credential.key();
    market.schema = ctx.accounts.schema.key();
    market.trusted_attester = trusted_attester;
    market.resolved = false;
    market.outcome = SIDE_NO;
    market.resolved_at = 0;
    market.evidence = Pubkey::default();
    market.evidence_hash = [0; 32];
    market.paid_out = 0;
    market.bump = ctx.bumps.market;
    Ok(())
}

pub(crate) fn handle_buy(ctx: Context<Buy>, side: u8, shares: u64, max_cost: u64) -> Result<()> {
    require!(side == SIDE_YES || side == SIDE_NO, MarketError::InvalidSide);
    require!(shares > 0, MarketError::ZeroAmount);
    let (cost, max_position) = {
        let market = &ctx.accounts.market;
        check_trade(market, &ctx.accounts.proposal, &ctx.accounts.trader.key())?;
        let cost = lmsr::buy_cost(market.b, market.q_yes, market.q_no, side, shares).map_err(lmsr_error)?;
        (cost, market.max_position)
    };
    require!(cost <= max_cost, MarketError::CostExceedsMax);

    let market_key = ctx.accounts.market.key();
    let position = &mut ctx.accounts.position;
    if position.market == Pubkey::default() {
        // Fresh (init_if_needed just created it) — the PDA seeds pin market, owner and side.
        position.market = market_key;
        position.owner = ctx.accounts.trader.key();
        position.side = side;
        position.claimed = false;
        position.bump = ctx.bumps.position;
    }
    position.amount = position.amount.checked_add(shares).ok_or(MarketError::MathOverflow)?;
    require!(max_position == 0 || position.amount <= max_position, MarketError::PositionCapExceeded);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        cost,
    )?;

    let market = &mut ctx.accounts.market;
    if side == SIDE_YES {
        market.q_yes = market.q_yes.checked_add(shares).ok_or(MarketError::MathOverflow)?;
    } else {
        market.q_no = market.q_no.checked_add(shares).ok_or(MarketError::MathOverflow)?;
    }
    Ok(())
}

pub(crate) fn handle_sell(ctx: Context<Sell>, side: u8, shares: u64, min_return: u64) -> Result<()> {
    require!(side == SIDE_YES || side == SIDE_NO, MarketError::InvalidSide);
    require!(shares > 0, MarketError::ZeroAmount);
    let proceeds = {
        let market = &ctx.accounts.market;
        check_trade(market, &ctx.accounts.proposal, &ctx.accounts.trader.key())?;
        require!(ctx.accounts.position.amount >= shares, MarketError::SellExceedsPosition);
        lmsr::sell_return(market.b, market.q_yes, market.q_no, side, shares).map_err(lmsr_error)?
    };
    require!(proceeds >= min_return, MarketError::ReturnBelowMin);

    let position = &mut ctx.accounts.position;
    position.amount -= shares;
    let market = &mut ctx.accounts.market;
    if side == SIDE_YES {
        market.q_yes -= shares;
    } else {
        market.q_no -= shares;
    }

    if proceeds > 0 {
        pay_from_vault(
            &ctx.accounts.market,
            &ctx.accounts.vault,
            &ctx.accounts.trader_token_account,
            &ctx.accounts.token_program,
            proceeds,
        )?;
    }
    Ok(())
}

/// The outcome a resolution settles on and the attestations behind it.
struct Settlement {
    outcome: u8,
    evidence: Pubkey,
    evidence_hash: [u8; 32],
    second_evidence: Pubkey,
    second_evidence_hash: [u8; 32],
}

impl Settlement {
    /// Settled by the agreement's status or by absence: no attestation behind it.
    fn without_evidence(outcome: u8) -> Self {
        Self {
            outcome,
            evidence: Pubkey::default(),
            evidence_hash: [0; 32],
            second_evidence: Pubkey::default(),
            second_evidence_hash: [0; 32],
        }
    }
}

pub(crate) fn handle_resolve_lmsr(ctx: Context<ResolveLmsr>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let settlement = {
        let market = &ctx.accounts.market;
        require!(!market.resolved, MarketError::MarketResolved);
        require_keys_eq!(ctx.accounts.proposal.key(), market.proposal, MarketError::InvalidProposalAccount);
        require_keys_eq!(ctx.accounts.schema.key(), market.schema, MarketError::WrongEvidenceSchema);
        if market.kind == KIND_PROPOSAL {
            let status = read_subject(&ctx.accounts.proposal, Some(&market.proposal))?.status;
            match proposal_outcome(status) {
                Some(outcome) => Settlement::without_evidence(outcome),
                None => {
                    require!(now >= market.grace_ends_at(), MarketError::GraceNotElapsed);
                    Settlement::without_evidence(SIDE_NO)
                }
            }
        } else {
            settle_from_evidence(market, &ctx.accounts.schema, ctx.remaining_accounts, now)?
        }
    };

    let market = &mut ctx.accounts.market;
    market.resolved = true;
    market.outcome = settlement.outcome;
    market.resolved_at = now;
    market.evidence = settlement.evidence;
    market.evidence_hash = settlement.evidence_hash;

    emit!(LmsrMarketResolved {
        market: market.key(),
        kind: market.kind,
        outcome: settlement.outcome,
        evidence: settlement.evidence,
        evidence_hash: settlement.evidence_hash,
        second_evidence: settlement.second_evidence,
        second_evidence_hash: settlement.second_evidence_hash,
        resolved_at: now,
    });
    Ok(())
}

/// Kind 1 (lmsr-market.md "Evidence for kind 1"): every attestation passed must qualify; one
/// settles on its committed outcome at any time, two with different values void the market, and
/// none settles NO once the deadline plus grace has passed.
fn settle_from_evidence(market: &LmsrMarket, schema: &AccountInfo, attestations: &[AccountInfo], now: i64) -> Result<Settlement> {
    require!(attestations.len() <= MAX_EVIDENCE, MarketError::TooMuchEvidence);
    let Some(first) = attestations.first() else {
        require!(now >= market.grace_ends_at(), MarketError::GraceNotElapsed);
        return Ok(Settlement::without_evidence(SIDE_NO));
    };
    validate_sas_schema_data(schema, &market.credential)?;
    let first = qualify_evidence(market, first, now)?;
    let mut settlement = Settlement {
        outcome: first.outcome,
        evidence: first.attestation,
        evidence_hash: first.account_hash,
        second_evidence: Pubkey::default(),
        second_evidence_hash: [0; 32],
    };
    if let Some(second) = attestations.get(1) {
        let second = qualify_evidence(market, second, now)?;
        if second.outcome != first.outcome {
            settlement.outcome = OUTCOME_VOID;
        }
        settlement.second_evidence = second.attestation;
        settlement.second_evidence_hash = second.account_hash;
    }
    Ok(settlement)
}

/// One attestation that satisfied every kind 1 check, and the outcome it commits to.
struct QualifiedEvidence {
    attestation: Pubkey,
    outcome: u8,
    account_hash: [u8; 32],
}

fn qualify_evidence(market: &LmsrMarket, attestation: &AccountInfo, now: i64) -> Result<QualifiedEvidence> {
    require_keys_eq!(*attestation.owner, SAS_PROGRAM_ID, MarketError::InvalidSasAccount);
    let data = attestation.try_borrow_data()?;
    let evidence = parse_market_evidence(&data)?;
    require_keys_eq!(evidence.credential, market.credential, MarketError::WrongEvidenceCredential);
    require_keys_eq!(evidence.schema, market.schema, MarketError::WrongEvidenceSchema);
    require_keys_eq!(evidence.authority, market.trusted_attester, MarketError::UntrustedAttester);
    require!(evidence.expiry > now, MarketError::ExpiredEvidence);
    require!(recipe_hash_matches(evidence.recipe_hash, &market.recipe_hash), MarketError::WrongEvidenceRecipe);
    require!(evidence.subject_hash == market.subject_hash, MarketError::WrongEvidenceSubject);
    let outcome = if evidence.value_hash == market.yes_value_hash {
        SIDE_YES
    } else if evidence.value_hash == market.no_value_hash {
        SIDE_NO
    } else {
        return err!(MarketError::UnsupportedEvidenceValue);
    };
    validate_evidence_chronology(evidence.event_time, evidence.source_observed_at, market.closes_at, now)?;
    Ok(QualifiedEvidence {
        attestation: attestation.key(),
        outcome,
        account_hash: hash(&data).to_bytes(),
    })
}

/// The MarketEvidence-v1 fields resolution checks.
struct MarketEvidence<'a> {
    credential: Pubkey,
    schema: Pubkey,
    authority: Pubkey,
    expiry: i64,
    recipe_hash: &'a [u8],
    subject_hash: [u8; 32],
    value_hash: [u8; 32],
    event_time: i64,
    source_observed_at: i64,
}

/// A MarketEvidence-v1 payload error reports as such; the account-level SAS errors map as usual.
fn evidence_error(error: SasError) -> Error {
    match error {
        SasError::InvalidPayload => error!(MarketError::InvalidMarketEvidencePayload),
        other => sas_error(other),
    }
}

/// MarketEvidence-v1: string recipeHash, string subject, string value, int64 eventTime,
/// int64 sourceObservedAt, string sourceRef, borsh, consumed exactly. One schema for every
/// source: the attester's adapter did the source-specific work.
fn parse_market_evidence(data: &[u8]) -> Result<MarketEvidence<'_>> {
    let attestation = sas_attestation::parse_attestation(data).map_err(evidence_error)?;
    let mut payload = PayloadReader::new(attestation.payload);
    let recipe_hash = payload.string().map_err(evidence_error)?;
    let subject = payload.string().map_err(evidence_error)?;
    let value = payload.string().map_err(evidence_error)?;
    let event_time = payload.i64().map_err(evidence_error)?;
    let source_observed_at = payload.i64().map_err(evidence_error)?;
    let _source_ref = payload.string().map_err(evidence_error)?;
    payload.finish().map_err(evidence_error)?;
    require!(event_time > 0, MarketError::InvalidMarketEvidencePayload);

    Ok(MarketEvidence {
        credential: attestation.credential,
        schema: attestation.schema,
        authority: attestation.authority,
        expiry: attestation.expiry,
        recipe_hash,
        subject_hash: hash(subject).to_bytes(),
        value_hash: hash(value).to_bytes(),
        event_time,
        source_observed_at,
    })
}

/// `recipeHash` is "sha256:" and the recipe digest in lowercase hex, the form recipes print.
fn recipe_hash_matches(text: &[u8], expected: &[u8; 32]) -> bool {
    const PREFIX: &[u8] = b"sha256:";
    const HEX: &[u8; 16] = b"0123456789abcdef";
    text.len() == PREFIX.len() + 64
        && text.starts_with(PREFIX)
        && text[PREFIX.len()..]
            .chunks_exact(2)
            .zip(expected.iter())
            .all(|(pair, byte)| pair[0] == HEX[usize::from(byte >> 4)] && pair[1] == HEX[usize::from(byte & 0x0f)])
}

/// The event happened by the deadline, and the source was read at or after the event and not in
/// the future. Unlike the court market, evidence may predate the close: a YES settles early.
fn validate_evidence_chronology(event_time: i64, source_observed_at: i64, closes_at: i64, now: i64) -> Result<()> {
    require!(event_time <= closes_at, MarketError::EventAfterDeadline);
    require!(event_time <= source_observed_at, MarketError::EvidenceObservedBeforeEvent);
    require!(source_observed_at <= now, MarketError::EvidenceFromFuture);
    Ok(())
}

pub(crate) fn handle_claim_lmsr(ctx: Context<ClaimLmsr>) -> Result<()> {
    let payout = {
        let market = &ctx.accounts.market;
        require!(market.resolved, MarketError::MarketNotResolved);
        require!(!ctx.accounts.position.claimed, MarketError::AlreadyClaimed);
        lmsr_payout(ctx.accounts.position.side, ctx.accounts.position.amount, market.outcome)
    };
    require!(payout > 0, MarketError::PositionPaysNothing);

    ctx.accounts.position.claimed = true;
    let market = &mut ctx.accounts.market;
    market.paid_out = market.paid_out.checked_add(payout).ok_or(MarketError::MathOverflow)?;

    pay_from_vault(
        &ctx.accounts.market,
        &ctx.accounts.vault,
        &ctx.accounts.claimer_token_account,
        &ctx.accounts.token_program,
        payout,
    )
}

pub(crate) fn handle_reclaim_seed(ctx: Context<ReclaimSeed>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.resolved, MarketError::MarketNotResolved);
    // Whatever the unclaimed positions are still owed stays behind; the rest is the creator's.
    let owed = lmsr_obligation(market.q_yes, market.q_no, market.outcome)
        .checked_sub(market.paid_out)
        .ok_or(MarketError::MathOverflow)?;
    let amount = ctx.accounts.vault.amount.checked_sub(owed).ok_or(MarketError::MathOverflow)?;
    require!(amount > 0, MarketError::NothingToReclaim);

    pay_from_vault(
        &ctx.accounts.market,
        &ctx.accounts.vault,
        &ctx.accounts.creator_token_account,
        &ctx.accounts.token_program,
        amount,
    )
}

#[derive(Accounts)]
pub struct CreateLmsrMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + LmsrMarket::INIT_SPACE,
        seeds = [LMSR_SEED, proposal.key().as_ref()],
        bump
    )]
    pub market: Box<Account<'info, LmsrMarket>>,
    /// CHECK: the agreement (an agreement-program Agreement); owner, discriminator and status are
    /// verified in the handler.
    pub proposal: UncheckedAccount<'info>,
    pub stake_mint: Box<Account<'info, Mint>>,
    // init_if_needed: the vault ATA's address is predictable, so anyone can create it first; `init`
    // would then fail forever and block the market. Anchor still verifies mint and authority.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = stake_mint,
        associated_token::authority = market
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = stake_mint, token::authority = creator)]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(recipe_hash: [u8; 32])]
pub struct CreateLmsrExternalMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + LmsrMarket::INIT_SPACE,
        seeds = [LMSR_SEED, recipe_hash.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, LmsrMarket>>,
    pub stake_mint: Box<Account<'info, Mint>>,
    // init_if_needed for the same reason as in CreateLmsrMarket.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = stake_mint,
        associated_token::authority = market
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: owner, discriminator and key embedded in schema are checked in the handler.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: owner, discriminator and embedded credential are checked in the handler.
    pub schema: UncheckedAccount<'info>,
    #[account(mut, token::mint = stake_mint, token::authority = creator)]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// The market accounts below carry no seeds constraint: only create_lmsr_market and
// create_lmsr_external_market can make an account with LmsrMarket's owner and discriminator, and
// they make it at its PDA. Vaults and positions are pinned to the market they are passed with.

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct Buy<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, LmsrMarket>>,
    /// CHECK: must equal market.proposal, the agreement (the System Program id for an unbound kind 1
    /// market); its owner, discriminator and layout are verified in the handler when it is read.
    pub proposal: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + Position::INIT_SPACE,
        seeds = [LMSR_POSITION_SEED, market.key().as_ref(), trader.key().as_ref(), &[side]],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.stake_mint, token::authority = trader)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct Sell<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, LmsrMarket>>,
    /// CHECK: must equal market.proposal, as in Buy.
    pub proposal: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [LMSR_POSITION_SEED, market.key().as_ref(), trader.key().as_ref(), &[side]],
        bump = position.bump,
        has_one = market @ MarketError::InvalidPosition,
        constraint = position.owner == trader.key() @ MarketError::InvalidPosition
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.stake_mint, token::authority = trader)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,
    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Kind 1 evidence attestations (none, one or two) follow as remaining accounts.
#[derive(Accounts)]
pub struct ResolveLmsr<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, LmsrMarket>>,
    /// CHECK: must equal market.proposal, the agreement; kind 0 reads its status (owner,
    /// discriminator, layout).
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: must equal market.schema (the System Program id for kind 0); SAS owner, credential
    /// relation, layout and paused state are checked when evidence is passed.
    pub schema: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimLmsr<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, LmsrMarket>>,
    #[account(
        mut,
        seeds = [LMSR_POSITION_SEED, market.key().as_ref(), claimer.key().as_ref(), &[position.side]],
        bump = position.bump,
        has_one = market @ MarketError::InvalidPosition,
        constraint = position.owner == claimer.key() @ MarketError::InvalidPosition
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.stake_mint, token::authority = claimer)]
    pub claimer_token_account: Box<Account<'info, TokenAccount>>,
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReclaimSeed<'info> {
    #[account(has_one = creator @ MarketError::NotCreator)]
    pub market: Box<Account<'info, LmsrMarket>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.stake_mint, token::authority = creator)]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct LmsrMarketResolved {
    pub market: Pubkey,
    pub kind: u8,
    pub outcome: u8,
    /// The attestation the market settled on (default for kind 0 and for NO by absence).
    pub evidence: Pubkey,
    pub evidence_hash: [u8; 32],
    /// A second attestation passed with the first: conflicting for a VOID, else concurring.
    pub second_evidence: Pubkey,
    pub second_evidence_hash: [u8; 32],
    pub resolved_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOSES_AT: i64 = 1_900_000_000;

    fn borsh_string(value: &str) -> Vec<u8> {
        let mut bytes = (value.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(value.as_bytes());
        bytes
    }

    fn evidence_payload(recipe_hash: &str, subject: &str, value: &str, event_time: i64, observed_at: i64) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&borsh_string(recipe_hash));
        payload.extend_from_slice(&borsh_string(subject));
        payload.extend_from_slice(&borsh_string(value));
        payload.extend_from_slice(&event_time.to_le_bytes());
        payload.extend_from_slice(&observed_at.to_le_bytes());
        payload.extend_from_slice(&borsh_string("permit 202603026735"));
        payload
    }

    fn attestation(payload: &[u8]) -> Vec<u8> {
        let mut data = vec![0; 101];
        data[0] = sas_attestation::ATTESTATION_DISCRIMINATOR;
        data[33..65].copy_from_slice(&[4; 32]);
        data[65..97].copy_from_slice(&[5; 32]);
        data[97..101].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        data.extend_from_slice(payload);
        data.extend_from_slice(&[6; 32]);
        data.extend_from_slice(&2_000_000_000i64.to_le_bytes());
        data.extend_from_slice(&[0; 32]);
        data
    }

    fn recipe_text(digest: &[u8; 32]) -> String {
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("sha256:{hex}")
    }

    #[test]
    fn parses_and_hashes_a_market_evidence_payload() {
        let recipe = [0xab; 32];
        let data = attestation(&evidence_payload(&recipe_text(&recipe), "SF|5000-002", "issued", 1_899_000_000, 1_899_000_500));
        let evidence = parse_market_evidence(&data).unwrap();
        assert_eq!(evidence.credential, Pubkey::new_from_array([4; 32]));
        assert_eq!(evidence.schema, Pubkey::new_from_array([5; 32]));
        assert_eq!(evidence.authority, Pubkey::new_from_array([6; 32]));
        assert_eq!(evidence.expiry, 2_000_000_000);
        assert!(recipe_hash_matches(evidence.recipe_hash, &recipe));
        assert_eq!(evidence.subject_hash, hash(b"SF|5000-002").to_bytes());
        assert_eq!(evidence.value_hash, hash(b"issued").to_bytes());
        assert_eq!(evidence.event_time, 1_899_000_000);
        assert_eq!(evidence.source_observed_at, 1_899_000_500);
    }

    #[test]
    fn rejects_truncated_extended_or_timeless_payloads() {
        let recipe = recipe_text(&[1; 32]);
        let payload = evidence_payload(&recipe, "s", "v", 10, 20);
        assert!(parse_market_evidence(&attestation(&payload[..payload.len() - 1])).is_err());
        let mut extended = payload.clone();
        extended.push(0);
        assert!(parse_market_evidence(&attestation(&extended)).is_err());
        assert!(parse_market_evidence(&attestation(&evidence_payload(&recipe, "s", "v", 0, 20))).is_err());
    }

    #[test]
    fn matches_the_recipe_hash_only_in_its_canonical_form() {
        let digest = [0x0f; 32];
        let canonical = recipe_text(&digest);
        assert!(recipe_hash_matches(canonical.as_bytes(), &digest));
        assert!(!recipe_hash_matches(canonical.to_uppercase().as_bytes(), &digest));
        assert!(!recipe_hash_matches(&canonical.as_bytes()[7..], &digest));
        assert!(!recipe_hash_matches(canonical.as_bytes(), &[0x0e; 32]));
        assert!(!recipe_hash_matches(format!("{canonical}0").as_bytes(), &digest));
    }

    #[test]
    fn evidence_must_report_an_event_by_the_deadline_observed_after_it_and_not_in_the_future() {
        let now = CLOSES_AT + 100;
        assert!(validate_evidence_chronology(CLOSES_AT, CLOSES_AT, CLOSES_AT, now).is_ok());
        assert!(validate_evidence_chronology(CLOSES_AT - 500, CLOSES_AT - 400, CLOSES_AT, now).is_ok());
        assert!(validate_evidence_chronology(CLOSES_AT + 1, CLOSES_AT + 2, CLOSES_AT, now).is_err());
        assert!(validate_evidence_chronology(CLOSES_AT - 10, CLOSES_AT - 11, CLOSES_AT, now).is_err());
        assert!(validate_evidence_chronology(CLOSES_AT - 10, now + 1, CLOSES_AT, now).is_err());
    }

    #[test]
    fn pays_winners_one_unit_per_share_and_a_void_one_half_floored() {
        assert_eq!(lmsr_payout(SIDE_YES, 7, SIDE_YES), 7);
        assert_eq!(lmsr_payout(SIDE_NO, 7, SIDE_YES), 0);
        assert_eq!(lmsr_payout(SIDE_NO, 7, SIDE_NO), 7);
        assert_eq!(lmsr_payout(SIDE_YES, 7, OUTCOME_VOID), 3);
        assert_eq!(lmsr_payout(SIDE_NO, 1, OUTCOME_VOID), 0);
    }

    #[test]
    fn the_obligation_covers_every_payout_of_its_outcome() {
        let yes = [3u64, 4, 1];
        let no = [5u64, 9];
        let (q_yes, q_no) = (yes.iter().sum::<u64>(), no.iter().sum::<u64>());
        for outcome in [SIDE_NO, SIDE_YES, OUTCOME_VOID] {
            let paid: u64 = yes.iter().map(|&a| lmsr_payout(SIDE_YES, a, outcome)).sum::<u64>()
                + no.iter().map(|&a| lmsr_payout(SIDE_NO, a, outcome)).sum::<u64>();
            assert!(paid <= lmsr_obligation(q_yes, q_no, outcome), "outcome {outcome}");
        }
        assert_eq!(lmsr_obligation(q_yes, q_no, OUTCOME_VOID), 4 + 7);
    }

    #[test]
    fn settles_kind_0_from_the_proposal_status() {
        assert_eq!(proposal_outcome(STATUS_EXECUTED), Some(SIDE_YES));
        assert_eq!(proposal_outcome(STATUS_EXPIRED), Some(SIDE_NO));
        assert_eq!(proposal_outcome(STATUS_CANCELLED), Some(OUTCOME_VOID));
        assert_eq!(proposal_outcome(STATUS_ACTIVE), None);
    }
}
