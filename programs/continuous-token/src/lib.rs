use anchor_lang::prelude::*;

mod state;

declare_id!("9KwgDXHGibr8yaGGMLPSvE6y7Yxfbkd8Rv4K7AkmCTgn");

#[program]
pub mod continuous_token {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
