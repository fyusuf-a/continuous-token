use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub seed: u64,
    pub first_price: u128,
    pub reserve_ratio_bps: u16,
    pub base_fee_bps: u16,
    pub discount_bps: u16,
    pub mint_rt: Pubkey,
    pub mint_ct: Pubkey,
    pub bump: u8,
    pub mint_ct_bump: u8,
    pub fee_vault_authority_bump: u8,
}
