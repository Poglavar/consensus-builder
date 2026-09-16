// proposal_market: a parimutuel prediction market per proposal_nft Proposal, staked in one SPL
// token (devnet USDC for the hackathon), with NO deadline. A market resolves only when its proposal
// reaches a terminal on-chain state: Executed → YES, Cancelled → NO. Anyone may create the market,
// stake, resolve and claim. The proposal is read directly from its account (owner, discriminator
// and layout checked) rather than through declare_program!, the same way proposal_nft reads
// parcel_nft accounts, so this crate stays on the workspace's single anchor-lang version.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB");

/// The proposal_nft program whose Proposal accounts markets are opened on (same id on localnet
/// and devnet, see Anchor.toml).
pub const PROPOSAL_NFT_PROGRAM_ID: Pubkey = pubkey!("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");

/// Account discriminator of proposal_nft::Proposal (sha256("account:Proposal")[..8], as in the IDL).
pub const PROPOSAL_DISCRIMINATOR: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];

/// proposal_nft::ProposalStatus variant indices (borsh encodes a unit enum as one u8).
pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_EXECUTED: u8 = 1;
pub const STATUS_CANCELLED: u8 = 2;

pub const SIDE_NO: u8 = 0;
pub const SIDE_YES: u8 = 1;

pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";

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
    #[account(
        init,
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
