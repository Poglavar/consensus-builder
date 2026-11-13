//! A hand-encoded CPI into Metaplex Core's `CreateV2` (program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d).
//! The `mpl-core` crate pins solana-program 3 (2.3 with its `anchor` feature) while this workspace
//! is on anchor-lang 0.30 / solana-program 1.18, so the instruction is spelled here byte for byte
//! from the crate's generated client (mpl-core 0.12.1, `instructions/create_v2.rs` and `types/`):
//! discriminator 20, then borsh `CreateV2Args { data_state, name, uri, plugins, external_plugin_adapters }`.
//! A record's asset is soulbound: the PermanentFreezeDelegate plugin (frozen, authority None) can
//! never be removed or unfrozen, so the asset is never transferred or burned.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

pub const MPL_CORE_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

/// `MplAssetInstruction::CreateV2`.
const CREATE_V2: u8 = 20;
/// `DataState::AccountState`: the asset lives in its own account.
const DATA_STATE_ACCOUNT: u8 = 0;
/// `Plugin::PermanentFreezeDelegate` (the sixth variant).
const PLUGIN_PERMANENT_FREEZE_DELEGATE: u8 = 5;
/// `PluginAuthority::None`: nobody may ever change the plugin.
const PLUGIN_AUTHORITY_NONE: u8 = 0;

fn push_string(data: &mut Vec<u8>, value: &str) {
    data.extend_from_slice(&(value.len() as u32).to_le_bytes());
    data.extend_from_slice(value.as_bytes());
}

/// The instruction data of a CreateV2 minting a permanently frozen asset named `name` with metadata `uri`.
pub fn create_v2_data(name: &str, uri: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(16 + name.len() + uri.len());
    data.push(CREATE_V2);
    data.push(DATA_STATE_ACCOUNT);
    push_string(&mut data, name);
    push_string(&mut data, uri);
    // plugins: Some(vec![PluginAuthorityPair { plugin: PermanentFreezeDelegate { frozen: true }, authority: Some(None) }])
    data.push(1);
    data.extend_from_slice(&1u32.to_le_bytes());
    data.push(PLUGIN_PERMANENT_FREEZE_DELEGATE);
    data.push(1);
    data.push(1);
    data.push(PLUGIN_AUTHORITY_NONE);
    // external_plugin_adapters: None
    data.push(0);
    data
}

/// The accounts CreateV2 takes, in its order, with its optional accounts (collection, authority,
/// log wrapper) absent: `asset` signs (here with its PDA seeds), `payer` pays the rent, `owner`
/// receives the asset, `update_authority` becomes its update authority.
pub struct CreateAsset<'a, 'info> {
    pub asset: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub update_authority: &'a AccountInfo<'info>,
    pub mpl_core_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Mint the soulbound asset; `asset_seeds` are the asset PDA's seeds with its bump.
pub fn create_soulbound_asset(accounts: CreateAsset, name: &str, uri: &str, asset_seeds: &[&[u8]]) -> Result<()> {
    let instruction = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*accounts.asset.key, true),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // collection: none
            AccountMeta::new_readonly(MPL_CORE_ID, false), // authority: none (the payer)
            AccountMeta::new(*accounts.payer.key, true),
            AccountMeta::new_readonly(*accounts.owner.key, false),
            AccountMeta::new_readonly(*accounts.update_authority.key, false),
            AccountMeta::new_readonly(*accounts.system_program.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper: none
        ],
        data: create_v2_data(name, uri),
    };
    invoke_signed(
        &instruction,
        &[
            accounts.asset.clone(),
            accounts.mpl_core_program.clone(),
            accounts.payer.clone(),
            accounts.owner.clone(),
            accounts.update_authority.clone(),
            accounts.system_program.clone(),
        ],
        &[asset_seeds],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_v2_data_is_the_generated_client_s_encoding() {
        // discriminator 20 | DataState 0 | name "ab" | uri "u" | Some([PermanentFreezeDelegate{frozen} authority Some(None)]) | None
        let expected: Vec<u8> = vec![
            20, 0, 2, 0, 0, 0, b'a', b'b', 1, 0, 0, 0, b'u', 1, 1, 0, 0, 0, 5, 1, 1, 0, 0,
        ];
        assert_eq!(create_v2_data("ab", "u"), expected);
    }
}
