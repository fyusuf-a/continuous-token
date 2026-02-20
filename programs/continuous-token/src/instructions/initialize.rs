use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, token_2022::Token2022, token_interface::{Mint, TokenAccount, TokenInterface, TokenMetadataInitialize, token_metadata_initialize}
};

use crate::{ContinuousTokenError, state::Config, update_account_lamports_to_minimum_balance};

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
        mint::token_program = token_program_ct,
        extensions::metadata_pointer::authority = config,
        extensions::metadata_pointer::metadata_address = mint_ct,
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

    pub token_program_ct: Program<'info, Token2022>,
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
        require!(discount_bps <= base_fee_bps, ContinuousTokenError::BadConfig);

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

    pub fn initialize_token_metadata(
        &self,
        seed: u64,
        name: String,
        symbol: String,
        uri: String,
        bumps: &InitializeBumps,
    ) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"config",
            &seed.to_le_bytes(),
            &[bumps.config],
        ]];
            
        let cpi_accounts = TokenMetadataInitialize {
            program_id: self.token_program_ct.to_account_info(),
            mint: self.mint_ct.to_account_info(),
            metadata: self.mint_ct.to_account_info(),
            mint_authority: self.config.to_account_info(),
            update_authority: self.config.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            self.token_program_ct.to_account_info(),
            cpi_accounts,
            signer_seeds
        );

        token_metadata_initialize(cpi_ctx, name, symbol, uri)?;

        update_account_lamports_to_minimum_balance(self.mint_ct.to_account_info(), self.initializer.to_account_info(), self.system_program.to_account_info())?;
        update_account_lamports_to_minimum_balance(self.config.to_account_info(), self.initializer.to_account_info(), self.system_program.to_account_info())?;
        Ok(())
    }
}
