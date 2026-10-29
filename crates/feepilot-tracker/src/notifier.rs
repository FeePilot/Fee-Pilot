use std::time::Duration;

use crate::Event;

/// Reports job state changes: always to the log, and to a webhook if one is configured.
///
/// Delivery is best-effort (one attempt, 5 s timeout): a failure is logged, never retried,
/// and never stops the tracker. The authoritative record is the job and its history.
pub struct Notifier {
    client: reqwest::Client,
    webhook: Option<String>,
}

impl Notifier {
    pub fn new(webhook: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("http client");
        Self { client, webhook }
    }

    pub async fn send(&self, event: &Event) {
        tracing::info!(
            "job {}: {} -> {} ({} confirmations)",
            event.job_id,
            event.from.as_str(),
            event.to.as_str(),
            event.confirmations
        );
        let Some(url) = &self.webhook else { return };
        match self.client.post(url).json(event).send().await {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => tracing::warn!(
                "webhook answered {} for job {}",
                resp.status(),
                event.job_id
            ),
            Err(e) => tracing::warn!("webhook delivery failed for job {}: {e}", event.job_id),
        }
    }
}
