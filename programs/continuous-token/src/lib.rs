use anchor_lang::prelude::*;

mod error;
mod instructions;
mod state;
mod utils;

pub use error::*;
pub use instructions::*;
pub use state::*;
pub use utils::*;

declare_id!("9KwgDXHGibr8yaGGMLPSvE6y7Yxfbkd8Rv4K7AkmCTgn");

#[program]
pub mod continuous_token {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        seed: u64,
        first_price: u128,
        reserve_ratio_bps: u16,
        base_fee_bps: u16,
        discount_bps: u16,
        min_balance_for_referral_bps: u16,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        ctx.accounts.init(
            seed,
            first_price,
            reserve_ratio_bps,
            base_fee_bps,
            discount_bps,
            min_balance_for_referral_bps,
            &ctx.bumps,
        )?;
        ctx.accounts
            .initialize_token_metadata(seed, name, symbol, uri, &ctx.bumps)
    }

    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        ctx.accounts.buy(amount)
    }

    pub fn sell(ctx: Context<Sell>, amount: u64) -> Result<()> {
        ctx.accounts.sell(amount)
    }
}
