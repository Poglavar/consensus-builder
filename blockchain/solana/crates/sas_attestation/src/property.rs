//! Lens members' property decisions: PropertyOfferConfirmation-v1 for property offers, and v2 for
//! apartment deposits in developer rounds (proposal_pledge).
use super::{
    parse_attestation, parse_credential_authority, parse_pubkey_string, schema_address,
    PayloadReader, SAS_PROGRAM_ID,
};
use anchor_lang::prelude::{AccountInfo, Pubkey};

pub struct Qualification<'a> {
    pub cid: &'a [u8],
    pub offer: Pubkey,
    pub terms_hash: [u8; 32],
    pub payouts_hash: [u8; 32],
    pub buyer: Pubkey,
    pub seller: Pubkey,
}

pub enum QualificationError {
    Account,
    Payload,
    Expired,
    Lens,
    Schema,
    NotQualified,
    Future,
}

fn digest(bytes: &[u8]) -> Option<[u8; 32]> {
    if bytes.len() != 64
        || !bytes
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    let text = core::str::from_utf8(bytes).ok()?;
    let mut result = [0; 32];
    for (i, slot) in result.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(result)
}

/// What a PropertyOfferConfirmation-v1 confirms: role 0, from a member of the buyer's lens, that the
/// seller holds the asset (and, by its address, which holding it sells); role 1, from a member of
/// the seller's lens, that the buyer qualifies.
pub struct OfferDecision<'a> {
    pub authority: Pubkey,
    pub cid: &'a [u8],
    pub offer: Pubkey,
    pub terms_hash: [u8; 32],
    pub payouts_hash: [u8; 32],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub role: u8,
}

/// Read a lens member's PropertyOfferConfirmation-v1. Payload (borsh): cid, offer, termsHash,
/// payoutsHash (hex), buyer, seller, role u8, asset (hex identity hash), holding (the statement or
/// offer through which the seller holds the asset; empty for role 1), observedAt i64. The program
/// checks the binding to the offer; asset and holding are for readers, and the attestation's
/// address (its nonce) is what makes a second confirmation of the same holding impossible.
pub fn offer_decision<'a>(
    account: &AccountInfo,
    data: &'a [u8],
    credential: &AccountInfo,
    now: i64,
) -> Result<OfferDecision<'a>, QualificationError> {
    use QualificationError::*;
    if account.owner != &SAS_PROGRAM_ID || credential.owner != &SAS_PROGRAM_ID {
        return Err(Account);
    }
    let att = parse_attestation(data).map_err(|_| Account)?;
    if att.expiry <= now {
        return Err(Expired);
    }
    if att.credential != *credential.key {
        return Err(Account);
    }
    let authority = parse_credential_authority(&credential.try_borrow_data().map_err(|_| Account)?)
        .map_err(|_| Account)?;
    if authority != att.authority {
        return Err(Account);
    }
    if att.schema != schema_address(credential.key, b"PropertyOfferConfirmation", 1) {
        return Err(Schema);
    }
    let mut r = PayloadReader::new(att.payload);
    let cid = r.string().map_err(|_| Payload)?;
    let offer = parse_pubkey_string(r.string().map_err(|_| Payload)?).map_err(|_| Payload)?;
    let terms_hash = digest(r.string().map_err(|_| Payload)?).ok_or(Payload)?;
    let payouts_hash = digest(r.string().map_err(|_| Payload)?).ok_or(Payload)?;
    let buyer = parse_pubkey_string(r.string().map_err(|_| Payload)?).map_err(|_| Payload)?;
    let seller = parse_pubkey_string(r.string().map_err(|_| Payload)?).map_err(|_| Payload)?;
    let role = r.u8().map_err(|_| Payload)?;
    if role > 1 {
        return Err(Payload);
    }
    digest(r.string().map_err(|_| Payload)?).ok_or(Payload)?;
    r.string().map_err(|_| Payload)?;
    let observed = r.i64().map_err(|_| Payload)?;
    if observed < 0 || observed > now {
        return Err(Future);
    }
    r.finish().map_err(|_| Payload)?;
    Ok(OfferDecision { authority, cid, offer, terms_hash, payouts_hash, buyer, seller, role })
}

pub fn qualification<'a>(
    account: &AccountInfo,
    data: &'a [u8],
    credential: &AccountInfo,
    lens: Pubkey,
    now: i64,
) -> Result<Qualification<'a>, QualificationError> {
    use QualificationError::*;
    if account.owner != &SAS_PROGRAM_ID || credential.owner != &SAS_PROGRAM_ID {
        return Err(Account);
    }
    let att = parse_attestation(data).map_err(|_| Account)?;
    if att.expiry <= now {
        return Err(Expired);
    }
    if att.credential != *credential.key {
        return Err(Account);
    }
    let authority = parse_credential_authority(&credential.try_borrow_data().map_err(|_| Account)?)
        .map_err(|_| Account)?;
    if authority != att.authority {
        return Err(Account);
    }
    if att.authority != lens {
        return Err(Lens);
    }
    if att.schema != schema_address(credential.key, b"PropertyOfferDecision", 2) {
        return Err(Schema);
    }
    let mut r = PayloadReader::new(att.payload);
    let cid = r.string().map_err(|_| Payload)?;
    let offer = parse_pubkey_string(r.string().map_err(|_| Payload)?).map_err(|_| Payload)?;
    let terms_hash = digest(r.string().map_err(|_| Payload)?).ok_or(Payload)?;
    let payouts_hash = digest(r.string().map_err(|_| Payload)?).ok_or(Payload)?;
    let buyer = parse_pubkey_string(r.string().map_err(|_| Payload)?).map_err(|_| Payload)?;
    let seller = parse_pubkey_string(r.string().map_err(|_| Payload)?).map_err(|_| Payload)?;
    match r.u8().map_err(|_| Payload)? {
        1 => (),
        0 => return Err(NotQualified),
        _ => return Err(Payload),
    }
    let observed = r.i64().map_err(|_| Payload)?;
    if observed < 0 || observed > now {
        return Err(Future);
    }
    r.finish().map_err(|_| Payload)?;
    Ok(Qualification {
        cid,
        offer,
        terms_hash,
        payouts_hash,
        buyer,
        seller,
    })
}
