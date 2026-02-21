use anchor_lang::{Lamports, prelude::*, system_program::{Transfer, transfer}};

pub fn update_account_lamports_to_minimum_balance<'info>(
    account: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
) -> Result<()> {
    let extra_lamports = Rent::get()?.minimum_balance(account.data_len()) - account.get_lamports();

    if extra_lamports > 0 {
        let cpi_program = system_program.to_account_info();
        let cpi_accounts = Transfer {
            from: payer,
            to: account,
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        transfer(cpi_ctx, extra_lamports)
    } else {
        Ok(())
    }
}
