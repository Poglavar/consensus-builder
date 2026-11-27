//! Fixed-price offers to buy or sell one property (a plot or a flat) in SOL or devnet USDC.
//!
//! The program never learns what is sold or whether the seller holds it: the offer commits its
//! terms by hash, and lenses decide. Each side names its own lens (1-8 member keys and how many must
//! confirm):
//! - the buyer's lens (required) states that the seller holds the asset (decision role 0);
//! - the seller's lens (optional, may be empty) states that the buyer qualifies (role 1).
//!
//! Lifecycle: create → commit → confirm* → execute, or cancel (the maker, while Open) or expire
//! (anyone, after the deadline; the buyer gets the escrow back). The buyer's money is escrowed when
//! the buyer acts: at create for a buy offer, at commit for a sell offer. Once both sides are
//! committed the offer waits for its lens members; each confirmation is a PropertyOfferConfirmation-v1
//! SAS attestation by that member, recorded by `confirm`, and `execute` pays the fixed payout
//! schedule once both lenses are met. A lens never decides by default: an unconfirmed offer expires.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sas_attestation::property::{offer_decision, QualificationError};

declare_id!("HrK4gvMqpYNvYSidaMLywy9mknQUatMig2fnWcG2UVyH");

pub const OFFER_SEED: &[u8] = b"property-offer";
pub const MAX_CID_LEN: usize = 64;
pub const MAX_PAYOUTS: usize = 16;
pub const MAX_LENS: usize = 8;
/// The only token besides SOL: Circle's devnet USDC (as in proposal_pledge).
pub const DEVNET_USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

#[program]
pub mod property_offer {
    use super::*;

    /// The maker states the terms and its own side's lens. A buyer pays the price into escrow now.
    pub fn create<'info>(
        ctx: Context<'_, '_, '_, 'info, Create<'info>>, cid: String, side: OfferSide, terms_hash: [u8; 32],
        price: u64, deadline: i64, payouts: Vec<Payout>, lens: Vec<Pubkey>, lens_threshold: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_valid_cid(&cid)?;
        require!(price > 0, OfferError::ZeroPrice);
        require!(deadline > now, OfferError::DeadlinePassed);
        let mint = match &ctx.accounts.mint {
            Some(mint) => { require_keys_eq!(mint.key(), DEVNET_USDC_MINT, OfferError::WrongMint); mint.key() }
            None => Pubkey::default(),
        };
        let maker = ctx.accounts.maker.key();
        let offer_key = ctx.accounts.offer.key();
        {
            let offer = &mut ctx.accounts.offer;
            offer.maker = maker;
            offer.mint = mint;
            offer.side = side;
            offer.status = OfferStatus::Open;
            offer.price = price;
            offer.escrow = 0;
            offer.deadline = deadline;
            offer.created_at = now;
            offer.committed_at = 0;
            offer.settled_at = 0;
            offer.terms_hash = terms_hash;
            offer.bump = ctx.bumps.offer;
            offer.cid = cid;
            match side {
                OfferSide::Buy => {
                    require!(payouts.is_empty(), OfferError::BuyHasPayouts);
                    offer.buyer = maker;
                    offer.seller = Pubkey::default();
                    offer.buyer_lens = Lens::new(&lens, lens_threshold, true)?;
                    offer.seller_lens = Lens::default();
                    offer.payouts = Vec::new();
                    offer.payouts_hash = [0; 32];
                }
                OfferSide::Sell => {
                    validate_payouts(&payouts, price, offer_key)?;
                    offer.buyer = Pubkey::default();
                    offer.seller = maker;
                    offer.seller_lens = Lens::new(&lens, lens_threshold, false)?;
                    offer.buyer_lens = Lens::default();
                    offer.payouts_hash = payout_hash(&payouts);
                    offer.payouts = payouts;
                }
            }
        }
        if side == OfferSide::Buy {
            let accounts = Deposit {
                payer: ctx.accounts.maker.to_account_info(), offer: ctx.accounts.offer.to_account_info(),
                payer_tokens: ctx.accounts.maker_tokens.as_ref().map(|a| a.to_account_info()),
                vault: ctx.accounts.vault.as_ref().map(|a| a.to_account_info()),
                token_program: ctx.accounts.token_program.as_ref().map(|a| a.to_account_info()),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            deposit(&accounts, offer_key, mint, price)?;
            ctx.accounts.offer.escrow = price;
        }
        Ok(())
    }

    /// The counterparty binds the open side and names its own lens. A seller supplies the payout
    /// schedule of a buy offer; a buyer pays a sell offer's price into escrow.
    pub fn commit<'info>(
        ctx: Context<'_, '_, '_, 'info, Commit<'info>>, payouts: Vec<Payout>, lens: Vec<Pubkey>, lens_threshold: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer_key = ctx.accounts.offer.key();
        let counterparty = ctx.accounts.counterparty.key();
        let (side, mint, price) = {
            let offer = &ctx.accounts.offer;
            require!(offer.status == OfferStatus::Open, OfferError::NotOpen);
            require!(now <= offer.deadline, OfferError::DeadlinePassed);
            require_keys_neq!(counterparty, offer.maker, OfferError::SelfDeal);
            (offer.side, offer.mint, offer.price)
        };
        {
            let offer = &mut ctx.accounts.offer;
            match side {
                OfferSide::Buy => {
                    validate_payouts(&payouts, price, offer_key)?;
                    offer.seller = counterparty;
                    offer.seller_lens = Lens::new(&lens, lens_threshold, false)?;
                    offer.payouts_hash = payout_hash(&payouts);
                    offer.payouts = payouts;
                }
                OfferSide::Sell => {
                    require!(payouts.is_empty(), OfferError::SellScheduleImmutable);
                    offer.buyer = counterparty;
                    offer.buyer_lens = Lens::new(&lens, lens_threshold, true)?;
                }
            }
            offer.status = OfferStatus::Committed;
            offer.committed_at = now;
        }
        if side == OfferSide::Sell {
            let accounts = Deposit {
                payer: ctx.accounts.counterparty.to_account_info(), offer: ctx.accounts.offer.to_account_info(),
                payer_tokens: ctx.accounts.counterparty_tokens.as_ref().map(|a| a.to_account_info()),
                vault: ctx.accounts.vault.as_ref().map(|a| a.to_account_info()),
                token_program: ctx.accounts.token_program.as_ref().map(|a| a.to_account_info()),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            deposit(&accounts, offer_key, mint, price)?;
            ctx.accounts.offer.escrow = price;
        }
        Ok(())
    }

    /// Record one lens member's PropertyOfferConfirmation-v1 for this committed offer. Anyone may submit
    /// it; the attestation's signer must be a member of the lens its role belongs to, and each
    /// member counts once.
    pub fn confirm(ctx: Context<Confirm>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer_key = ctx.accounts.offer.key();
        let offer = &mut ctx.accounts.offer;
        require!(offer.status == OfferStatus::Committed, OfferError::NotCommitted);
        require!(now <= offer.deadline, OfferError::DeadlinePassed);
        let data = ctx.accounts.attestation.try_borrow_data()?;
        let decision = offer_decision(&ctx.accounts.attestation, &data, &ctx.accounts.credential, now).map_err(|e| match e {
            QualificationError::Account => error!(OfferError::InvalidAttestation),
            QualificationError::Expired => error!(OfferError::AttestationExpired),
            QualificationError::Schema => error!(OfferError::WrongSchema),
            QualificationError::Future => error!(OfferError::AttestationFromFuture),
            _ => error!(OfferError::InvalidDecisionPayload),
        })?;
        require!(decision.cid == offer.cid.as_bytes(), OfferError::WrongDecision);
        require_keys_eq!(decision.offer, offer_key, OfferError::WrongDecision);
        require!(decision.terms_hash == offer.terms_hash && decision.payouts_hash == offer.payouts_hash, OfferError::WrongDecision);
        require_keys_eq!(decision.buyer, offer.buyer, OfferError::WrongDecision);
        require_keys_eq!(decision.seller, offer.seller, OfferError::WrongDecision);
        let lens = if decision.role == 0 { &mut offer.buyer_lens } else { &mut offer.seller_lens };
        let index = lens.index_of(&decision.authority).ok_or(error!(OfferError::NotALensMember))?;
        let bit = 1u8 << index;
        require!(lens.confirmed & bit == 0, OfferError::MemberAlreadyConfirmed);
        lens.confirmed |= bit;
        Ok(())
    }

    /// Pay the fixed schedule once both lenses are met. Remaining accounts are the recipients in
    /// schedule order: their wallets for SOL, their token accounts for USDC.
    pub fn execute<'info>(ctx: Context<'_, '_, 'info, 'info, Execute<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer_info = ctx.accounts.offer.to_account_info();
        let offer = &ctx.accounts.offer;
        require!(offer.status == OfferStatus::Committed, OfferError::NotCommitted);
        require!(now <= offer.deadline, OfferError::DeadlinePassed);
        require!(offer.buyer_lens.met() && offer.seller_lens.met(), OfferError::LensNotMet);
        require!(offer.escrow == offer.price, OfferError::InsufficientEscrow);
        require!(ctx.remaining_accounts.len() == offer.payouts.len(), OfferError::WrongRecipientList);
        let seeds: &[&[u8]] = &[OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid), &[offer.bump]];
        for (payout, recipient) in offer.payouts.iter().zip(ctx.remaining_accounts.iter()) {
            require!(recipient.is_writable, OfferError::WrongRecipient);
            if offer.mint == Pubkey::default() {
                require_keys_eq!(payout.recipient, recipient.key(), OfferError::WrongRecipient);
                transfer_lamports(&offer_info, recipient, payout.amount)?;
            } else {
                let account = token_account(recipient)?;
                require_keys_eq!(account.owner, payout.recipient, OfferError::WrongRecipient);
                require_keys_eq!(account.mint, offer.mint, OfferError::WrongMint);
                let (vault, token_program) = token_accounts(&ctx.accounts.vault, &ctx.accounts.token_program, offer_info.key, &offer.mint)?;
                token::transfer(CpiContext::new_with_signer(token_program, Transfer {
                    from: vault, to: recipient.clone(), authority: offer_info.clone(),
                }, &[seeds]), payout.amount)?;
            }
        }
        let offer = &mut ctx.accounts.offer;
        offer.escrow = 0;
        offer.status = OfferStatus::Settled;
        offer.settled_at = now;
        Ok(())
    }

    /// The maker withdraws an offer nobody has committed to; a buyer's escrow returns.
    pub fn cancel<'info>(ctx: Context<'_, '_, 'info, 'info, Cancel<'info>>) -> Result<()> {
        require!(ctx.accounts.offer.status == OfferStatus::Open, OfferError::NotCancellable);
        require_keys_eq!(ctx.accounts.maker.key(), ctx.accounts.offer.maker, OfferError::Unauthorized);
        let refund_to = ctx.accounts.refund_tokens.as_ref().map(|a| a.to_account_info()).unwrap_or(ctx.accounts.maker.to_account_info());
        refund(&ctx.accounts.offer, &ctx.accounts.vault, &ctx.accounts.token_program, &refund_to)?;
        let offer = &mut ctx.accounts.offer;
        offer.escrow = 0;
        offer.status = OfferStatus::Cancelled;
        Ok(())
    }

    /// After the deadline anyone ends an unsettled offer; any escrow returns to the buyer.
    pub fn expire<'info>(ctx: Context<'_, '_, 'info, 'info, Expire<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer = &ctx.accounts.offer;
        require!(matches!(offer.status, OfferStatus::Open | OfferStatus::Committed), OfferError::NotExpirable);
        require!(now > offer.deadline, OfferError::DeadlineNotPassed);
        if offer.escrow > 0 {
            let refund_to = ctx.accounts.refund_to.to_account_info();
            if offer.mint == Pubkey::default() {
                require_keys_eq!(refund_to.key(), offer.buyer, OfferError::WrongRecipient);
            }
            refund(offer, &ctx.accounts.vault, &ctx.accounts.token_program, &refund_to)?;
        }
        let offer = &mut ctx.accounts.offer;
        offer.escrow = 0;
        offer.status = OfferStatus::Expired;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(cid: String)]
pub struct Create<'info> {
    #[account(init, payer = maker, space = 8 + PropertyOffer::INIT_SPACE, seeds = [OFFER_SEED, maker.key().as_ref(), &cid_seed(&cid)], bump)]
    pub offer: Box<Account<'info, PropertyOffer>>,
    #[account(mut)] pub maker: Signer<'info>,
    /// USDC only: the mint; absent for SOL.
    pub mint: Option<Box<Account<'info, Mint>>>,
    /// USDC buy offers: the maker's token account the price comes from.
    #[account(mut)] pub maker_tokens: Option<Box<Account<'info, TokenAccount>>>,
    /// USDC buy offers: the offer's associated token account (created by the client beforehand).
    #[account(mut)] pub vault: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)] pub struct Commit<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Box<Account<'info, PropertyOffer>>,
    #[account(mut)] pub counterparty: Signer<'info>,
    #[account(mut)] pub counterparty_tokens: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut)] pub vault: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)] pub struct Confirm<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Box<Account<'info, PropertyOffer>>,
    /// CHECK: a SAS attestation, checked in confirm
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: its SAS credential, checked in confirm
    pub credential: UncheckedAccount<'info>,
}
#[derive(Accounts)] pub struct Execute<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Box<Account<'info, PropertyOffer>>,
    #[account(mut)] pub vault: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}
#[derive(Accounts)] pub struct Cancel<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Box<Account<'info, PropertyOffer>>,
    #[account(mut)] pub maker: Signer<'info>,
    #[account(mut)] pub vault: Option<Box<Account<'info, TokenAccount>>>,
    /// USDC buy offers: the maker's token account the escrow returns to.
    #[account(mut)] pub refund_tokens: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}
#[derive(Accounts)] pub struct Expire<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Box<Account<'info, PropertyOffer>>,
    /// CHECK: the buyer's wallet (SOL) or the buyer's token account (USDC), checked in refund
    #[account(mut)] pub refund_to: UncheckedAccount<'info>,
    #[account(mut)] pub vault: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}

/// The fixed header puts maker, buyer, seller and mint at known offsets for memcmp listing filters.
#[account]
#[derive(InitSpace)]
pub struct PropertyOffer {
    pub maker: Pubkey, pub buyer: Pubkey, pub seller: Pubkey,
    /// `Pubkey::default()` for SOL, else the token mint (devnet USDC).
    pub mint: Pubkey,
    pub side: OfferSide, pub status: OfferStatus,
    pub price: u64, pub escrow: u64,
    pub deadline: i64, pub created_at: i64, pub committed_at: i64, pub settled_at: i64,
    pub terms_hash: [u8; 32], pub payouts_hash: [u8; 32],
    pub buyer_lens: Lens, pub seller_lens: Lens,
    #[max_len(MAX_PAYOUTS)] pub payouts: Vec<Payout>,
    pub bump: u8,
    #[max_len(MAX_CID_LEN)] pub cid: String,
}
/// Up to 8 member keys, how many must confirm, and which have (bit i = members[i]).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Lens { pub members: [Pubkey; MAX_LENS], pub count: u8, pub threshold: u8, pub confirmed: u8 }
impl Lens {
    fn new(keys: &[Pubkey], threshold: u8, required: bool) -> Result<Lens> {
        require!(keys.len() <= MAX_LENS, OfferError::InvalidLens);
        require!(!required || !keys.is_empty(), OfferError::NoLens);
        for (i, k) in keys.iter().enumerate() {
            require!(*k != Pubkey::default() && !keys[..i].contains(k), OfferError::InvalidLens);
        }
        if keys.is_empty() { require!(threshold == 0, OfferError::InvalidLens); } else { require!(threshold >= 1 && threshold as usize <= keys.len(), OfferError::InvalidLens); }
        let mut lens = Lens { count: keys.len() as u8, threshold, ..Default::default() };
        lens.members[..keys.len()].copy_from_slice(keys);
        Ok(lens)
    }
    fn index_of(&self, key: &Pubkey) -> Option<usize> { self.members[..self.count as usize].iter().position(|m| m == key) }
    fn met(&self) -> bool { self.confirmed.count_ones() as u8 >= self.threshold }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)] pub struct Payout { pub recipient: Pubkey, pub amount: u64 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)] pub enum OfferSide { Buy = 0, Sell = 1 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)] pub enum OfferStatus { Open = 0, Committed = 1, Settled = 2, Cancelled = 3, Expired = 4 }

struct Deposit<'info> {
    payer: AccountInfo<'info>, offer: AccountInfo<'info>, payer_tokens: Option<AccountInfo<'info>>,
    vault: Option<AccountInfo<'info>>, token_program: Option<AccountInfo<'info>>, system_program: AccountInfo<'info>,
}
/// Move exactly the price from the payer into the offer: lamports for SOL, else tokens into the
/// offer's associated token account.
fn deposit(a: &Deposit, offer: Pubkey, mint: Pubkey, price: u64) -> Result<()> {
    if mint == Pubkey::default() {
        return system_program::transfer(CpiContext::new(a.system_program.clone(), system_program::Transfer { from: a.payer.clone(), to: a.offer.clone() }), price);
    }
    let (Some(from), Some(vault), Some(token_program)) = (&a.payer_tokens, &a.vault, &a.token_program) else { return err!(OfferError::MissingTokenAccounts) };
    require_keys_eq!(vault.key(), get_associated_token_address(&offer, &mint), OfferError::WrongVault);
    token::transfer(CpiContext::new(token_program.clone(), Transfer { from: from.clone(), to: vault.clone(), authority: a.payer.clone() }), price)
}
fn token_accounts<'info>(vault: &Option<Box<Account<'info, TokenAccount>>>, token_program: &Option<Program<'info, Token>>, offer: &Pubkey, mint: &Pubkey) -> Result<(AccountInfo<'info>, AccountInfo<'info>)> {
    let (Some(vault), Some(token_program)) = (vault, token_program) else { return err!(OfferError::MissingTokenAccounts) };
    require_keys_eq!(vault.key(), get_associated_token_address(offer, mint), OfferError::WrongVault);
    Ok((vault.to_account_info(), token_program.to_account_info()))
}
/// Return the whole escrow to `to`: the buyer's wallet for SOL, the buyer's token account for USDC.
fn refund<'info>(offer: &Account<'info, PropertyOffer>, vault: &Option<Box<Account<'info, TokenAccount>>>, token_program: &Option<Program<'info, Token>>, to: &AccountInfo<'info>) -> Result<()> {
    if offer.escrow == 0 { return Ok(()); }
    let offer_info = offer.to_account_info();
    if offer.mint == Pubkey::default() { return transfer_lamports(&offer_info, to, offer.escrow); }
    let account = token_account(to)?;
    require_keys_eq!(account.owner, offer.buyer, OfferError::WrongRecipient);
    require_keys_eq!(account.mint, offer.mint, OfferError::WrongMint);
    let (vault, token_program) = token_accounts(vault, token_program, offer_info.key, &offer.mint)?;
    let seeds: &[&[u8]] = &[OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid), &[offer.bump]];
    token::transfer(CpiContext::new_with_signer(token_program, Transfer { from: vault, to: to.clone(), authority: offer_info }, &[seeds]), offer.escrow)
}

/// A token account's fields, read without tying the account to the instruction's lifetime.
fn token_account(info: &AccountInfo) -> Result<TokenAccount> {
    require_keys_eq!(*info.owner, token::ID, OfferError::WrongRecipient);
    TokenAccount::try_deserialize(&mut &info.try_borrow_data()?[..]).map_err(|_| error!(OfferError::WrongRecipient))
}
fn cid_seed(cid: &str) -> [u8; 32] { hash(cid.as_bytes()).to_bytes() }
fn require_valid_cid(cid: &str) -> Result<()> { require!(!cid.is_empty() && cid.len() <= MAX_CID_LEN && cid.bytes().all(|b| b.is_ascii_alphanumeric()), OfferError::InvalidCid); Ok(()) }
fn validate_payouts(payouts: &[Payout], price: u64, offer: Pubkey) -> Result<()> {
    require!(!payouts.is_empty() && payouts.len() <= MAX_PAYOUTS, OfferError::InvalidPayoutSchedule);
    let mut total = 0u64;
    for (i, p) in payouts.iter().enumerate() {
        require!(p.recipient != Pubkey::default() && p.recipient != offer && p.amount > 0, OfferError::InvalidPayoutSchedule);
        require!(!payouts[..i].iter().any(|prior| prior.recipient == p.recipient), OfferError::DuplicateRecipient);
        total = total.checked_add(p.amount).ok_or(OfferError::ArithmeticOverflow)?;
    }
    require!(total == price, OfferError::PayoutTotalMismatch); Ok(())
}
fn payout_hash(payouts: &[Payout]) -> [u8; 32] { let mut bytes = Vec::with_capacity(payouts.len() * 40); for p in payouts { bytes.extend_from_slice(p.recipient.as_ref()); bytes.extend_from_slice(&p.amount.to_le_bytes()); } hash(&bytes).to_bytes() }
fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> { if amount == 0 { return Ok(()); } let available = from.lamports(); require!(available >= amount, OfferError::InsufficientEscrow); **from.try_borrow_mut_lamports()? = available.checked_sub(amount).ok_or(OfferError::ArithmeticOverflow)?; **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(OfferError::ArithmeticOverflow)?; Ok(()) }

#[error_code] pub enum OfferError {
    #[msg("Offer is not open")] NotOpen, #[msg("Offer is not committed by both sides")] NotCommitted, #[msg("Offer deadline has passed")] DeadlinePassed, #[msg("Offer deadline has not passed")] DeadlineNotPassed, #[msg("Unauthorized")] Unauthorized,
    #[msg("CID must be 1-64 ASCII letters and digits")] InvalidCid, #[msg("The buyer's lens needs at least one member")] NoLens, #[msg("A lens has 0-8 distinct members and a threshold within them")] InvalidLens, #[msg("Price must be positive")] ZeroPrice, #[msg("Buy offers get their schedule from the seller")] BuyHasPayouts, #[msg("Payout schedule is invalid")] InvalidPayoutSchedule, #[msg("Payout recipients must be unique")] DuplicateRecipient, #[msg("Payout amounts must equal the offer price")] PayoutTotalMismatch,
    #[msg("A sell offer's schedule is fixed")] SellScheduleImmutable, #[msg("The maker cannot take its own offer")] SelfDeal, #[msg("Offer cannot be cancelled now")] NotCancellable, #[msg("Offer cannot be expired now")] NotExpirable,
    #[msg("Only SOL or devnet USDC")] WrongMint, #[msg("Token accounts are missing")] MissingTokenAccounts, #[msg("Vault is not the offer's token account")] WrongVault,
    #[msg("Invalid SAS attestation or credential")] InvalidAttestation, #[msg("Attestation expired")] AttestationExpired, #[msg("Wrong decision schema")] WrongSchema, #[msg("Malformed property offer decision")] InvalidDecisionPayload, #[msg("Decision does not bind this committed offer")] WrongDecision, #[msg("Decision observation is in the future")] AttestationFromFuture,
    #[msg("The signer is not a member of this lens")] NotALensMember, #[msg("This lens member has already confirmed")] MemberAlreadyConfirmed, #[msg("The lenses have not confirmed yet")] LensNotMet,
    #[msg("Recipient differs from the schedule")] WrongRecipient, #[msg("Recipient account list differs from the schedule")] WrongRecipientList, #[msg("Insufficient escrow")] InsufficientEscrow, #[msg("Arithmetic overflow")] ArithmeticOverflow,
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn schedule_is_exact_and_unique() { let o = Pubkey::new_unique(); let a = Pubkey::new_unique(); let b = Pubkey::new_unique(); assert!(validate_payouts(&[Payout { recipient: a, amount: 2 }, Payout { recipient: b, amount: 3 }], 5, o).is_ok()); assert!(validate_payouts(&[Payout { recipient: a, amount: 2 }, Payout { recipient: a, amount: 3 }], 5, o).is_err()); assert!(validate_payouts(&[Payout { recipient: a, amount: 2 }], 3, o).is_err()); assert!(validate_payouts(&[Payout { recipient: o, amount: 3 }], 3, o).is_err()); }
    #[test] fn lens_rules() { let a = Pubkey::new_unique(); let b = Pubkey::new_unique(); assert!(Lens::new(&[], 0, true).is_err()); assert!(Lens::new(&[], 0, false).unwrap().met()); assert!(Lens::new(&[a, a], 1, true).is_err()); assert!(Lens::new(&[a, b], 3, true).is_err()); let mut l = Lens::new(&[a, b], 2, true).unwrap(); assert!(!l.met()); l.confirmed = 0b01; assert!(!l.met()); l.confirmed = 0b11; assert!(l.met()); assert_eq!(l.index_of(&b), Some(1)); }
}
