//! Availability, explicit priority, session affinity, then weekly scheduling.
use super::*;
use crate::accounts::Usage;
use quota::{ReserveStatus, remaining, windows};

const AFFINITY_LIMIT: usize = 4096;
const AFFINITY_TTL: u64 = 30 * 86400;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Binding {
    record_id: String,
    touched_at: u64,
}

pub(super) fn session_key(headers: &HeaderMap) -> Option<String> {
    ["thread-id", "session-id"].into_iter().find_map(|name| {
        let value = headers.get(name)?.to_str().ok()?.trim();
        (!value.is_empty() && value.len() <= 512).then(|| format!("{name}:{value}"))
    })
}

pub(super) fn available(usage: &Usage) -> bool {
    usage
        .rate_limit
        .as_ref()
        .is_some_and(|rate| rate.allowed != Some(false) && rate.limit_reached != Some(true))
        && windows(usage).next().is_some()
        && windows(usage).all(|window| {
            window.limit_window_seconds.is_some_and(|s| s > 0)
                && window.reset_at.is_some_and(|r| r > unix_now() as i64)
                && remaining(window).is_some_and(|r| r > 0.0)
        })
}

/// Percent of a weekly allowance per day. Short-window percentages never rank accounts.
pub(super) fn weekly_score(usage: &Usage) -> Option<f64> {
    let window = windows(usage)
        .find(|w| w.limit_window_seconds == Some(604800))
        .or_else(|| windows(usage).find(|w| w.limit_window_seconds.is_some_and(|s| s > 86400)))?;
    let seconds = window.reset_at?.checked_sub(unix_now() as i64)?;
    (seconds > 0)
        .then(|| remaining(window).map(|r| r * 86400.0 / seconds as f64))
        .flatten()
}

impl SubscriptionApi {
    pub(super) fn bind_session(&self, key: Option<&str>, id: &str) {
        let Some(key) = key else { return };
        let now = unix_now();
        let mut bindings = self.affinity.lock().unwrap();
        bindings.retain(|_, b| now.saturating_sub(b.touched_at) < AFFINITY_TTL);
        bindings.insert(
            key.into(),
            Binding {
                record_id: id.into(),
                touched_at: now,
            },
        );
        if bindings.len() > AFFINITY_LIMIT
            && let Some(oldest) = bindings
                .iter()
                .min_by_key(|(_, b)| b.touched_at)
                .map(|(k, _)| k.clone())
        {
            bindings.remove(&oldest);
        }
        if let Err(error) = crate::store::save(
            &self.paths.state_dir.join("subscription-affinity.json"),
            &*bindings,
        ) {
            crate::runtime::append_log(
                &self.paths,
                "subscription.affinity.save_failed",
                json!({"error":error.to_string()}),
            );
        }
    }

    pub(super) fn scheduling_states(&self, config: &SubscriptionConfig) -> Vec<Value> {
        config
            .account_order
            .iter()
            .map(|id| {
                let usage = self.quota.latest_unexpired_usage(id);
                json!({"recordId":id,"weeklyScore":usage.as_ref().and_then(weekly_score),
                "available":usage.as_ref().map(available),
                "priority":config.account_priority.iter().position(|p| p == id).map(|p| p+1)})
            })
            .collect()
    }

    pub(super) async fn scheduled_accounts(
        &self,
        config: &SubscriptionConfig,
        model: &str,
        headers: &HeaderMap,
        client: &reqwest::Client,
    ) -> (Vec<String>, usize, usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        // One shared deadline and per-account fetch locks bound concurrent cold starts.
        let results =
            futures_util::stream::iter(config.account_order.clone().into_iter().enumerate().map(
                |(index, owned_id)| async move {
                    let id = &owned_id;
                    if let Some(temp) = config.account_temporary.get(id)
                        && let Some(reason) = self.check_temporary_time_only(id, temp)
                    {
                        let _ = self.retire_temporary_account(id, reason);
                    }
                    if self.cooling(id, model) || self.is_rejected_current(id) {
                        return (index, id.clone(), None, false);
                    }
                    let default_reserve = config::AccountReserve::default();
                    let reserve = config
                        .account_reserves
                        .get(id)
                        .filter(|r| r.enabled())
                        .unwrap_or(&default_reserve);
                    let current =
                        SubscriptionConfig::load(&self.paths).unwrap_or_else(|_| config.clone());
                    let temp = current.account_temporary.get(id).filter(|t| t.enabled());
                    let mut status = self
                        .check_policies(id, Some(reserve), temp, client, deadline)
                        .await;
                    // Completed priority goals return to automatic scheduling in this request.
                    if matches!(status, ReserveStatus::Reserved(_))
                        && temp.is_some()
                        && let Ok(current) = SubscriptionConfig::load(&self.paths)
                        && current.account_order.contains(id)
                        && !current.account_temporary.contains_key(id)
                    {
                        status = self
                            .check_policies(id, Some(reserve), None, client, deadline)
                            .await;
                    }
                    let usage = self.quota.latest_unexpired_usage(id);
                    let ready =
                        status == ReserveStatus::Ready && usage.as_ref().is_some_and(available);
                    (index, id.clone(), Some(status), ready)
                },
            ))
            .buffer_unordered(6)
            .collect::<Vec<_>>()
            .await;
        let mut unknown = 0;
        let mut reserved = 0;
        let mut candidates = Vec::new();
        for (index, id, status, ready) in results {
            if ready {
                let score = self
                    .quota
                    .latest_unexpired_usage(&id)
                    .as_ref()
                    .and_then(weekly_score);
                candidates.push((id, score, index));
            } else {
                match status {
                    Some(ReserveStatus::Unknown) => unknown += 1,
                    Some(ReserveStatus::Reserved(_)) => reserved += 1,
                    _ => {}
                }
            }
        }
        let current = SubscriptionConfig::load(&self.paths).unwrap_or_else(|_| config.clone());
        candidates.retain(|(id, _, _)| current.account_order.contains(id));
        let key = session_key(headers);
        let bound = key.as_ref().and_then(|k| {
            self.affinity
                .lock()
                .unwrap()
                .get(k)
                .filter(|b| unix_now().saturating_sub(b.touched_at) < AFFINITY_TTL)
                .map(|b| b.record_id.clone())
        });
        candidates.sort_by(|a, b| {
            let priority = |id: &String| current.account_priority.iter().position(|p| p == id);
            let affinity = |id: &String| bound.as_ref() == Some(id);
            let tier = |id: &String| {
                if current.force_priority && priority(id).is_some() {
                    0
                } else if affinity(id) {
                    1
                } else if priority(id).is_some() {
                    2
                } else {
                    3
                }
            };
            tier(&a.0)
                .cmp(&tier(&b.0))
                .then_with(|| priority(&a.0).cmp(&priority(&b.0)))
                .then_with(|| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.2.cmp(&b.2))
        });
        (
            candidates.into_iter().map(|(id, _, _)| id).collect(),
            reserved,
            unknown,
        )
    }
}

#[cfg(test)]
mod tests;
