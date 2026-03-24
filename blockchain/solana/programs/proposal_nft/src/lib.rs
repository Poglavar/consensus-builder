//! Urban Game Theory Proposal NFT - Solana Program
//! Equivalent to EVM ProposalNFT.sol - proposals for parcel development

use anchor_lang::prelude::*;

declare_id!("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");

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
    ) -> Result<()> {
        require!(!parcel_ids.is_empty(), ProposalError::NoParcels);
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

        Ok(())
    }

    /// Contribute SOL to a proposal
    pub fn contribute_funds(ctx: Context<ContributeFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, ProposalError::ZeroAmount);
        require!(ctx.accounts.proposal.acceptance_possible, ProposalError::AcceptanceClosed);

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

    /// Accept a proposal (parcel owner)
    pub fn accept_proposal(
        ctx: Context<AcceptProposal>,
        parcel_id: String,
    ) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        require!(proposal.acceptance_possible, ProposalError::AcceptanceClosed);
        require!(
            proposal.parcel_ids.contains(&parcel_id),
            ProposalError::ParcelNotInProposal
        );
        require!(
            !proposal.accepted_parcels.contains(&parcel_id),
            ProposalError::AlreadyAccepted
        );

        proposal.accepted_parcels.push(parcel_id.clone());
        proposal.acceptance_count += 1;

        if proposal.acceptance_count == proposal.parcel_ids.len() as u64 {
            proposal.acceptance_possible = false;
            proposal.status = ProposalStatus::Executed;
        }

        Ok(())
    }

    /// Withdraw acceptance (conditional proposals only)
    pub fn withdraw_acceptance(
        ctx: Context<WithdrawAcceptance>,
        parcel_id: String,
    ) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        require!(proposal.is_conditional, ProposalError::NotConditional);
        require!(proposal.status == ProposalStatus::Active, ProposalError::NotActive);

        if let Some(pos) = proposal.accepted_parcels.iter().position(|p| p == &parcel_id) {
            proposal.accepted_parcels.remove(pos);
            proposal.acceptance_count -= 1;
            proposal.acceptance_possible = true;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct MintAndFund<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 4 + (4 + 64) * 10 + 1 + 4 + 256 + 1 + 1 + 8 + 8 + 8 + 4 + (4 + 64) * 10 + 4 + 32 * 10 + 32 + 1,
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
pub struct AcceptProposal<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    pub accepter: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(parcel_id: String)]
pub struct WithdrawAcceptance<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    pub withdrawer: Signer<'info>,
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
    #[msg("Must include at least one parcel")]
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
}
