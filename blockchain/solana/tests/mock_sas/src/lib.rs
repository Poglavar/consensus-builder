//! Localnet-only mock of the Solana Attestation Service (SAS) program. Anchor.toml loads it at the
//! real SAS program id, so accounts it owns pass the programs' `owner == SAS_PROGRAM_ID` checks.
//! Its single instruction writes raw bytes into an account it owns — [offset u32 LE][bytes] —
//! which lets the TypeScript suites lay out credentials, schemas and attestations byte-identical
//! to sas-lib's codecs (tests/sas-mock.ts). Anyone may write: never deploy this anywhere else.

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let target = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if target.owner != program_id || !target.is_writable {
        return Err(ProgramError::IncorrectProgramId);
    }
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let offset = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let bytes = &data[4..];
    let end = offset.checked_add(bytes.len()).ok_or(ProgramError::InvalidInstructionData)?;
    let mut account_data = target.try_borrow_mut_data()?;
    if end > account_data.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    account_data[offset..end].copy_from_slice(bytes);
    Ok(())
}
