use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, token_interface::{Mint, TokenAccount, TokenInterface}
};

use crate::state::Config;

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,

    #[account(
        init,
        payer = initializer,
        seeds = [b"config", seed.to_le_bytes().as_ref()],
        bump,
        space = Config::DISCRIMINATOR.len() + Config::INIT_SPACE,
    )]
    pub config: Account<'info, Config>,

    #[account(mint::token_program = token_program_rt)]
    pub mint_rt: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = initializer,
        seeds = [b"ct", seed.to_le_bytes().as_ref()],
        bump,
        mint::decimals = 8,
        mint::authority = config,
        mint::token_program = token_program_ct
    )]
    pub mint_ct: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = initializer,
        associated_token::mint = mint_rt,
        associated_token::authority = config,
        associated_token::token_program = token_program_rt,
    )]
    pub vault_rt: InterfaceAccount<'info, TokenAccount>,


    pub token_program_rt: Interface<'info, TokenInterface>,
    pub token_program_ct: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Initialize<'info> {
    pub fn init(
        &mut self,
        seed: u64,
        first_price: u128,
        reserve_ratio_bps: u16,
        base_fee_bps: u16,
        discount_bps: u16,
        bumps: &InitializeBumps,
    ) -> Result<()> {
        self.config.set_inner(Config {
            seed,
            first_price,
            reserve_ratio_bps,
            base_fee_bps,
            discount_bps,
            bump: bumps.config,
        });
        Ok(())
    }
}
