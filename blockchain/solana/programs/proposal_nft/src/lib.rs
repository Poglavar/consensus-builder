//! Urban Game Theory Proposal NFT - Solana Program
//! Equivalent to EVM ProposalNFT.sol - proposals for parcel development

use anchor_lang::prelude::*;

declare_id!("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");

const PARCEL_NFT_PROGRAM_ID: Pubkey = pubkey!("4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1");

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

    /// Accept a proposal (parcel owner)
    pub fn accept_proposal(ctx: Context<AcceptProposal>, parcel_id: String) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.parcel_program.key(),
            PARCEL_NFT_PROGRAM_ID,
            ProposalError::InvalidParcelProgram
        );
        validate_parcel_owner(
            &ctx.accounts.parcel,
            &ctx.accounts.parcel_program,
            &parcel_id,
            &ctx.accounts.accepter.key(),
        )?;

        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.acceptance_possible,
            ProposalError::AcceptanceClosed
        );
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
    pub fn withdraw_acceptance(ctx: Context<WithdrawAcceptance>, parcel_id: String) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.parcel_program.key(),
            PARCEL_NFT_PROGRAM_ID,
            ProposalError::InvalidParcelProgram
        );
        validate_parcel_owner(
            &ctx.accounts.parcel,
            &ctx.accounts.parcel_program,
            &parcel_id,
            &ctx.accounts.withdrawer.key(),
        )?;

        let proposal = &mut ctx.accounts.proposal;
        require!(proposal.is_conditional, ProposalError::NotConditional);
        require!(
            proposal.status == ProposalStatus::Active,
            ProposalError::NotActive
        );

        let pos = proposal
            .accepted_parcels
            .iter()
            .position(|p| p == &parcel_id)
            .ok_or(ProposalError::AcceptanceNotFound)?;

        proposal.accepted_parcels.remove(pos);
        proposal.acceptance_count -= 1;
        proposal.acceptance_possible = true;

        Ok(())
    }

    /// Distribute locked SOL equally to owners of accepted parcel certificates.
    pub fn distribute_funds(ctx: Context<DistributeFunds>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.parcel_program.key(),
            PARCEL_NFT_PROGRAM_ID,
            ProposalError::InvalidParcelProgram
        );

        let (accepted_parcels, amount) = {
            let proposal = &mut ctx.accounts.proposal;
            require!(
                proposal.status == ProposalStatus::Executed,
                ProposalError::NotExecuted
            );
            require!(proposal.sol_balance > 0, ProposalError::ZeroAmount);
            require!(
                !proposal.accepted_parcels.is_empty(),
                ProposalError::AcceptanceNotFound
            );

            let accepted_parcels = proposal.accepted_parcels.clone();
            let amount = proposal.sol_balance;
            proposal.sol_balance = 0;
            (accepted_parcels, amount)
        };

        let expected_remaining = accepted_parcels.len() * 2;
        require!(
            ctx.remaining_accounts.len() == expected_remaining,
            ProposalError::InvalidDistributionAccounts
        );

        let accepted_count = accepted_parcels.len() as u64;
        let base_share = amount
            .checked_div(accepted_count)
            .ok_or(ProposalError::ArithmeticOverflow)?;
        let remainder = amount
            .checked_rem(accepted_count)
            .ok_or(ProposalError::ArithmeticOverflow)?;

        for (index, parcel_id) in accepted_parcels.iter().enumerate() {
            let parcel_account = &ctx.remaining_accounts[index * 2];
            let recipient = &ctx.remaining_accounts[index * 2 + 1];
            require!(
                recipient.is_writable,
                ProposalError::InvalidDistributionAccounts
            );
            validate_parcel_owner(
                parcel_account,
                &ctx.accounts.parcel_program,
                parcel_id,
                recipient.key,
            )?;

            let payout = base_share
                .checked_add(if index == 0 { remainder } else { 0 })
                .ok_or(ProposalError::ArithmeticOverflow)?;
            transfer_program_lamports(&ctx.accounts.proposal.to_account_info(), recipient, payout)?;
        }

        Ok(())
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
        space = 4096,
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

    /// CHECK: Validated as the PDA account for the accepted parcel id.
    pub parcel: UncheckedAccount<'info>,

    /// CHECK: Must be the trusted ParcelNFT program.
    pub parcel_program: UncheckedAccount<'info>,

    pub accepter: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(parcel_id: String)]
pub struct WithdrawAcceptance<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    /// CHECK: Validated as the PDA account for the withdrawn parcel id.
    pub parcel: UncheckedAccount<'info>,

    /// CHECK: Must be the trusted ParcelNFT program.
    pub parcel_program: UncheckedAccount<'info>,

    pub withdrawer: Signer<'info>,
}

#[derive(Accounts)]
pub struct DistributeFunds<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    /// CHECK: Must be the trusted ParcelNFT program. Remaining accounts carry parcel/recipient pairs.
    pub parcel_program: UncheckedAccount<'info>,
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
}

#[account]
pub struct Parcel {
    pub parcel_id: String,
    pub metadata_uri: String,
    pub owner: Pubkey,
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
}

fn validate_parcel_owner<'parcel, 'program>(
    parcel_account: &AccountInfo<'parcel>,
    parcel_program: &AccountInfo<'program>,
    parcel_id: &str,
    expected_owner: &Pubkey,
) -> Result<Parcel> {
    require!(
        parcel_program.executable,
        ProposalError::InvalidParcelProgram
    );
    require_keys_eq!(
        parcel_program.key(),
        PARCEL_NFT_PROGRAM_ID,
        ProposalError::InvalidParcelProgram
    );
    require_keys_eq!(
        *parcel_account.owner,
        parcel_program.key(),
        ProposalError::InvalidParcelProgram
    );

    let (expected_parcel_pda, _) =
        Pubkey::find_program_address(&[b"parcel", parcel_id.as_bytes()], &parcel_program.key());
    require_keys_eq!(
        parcel_account.key(),
        expected_parcel_pda,
        ProposalError::InvalidParcelAccount
    );

    let account_data = parcel_account.try_borrow_data()?;
    let mut data_slice: &[u8] = &account_data;
    let parcel = Parcel::try_deserialize(&mut data_slice)
        .map_err(|_| ProposalError::InvalidParcelAccount)?;

    require!(
        parcel.parcel_id == parcel_id,
        ProposalError::InvalidParcelAccount
    );
    require_keys_eq!(
        parcel.owner,
        *expected_owner,
        ProposalError::UnauthorizedParcelOwner
    );

    Ok(parcel)
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
