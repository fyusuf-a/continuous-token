use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    first_price: u128,
    reserve_ratio: u128,
    base_fee_bps: u128,
    discount_bps: u128,
}

