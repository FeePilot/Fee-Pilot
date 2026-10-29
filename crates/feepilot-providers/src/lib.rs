//! External accelerator adapters. Each provider normalises eligibility, price,
//! submission and response formats, but keeps provider-specific conditions.

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("not implemented: {0}")]
    Unimplemented(&'static str),
}

#[derive(Debug, Clone)]
pub struct Quote {
    pub provider: &'static str,
    /// Service charge in satoshis, separate from any Bitcoin network fee.
    pub service_fee_sat: u64,
    pub conditions: Vec<String>,
}

pub trait AcceleratorProvider {
    fn name(&self) -> &'static str;
    /// Does the provider accept this transaction, and at what price?
    fn quote(
        &self,
        txid: &str,
    ) -> impl std::future::Future<Output = Result<Option<Quote>, ProviderError>> + Send;
    /// Submit after explicit user consent to the quoted price.
    fn submit(
        &self,
        txid: &str,
        quote: &Quote,
    ) -> impl std::future::Future<Output = Result<(), ProviderError>> + Send;
}
