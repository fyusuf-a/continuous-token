use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub seed: u64,
    pub first_price: u128,
    pub reserve_ratio_bps: u16,
    pub base_fee_bps: u16,
    pub discount_bps: u16,
    pub bump: u8,
}
