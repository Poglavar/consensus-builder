// proposal_pledge: funded refundable donations plus revocable, unfunded commitments for
// proposal_nft proposals. The proposal lifecycle is authoritative and its owner is captured as
// the beneficiary, so callers cannot redirect settlement.

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
pub const COMMITMENT_ACTIVE: u8 = 0;
pub const COMMITMENT_FULFILLED: u8 = 1;
pub const COMMITMENT_REVOKED: u8 = 2;
pub const COMMITMENT_VOIDED: u8 = 3;

pub const DONATION_ESCROW_SEED: &[u8] = b"donation_escrow";
pub const DONATION_SEED: &[u8] = b"donation";
pub const DONOR_SEED: &[u8] = b"donor";
pub const PLEDGE_BOOK_SEED: &[u8] = b"pledge_book";
pub const PLEDGE_SEED: &[u8] = b"pledge";

#[program]
pub mod proposal_pledge {
    use super::*;

    pub fn create_donation_escrow(ctx: Context<CreateDonationEscrow>) -> Result<()> {
        let (beneficiary, status) = read_proposal(&ctx.accounts.proposal, None)?;
        require!(status == STATUS_ACTIVE, SupportError::ProposalNotActive);
        let escrow = &mut ctx.accounts.escrow;
        escrow.proposal = ctx.accounts.proposal.key();
        escrow.beneficiary = beneficiary;
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.total_donated = 0;
        escrow.total_released = 0;
        escrow.total_refunded = 0;
        escrow.donation_count = 0;
        escrow.donor_count = 0;
        escrow.released = false;
        escrow.bump = ctx.bumps.escrow;
        Ok(())
    }

    /// Fund one immutable donation. A stable donation_id makes retries idempotent.
    pub fn donate(ctx: Context<Donate>, donation_id: [u8; 32], amount: u64) -> Result<()> {
        require!(amount > 0, SupportError::ZeroAmount);
        require!(!ctx.accounts.escrow.released, SupportError::DonationsReleased);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.escrow.proposal))?;
        require!(status == STATUS_ACTIVE, SupportError::ProposalNotActive);
        token::transfer(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.donor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.donor.to_account_info(),
            },
        ), amount)?;

        let position = &mut ctx.accounts.position;
        position.escrow = ctx.accounts.escrow.key();
        position.owner = ctx.accounts.donor.key();
        position.donation_id = donation_id;
        position.amount = amount;
        position.refunded = false;
        position.bump = ctx.bumps.position;

        let donor = &mut ctx.accounts.donor_record;
        if donor.donation_count == 0 {
            donor.escrow = ctx.accounts.escrow.key();
            donor.owner = ctx.accounts.donor.key();
            donor.total_donated = 0;
            donor.bump = ctx.bumps.donor_record;
            ctx.accounts.escrow.donor_count = add(ctx.accounts.escrow.donor_count, 1)?;
        }
        donor.total_donated = add(donor.total_donated, amount)?;
        donor.donation_count = add(donor.donation_count, 1)?;
        ctx.accounts.escrow.total_donated = add(ctx.accounts.escrow.total_donated, amount)?;
        ctx.accounts.escrow.donation_count = add(ctx.accounts.escrow.donation_count, 1)?;
        Ok(())
    }

    /// Permissionless settlement after execution to the captured proposal owner.
    pub fn release_donations(ctx: Context<ReleaseDonations>) -> Result<()> {
        require!(!ctx.accounts.escrow.released, SupportError::DonationsReleased);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.escrow.proposal))?;
        require!(status == STATUS_EXECUTED, SupportError::ProposalNotExecuted);
        let amount = ctx.accounts.vault.amount;
        require!(amount > 0, SupportError::NothingToRelease);
        let proposal = ctx.accounts.escrow.proposal;
        let seeds: &[&[u8]] = &[DONATION_ESCROW_SEED, proposal.as_ref(), &[ctx.accounts.escrow.bump]];
        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.beneficiary_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ), amount)?;
        ctx.accounts.escrow.released = true;
        ctx.accounts.escrow.total_released = add(ctx.accounts.escrow.total_released, amount)?;
        Ok(())
    }

    /// Refund one funded donation to its owner after cancellation or expiry.
    pub fn refund_donation(ctx: Context<RefundDonation>) -> Result<()> {
        require!(!ctx.accounts.escrow.released, SupportError::DonationsReleased);
        require!(!ctx.accounts.position.refunded, SupportError::AlreadyRefunded);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.escrow.proposal))?;
        require!(is_refundable_status(status), SupportError::ProposalNotRefundable);
        let amount = ctx.accounts.position.amount;
        require!(amount > 0, SupportError::NothingToRefund);
        let proposal = ctx.accounts.escrow.proposal;
        let seeds: &[&[u8]] = &[DONATION_ESCROW_SEED, proposal.as_ref(), &[ctx.accounts.escrow.bump]];
        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.donor_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ), amount)?;
        ctx.accounts.position.refunded = true;
        ctx.accounts.escrow.total_refunded = add(ctx.accounts.escrow.total_refunded, amount)?;
        Ok(())
    }

    pub fn create_pledge_book(ctx: Context<CreatePledgeBook>) -> Result<()> {
        let (beneficiary, status) = read_proposal(&ctx.accounts.proposal, None)?;
        require!(status == STATUS_ACTIVE, SupportError::ProposalNotActive);
        let book = &mut ctx.accounts.book;
        book.proposal = ctx.accounts.proposal.key();
        book.beneficiary = beneficiary;
        book.mint = ctx.accounts.mint.key();
        book.active_pledged = 0;
        book.total_fulfilled = 0;
        book.total_revoked = 0;
        book.pledge_count = 0;
        book.active_count = 0;
        book.fulfilled_count = 0;
        book.bump = ctx.bumps.book;
        Ok(())
    }

    /// Create or replace this wallet's soft commitment. No USDC moves at pledge time.
    pub fn set_pledge(ctx: Context<SetPledge>, amount: u64) -> Result<()> {
        require!(amount > 0, SupportError::ZeroAmount);
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.book.proposal))?;
        require!(status == STATUS_ACTIVE, SupportError::ProposalNotActive);
        let commitment = &mut ctx.accounts.commitment;
        if commitment.initialized {
            require!(commitment.status != COMMITMENT_FULFILLED, SupportError::PledgeAlreadyFulfilled);
            if commitment.status == COMMITMENT_ACTIVE {
                ctx.accounts.book.active_pledged = sub(ctx.accounts.book.active_pledged, commitment.amount)?;
            } else {
                ctx.accounts.book.active_count = add(ctx.accounts.book.active_count, 1)?;
            }
        } else {
            commitment.book = ctx.accounts.book.key();
            commitment.proposal = ctx.accounts.proposal.key();
            commitment.owner = ctx.accounts.pledger.key();
            commitment.initialized = true;
            commitment.bump = ctx.bumps.commitment;
            ctx.accounts.book.pledge_count = add(ctx.accounts.book.pledge_count, 1)?;
            ctx.accounts.book.active_count = add(ctx.accounts.book.active_count, 1)?;
        }
        commitment.amount = amount;
        commitment.status = COMMITMENT_ACTIVE;
        ctx.accounts.book.active_pledged = add(ctx.accounts.book.active_pledged, amount)?;
        Ok(())
    }

    pub fn revoke_pledge(ctx: Context<RevokePledge>) -> Result<()> {
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.book.proposal))?;
        require!(status == STATUS_ACTIVE, SupportError::ProposalNotActive);
        require!(ctx.accounts.commitment.status == COMMITMENT_ACTIVE, SupportError::PledgeNotActive);
        let amount = ctx.accounts.commitment.amount;
        ctx.accounts.commitment.status = COMMITMENT_REVOKED;
        ctx.accounts.book.active_pledged = sub(ctx.accounts.book.active_pledged, amount)?;
        ctx.accounts.book.active_count = sub(ctx.accounts.book.active_count, 1)?;
        ctx.accounts.book.total_revoked = add(ctx.accounts.book.total_revoked, amount)?;
        Ok(())
    }

    /// Move the pledged USDC only after execution, with the pledger signing.
    pub fn fulfill_pledge(ctx: Context<FulfillPledge>) -> Result<()> {
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.book.proposal))?;
        require!(status == STATUS_EXECUTED, SupportError::ProposalNotExecuted);
        require!(ctx.accounts.commitment.status == COMMITMENT_ACTIVE, SupportError::PledgeNotActive);
        let amount = ctx.accounts.commitment.amount;
        token::transfer(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pledger_token_account.to_account_info(),
                to: ctx.accounts.beneficiary_token_account.to_account_info(),
                authority: ctx.accounts.pledger.to_account_info(),
            },
        ), amount)?;
        ctx.accounts.commitment.status = COMMITMENT_FULFILLED;
        ctx.accounts.book.active_pledged = sub(ctx.accounts.book.active_pledged, amount)?;
        ctx.accounts.book.active_count = sub(ctx.accounts.book.active_count, 1)?;
        ctx.accounts.book.total_fulfilled = add(ctx.accounts.book.total_fulfilled, amount)?;
        ctx.accounts.book.fulfilled_count = add(ctx.accounts.book.fulfilled_count, 1)?;
        Ok(())
    }

    /// Clear an unfunded commitment once a proposal is cancelled or expires.
    pub fn void_pledge(ctx: Context<VoidPledge>) -> Result<()> {
        let (_, status) = read_proposal(&ctx.accounts.proposal, Some(&ctx.accounts.book.proposal))?;
        require!(is_refundable_status(status), SupportError::ProposalNotRefundable);
        require!(ctx.accounts.commitment.status == COMMITMENT_ACTIVE, SupportError::PledgeNotActive);
        let amount = ctx.accounts.commitment.amount;
        ctx.accounts.commitment.status = COMMITMENT_VOIDED;
        ctx.accounts.book.active_pledged = sub(ctx.accounts.book.active_pledged, amount)?;
        ctx.accounts.book.active_count = sub(ctx.accounts.book.active_count, 1)?;
        Ok(())
    }
}

pub fn is_refundable_status(status: u8) -> bool {
    status == STATUS_CANCELLED || status == STATUS_EXPIRED
}
fn add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right).ok_or_else(|| error!(SupportError::MathOverflow))
}
fn sub(left: u64, right: u64) -> Result<u64> {
    left.checked_sub(right).ok_or_else(|| error!(SupportError::MathOverflow))
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
        require_keys_eq!(proposal.key(), *expected_key, SupportError::InvalidProposalAccount);
    }
    require_keys_eq!(*proposal.owner, PROPOSAL_NFT_PROGRAM_ID, SupportError::InvalidProposalAccount);
    let data = proposal.try_borrow_data()?;
    require!(data.len() > 8 && data[..8] == PROPOSAL_DISCRIMINATOR, SupportError::InvalidProposalAccount);
    let mut body: &[u8] = &data[8..];
    let head = ProposalHead::deserialize(&mut body).map_err(|_| error!(SupportError::InvalidProposalAccount))?;
    Ok((head.owner, head.status))
}

#[account]
#[derive(InitSpace)]
pub struct DonationEscrow {
    pub proposal: Pubkey, pub beneficiary: Pubkey, pub mint: Pubkey, pub vault: Pubkey,
    pub total_donated: u64, pub total_released: u64, pub total_refunded: u64,
    pub donation_count: u64, pub donor_count: u64, pub released: bool, pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct DonationPosition {
    pub escrow: Pubkey, pub owner: Pubkey, pub donation_id: [u8; 32], pub amount: u64,
    pub refunded: bool, pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct Donor {
    pub escrow: Pubkey, pub owner: Pubkey, pub total_donated: u64, pub donation_count: u64, pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct PledgeBook {
    pub proposal: Pubkey, pub beneficiary: Pubkey, pub mint: Pubkey,
    pub active_pledged: u64, pub total_fulfilled: u64, pub total_revoked: u64,
    pub pledge_count: u64, pub active_count: u64, pub fulfilled_count: u64, pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct PledgeCommitment {
    pub book: Pubkey, pub proposal: Pubkey, pub owner: Pubkey, pub amount: u64,
    pub status: u8, pub initialized: bool, pub bump: u8,
}

#[derive(Accounts)]
pub struct CreateDonationEscrow<'info> {
    #[account(init, payer = creator, space = 8 + DonationEscrow::INIT_SPACE, seeds = [DONATION_ESCROW_SEED, proposal.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, DonationEscrow>>,
    /// CHECK: verified by read_proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(address = DEVNET_USDC_MINT @ SupportError::InvalidMint)] pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = escrow)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>, pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(donation_id: [u8; 32])]
pub struct Donate<'info> {
    #[account(mut, seeds = [DONATION_ESCROW_SEED, escrow.proposal.as_ref()], bump = escrow.bump)] pub escrow: Box<Account<'info, DonationEscrow>>,
    /// CHECK: verified against escrow.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(init, payer = donor, space = 8 + DonationPosition::INIT_SPACE, seeds = [DONATION_SEED, escrow.key().as_ref(), donor.key().as_ref(), donation_id.as_ref()], bump)]
    pub position: Box<Account<'info, DonationPosition>>,
    #[account(init_if_needed, payer = donor, space = 8 + Donor::INIT_SPACE, seeds = [DONOR_SEED, escrow.key().as_ref(), donor.key().as_ref()], bump)]
    pub donor_record: Box<Account<'info, Donor>>,
    #[account(mut, address = escrow.vault)] pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = escrow.mint, token::authority = donor)] pub donor_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub donor: Signer<'info>,
    pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseDonations<'info> {
    #[account(mut, seeds = [DONATION_ESCROW_SEED, escrow.proposal.as_ref()], bump = escrow.bump)] pub escrow: Box<Account<'info, DonationEscrow>>,
    /// CHECK: verified against escrow.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(address = escrow.mint)] pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = escrow.vault)] pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: fixed to escrow.beneficiary.
    #[account(address = escrow.beneficiary)] pub beneficiary: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = releaser, associated_token::mint = mint, associated_token::authority = beneficiary)]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub releaser: Signer<'info>,
    pub token_program: Program<'info, Token>, pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundDonation<'info> {
    #[account(mut, seeds = [DONATION_ESCROW_SEED, escrow.proposal.as_ref()], bump = escrow.bump)] pub escrow: Box<Account<'info, DonationEscrow>>,
    /// CHECK: verified against escrow.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(mut, seeds = [DONATION_SEED, escrow.key().as_ref(), donor.key().as_ref(), position.donation_id.as_ref()], bump = position.bump, has_one = escrow @ SupportError::InvalidPosition, constraint = position.owner == donor.key() @ SupportError::InvalidPosition)]
    pub position: Box<Account<'info, DonationPosition>>,
    #[account(mut, address = escrow.vault)] pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = escrow.mint, token::authority = donor)] pub donor_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub donor: Signer<'info>, pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreatePledgeBook<'info> {
    #[account(init, payer = creator, space = 8 + PledgeBook::INIT_SPACE, seeds = [PLEDGE_BOOK_SEED, proposal.key().as_ref()], bump)]
    pub book: Box<Account<'info, PledgeBook>>,
    /// CHECK: verified by read_proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(address = DEVNET_USDC_MINT @ SupportError::InvalidMint)] pub mint: Box<Account<'info, Mint>>,
    #[account(mut)] pub creator: Signer<'info>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPledge<'info> {
    #[account(mut, seeds = [PLEDGE_BOOK_SEED, book.proposal.as_ref()], bump = book.bump)] pub book: Box<Account<'info, PledgeBook>>,
    /// CHECK: verified against book.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = pledger, space = 8 + PledgeCommitment::INIT_SPACE, seeds = [PLEDGE_SEED, book.key().as_ref(), pledger.key().as_ref()], bump)]
    pub commitment: Box<Account<'info, PledgeCommitment>>,
    #[account(mut)] pub pledger: Signer<'info>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePledge<'info> {
    #[account(mut, seeds = [PLEDGE_BOOK_SEED, book.proposal.as_ref()], bump = book.bump)] pub book: Box<Account<'info, PledgeBook>>,
    /// CHECK: verified against book.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(mut, seeds = [PLEDGE_SEED, book.key().as_ref(), pledger.key().as_ref()], bump = commitment.bump, has_one = book @ SupportError::InvalidCommitment, constraint = commitment.owner == pledger.key() @ SupportError::InvalidCommitment)]
    pub commitment: Box<Account<'info, PledgeCommitment>>, pub pledger: Signer<'info>,
}

#[derive(Accounts)]
pub struct FulfillPledge<'info> {
    #[account(mut, seeds = [PLEDGE_BOOK_SEED, book.proposal.as_ref()], bump = book.bump)] pub book: Box<Account<'info, PledgeBook>>,
    /// CHECK: verified against book.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(mut, seeds = [PLEDGE_SEED, book.key().as_ref(), pledger.key().as_ref()], bump = commitment.bump, has_one = book @ SupportError::InvalidCommitment, constraint = commitment.owner == pledger.key() @ SupportError::InvalidCommitment)]
    pub commitment: Box<Account<'info, PledgeCommitment>>,
    #[account(address = book.mint)] pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = book.mint, token::authority = pledger)] pub pledger_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: fixed to book.beneficiary.
    #[account(address = book.beneficiary)] pub beneficiary: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = pledger, associated_token::mint = mint, associated_token::authority = beneficiary)]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub pledger: Signer<'info>, pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VoidPledge<'info> {
    #[account(mut, seeds = [PLEDGE_BOOK_SEED, book.proposal.as_ref()], bump = book.bump)] pub book: Box<Account<'info, PledgeBook>>,
    /// CHECK: verified against book.proposal.
    pub proposal: UncheckedAccount<'info>,
    #[account(mut, seeds = [PLEDGE_SEED, book.key().as_ref(), commitment.owner.as_ref()], bump = commitment.bump, has_one = book @ SupportError::InvalidCommitment)]
    pub commitment: Box<Account<'info, PledgeCommitment>>,
}

#[error_code]
pub enum SupportError {
    #[msg("Invalid proposal account")] InvalidProposalAccount,
    #[msg("Support token must be devnet USDC")] InvalidMint,
    #[msg("Proposal is not Active")] ProposalNotActive,
    #[msg("Proposal has not Executed")] ProposalNotExecuted,
    #[msg("Proposal is not Cancelled or Expired")] ProposalNotRefundable,
    #[msg("Support amount must be positive")] ZeroAmount,
    #[msg("Donations already released")] DonationsReleased,
    #[msg("Donation already refunded")] AlreadyRefunded,
    #[msg("Nothing to release")] NothingToRelease,
    #[msg("Nothing to refund")] NothingToRefund,
    #[msg("Arithmetic overflow or inconsistent aggregate")] MathOverflow,
    #[msg("Invalid donation position")] InvalidPosition,
    #[msg("Invalid pledge commitment")] InvalidCommitment,
    #[msg("Pledge is not active")] PledgeNotActive,
    #[msg("Fulfilled pledge cannot be changed")] PledgeAlreadyFulfilled,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_cancelled_and_expired_refund_or_void() {
        assert!(!is_refundable_status(STATUS_ACTIVE));
        assert!(!is_refundable_status(STATUS_EXECUTED));
        assert!(is_refundable_status(STATUS_CANCELLED));
        assert!(is_refundable_status(STATUS_EXPIRED));
    }
    #[test]
    fn commitment_states_are_distinct() {
        assert_eq!([COMMITMENT_ACTIVE, COMMITMENT_FULFILLED, COMMITMENT_REVOKED, COMMITMENT_VOIDED], [0, 1, 2, 3]);
    }
}
