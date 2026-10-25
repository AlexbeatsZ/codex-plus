//! Account-local reserve checks. Unknown quota never authorizes reserved usage.
use super::*;
use crate::accounts::{RateLimit, Usage, UsageWindow};
use config::AccountReserve;
use std::time::Instant;

const CACHE_TTL: Duration = Duration::from_secs(15);
const NEAR_LIMIT_TTL: Duration = Duration::from_secs(3);

#[derive(Default)]
pub(super) struct QuotaTracker {
    observations: Mutex<HashMap<String, Observation>>,
    fetch_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

struct Observation {
    usage: Option<Usage>,
    at: Instant,
}

#[derive(Debug, PartialEq)]
pub(super) enum ReserveStatus {
    Ready,
    Reserved(String),
    Unknown,
}

fn windows(usage: &Usage) -> impl Iterator<Item = &UsageWindow> {
    usage.rate_limit.iter().flat_map(|rate| {
        [rate.primary_window.as_ref(), rate.secondary_window.as_ref()]
            .into_iter()
            .flatten()
    })
}

fn threshold(reserve: &AccountReserve, window: &UsageWindow) -> Option<(u8, &'static str)> {
    match window.limit_window_seconds? {
        0 => None,
        1..=86400 => reserve.short_term_percent.map(|p| (p, "短期额度")),
        _ => reserve.long_term_percent.map(|p| (p, "长期额度")),
    }
}

fn remaining(window: &UsageWindow) -> Option<f64> {
    let used = window.used_percent?;
    (used.is_finite() && (0.0..=100.0).contains(&used)).then_some(100.0 - used)
}

fn evaluate(usage: &Usage, reserve: &AccountReserve) -> ReserveStatus {
    let mut present = false;
    let mut unknown = false;
    for window in windows(usage) {
        present = true;
        if window.limit_window_seconds.is_none_or(|s| s == 0)
            || window
                .reset_at
                .is_some_and(|reset| reset <= unix_now() as i64)
        {
            unknown = true;
            continue;
        }
        if let Some((percent, label)) = threshold(reserve, window) {
            match remaining(window) {
                Some(value) if value <= f64::from(percent) => {
                    return ReserveStatus::Reserved(format!(
                        "{label}剩余 {value:.1}% ≤ 保留 {percent}%"
                    ));
                }
                None => unknown = true,
                _ => {}
            }
        }
    }
    if !present || unknown {
        ReserveStatus::Unknown
    } else {
        ReserveStatus::Ready
    }
}

impl QuotaTracker {
    pub(super) fn clear(&self) {
        self.observations.lock().unwrap().clear();
    }

    fn cached(&self, id: &str, reserve: &AccountReserve) -> Option<ReserveStatus> {
        let observations = self.observations.lock().unwrap();
        let observation = observations.get(id)?;
        let ttl = if observation.usage.as_ref().is_some_and(|usage| {
            windows(usage).any(|window| {
                threshold(reserve, window).is_some_and(|(percent, _)| {
                    remaining(window).is_some_and(|value| {
                        value > f64::from(percent) && value <= f64::from(percent) + 5.0
                    })
                })
            })
        }) {
            NEAR_LIMIT_TTL
        } else {
            CACHE_TTL
        };
        if observation.at.elapsed() >= ttl
            || observation.usage.as_ref().is_some_and(|usage| {
                windows(usage).any(|w| w.reset_at.is_some_and(|reset| reset <= unix_now() as i64))
            })
        {
            return None;
        }
        Some(
            observation
                .usage
                .as_ref()
                .map_or(ReserveStatus::Unknown, |usage| evaluate(usage, reserve)),
        )
    }

    fn record(&self, id: &str, usage: Option<Usage>) {
        self.observations.lock().unwrap().insert(
            id.into(),
            Observation {
                usage,
                at: Instant::now(),
            },
        );
    }

    pub(super) fn observe_headers(&self, id: &str, headers: &HeaderMap) {
        let window = |kind: &str| -> Option<UsageWindow> {
            let value = |suffix: &str| {
                headers
                    .get(format!("x-codex-{kind}-{suffix}"))?
                    .to_str()
                    .ok()
            };
            let used_percent = value("used-percent")?.parse::<f64>().ok()?;
            if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
                return None;
            }
            Some(UsageWindow {
                used_percent: Some(used_percent),
                limit_window_seconds: value("window-minutes")
                    .and_then(|v| v.parse::<u64>().ok())
                    .and_then(|m| m.checked_mul(60)),
                reset_at: value("reset-at").and_then(|v| v.parse().ok()),
                reset_after_seconds: None,
            })
        };
        let primary = window("primary");
        let secondary = window("secondary");
        if primary.is_none() && secondary.is_none() {
            return;
        }
        self.observe_event(
            id,
            Some(Usage {
                plan_type: None,
                credits: None,
                rate_limit: Some(RateLimit {
                    allowed: None,
                    limit_reached: None,
                    primary_window: primary,
                    secondary_window: secondary,
                }),
            }),
        );
    }

    pub(super) fn observe_event(&self, id: &str, usage: Option<Usage>) {
        self.observe(id, usage, None);
    }

    fn observe(
        &self,
        id: &str,
        usage: Option<Usage>,
        query_started: Option<Instant>,
    ) -> Option<Usage> {
        let Some(mut usage) = usage else {
            return None;
        };
        let mut observations = self.observations.lock().unwrap();
        if let Some(old) = observations
            .get(id)
            .filter(|o| query_started.is_none_or(|started| o.at > started))
            .and_then(|o| o.usage.as_ref())
        {
            // Partial headers must not erase the other window. Delayed concurrent
            // responses must not reopen an account in the same reset window.
            if let (Some(next), Some(previous)) = (&mut usage.rate_limit, &old.rate_limit) {
                for (new, old) in [
                    (&mut next.primary_window, &previous.primary_window),
                    (&mut next.secondary_window, &previous.secondary_window),
                ] {
                    match (new.as_mut(), old) {
                        (Some(new), Some(old))
                            if new.limit_window_seconds == old.limit_window_seconds =>
                        {
                            if new.reset_at.is_none() {
                                new.reset_at = old.reset_at;
                            }
                            if new.reset_at == old.reset_at {
                                new.used_percent = match (new.used_percent, old.used_percent) {
                                    (Some(a), Some(b)) => Some(a.max(b)),
                                    (a, b) => a.or(b),
                                };
                            } else if matches!((new.reset_at, old.reset_at), (Some(a), Some(b)) if a < b)
                            {
                                *new = old.clone();
                            }
                        }
                        (None, Some(old)) => *new = Some(old.clone()),
                        _ => {}
                    }
                }
            }
        }
        let result = usage.clone();
        observations.insert(
            id.into(),
            Observation {
                usage: Some(usage),
                at: Instant::now(),
            },
        );
        Some(result)
    }
}

impl SubscriptionApi {
    pub(super) async fn check_reserve(
        &self,
        id: &str,
        reserve: &AccountReserve,
        client: &reqwest::Client,
        deadline: tokio::time::Instant,
    ) -> ReserveStatus {
        if let Some(status) = self.quota.cached(id, reserve) {
            return status;
        }
        if tokio::time::Instant::now() >= deadline {
            return ReserveStatus::Unknown;
        }
        let lock = self
            .quota
            .fetch_locks
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .clone();
        let Ok(_guard) = tokio::time::timeout_at(deadline, lock.lock()).await else {
            return ReserveStatus::Unknown;
        };
        if let Some(status) = self.quota.cached(id, reserve) {
            return status;
        }
        if tokio::time::Instant::now() >= deadline {
            return ReserveStatus::Unknown;
        }
        let vault = AccountVault::new(self.paths.clone());
        let started = Instant::now();
        let usage = tokio::time::timeout_at(
            deadline,
            vault.fetch_usage_with_client(id, client, &self.refresh_url),
        )
        .await;
        match usage {
            Ok(Ok(usage)) => {
                let usage = self.quota.observe(id, Some(usage), Some(started)).unwrap();
                evaluate(&usage, reserve)
            }
            result => {
                if let Ok(Err(error)) = &result
                    && matches!(
                        error.downcast_ref::<CredentialFailure>(),
                        Some(CredentialFailure::Rejected(_))
                    )
                {
                    self.credential_failed(id, error);
                }
                self.quota.record(id, None);
                ReserveStatus::Unknown
            }
        }
    }

    pub(super) fn quota_states(&self, config: &SubscriptionConfig) -> Vec<Value> {
        config
            .account_order
            .iter()
            .filter_map(|id| {
                let reserve = config.account_reserves.get(id).filter(|r| r.enabled())?;
                let status = self
                    .quota
                    .cached(id, reserve)
                    .unwrap_or(ReserveStatus::Unknown);
                let (status, reason) = match status {
                    ReserveStatus::Ready => ("ready", "当前额度高于保留阈值".into()),
                    ReserveStatus::Reserved(reason) => ("reserved", reason),
                    ReserveStatus::Unknown => {
                        ("unknown", "额度待确认；发送前检查，无法确认时跳过".into())
                    }
                };
                Some(json!({"recordId":id, "status":status, "reason":reason}))
            })
            .collect()
    }
}

pub(super) fn usage_event(value: &Value) -> Option<Usage> {
    if value["type"] != "codex.rate_limits" {
        return None;
    }
    let limit = value["metered_limit_name"]
        .as_str()
        .or_else(|| value["limit_name"].as_str());
    if limit.is_some_and(|id| id != "codex") {
        return None;
    }
    let window = |kind: &str| -> Option<UsageWindow> {
        let value = &value["rate_limits"][kind];
        if value.is_null() {
            return None;
        }
        let used_percent = value["used_percent"].as_f64()?;
        if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
            return None;
        }
        Some(UsageWindow {
            used_percent: Some(used_percent),
            limit_window_seconds: value["window_minutes"]
                .as_u64()
                .and_then(|m| m.checked_mul(60)),
            reset_after_seconds: None,
            reset_at: value["reset_at"].as_i64(),
        })
    };
    let primary_window = window("primary");
    let secondary_window = window("secondary");
    if primary_window.is_none() && secondary_window.is_none() {
        return None;
    }
    Some(Usage {
        plan_type: None,
        credits: None,
        rate_limit: Some(RateLimit {
            allowed: None,
            limit_reached: None,
            primary_window,
            secondary_window,
        }),
    })
}

#[cfg(test)]
#[path = "quota_tests.rs"]
mod tests;
