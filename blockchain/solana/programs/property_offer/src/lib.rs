//! Fixed-price property offers. The maker chooses the lens that qualifies the accepting
//! counterparty for the immutable terms and payout schedule.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;
use sas_attestation::property::{qualification, QualificationError};

declare_id!("BasWrJJH6By9nkeeLAoAdYpPu35BM9VMtMCWGyXjqdBp");

pub const OFFER_SEED: &[u8] = b"property-offer";
pub const MAX_CID_LEN: usize = 64;
pub const MAX_PAYOUTS: usize = 16;

#[program]
pub mod property_offer {
    use super::*;

    pub fn create(
        ctx: Context<Create>, cid: String, lens: Pubkey, side: OfferSide, terms_hash: [u8; 32],
        price_lamports: u64, deadline: i64, payouts: Vec<Payout>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_valid_cid(&cid)?;
        require!(lens != Pubkey::default(), OfferError::NoLens);
        require!(price_lamports > 0, OfferError::ZeroPrice);
        require!(deadline > now, OfferError::DeadlinePassed);
        if side == OfferSide::Buy { require!(payouts.is_empty(), OfferError::BuyHasPayouts); }
        if side == OfferSide::Sell { validate_payouts(&payouts, price_lamports)?; require_no_offer_recipient(&payouts, ctx.accounts.offer.key())?; }
        let maker = ctx.accounts.maker.key();
        let offer = &mut ctx.accounts.offer;
        offer.maker = maker;
        offer.lens = lens;
        offer.buyer = if side == OfferSide::Buy { maker } else { Pubkey::default() };
        offer.seller = if side == OfferSide::Sell { maker } else { Pubkey::default() };
        offer.side = side;
        offer.status = OfferStatus::Open;
        offer.price_lamports = price_lamports;
        offer.escrow_lamports = 0;
        offer.deadline = deadline;
        offer.created_at = now;
        offer.accepted_at = 0;
        offer.attested_at = 0;
        offer.terms_hash = terms_hash;
        offer.payouts = payouts;
        offer.payouts_hash = payout_hash(&offer.payouts);
        offer.payouts_released = 0;
        offer.paid_bitmap = 0;
        offer.decision_attestation = Pubkey::default();
        offer.decision_hash = [0; 32];
        offer.bump = ctx.bumps.offer;
        offer.cid = cid;
        Ok(())
    }

    /// Binds the previously open side. A BUY offer supplies its seller schedule here; a SELL
    /// offer's schedule was immutable at create and the accepting wallet becomes its buyer.
    pub fn accept(ctx: Context<Accept>, payouts: Vec<Payout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer_key = ctx.accounts.offer.key();
        let offer = &mut ctx.accounts.offer;
        require!(offer.status == OfferStatus::Open, OfferError::NotOpen);
        require!(now <= offer.deadline, OfferError::DeadlinePassed);
        let (buyer, seller, schedule) = match offer.side {
            OfferSide::Buy => {
                require!(offer.seller == Pubkey::default(), OfferError::AlreadyAccepted);
                validate_payouts(&payouts, offer.price_lamports)?;
                require_no_offer_recipient(&payouts, offer_key)?;
                (offer.buyer, ctx.accounts.counterparty.key(), payouts)
            }
            OfferSide::Sell => {
                require!(offer.buyer == Pubkey::default(), OfferError::AlreadyAccepted);
                require!(payouts.is_empty(), OfferError::SellScheduleImmutable);
                (ctx.accounts.counterparty.key(), offer.seller, offer.payouts.clone())
            }
        };
        let schedule_hash = payout_hash(&schedule);
        let data = ctx.accounts.attestation.try_borrow_data()?;
        let decision = qualification(&ctx.accounts.attestation, &data, &ctx.accounts.credential, offer.lens, now).map_err(|e| match e {
            QualificationError::Account => error!(OfferError::InvalidAttestation),
            QualificationError::Payload => error!(OfferError::InvalidDecisionPayload),
            QualificationError::Expired => error!(OfferError::AttestationExpired),
            QualificationError::Lens => error!(OfferError::WrongLens),
            QualificationError::Schema => error!(OfferError::WrongSchema),
            QualificationError::NotQualified => error!(OfferError::CounterpartyNotQualified),
            QualificationError::Future => error!(OfferError::AttestationFromFuture),
        })?;
        require!(decision.cid == offer.cid.as_bytes(), OfferError::WrongDecision);
        require_keys_eq!(decision.offer, offer_key, OfferError::WrongDecision);
        require!(decision.terms_hash == offer.terms_hash && decision.payouts_hash == schedule_hash, OfferError::WrongDecision);
        require_keys_eq!(decision.buyer, buyer, OfferError::WrongDecision);
        require_keys_eq!(decision.seller, seller, OfferError::WrongDecision);
        offer.buyer = buyer; offer.seller = seller; offer.payouts = schedule; offer.payouts_hash = schedule_hash;
        offer.status = OfferStatus::Accepted;
        offer.accepted_at = now;
        offer.decision_attestation = ctx.accounts.attestation.key();
        offer.decision_hash = hash(&data).to_bytes();
        offer.attested_at = now;
        Ok(())
    }

    /// Exactly one fixed-price deposit by the bound buyer. Preventing top-ups makes refunds and
    /// the price/schedule invariant trivial to audit.
    pub fn fund(ctx: Context<Fund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer = &ctx.accounts.offer;
        require!(offer.status == OfferStatus::Accepted, OfferError::NotAccepted);
        require!(now <= offer.deadline, OfferError::DeadlinePassed);
        require!(offer.escrow_lamports == 0, OfferError::AlreadyFunded);
        system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
            from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.offer.to_account_info(),
        }), offer.price_lamports)?;
        ctx.accounts.offer.escrow_lamports = offer.price_lamports;
        Ok(())
    }

    /// Atomically settle every recipient in the fixed schedule. The remaining accounts must be
    /// the writable recipients in schedule order; any mismatch rolls the whole instruction back.
    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer_account = ctx.accounts.offer.to_account_info();
        let offer = &mut ctx.accounts.offer;
        require!(offer.status == OfferStatus::Accepted, OfferError::NotAccepted);
        require!(offer.decision_attestation != Pubkey::default(), OfferError::NotAttested);
        require!(now <= offer.deadline, OfferError::DeadlinePassed);
        require!(offer.escrow_lamports == offer.price_lamports, OfferError::InsufficientEscrow);
        require!(ctx.remaining_accounts.len() == offer.payouts.len(), OfferError::WrongRecipientList);
        for (payout, recipient) in offer.payouts.iter().zip(ctx.remaining_accounts.iter()) {
            require_keys_eq!(payout.recipient, recipient.key(), OfferError::WrongRecipient);
            require!(recipient.is_writable, OfferError::WrongRecipient);
        }
        for (payout, recipient) in offer.payouts.iter().zip(ctx.remaining_accounts.iter()) {
            transfer_lamports(&offer_account, recipient, payout.lamports)?;
        }
        offer.escrow_lamports = 0;
        offer.payouts_released = offer.payouts.len() as u8;
        // `MAX_PAYOUTS` is 16: calculate in u32, then narrow the full 16-bit mask.
        offer.paid_bitmap = ((1u32 << offer.payouts.len()) - 1) as u16;
        offer.status = OfferStatus::Settled;
        Ok(())
    }

    /// An open offer belongs to its maker. Acceptance is lens-gated and irreversible; expiry is
    /// the recovery path for an uncompleted funded escrow.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        require!(offer.status == OfferStatus::Open, OfferError::NotCancellable);
        require_keys_eq!(ctx.accounts.authority.key(), offer.maker, OfferError::Unauthorized);
        let amount = offer.escrow_lamports;
        offer.escrow_lamports = 0;
        offer.status = OfferStatus::Cancelled;
        transfer_lamports(&ctx.accounts.offer.to_account_info(), &ctx.accounts.authority.to_account_info(), amount)
    }

    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let offer = &mut ctx.accounts.offer;
        require!(matches!(offer.status, OfferStatus::Open | OfferStatus::Accepted), OfferError::NotExpirable);
        require!(now > offer.deadline, OfferError::DeadlineNotPassed);
        // An open SELL has no buyer yet. It has no escrow, but still needs a writable account
        // for this terminal instruction; use the maker in that case.
        let refund_recipient = if offer.buyer == Pubkey::default() { offer.maker } else { offer.buyer };
        require_keys_eq!(ctx.accounts.buyer.key(), refund_recipient, OfferError::WrongRecipient);
        let amount = offer.escrow_lamports;
        offer.escrow_lamports = 0;
        offer.status = OfferStatus::Expired;
        transfer_lamports(&ctx.accounts.offer.to_account_info(), &ctx.accounts.buyer.to_account_info(), amount)
    }
}

#[derive(Accounts)]
#[instruction(cid: String)]
pub struct Create<'info> {
    #[account(init, payer = maker, space = 8 + PropertyOffer::INIT_SPACE, seeds = [OFFER_SEED, maker.key().as_ref(), &cid_seed(&cid)], bump)]
    pub offer: Account<'info, PropertyOffer>,
    #[account(mut)] pub maker: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)] pub struct Accept<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Account<'info, PropertyOffer>,
    pub counterparty: Signer<'info>,
    /// CHECK: checked in accept before it binds counterparties
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: checked in accept
    pub credential: UncheckedAccount<'info>,
}
#[derive(Accounts)] pub struct Fund<'info> {
    #[account(mut, has_one = buyer @ OfferError::Unauthorized, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Account<'info, PropertyOffer>,
    #[account(mut)] pub buyer: Signer<'info>, pub system_program: Program<'info, System>,
}
#[derive(Accounts)] pub struct Execute<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Account<'info, PropertyOffer>,
}
#[derive(Accounts)] pub struct Cancel<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Account<'info, PropertyOffer>,
    #[account(mut)] pub authority: Signer<'info>,
}
#[derive(Accounts)] pub struct Expire<'info> {
    #[account(mut, seeds = [OFFER_SEED, offer.maker.as_ref(), &cid_seed(&offer.cid)], bump = offer.bump)] pub offer: Account<'info, PropertyOffer>,
    /// CHECK: the fixed buyer, or the maker for an open sell, receives any escrow.
    #[account(mut)] pub buyer: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct PropertyOffer {
    pub maker: Pubkey, pub lens: Pubkey, pub buyer: Pubkey, pub seller: Pubkey,
    pub side: OfferSide, pub status: OfferStatus, pub price_lamports: u64, pub escrow_lamports: u64,
    pub deadline: i64, pub created_at: i64, pub accepted_at: i64, pub attested_at: i64,
    pub terms_hash: [u8; 32], pub payouts_hash: [u8; 32], #[max_len(MAX_PAYOUTS)] pub payouts: Vec<Payout>,
    pub payouts_released: u8, pub paid_bitmap: u16, pub decision_attestation: Pubkey, pub decision_hash: [u8; 32], pub bump: u8,
    #[max_len(MAX_CID_LEN)] pub cid: String,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)] pub struct Payout { pub recipient: Pubkey, pub lamports: u64 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)] pub enum OfferSide { Buy = 0, Sell = 1 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)] pub enum OfferStatus { Open = 0, Accepted = 1, Settled = 2, Cancelled = 3, Expired = 4 }

fn cid_seed(cid: &str) -> [u8; 32] { hash(cid.as_bytes()).to_bytes() }
fn require_valid_cid(cid: &str) -> Result<()> { require!(!cid.is_empty() && cid.len() <= MAX_CID_LEN && cid.bytes().all(|b| b.is_ascii_alphanumeric()), OfferError::InvalidCid); Ok(()) }
fn validate_payouts(payouts: &[Payout], price: u64) -> Result<()> {
    require!(!payouts.is_empty() && payouts.len() <= MAX_PAYOUTS, OfferError::InvalidPayoutSchedule);
    let mut total = 0u64;
    for (i, p) in payouts.iter().enumerate() { require!(p.recipient != Pubkey::default() && p.lamports > 0, OfferError::InvalidPayoutSchedule); for prior in &payouts[..i] { require!(prior.recipient != p.recipient, OfferError::DuplicateRecipient); } total = total.checked_add(p.lamports).ok_or(OfferError::ArithmeticOverflow)?; }
    require!(total == price, OfferError::PayoutTotalMismatch); Ok(())
}
fn require_no_offer_recipient(payouts: &[Payout], offer: Pubkey) -> Result<()> { for payout in payouts { require_keys_neq!(payout.recipient, offer, OfferError::InvalidPayoutSchedule); } Ok(()) }
fn payout_hash(payouts: &[Payout]) -> [u8; 32] { let mut bytes = Vec::with_capacity(payouts.len() * 40); for p in payouts { bytes.extend_from_slice(p.recipient.as_ref()); bytes.extend_from_slice(&p.lamports.to_le_bytes()); } hash(&bytes).to_bytes() }
fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> { if amount == 0 { return Ok(()); } let available = from.lamports(); require!(available >= amount, OfferError::InsufficientEscrow); **from.try_borrow_mut_lamports()? = available.checked_sub(amount).ok_or(OfferError::ArithmeticOverflow)?; **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(OfferError::ArithmeticOverflow)?; Ok(()) }

#[error_code] pub enum OfferError {
    #[msg("Offer is not open")] NotOpen, #[msg("Offer is not accepted")] NotAccepted, #[msg("Offer deadline has passed")] DeadlinePassed, #[msg("Offer deadline has not passed")] DeadlineNotPassed, #[msg("Unauthorized")] Unauthorized,
    #[msg("CID must be 1-64 ASCII letters and digits")] InvalidCid, #[msg("A lens is required")] NoLens, #[msg("Price must be positive")] ZeroPrice, #[msg("Buy offers have no schedule until acceptance")] BuyHasPayouts, #[msg("Payout schedule is invalid")] InvalidPayoutSchedule, #[msg("Payout recipients must be unique")] DuplicateRecipient, #[msg("Payout amounts must equal the offer price")] PayoutTotalMismatch,
    #[msg("Offer already has a counterparty")] AlreadyAccepted, #[msg("A sell offer's schedule is immutable")] SellScheduleImmutable, #[msg("Offer is already funded")] AlreadyFunded, #[msg("Offer cannot be cancelled now")] NotCancellable, #[msg("Offer cannot be expired now")] NotExpirable, #[msg("No lens decision is recorded")] NotAttested,
    #[msg("Invalid SAS attestation or credential")] InvalidAttestation, #[msg("Attestation expired")] AttestationExpired, #[msg("Wrong lens")] WrongLens, #[msg("Wrong decision schema")] WrongSchema, #[msg("Malformed property offer decision")] InvalidDecisionPayload, #[msg("Decision does not bind this accepted offer")] WrongDecision, #[msg("Decision did not qualify the counterparty")] CounterpartyNotQualified, #[msg("Decision observation is in the future")] AttestationFromFuture,
    #[msg("Recipient differs from the schedule")] WrongRecipient, #[msg("Recipient account list differs from the schedule")] WrongRecipientList, #[msg("Insufficient escrow")] InsufficientEscrow, #[msg("Arithmetic overflow")] ArithmeticOverflow,
}

#[cfg(test)] mod tests { use super::*; #[test] fn schedule_is_exact_and_unique() { let a = Pubkey::new_unique(); let b = Pubkey::new_unique(); assert!(validate_payouts(&[Payout { recipient: a, lamports: 2 }, Payout { recipient: b, lamports: 3 }], 5).is_ok()); assert!(validate_payouts(&[Payout { recipient: a, lamports: 2 }, Payout { recipient: a, lamports: 3 }], 5).is_err()); assert!(validate_payouts(&[Payout { recipient: a, lamports: 2 }], 3).is_err()); } #[test] fn payout_hash_is_order_sensitive() { let a = Pubkey::new_unique(); let b = Pubkey::new_unique(); assert_ne!(payout_hash(&[Payout { recipient: a, lamports: 1 }, Payout { recipient: b, lamports: 2 }]), payout_hash(&[Payout { recipient: b, lamports: 2 }, Payout { recipient: a, lamports: 1 }])); } #[test] fn settled_bitmap_covers_all_sixteen_recipients() { assert_eq!(((1u32 << MAX_PAYOUTS) - 1) as u16, u16::MAX); } }
