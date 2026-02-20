use anchor_lang::prelude::error_code;

#[error_code]
pub enum ContinuousTokenError {
    #[msg("Bad configuration parameters")]
    BadConfig,
}
