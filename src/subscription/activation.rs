use super::*;
use crate::accounts::Usage;
use fs2::FileExt as _;

const FIVE_HOURS: u64 = 5 * 60 * 60;
const WEEK: u64 = 7 * 24 * 60 * 60;
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct Activity {
    latest: Option<String>,
    busy: HashMap<String, usize>,
}

pub(super) struct ForegroundGuard {
    activity: Arc<Mutex<Activity>>,
    id: String,
}

impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        let mut activity = self.activity.lock().unwrap();
        if let Some(count) = activity.busy.get_mut(&self.id) {
            *count -= 1;
            if *count == 0 {
                activity.busy.remove(&self.id);
            }
        }
    }
}

fn eligible(usage: &Usage, reserve: Option<&config::AccountReserve>, now: u64) -> bool {
    let Some(rate) = &usage.rate_limit else {
        return false;
    };
    if rate.allowed == Some(false) || rate.limit_reached == Some(true) {
        return false;
    }
    let windows: Vec<_> = [rate.primary_window.as_ref(), rate.secondary_window.as_ref()]
        .into_iter()
        .flatten()
        .collect();
    let short = windows
        .iter()
        .find(|window| window.limit_window_seconds == Some(FIVE_HOURS));
    let long = windows
        .iter()
        .find(|window| window.limit_window_seconds == Some(WEEK));
    let fresh = |reset: Option<i64>| reset.is_some_and(|reset| reset > now as i64);
    short.is_some_and(|window| window.used_percent == Some(0.0) && fresh(window.reset_at))
        && long.is_some_and(|window| {
            window
                .used_percent
                .is_some_and(|used| used.is_finite() && (0.0..100.0).contains(&used))
                && fresh(window.reset_at)
        })
        && reserve
            .is_none_or(|reserve| quota::evaluate(usage, reserve) == quota::ReserveStatus::Ready)
}

impl SubscriptionApi {
    pub(super) fn begin_foreground(&self, id: &str) -> ForegroundGuard {
        let mut activity = self.activity.lock().unwrap();
        activity.latest = Some(id.into());
        *activity.busy.entry(id.into()).or_default() += 1;
        self.foreground.notify_waiters();
        ForegroundGuard {
            activity: self.activity.clone(),
            id: id.into(),
        }
    }

    fn activation_idle(&self, id: &str) -> anyhow::Result<bool> {
        let accounts = AccountVault::new(self.paths.clone()).list_accounts()?;
        let activity = self.activity.lock().unwrap();
        Ok(accounts
            .iter()
            .any(|account| account.record_id == id && !account.active)
            && activity.latest.as_deref() != Some(id)
            && !activity.busy.contains_key(id))
    }

    pub(crate) async fn run_activation(&self) {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if self.activate_idle_accounts().await.is_err() {
                crate::runtime::append_log(
                    &self.paths,
                    "subscription.activation.check_failed",
                    json!({"message":"自动激活检查失败；本轮跳过"}),
                );
            }
        }
    }

    async fn activate_idle_accounts(&self) -> anyhow::Result<()> {
        let config = SubscriptionConfig::load(&self.paths)?;
        if !config.enabled || !config.auto_activate {
            return Ok(());
        }
        let Some(model) = config
            .models
            .iter()
            .find(|model| model.visible && model.model_id != AUTO_REVIEW_MODEL)
        else {
            return Ok(());
        };
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.paths.state_dir.join("subscription-activation.lock"))?;
        if lock.try_lock_exclusive().is_err() {
            return Ok(());
        }
        let ledger_path = self.paths.state_dir.join("subscription-activation.json");
        let mut attempts: HashMap<String, u64> = match std::fs::read(&ledger_path) {
            Ok(raw) => serde_json::from_slice(&raw)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(error.into()),
        };
        attempts.retain(|_, until| *until > unix_now());
        let client = config.client()?;
        for id in &config.account_order {
            if attempts.contains_key(id)
                || !self.activation_idle(id)?
                || self.cooling(id, &model.model_id)
                || self.is_rejected_current(id)
            {
                continue;
            }
            let Ok(usage) = self.fetch_usage(id).await else {
                continue;
            };
            let reserve = config
                .account_reserves
                .get(id)
                .filter(|reserve| reserve.enabled());
            if !eligible(&usage, reserve, unix_now()) {
                continue;
            }
            let interrupted = self.foreground.notified();
            tokio::pin!(interrupted);
            interrupted.as_mut().enable();
            if SubscriptionConfig::load(&self.paths)? != config {
                break;
            }
            if !self.activation_idle(id)? {
                continue;
            }
            attempts.insert(id.clone(), unix_now() + FIVE_HOURS);
            atomic_write(&ledger_path, &serde_json::to_vec_pretty(&attempts)?)?;
            let outcome = tokio::select! {
                biased;
                _ = &mut interrupted => "interrupted",
                result = tokio::time::timeout(REQUEST_TIMEOUT, self.activation_request(id, &model.model_id, &client)) => {
                    match result {
                        Ok(Ok(true)) => "completed",
                        Ok(_) => "failed",
                        Err(_) => "timeout",
                    }
                },
            };
            crate::runtime::append_log(
                &self.paths,
                "subscription.activation.attempt",
                json!({"recordId":id,"model":model.model_id,"outcome":outcome,"nextAttemptAt":attempts[id]}),
            );
        }
        Ok(())
    }

    async fn activation_request(
        &self,
        id: &str,
        model: &str,
        client: &reqwest::Client,
    ) -> anyhow::Result<bool> {
        let body = json!({
            "model": model, "store": false, "stream": true,
            "instructions": "Reply only with OK.",
            "input": [{"role": "user", "content": "Reply only with OK."}],
            "tools": []
        });
        let endpoint = format!("{}/responses", self.native_base);
        let Some(response) = self
            .authenticated_request(id, client, &endpoint, Some(&body), None)
            .await?
        else {
            return Ok(false);
        };
        self.quota.observe_headers(id, response.headers());
        if !response.status().is_success() {
            return Ok(false);
        }
        if let Prepared::Stream {
            prefix,
            mut tail,
            mut guard,
        } = prepare_stream(response).await?
        {
            self.quota.observe_event(id, guard.quota_update.take());
            let mut size = prefix.len();
            while !guard.terminal && size < PRELUDE_LIMIT {
                let Some(bytes) = tail.next().await else {
                    break;
                };
                let bytes = bytes?;
                size += bytes.len();
                guard.push(&bytes);
                self.quota.observe_event(id, guard.quota_update.take());
            }
            return Ok(guard.terminal && guard.failure.is_none());
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests;
