use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};

use crate::{state::Config, ContinuousTokenError};

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        seeds = [b"config", config.seed.to_le_bytes().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mint::token_program = token_program_rt,
        constraint = mint_rt.key() == config.mint_rt @ ContinuousTokenError::IncorrectMint
    )]
    pub mint_rt: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"ct", config.seed.to_le_bytes().as_ref()],
        bump = config.mint_ct_bump,
        mint::authority = config,
        mint::token_program = token_program_ct,
        constraint = mint_ct.key() == config.mint_ct @ ContinuousTokenError::IncorrectMint
    )]
    pub mint_ct: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_rt,
        associated_token::authority = config,
        associated_token::token_program = token_program_rt,
    )]
    pub vault_rt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_ct,
        associated_token::authority = config,
        associated_token::token_program = token_program_ct,
    )]
    pub vault_ct_unlocked: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_ct,
        associated_token::authority = fee_vault_authority,
        associated_token::token_program = token_program_ct,
    )]
    pub vault_ct_locked: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [b"fee_vault", config.seed.to_le_bytes().as_ref()],
        bump = config.fee_vault_authority_bump
    )]
    /// CHECK: PDA authority only
    pub fee_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint_ct,
        associated_token::authority = seller,
        associated_token::token_program = token_program_ct,
    )]
    pub seller_ct_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint_rt,
        associated_token::authority = seller,
        associated_token::token_program = token_program_rt,
    )]
    pub seller_rt_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program_rt: Interface<'info, TokenInterface>,
    pub token_program_ct: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// CT in -> RT out
impl<'info> Sell<'info> {
    pub fn sell(&mut self, amount: u64) -> Result<()> {
        require!(
            self.seller_ct_ata.amount >= amount,
            ContinuousTokenError::InsufficientBalance
        );
        require!(amount > 0, ContinuousTokenError::InvalidAmount);

        let amount_u128 = amount as u128;

        let fee = amount_u128
            .checked_mul(self.config.base_fee_bps as u128)
            .ok_or(ContinuousTokenError::Overflow)?
            .checked_div(10_000)
            .ok_or(ContinuousTokenError::Underflow)?;
        let fee_u64: u64 = fee.try_into().map_err(|_| ContinuousTokenError::Overflow)?;

        let net_amount = amount_u128
            .checked_sub(fee)
            .ok_or(ContinuousTokenError::Underflow)?;
        let net_amount_u64 = net_amount
            .try_into()
            .map_err(|_| ContinuousTokenError::Overflow)?;

        let user_rt = Self::bonding_curve_sell(
            self.mint_rt.decimals,
            self.config.reserve_ratio_bps,
            self.mint_ct.supply,
            self.vault_rt.amount,
            net_amount,
        )?;
        let user_rt_u64 = user_rt
            .try_into()
            .map_err(|_| ContinuousTokenError::Overflow)?;

        {
            // Transfer fee to locked
            let cpi_program = self.token_program_ct.to_account_info();

            let cpi_accounts = TransferChecked {
                from: self.seller_ct_ata.to_account_info(),
                mint: self.mint_ct.to_account_info(),
                to: self.vault_ct_locked.to_account_info(),
                authority: self.seller.to_account_info(),
            };

            let ctx = CpiContext::new(cpi_program, cpi_accounts);

            transfer_checked(ctx, fee_u64, self.mint_ct.decimals)?;
        }

        {
            // Burn
            let cpi_program = self.token_program_ct.to_account_info();

            let cpi_accounts = Burn {
                mint: self.mint_ct.to_account_info(),
                from: self.seller_ct_ata.to_account_info(),
                authority: self.seller.to_account_info(),
            };

            let ctx = CpiContext::new(cpi_program, cpi_accounts);

            burn(ctx, net_amount_u64)?;
        }

        {
            // Transfer reserve to user
            let seed_bytes = self.config.seed.to_le_bytes();
            let signer_seeds: &[&[&[u8]]] =
                &[&[b"config", seed_bytes.as_ref(), &[self.config.bump]]];

            let cpi_program = self.token_program_rt.to_account_info();

            let cpi_accounts = TransferChecked {
                from: self.vault_rt.to_account_info(),
                mint: self.mint_rt.to_account_info(),
                to: self.seller_rt_ata.to_account_info(),
                authority: self.config.to_account_info(),
            };

            let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

            transfer_checked(ctx, user_rt_u64, self.mint_rt.decimals)?;
        }

        Ok(())
    }

    fn bonding_curve_sell(
        decimals: u8,
        reserve_ratio_bps: u16,
        supply: u64,
        reserve: u64,
        amount: u128,
    ) -> Result<u128> {
        let alpha = (reserve_ratio_bps as f64) / 10_000.0_f64;
        let scale = 10u128.pow(decimals as u32) as f64;

        let k = (reserve as f64) / ((supply as f64) / scale).powf(1.0 / alpha);

        let s_new = ((supply as f64) - (amount as f64)) / scale;
        let r_new = k * s_new.powf(1.0 / alpha);
        let delta_r = (reserve as f64) - r_new;

        if !delta_r.is_finite() || delta_r <= 0.0 {
            return Ok(0);
        }

        Ok(delta_r.floor() as u128)
    }
}
