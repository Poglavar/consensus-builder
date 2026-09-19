// proposal_pledge: non-custodial USDC crowdfunding for proposal_nft proposals. Each pledge has an
// immutable, caller-chosen 32-byte id in its PDA, making retries detectable without pooling a
// backer's balance into somebody else's record. Executed proposals release to their on-chain owner;
// Cancelled or Expired proposals let every contributor refund their own position.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g");

pub const PROPOSAL_NFT_PROGRAM_ID: Pubkey = pubkey!("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");
pub const DEVNET_USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
pub const PROPOSAL_DISCRIMINATOR: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_EXECUTED: u8 = 1;
pub const STATUS_CANCELLED: u8 = 2;
pub const STATUS_EXPIRED: u8 = 3;

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const PLEDGE_SEED: &[u8] = b"pledge";
pub const BACKER_SEED: &[u8] = b"backer";

#[program]
pub mod proposal_pledge {
    use super::*;

    /// Create the one USDC escrow for an Active proposal. Permissionless: beneficiary and lifecycle
    /// are read from the proposal account, so the payer cannot redirect or control the funds.
    pub fn create_escrow(ctx: Context<CreateEscrow>) -> Result<()> {
        let (beneficiary, status) = read_proposal(&ctx.accounts.proposal, None)?;
        require!(status == STATUS_ACTIVE, PledgeError::ProposalNotActive);

        let escrow = &mut ctx.accounts.escrow;
        escrow.proposal = ctx.accounts.proposal.key();
        escrow.beneficiary = beneficiary;
        escrow.pledge_mint = ctx.accounts.pledge_mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.total_pledged = 0;
        escrow.total_released = 0;
        escrow.total_refunded = 0;
        escrow.pledge_count = 0;
        escrow.backer_count = 0;
        escrow.released = false;
        escrow.bump = ctx.bumps.escrow;
        Ok(())
    }

    /// Deposit one immutable pledge. `pledge_id` should be stable across retries; its PDA can exist
    /// only once, so a retried logical operation can never charge twice.
    pub fn pledge(ctx: Context<Pledge>, pledge_id: [u8; 32], amount: u64) -> Result<()> {
        require!(amount > 0, PledgeError::ZeroAmount);
        require!(!ctx.accounts.escrow.released, PledgeError::EscrowReleased);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.escrow.proposal))?;
        require!(status == STATUS_ACTIVE, PledgeError::ProposalNotActive);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pledger_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.pledger.to_account_info(),
                },
            ),
            amount,
        )?;

        let position = &mut ctx.accounts.position;
        position.escrow = ctx.accounts.escrow.key();
        position.owner = ctx.accounts.pledger.key();
        position.pledge_id = pledge_id;
        position.amount = amount;
        position.refunded = false;
        position.bump = ctx.bumps.position;

        let backer = &mut ctx.accounts.backer;
        if backer.pledge_count == 0 {
            backer.escrow = ctx.accounts.escrow.key();
            backer.owner = ctx.accounts.pledger.key();
            backer.total_pledged = 0;
            backer.bump = ctx.bumps.backer;
            ctx.accounts.escrow.backer_count = ctx.accounts.escrow.backer_count
                .checked_add(1)
                .ok_or(PledgeError::MathOverflow)?;
        }
        backer.total_pledged = backer.total_pledged.checked_add(amount).ok_or(PledgeError::MathOverflow)?;
        backer.pledge_count = backer.pledge_count.checked_add(1).ok_or(PledgeError::MathOverflow)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.total_pledged = escrow.total_pledged.checked_add(amount).ok_or(PledgeError::MathOverflow)?;
        escrow.pledge_count = escrow.pledge_count.checked_add(1).ok_or(PledgeError::MathOverflow)?;
        Ok(())
    }

    /// Permissionless settlement after proposal execution. The complete vault is paid to the
    /// proposal owner captured at escrow creation; the caller can neither choose nor alter it.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        require!(!ctx.accounts.escrow.released, PledgeError::EscrowReleased);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.escrow.proposal))?;
        require!(status == STATUS_EXECUTED, PledgeError::ProposalNotExecuted);

        let amount = ctx.accounts.vault.amount;
        require!(amount > 0, PledgeError::NothingToRelease);
        let proposal = ctx.accounts.escrow.proposal;
        let seeds: &[&[u8]] = &[ESCROW_SEED, proposal.as_ref(), &[ctx.accounts.escrow.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.beneficiary_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.released = true;
        escrow.total_released = escrow.total_released.checked_add(amount).ok_or(PledgeError::MathOverflow)?;
        Ok(())
    }

    /// Refund exactly one contributor's immutable pledge after cancellation or expiry. A position
    /// stays on-chain as a receipt and cannot be claimed twice.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        require!(!ctx.accounts.escrow.released, PledgeError::EscrowReleased);
        require!(!ctx.accounts.position.refunded, PledgeError::AlreadyRefunded);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.escrow.proposal))?;
        require!(is_refundable_status(status), PledgeError::ProposalNotRefundable);

        let amount = ctx.accounts.position.amount;
        require!(amount > 0, PledgeError::NothingToRefund);
        let proposal = ctx.accounts.escrow.proposal;
        let seeds: &[&[u8]] = &[ESCROW_SEED, proposal.as_ref(), &[ctx.accounts.escrow.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.pledger_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        ctx.accounts.position.refunded = true;
        let escrow = &mut ctx.accounts.escrow;
        escrow.total_refunded = escrow.total_refunded.checked_add(amount).ok_or(PledgeError::MathOverflow)?;
        Ok(())
    }
}

pub fn is_refundable_status(status: u8) -> bool {
    status == STATUS_CANCELLED || status == STATUS_EXPIRED
}

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

fn read_proposal(proposal: &AccountInfo, expected: Option<&Pubkey>) -> Result<(Pubkey, u8)> {
    if let Some(expected_key) = expected {
        require_keys_eq!(proposal.key(), *expected_key, PledgeError::InvalidProposalAccount);
    }
    require_keys_eq!(*proposal.owner, PROPOSAL_NFT_PROGRAM_ID, PledgeError::InvalidProposalAccount);
    let data = proposal.try_borrow_data()?;
    require!(data.len() > 8 && data[..8] == PROPOSAL_DISCRIMINATOR, PledgeError::InvalidProposalAccount);
    let mut body: &[u8] = &data[8..];
    let head = ProposalHead::deserialize(&mut body).map_err(|_| error!(PledgeError::InvalidProposalAccount))?;
    Ok((head.owner, head.status))
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub proposal: Pubkey,
    pub beneficiary: Pubkey,
    pub pledge_mint: Pubkey,
    pub vault: Pubkey,
    pub total_pledged: u64,
    pub total_released: u64,
    pub total_refunded: u64,
    pub pledge_count: u64,
    pub backer_count: u64,
    pub released: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PledgePosition {
    pub escrow: Pubkey,
    pub owner: Pubkey,
    pub pledge_id: [u8; 32],
    pub amount: u64,
    pub refunded: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Backer {
    pub escrow: Pubkey,
    pub owner: Pubkey,
    pub total_pledged: u64,
    pub pledge_count: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, proposal.key().as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    /// CHECK: proposal_nft owner, discriminator and state are verified in the handler.
    pub proposal: UncheckedAccount<'info>,
    #[account(address = DEVNET_USDC_MINT @ PledgeError::InvalidPledgeMint)]
    pub pledge_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = pledge_mint,
        associated_token::authority = escrow
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pledge_id: [u8; 32])]
pub struct Pledge<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.proposal.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, Escrow>>,
    /// CHECK: verified against escrow.proposal in the handler.
    pub proposal: UncheckedAccount<'info>,
    #[account(
        init,
        payer = pledger,
        space = 8 + PledgePosition::INIT_SPACE,
        seeds = [PLEDGE_SEED, escrow.key().as_ref(), pledger.key().as_ref(), pledge_id.as_ref()],
        bump
    )]
    pub position: Box<Account<'info, PledgePosition>>,
    #[account(
        init_if_needed,
        payer = pledger,
        space = 8 + Backer::INIT_SPACE,
        seeds = [BACKER_SEED, escrow.key().as_ref(), pledger.key().as_ref()],
        bump
    )]
    pub backer: Box<Account<'info, Backer>>,
    #[account(mut, address = escrow.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = escrow.pledge_mint, token::authority = pledger)]
    pub pledger_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pledger: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.proposal.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, Escrow>>,
    /// CHECK: verified against escrow.proposal in the handler.
    pub proposal: UncheckedAccount<'info>,
    #[account(address = escrow.pledge_mint)]
    pub pledge_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = escrow.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: fixed to escrow.beneficiary and used only as the ATA authority.
    #[account(address = escrow.beneficiary)]
    pub beneficiary: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = releaser,
        associated_token::mint = pledge_mint,
        associated_token::authority = beneficiary
    )]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub releaser: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.proposal.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, Escrow>>,
    /// CHECK: verified against escrow.proposal in the handler.
    pub proposal: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [PLEDGE_SEED, escrow.key().as_ref(), pledger.key().as_ref(), position.pledge_id.as_ref()],
        bump = position.bump,
        has_one = escrow @ PledgeError::InvalidPosition,
        constraint = position.owner == pledger.key() @ PledgeError::InvalidPosition
    )]
    pub position: Box<Account<'info, PledgePosition>>,
    #[account(mut, address = escrow.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = escrow.pledge_mint, token::authority = pledger)]
    pub pledger_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pledger: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum PledgeError {
    #[msg("The proposal account is not a proposal_nft Proposal (or not this escrow's)")]
    InvalidProposalAccount,
    #[msg("The escrow token must be devnet USDC")]
    InvalidPledgeMint,
    #[msg("The proposal is not Active")]
    ProposalNotActive,
    #[msg("The proposal has not Executed")]
    ProposalNotExecuted,
    #[msg("Only Cancelled or Expired proposals are refundable")]
    ProposalNotRefundable,
    #[msg("Pledge amount must be positive")]
    ZeroAmount,
    #[msg("This escrow has already been released")]
    EscrowReleased,
    #[msg("This pledge was already refunded")]
    AlreadyRefunded,
    #[msg("The vault has nothing to release")]
    NothingToRelease,
    #[msg("This position has nothing to refund")]
    NothingToRefund,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The pledge position does not belong to this escrow and contributor")]
    InvalidPosition,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cancelled_and_expired_proposals_refund() {
        assert!(!is_refundable_status(STATUS_ACTIVE));
        assert!(!is_refundable_status(STATUS_EXECUTED));
        assert!(is_refundable_status(STATUS_CANCELLED));
        assert!(is_refundable_status(STATUS_EXPIRED));
    }
}
