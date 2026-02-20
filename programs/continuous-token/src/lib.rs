use anchor_lang::prelude::*;

mod state;
mod instructions;
mod error;
mod utils;

pub use state::*;
pub use instructions::*;
pub use error::*;
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
            &ctx.bumps,
        )?;
        ctx.accounts.initialize_token_metadata(seed, name, symbol, uri, &ctx.bumps)
    }
}
