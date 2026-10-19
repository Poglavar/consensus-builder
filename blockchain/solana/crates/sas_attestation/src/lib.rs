//! Byte-level readers for Solana Attestation Service (SAS) accounts, shared by proposal_market
//! (court evidence for external markets) and proposal_nft (lens ownership and verdict
//! attestations). Programs read SAS accounts directly instead of through CPI or declare_program!,
//! so these layouts must match sas-lib 1.0.10's generated codecs byte for byte:
//!
//! - Credential: discriminator u8 (0) | authority 32 | name (u32 len + bytes) | authorized_signers
//!   (u32 count + 32 each)
//! - Schema: discriminator u8 (1) | credential 32 | name, description, layout, field_names (each
//!   u32 len + bytes) | is_paused u8 | version u8
//! - Attestation: discriminator u8 (2) | nonce 32 | credential 32 | schema 32 | data (u32 len +
//!   bytes) | signer 32 | expiry i64 LE | token_account 32
//!
//! Errors are a plain enum so each program maps them onto its own Anchor error codes.

use anchor_lang::prelude::pubkey;
use anchor_lang::solana_program::pubkey::Pubkey;

/// SAS program id (same on devnet and mainnet).
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

pub const CREDENTIAL_DISCRIMINATOR: u8 = 0;
pub const SCHEMA_DISCRIMINATOR: u8 = 1;
pub const ATTESTATION_DISCRIMINATOR: u8 = 2;

/// Offset of the attestation payload: discriminator + nonce + credential + schema + u32 length.
pub const ATTESTATION_DATA_OFFSET: usize = 101;
/// signer (32) + expiry (8) follow the payload; the token account after them is not read.
const ATTESTATION_TRAILER: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SasError {
    /// Wrong discriminator, truncated account or inconsistent lengths.
    InvalidAccount,
    /// The attestation payload does not match the expected borsh layout.
    InvalidPayload,
    /// The schema names a different credential than expected.
    WrongCredential,
    /// The schema is paused.
    SchemaPaused,
}

/// The fields of a SAS attestation account that programs verify.
pub struct Attestation<'a> {
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub payload: &'a [u8],
    /// The `signer` field: the key that issued the attestation.
    pub authority: Pubkey,
    pub expiry: i64,
}

fn pubkey_at(data: &[u8], start: usize) -> Result<Pubkey, SasError> {
    let end = start.checked_add(32).ok_or(SasError::InvalidAccount)?;
    let bytes: [u8; 32] = data
        .get(start..end)
        .ok_or(SasError::InvalidAccount)?
        .try_into()
        .map_err(|_| SasError::InvalidAccount)?;
    Ok(Pubkey::new_from_array(bytes))
}

/// Parse an attestation account's bytes (owner must be checked by the caller).
pub fn parse_attestation(data: &[u8]) -> Result<Attestation<'_>, SasError> {
    if data.len() < ATTESTATION_DATA_OFFSET + ATTESTATION_TRAILER || data[0] != ATTESTATION_DISCRIMINATOR {
        return Err(SasError::InvalidAccount);
    }
    let credential = pubkey_at(data, 33)?;
    let schema = pubkey_at(data, 65)?;
    let payload_len = u32::from_le_bytes(data[97..101].try_into().map_err(|_| SasError::InvalidAccount)?) as usize;
    let payload_end = ATTESTATION_DATA_OFFSET.checked_add(payload_len).ok_or(SasError::InvalidAccount)?;
    let record_end = payload_end.checked_add(ATTESTATION_TRAILER).ok_or(SasError::InvalidAccount)?;
    if record_end > data.len() {
        return Err(SasError::InvalidAccount);
    }
    let authority = pubkey_at(data, payload_end)?;
    let expiry = i64::from_le_bytes(
        data[payload_end + 32..record_end].try_into().map_err(|_| SasError::InvalidAccount)?,
    );
    Ok(Attestation {
        credential,
        schema,
        payload: &data[ATTESTATION_DATA_OFFSET..payload_end],
        authority,
        expiry,
    })
}

/// Parse a credential account's bytes and return its authority. The name and signer vectors are
/// walked so a truncated or foreign account is rejected rather than half-read.
pub fn parse_credential_authority(data: &[u8]) -> Result<Pubkey, SasError> {
    if data.len() < 33 || data[0] != CREDENTIAL_DISCRIMINATOR {
        return Err(SasError::InvalidAccount);
    }
    let authority = pubkey_at(data, 1)?;
    let mut offset = 33usize;
    read_borsh_bytes(data, &mut offset).map_err(|_| SasError::InvalidAccount)?;
    let count_end = offset.checked_add(4).ok_or(SasError::InvalidAccount)?;
    let count = u32::from_le_bytes(
        data.get(offset..count_end).ok_or(SasError::InvalidAccount)?.try_into().map_err(|_| SasError::InvalidAccount)?,
    ) as usize;
    let signers_end = count
        .checked_mul(32)
        .and_then(|len| count_end.checked_add(len))
        .ok_or(SasError::InvalidAccount)?;
    if signers_end > data.len() {
        return Err(SasError::InvalidAccount);
    }
    Ok(authority)
}

/// Check a schema account's bytes: discriminator, embedded credential, four byte vectors, and
/// that it is not paused.
pub fn validate_schema_bytes(schema_data: &[u8], expected_credential: &Pubkey) -> Result<(), SasError> {
    if schema_data.len() < 33 || schema_data[0] != SCHEMA_DISCRIMINATOR {
        return Err(SasError::InvalidAccount);
    }
    if pubkey_at(schema_data, 1)? != *expected_credential {
        return Err(SasError::WrongCredential);
    }
    let mut offset = 33usize;
    for _ in 0..4 {
        read_borsh_bytes(schema_data, &mut offset).map_err(|_| SasError::InvalidAccount)?;
    }
    if offset + 2 > schema_data.len() {
        return Err(SasError::InvalidAccount);
    }
    if schema_data[offset] != 0 {
        return Err(SasError::SchemaPaused);
    }
    Ok(())
}

/// The schema PDA SAS derives for `name` / `version` under `credential`
/// (sas-lib deriveSchemaPda: ["schema", credential, name, [version]]).
pub fn schema_address(credential: &Pubkey, name: &[u8], version: u8) -> Pubkey {
    Pubkey::find_program_address(&[b"schema", credential.as_ref(), name, &[version]], &SAS_PROGRAM_ID).0
}

/// Read one borsh `Vec<u8>` / string (u32 LE length + bytes) at `offset` and advance it.
pub fn read_borsh_bytes<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8], SasError> {
    let length_end = offset.checked_add(4).ok_or(SasError::InvalidPayload)?;
    if length_end > bytes.len() {
        return Err(SasError::InvalidPayload);
    }
    let length = u32::from_le_bytes(bytes[*offset..length_end].try_into().map_err(|_| SasError::InvalidPayload)?) as usize;
    let value_end = length_end.checked_add(length).ok_or(SasError::InvalidPayload)?;
    if value_end > bytes.len() {
        return Err(SasError::InvalidPayload);
    }
    *offset = value_end;
    Ok(&bytes[length_end..value_end])
}

/// Sequential reader over a borsh attestation payload (SAS layout types String, U8, I64).
pub struct PayloadReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> PayloadReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    pub fn string(&mut self) -> Result<&'a [u8], SasError> {
        read_borsh_bytes(self.bytes, &mut self.offset)
    }

    pub fn u8(&mut self) -> Result<u8, SasError> {
        let value = *self.bytes.get(self.offset).ok_or(SasError::InvalidPayload)?;
        self.offset += 1;
        Ok(value)
    }

    pub fn i64(&mut self) -> Result<i64, SasError> {
        let end = self.offset.checked_add(8).ok_or(SasError::InvalidPayload)?;
        let bytes: [u8; 8] = self
            .bytes
            .get(self.offset..end)
            .ok_or(SasError::InvalidPayload)?
            .try_into()
            .map_err(|_| SasError::InvalidPayload)?;
        self.offset = end;
        Ok(i64::from_le_bytes(bytes))
    }

    pub fn is_at_end(&self) -> bool {
        self.offset == self.bytes.len()
    }

    /// Require that every payload byte was consumed (a schema-extended payload is rejected).
    pub fn finish(&self) -> Result<(), SasError> {
        if self.is_at_end() {
            Ok(())
        } else {
            Err(SasError::InvalidPayload)
        }
    }
}

/// Parse a payload string field that holds a base58 public key.
pub fn parse_pubkey_string(value: &[u8]) -> Result<Pubkey, SasError> {
    let text = core::str::from_utf8(value).map_err(|_| SasError::InvalidPayload)?;
    text.parse::<Pubkey>().map_err(|_| SasError::InvalidPayload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn borsh(value: &[u8]) -> Vec<u8> {
        let mut out = (value.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(value);
        out
    }

    fn attestation(payload: &[u8]) -> Vec<u8> {
        let mut data = vec![0u8; ATTESTATION_DATA_OFFSET];
        data[0] = ATTESTATION_DISCRIMINATOR;
        data[33..65].copy_from_slice(&[4; 32]);
        data[65..97].copy_from_slice(&[5; 32]);
        data[97..101].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        data.extend_from_slice(payload);
        data.extend_from_slice(&[6; 32]);
        data.extend_from_slice(&7i64.to_le_bytes());
        data.extend_from_slice(&[0; 32]);
        data
    }

    #[test]
    fn parses_an_attestation_with_its_trailing_token_account() {
        let payload = [borsh(b"HR-1"), vec![2u8]].concat();
        let data = attestation(&payload);
        let parsed = parse_attestation(&data).unwrap();
        assert_eq!(parsed.credential, Pubkey::new_from_array([4; 32]));
        assert_eq!(parsed.schema, Pubkey::new_from_array([5; 32]));
        assert_eq!(parsed.authority, Pubkey::new_from_array([6; 32]));
        assert_eq!(parsed.expiry, 7);
        let mut reader = PayloadReader::new(parsed.payload);
        assert_eq!(reader.string().unwrap(), b"HR-1");
        assert_eq!(reader.u8().unwrap(), 2);
        assert!(reader.finish().is_ok());
        assert!(reader.u8().is_err());
    }

    #[test]
    fn rejects_truncated_attestations_and_wrong_discriminators() {
        let data = attestation(&borsh(b"x"));
        assert!(parse_attestation(&data[..data.len() - 33]).is_err());
        let mut wrong = data.clone();
        wrong[0] = CREDENTIAL_DISCRIMINATOR;
        assert!(parse_attestation(&wrong).is_err());
    }

    #[test]
    fn reads_the_credential_authority_and_rejects_truncated_signer_lists() {
        let mut data = vec![CREDENTIAL_DISCRIMINATOR];
        data.extend_from_slice(&[9; 32]);
        data.extend_from_slice(&borsh(b"notary"));
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&[9; 32]);
        assert_eq!(parse_credential_authority(&data).unwrap(), Pubkey::new_from_array([9; 32]));
        assert!(parse_credential_authority(&data[..data.len() - 1]).is_err());
        data[0] = SCHEMA_DISCRIMINATOR;
        assert!(parse_credential_authority(&data).is_err());
    }

    #[test]
    fn parses_base58_pubkey_strings_strictly() {
        let key = Pubkey::new_from_array([3; 32]);
        assert_eq!(parse_pubkey_string(key.to_string().as_bytes()).unwrap(), key);
        assert!(parse_pubkey_string(b"not-a-key").is_err());
        assert!(parse_pubkey_string(b"").is_err());
    }
}
