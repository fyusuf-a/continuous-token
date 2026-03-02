use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::MintToChecked,
    token_interface::{
        mint_to_checked, transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};

use crate::{state::Config, ContinuousTokenError};

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

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
        bump = config.fee_vault_authority_bump,
    )]
    /// CHECK: PDA authority only
    pub fee_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint_rt,
        associated_token::authority = buyer,
        associated_token::token_program = token_program_rt,
    )]
    pub buyer_rt_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint_ct,
        associated_token::authority = buyer,
        associated_token::token_program = token_program_ct,
    )]
    pub buyer_ct_ata: InterfaceAccount<'info, TokenAccount>,

    #[account()]
    pub referrer: Option<SystemAccount<'info>>,
    #[account(
        // NOTE: Do you want to make the referrer already have made a purchase?
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint_ct,
        associated_token::authority = referrer,
        associated_token::token_program = token_program_ct,
    )]
    pub referrer_ct_ata: Option<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_rt: Interface<'info, TokenInterface>,
    pub token_program_ct: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// RT in -> CT out
impl<'info> Buy<'info> {
    pub fn buy(&mut self, amount: u64) -> Result<()> {
        require!(
            self.buyer_rt_ata.amount >= amount,
            ContinuousTokenError::InsufficientBalance
        );
        require!(amount > 0, ContinuousTokenError::InvalidAmount);

        match (&self.referrer, &self.referrer_ct_ata) {
            (None, None) => {}
            (Some(referrer), Some(referrer_ata)) => {
                require_keys_eq!(
                    referrer.key(),
                    referrer_ata.owner,
                    ContinuousTokenError::InvalidReferrerAta
                );

                require_keys_neq!(
                    referrer.key(),
                    self.buyer.key(),
                    ContinuousTokenError::SelfReferralNotAllowed
                );
            }
            _ => {
                return err!(ContinuousTokenError::InvalidReferral);
            }
        }

        let amount_u128 = amount as u128;

        let total_ct = Self::bonding_curve_buy(
            self.mint_ct.decimals,
            self.config.first_price,
            self.config.reserve_ratio_bps,
            self.mint_ct.supply,
            self.vault_rt.amount,
            amount_u128,
        )?;
        let total_ct_u64: u64 = total_ct
            .try_into()
            .map_err(|_| ContinuousTokenError::Overflow)?;

        let has_referrer = self.referrer_ct_ata.is_some();

        let final_fee_bps = if has_referrer {
            self.config
                .base_fee_bps
                .checked_sub(self.config.discount_bps)
                .ok_or(ContinuousTokenError::Underflow)?
        } else {
            self.config.base_fee_bps
        };

        let fee = total_ct
            .checked_mul(final_fee_bps as u128)
            .ok_or(ContinuousTokenError::Overflow)?
            .checked_div(10_000)
            .ok_or(ContinuousTokenError::Overflow)?;
        let fee_u64: u64 = fee.try_into().map_err(|_| ContinuousTokenError::Overflow)?;

        let user_ct = total_ct
            .checked_sub(fee)
            .ok_or(ContinuousTokenError::Underflow)?;
        let user_ct_u64: u64 = user_ct
            .try_into()
            .map_err(|_| ContinuousTokenError::Overflow)?;

        let seed_bytes = self.config.seed.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[b"config", seed_bytes.as_ref(), &[self.config.bump]]];

        {
            // Transfer User RT to Vault
            let cpi_program = self.token_program_rt.to_account_info();

            let cpi_accounts = TransferChecked {
                from: self.buyer_rt_ata.to_account_info(),
                mint: self.mint_rt.to_account_info(),
                to: self.vault_rt.to_account_info(),
                authority: self.buyer.to_account_info(),
            };

            let ctx = CpiContext::new(cpi_program, cpi_accounts);

            transfer_checked(ctx, amount, self.mint_rt.decimals)?;
        }

        {
            // Mint CT to temp
            let cpi_program = self.token_program_ct.to_account_info();

            let cpi_accounts = MintToChecked {
                mint: self.mint_ct.to_account_info(),
                to: self.vault_ct_unlocked.to_account_info(),
                authority: self.config.to_account_info(),
            };

            let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

            mint_to_checked(ctx, total_ct_u64, self.mint_ct.decimals)?;
        }

        {
            // Transfer CT to User
            let cpi_program = self.token_program_ct.to_account_info();

            let cpi_accounts = TransferChecked {
                from: self.vault_ct_unlocked.to_account_info(),
                mint: self.mint_ct.to_account_info(),
                to: self.buyer_ct_ata.to_account_info(),
                authority: self.config.to_account_info(),
            };

            let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

            transfer_checked(ctx, user_ct_u64, self.mint_ct.decimals)?;
        }

        match &self.referrer_ct_ata {
            Some(referrer_ct_ata) => {
                // Transfer CT to Referrer
                let cpi_program = self.token_program_ct.to_account_info();

                let cpi_accounts = TransferChecked {
                    from: self.vault_ct_unlocked.to_account_info(),
                    mint: self.mint_ct.to_account_info(),
                    to: referrer_ct_ata.to_account_info(),
                    authority: self.config.to_account_info(),
                };

                let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

                transfer_checked(ctx, fee_u64, self.mint_ct.decimals)?;
            }
            None => {
                // Transfer CT to Locked Vault
                let cpi_program = self.token_program_ct.to_account_info();

                let cpi_accounts = TransferChecked {
                    from: self.vault_ct_unlocked.to_account_info(),
                    mint: self.mint_ct.to_account_info(),
                    to: self.vault_ct_locked.to_account_info(),
                    authority: self.config.to_account_info(),
                };

                let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

                transfer_checked(ctx, fee_u64, self.mint_ct.decimals)?;
            }
        }

        Ok(())
    }

    fn bonding_curve_buy(
        decimals: u8,
        first_price: u128,
        reserve_ratio_bps: u16,
        supply: u64,
        reserve: u64,
        amount: u128,
    ) -> Result<u128> {
        let alpha = (reserve_ratio_bps as f64) / 10_000.0_f64;
        let scale = 10u128.pow(decimals as u32) as f64;

        let k = if supply == 0 {
            first_price as f64
        } else {
            (reserve as f64) / ((supply as f64) / scale).powf(1.0 / alpha)
        };

        let r_new = (reserve as f64) + (amount as f64);
        let new_supply_f = (r_new / k).powf(alpha);
        let new_supply_u = (new_supply_f * scale).floor() as u128;

        let delta_s = new_supply_u.saturating_sub(supply as u128);

        Ok(delta_s)
    }
}
