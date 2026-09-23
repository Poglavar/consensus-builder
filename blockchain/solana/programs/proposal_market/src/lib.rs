// proposal_market: a parimutuel prediction market per proposal_nft Proposal, staked in one SPL
// token (devnet USDC for the hackathon), with NO deadline. A market resolves only when its proposal
// reaches a terminal on-chain state: Executed → YES, Cancelled → NO. Anyone may create the market,
// stake, resolve and claim. The proposal is read directly from its account (owner, discriminator
// and layout checked) rather than through declare_program!, the same way proposal_nft reads
// parcel_nft accounts, so this crate stays on the workspace's single anchor-lang version.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB");

/// The proposal_nft program whose Proposal accounts markets are opened on (same id on localnet
/// and devnet, see Anchor.toml).
pub const PROPOSAL_NFT_PROGRAM_ID: Pubkey = pubkey!("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");

/// Solana Attestation Service program used by the court oracle on devnet. External markets do not
/// trust an API response: they parse an account owned by this program and pin its credential,
/// schema, issuer, parcel and outcome value against commitments made before staking starts.
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

/// Account discriminator of proposal_nft::Proposal (sha256("account:Proposal")[..8], as in the IDL).
pub const PROPOSAL_DISCRIMINATOR: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];

/// proposal_nft::ProposalStatus variant indices (borsh encodes a unit enum as one u8).
pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_EXECUTED: u8 = 1;
pub const STATUS_CANCELLED: u8 = 2;

pub const SIDE_NO: u8 = 0;
pub const SIDE_YES: u8 = 1;

pub const MARKET_SEED: &[u8] = b"market";
pub const EXTERNAL_MARKET_SEED: &[u8] = b"external_market";
pub const POSITION_SEED: &[u8] = b"position";

pub const SAS_CREDENTIAL_DISCRIMINATOR: u8 = 0;
pub const SAS_SCHEMA_DISCRIMINATOR: u8 = 1;
pub const SAS_ATTESTATION_DISCRIMINATOR: u8 = 2;

#[program]
pub mod proposal_market {
    use super::*;

    /// Open the (single) market for a proposal. Only an Active proposal can get a market: a
    /// market on an already-terminal proposal would resolve instantly and take no stakes.
    pub fn create_market(ctx: Context<CreateMarket>) -> Result<()> {
        let status = read_proposal_status(&ctx.accounts.proposal, None)?;
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

    /// Stake `amount` of the market's token on `side` (1 = YES the proposal executes, 0 = NO it
    /// is cancelled). Allowed only while the proposal is still Active and the market unresolved.
    /// Stakes are locked until resolution: no early exit, because the visible acceptance count
    /// would make late exits gameable.
    pub fn stake(ctx: Context<Stake>, side: u8, amount: u64) -> Result<()> {
        require!(side == SIDE_YES || side == SIDE_NO, MarketError::InvalidSide);
        require!(amount > 0, MarketError::ZeroAmount);
        require!(!ctx.accounts.market.resolved, MarketError::MarketResolved);

        let status = read_proposal_status(&ctx.accounts.proposal, Some(&ctx.accounts.market.proposal))?;
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

    /// Permissionless. Reads the proposal's on-chain status: Executed → YES, Cancelled → NO,
    /// anything else → NotTerminal. There is no clock: an Active proposal keeps the market open.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        require!(!ctx.accounts.market.resolved, MarketError::MarketResolved);
        let status = read_proposal_status(&ctx.accounts.proposal, Some(&ctx.accounts.market.proposal))?;
        let outcome = match status {
            STATUS_EXECUTED => SIDE_YES,
            STATUS_CANCELLED => SIDE_NO,
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

        let proposal_key = market.proposal;
        let seeds: &[&[u8]] = &[MARKET_SEED, proposal_key.as_ref(), &[market.bump]];
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

/// The prefix of proposal_nft::Proposal up to and including `status`. Borsh reads sequentially,
/// so the fields after `status` need not be mirrored. Field order MUST match
/// programs/proposal_nft/src/lib.rs (a backend test pins the two files to each other).
// Only `status` is read; the leading fields exist to advance the Borsh
// cursor and keep their real names so the backend layout tests can pin them to proposal_nft.
#[allow(dead_code)]
#[derive(AnchorDeserialize)]
struct ProposalHead {
    pub proposal_id: u64,
    pub owner: Pubkey,
    pub parcel_ids: Vec<String>,
    pub is_conditional: bool,
    pub image_uri: String,
    pub acceptance_possible: bool,
    pub status: u8,
}

/// Verify that `proposal` is a proposal_nft Proposal (and, when `expected` is given, the one the
/// market was opened on) and return its status byte.
fn read_proposal_status(proposal: &AccountInfo, expected: Option<&Pubkey>) -> Result<u8> {
    if let Some(expected_key) = expected {
        require_keys_eq!(proposal.key(), *expected_key, MarketError::InvalidProposalAccount);
    }
    require_keys_eq!(*proposal.owner, PROPOSAL_NFT_PROGRAM_ID, MarketError::InvalidProposalAccount);
    let data = proposal.try_borrow_data()?;
    require!(data.len() > 8 && data[..8] == PROPOSAL_DISCRIMINATOR, MarketError::InvalidProposalAccount);
    let mut body: &[u8] = &data[8..];
    let head = ProposalHead::deserialize(&mut body).map_err(|_| error!(MarketError::InvalidProposalAccount))?;
    Ok(head.status)
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
    require!(schema_data.len() >= 33 && schema_data[0] == SAS_SCHEMA_DISCRIMINATOR, MarketError::InvalidSasAccount);
    let embedded_credential = Pubkey::new_from_array(
        schema_data[1..33].try_into().map_err(|_| error!(MarketError::InvalidSasAccount))?
    );
    require_keys_eq!(embedded_credential, *expected_credential, MarketError::WrongEvidenceCredential);
    // Schema layout: discriminator, credential, then four u32-sized byte vectors, isPaused, version.
    let mut offset = 33usize;
    for _ in 0..4 {
        read_borsh_string(&schema_data, &mut offset).map_err(|_| error!(MarketError::InvalidSasAccount))?;
    }
    require!(offset + 2 <= schema_data.len(), MarketError::InvalidSasAccount);
    require!(schema_data[offset] == 0, MarketError::SchemaPaused);
    Ok(())
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
    // discriminator + nonce + credential + schema + data length + authority + expiry
    require!(data.len() >= 141 && data[0] == SAS_ATTESTATION_DISCRIMINATOR, MarketError::InvalidSasAccount);
    let credential = Pubkey::new_from_array(data[33..65].try_into().map_err(|_| error!(MarketError::InvalidSasAccount))?);
    let schema = Pubkey::new_from_array(data[65..97].try_into().map_err(|_| error!(MarketError::InvalidSasAccount))?);
    let payload_len = u32::from_le_bytes(data[97..101].try_into().map_err(|_| error!(MarketError::InvalidSasAccount))?) as usize;
    let payload_end = 101usize.checked_add(payload_len).ok_or(MarketError::InvalidSasAccount)?;
    let record_end = payload_end.checked_add(40).ok_or(MarketError::InvalidSasAccount)?;
    require!(record_end <= data.len(), MarketError::InvalidSasAccount);
    let authority = Pubkey::new_from_array(
        data[payload_end..payload_end + 32].try_into().map_err(|_| error!(MarketError::InvalidSasAccount))?
    );
    let expiry = i64::from_le_bytes(
        data[payload_end + 32..record_end].try_into().map_err(|_| error!(MarketError::InvalidSasAccount))?
    );

    // CourtParcelOperationV1: string parcelUid, string decisionUuid, string operation,
    // string decisionLink.
    // CourtParcelOperationV2 appends int64 sourceObservedAt. The schema account bound into the
    // market determines which payload SAS can issue; accepting both shapes keeps already-created
    // V1 markets resolvable while V2 markets gain an on-chain temporal-integrity check.
    let payload = &data[101..payload_end];
    let mut offset = 0usize;
    let parcel_uid = read_borsh_string(payload, &mut offset)?;
    let _decision_uuid = read_borsh_string(payload, &mut offset)?;
    let operation = read_borsh_string(payload, &mut offset)?;
    let _decision_link = read_borsh_string(payload, &mut offset)?;
    let source_observed_at = if offset == payload.len() {
        None
    } else {
        let timestamp_end = offset.checked_add(8).ok_or(MarketError::InvalidEvidencePayload)?;
        require!(timestamp_end == payload.len(), MarketError::InvalidEvidencePayload);
        let timestamp = i64::from_le_bytes(
            payload[offset..timestamp_end].try_into().map_err(|_| error!(MarketError::InvalidEvidencePayload))?
        );
        require!(timestamp > 0, MarketError::InvalidEvidencePayload);
        Some(timestamp)
    };

    Ok(SasCourtEvidence {
        credential,
        schema,
        authority,
        expiry,
        subject_hash: hash(parcel_uid).to_bytes(),
        value_hash: hash(operation).to_bytes(),
        source_observed_at,
        account_hash: hash(&data).to_bytes(),
    })
}

fn validate_source_chronology(source_observed_at: Option<i64>, closes_at: i64, now: i64) -> Result<()> {
    if let Some(observed_at) = source_observed_at {
        require!(observed_at >= closes_at, MarketError::EvidencePredatesMarketClose);
        require!(observed_at <= now, MarketError::EvidenceFromFuture);
    }
    Ok(())
}

fn read_borsh_string<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8]> {
    let length_end = offset.checked_add(4).ok_or(MarketError::InvalidEvidencePayload)?;
    require!(length_end <= bytes.len(), MarketError::InvalidEvidencePayload);
    let length = u32::from_le_bytes(
        bytes[*offset..length_end].try_into().map_err(|_| error!(MarketError::InvalidEvidencePayload))?
    ) as usize;
    let value_end = length_end.checked_add(length).ok_or(MarketError::InvalidEvidencePayload)?;
    require!(value_end <= bytes.len(), MarketError::InvalidEvidencePayload);
    *offset = value_end;
    Ok(&bytes[length_end..value_end])
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
    /// CHECK: a proposal_nft Proposal; owner, discriminator and status are verified in the handler.
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
    #[msg("The proposal account is not a proposal_nft Proposal (or not this market's)")]
    InvalidProposalAccount,
    #[msg("The proposal is not Active")]
    ProposalNotActive,
    #[msg("The proposal has not reached a terminal state (Executed or Cancelled)")]
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
