//! Account-local reserve and temporary quota checks. Unknown quota never authorizes reserved usage.
use super::*;
use crate::accounts::{RateLimit, Usage, UsageWindow};
use config::{AccountReserve, AccountTemporary, TemporaryResetTarget};
use std::time::Instant;

const CACHE_TTL: Duration = Duration::from_secs(15);
const NEAR_LIMIT_TTL: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct TemporaryProgress {
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub until_reset: Option<TemporaryResetTarget>,
    #[serde(default)]
    pub target_reset_at: Option<i64>,
    #[serde(default)]
    pub target_baseline_used: Option<f64>,
    #[serde(default)]
    pub short_baseline_used: Option<f64>,
    #[serde(default)]
    pub short_last_used: Option<f64>,
    #[serde(default)]
    pub short_reset_at: Option<i64>,
    #[serde(default)]
    pub long_baseline_used: Option<f64>,
    #[serde(default)]
    pub long_last_used: Option<f64>,
    #[serde(default)]
    pub long_reset_at: Option<i64>,
    #[serde(default)]
    pub completed_reason: Option<String>,
}

#[derive(Default)]
pub(super) struct QuotaTracker {
    observations: Mutex<HashMap<String, Observation>>,
    fetch_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub(super) temporary: Mutex<HashMap<String, TemporaryProgress>>,
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

pub(super) fn windows(usage: &Usage) -> impl Iterator<Item = &UsageWindow> {
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

pub(super) fn remaining(window: &UsageWindow) -> Option<f64> {
    let used = window.used_percent?;
    (used.is_finite() && (0.0..=100.0).contains(&used)).then_some(100.0 - used)
}

pub(super) fn evaluate(usage: &Usage, reserve: &AccountReserve) -> ReserveStatus {
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

fn update_temporary_window(
    baseline_used: &mut Option<f64>,
    last_used: &mut Option<f64>,
    stored_reset_at: &mut Option<i64>,
    window: &UsageWindow,
) -> Option<f64> {
    if window.limit_window_seconds.is_none_or(|s| s == 0)
        || window
            .reset_at
            .is_some_and(|reset| reset <= unix_now() as i64)
    {
        return None;
    }
    let used = window.used_percent?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return None;
    }
    match (*baseline_used, *last_used) {
        (None, _) => {
            *baseline_used = Some(used);
            *last_used = Some(used);
            *stored_reset_at = window.reset_at;
            Some(0.0)
        }
        (Some(base), last) => {
            let prev_used = last.unwrap_or(base);
            let reset_advanced = match (*stored_reset_at, window.reset_at) {
                (Some(old_r), Some(new_r)) => {
                    new_r > old_r + 60 || (new_r > old_r && used + 1e-6 < prev_used)
                }
                _ => false,
            };
            if reset_advanced {
                let prior_consumed = (prev_used - base).max(0.0);
                let new_base = -prior_consumed;
                *baseline_used = Some(new_base);
                *last_used = Some(used);
                *stored_reset_at = window.reset_at;
                Some((used - new_base).max(0.0))
            } else {
                if stored_reset_at.is_none() && window.reset_at.is_some() {
                    *stored_reset_at = window.reset_at;
                }
                let effective = prev_used.max(used);
                *last_used = Some(effective);
                Some((effective - base).max(0.0))
            }
        }
    }
}

pub(super) fn sync_temporary_time_fields(
    progress: &mut TemporaryProgress,
    temp: &AccountTemporary,
    now: i64,
) {
    if let Some(mins) = temp.duration_minutes {
        if progress.duration_minutes != Some(mins) || progress.expires_at.is_none() {
            progress.started_at = Some(now);
            progress.duration_minutes = Some(mins);
            progress.expires_at = Some(now + i64::from(mins) * 60);
        }
    } else {
        progress.started_at = None;
        progress.duration_minutes = None;
        progress.expires_at = None;
    }
    if progress.until_reset != temp.until_reset {
        progress.until_reset = temp.until_reset;
        progress.target_reset_at = None;
        progress.target_baseline_used = None;
    }
    if temp.short_term_percent.is_none() {
        progress.short_baseline_used = None;
        progress.short_last_used = None;
        progress.short_reset_at = None;
    }
    if temp.long_term_percent.is_none() {
        progress.long_baseline_used = None;
        progress.long_last_used = None;
        progress.long_reset_at = None;
    }
}

pub(super) fn evaluate_temporary_time(
    progress: &TemporaryProgress,
    temp: &AccountTemporary,
    now: i64,
) -> Option<String> {
    if let Some(mins) = temp.duration_minutes
        && progress.expires_at.is_some_and(|exp| now >= exp)
    {
        return Some(format!(
            "临时使用时间已到：设定 {mins} 分钟已到期，已自动移出额度池"
        ));
    }
    if let Some(target) = temp.until_reset
        && progress
            .target_reset_at
            .is_some_and(|reset_at| now >= reset_at)
    {
        return Some(format!(
            "临时使用已到期：已达下一次{}刷新时间，已自动移出额度池",
            target.label()
        ));
    }
    None
}

pub(super) fn evaluate_temporary_progress(
    progress: &mut TemporaryProgress,
    usage: &Usage,
    temp: &AccountTemporary,
) -> ReserveStatus {
    let now = unix_now() as i64;
    sync_temporary_time_fields(progress, temp, now);
    if let Some(reason) = evaluate_temporary_time(progress, temp, now) {
        return ReserveStatus::Reserved(reason);
    }
    let mut short_seen = false;
    let mut long_seen = false;
    let mut until_reset_seen = false;
    let mut unknown = false;
    for window in windows(usage) {
        let Some(seconds) = window.limit_window_seconds else {
            unknown = true;
            continue;
        };
        if seconds > 86400
            && let Some(target) = temp.weekly_remaining_percent
        {
            if window.reset_at.is_none_or(|r| r <= now) {
                unknown = true;
                continue;
            }
            match remaining(window) {
                Some(value) if value <= f64::from(target) => {
                    return ReserveStatus::Reserved(format!(
                        "周剩余额度 {value:.1}% ≤ {target}%，优先目标已完成"
                    ));
                }
                None => unknown = true,
                _ => {}
            }
            long_seen = true;
        }
        if seconds == 0 {
            unknown = true;
            continue;
        }
        let used = window
            .used_percent
            .filter(|u| u.is_finite() && (0.0..=100.0).contains(u));
        if let Some(target) = temp.until_reset {
            let matches = match target {
                TemporaryResetTarget::Short => seconds <= 86400,
                TemporaryResetTarget::Long => seconds > 86400,
            };
            if matches {
                until_reset_seen = true;
                match (progress.target_reset_at, window.reset_at) {
                    (None, Some(reset_at)) if reset_at > now => {
                        progress.target_reset_at = Some(reset_at);
                        progress.target_baseline_used = used;
                    }
                    (Some(target_r), Some(new_r)) => {
                        let reset_triggered = new_r <= now
                            || new_r > target_r + 60
                            || (new_r > target_r
                                && used
                                    .zip(progress.target_baseline_used)
                                    .is_some_and(|(u, base)| u + 1e-6 < base));
                        if reset_triggered {
                            return ReserveStatus::Reserved(format!(
                                "临时使用已到期：已达下一次{}刷新时间，已自动移出额度池",
                                target.label()
                            ));
                        }
                        if let Some(u) = used {
                            progress.target_baseline_used =
                                Some(progress.target_baseline_used.map_or(u, |b| b.max(u)));
                        }
                    }
                    _ => unknown = true,
                }
            }
        }
        if seconds <= 86400 {
            if let Some(limit) = temp.short_term_percent {
                short_seen = true;
                match update_temporary_window(
                    &mut progress.short_baseline_used,
                    &mut progress.short_last_used,
                    &mut progress.short_reset_at,
                    window,
                ) {
                    Some(consumed) if consumed + 1e-9 >= f64::from(limit) => {
                        return ReserveStatus::Reserved(format!(
                            "临时额度已达标：5h 额度本次已用 {consumed:.1}% ≥ 设定 {limit}%，已自动移出额度池"
                        ));
                    }
                    None => unknown = true,
                    _ => {}
                }
            }
        } else if let Some(limit) = temp.long_term_percent {
            long_seen = true;
            match update_temporary_window(
                &mut progress.long_baseline_used,
                &mut progress.long_last_used,
                &mut progress.long_reset_at,
                window,
            ) {
                Some(consumed) if consumed + 1e-9 >= f64::from(limit) => {
                    return ReserveStatus::Reserved(format!(
                        "临时额度已达标：周额度本次已用 {consumed:.1}% ≥ 设定 {limit}%，已自动移出额度池"
                    ));
                }
                None => unknown = true,
                _ => {}
            }
        }
    }
    if (temp.short_term_percent.is_some() && !short_seen)
        || ((temp.long_term_percent.is_some() || temp.weekly_remaining_percent.is_some())
            && !long_seen)
        || (temp.until_reset.is_some() && !until_reset_seen)
        || unknown
    {
        ReserveStatus::Unknown
    } else {
        ReserveStatus::Ready
    }
}

impl QuotaTracker {
    pub(super) fn with_temporary(temporary: HashMap<String, TemporaryProgress>) -> Self {
        Self {
            observations: Mutex::new(HashMap::new()),
            fetch_locks: Mutex::new(HashMap::new()),
            temporary: Mutex::new(temporary),
        }
    }

    pub(super) fn clear(&self) {
        self.observations.lock().unwrap().clear();
    }

    pub(super) fn latest_unexpired_usage(&self, id: &str) -> Option<Usage> {
        let observations = self.observations.lock().unwrap();
        let observation = observations.get(id)?;
        if observation.at.elapsed() >= Duration::from_secs(300)
            || observation.usage.as_ref().is_some_and(|usage| {
                windows(usage).any(|w| w.reset_at.is_some_and(|reset| reset <= unix_now() as i64))
            })
        {
            return None;
        }
        observation.usage.clone()
    }

    fn near_limit(
        &self,
        id: &str,
        usage: &Usage,
        reserve: Option<&AccountReserve>,
        temporary: Option<&AccountTemporary>,
    ) -> bool {
        let near_reserve = reserve.is_some_and(|reserve| {
            windows(usage).any(|window| {
                threshold(reserve, window).is_some_and(|(percent, _)| {
                    remaining(window).is_some_and(|value| {
                        value > f64::from(percent) && value <= f64::from(percent) + 5.0
                    })
                })
            })
        });
        if near_reserve {
            return true;
        }
        if temporary
            .and_then(|t| t.weekly_remaining_percent)
            .is_some_and(|target| {
                windows(usage)
                    .filter(|w| w.limit_window_seconds.is_some_and(|s| s > 86400))
                    .any(|w| remaining(w).is_some_and(|r| r <= f64::from(target) + 5.0))
            })
        {
            return true;
        }
        let Some(temp) = temporary.filter(|t| t.enabled()) else {
            return false;
        };
        let guard = self.temporary.lock().unwrap();
        let Some(progress) = guard.get(id) else {
            return false;
        };
        windows(usage).any(|window| {
            let Some(seconds) = window.limit_window_seconds else {
                return false;
            };
            let Some(used) = window
                .used_percent
                .filter(|u| u.is_finite() && (0.0..=100.0).contains(u))
            else {
                return false;
            };
            let (limit, base) = if seconds > 0 && seconds <= 86400 {
                (temp.short_term_percent, progress.short_baseline_used)
            } else if seconds > 86400 {
                (temp.long_term_percent, progress.long_baseline_used)
            } else {
                (None, None)
            };
            match (limit, base) {
                (Some(limit), Some(base)) => {
                    let consumed = (used - base).max(0.0);
                    consumed < f64::from(limit) && consumed + 5.0 >= f64::from(limit)
                }
                _ => false,
            }
        })
    }

    fn cached_entry(
        &self,
        id: &str,
        reserve: Option<&AccountReserve>,
        temporary: Option<&AccountTemporary>,
    ) -> Option<Option<Usage>> {
        let observations = self.observations.lock().unwrap();
        let observation = observations.get(id)?;
        let ttl = if observation
            .usage
            .as_ref()
            .is_some_and(|usage| self.near_limit(id, usage, reserve, temporary))
        {
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
        Some(observation.usage.clone())
    }

    fn cached(&self, id: &str, reserve: &AccountReserve) -> Option<ReserveStatus> {
        self.cached_entry(id, Some(reserve), None).map(|usage| {
            usage
                .as_ref()
                .map_or(ReserveStatus::Unknown, |u| evaluate(u, reserve))
        })
    }

    pub(super) fn record(&self, id: &str, usage: Option<Usage>) {
        self.observations.lock().unwrap().insert(
            id.into(),
            Observation {
                usage,
                at: Instant::now(),
            },
        );
    }

    pub(super) fn observe_headers(&self, id: &str, headers: &HeaderMap) -> Option<Usage> {
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
            return None;
        }
        self.observe_event(
            id,
            Some(Usage {
                plan_type: None,
                credits: None,
                rate_limit_reset_credits: None,
                rate_limit: Some(RateLimit {
                    allowed: None,
                    limit_reached: None,
                    primary_window: primary,
                    secondary_window: secondary,
                }),
            }),
        )
    }

    pub(super) fn observe_event(&self, id: &str, usage: Option<Usage>) -> Option<Usage> {
        self.observe(id, usage, None)
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
    fn save_temporary_ledger(
        &self,
        temporary: &HashMap<String, TemporaryProgress>,
    ) -> anyhow::Result<()> {
        crate::store::save(
            &self.paths.state_dir.join("subscription-temporary.json"),
            temporary,
        )
    }

    pub(super) fn sync_temporary_on_save(
        &self,
        previous: &SubscriptionConfig,
        current: &SubscriptionConfig,
    ) -> anyhow::Result<()> {
        let now = unix_now() as i64;
        let mut ledger = self.quota.temporary.lock().unwrap();
        let mut updated = HashMap::new();
        for (id, temp) in &current.account_temporary {
            if !current.account_order.contains(id) || !temp.enabled() {
                continue;
            }
            let was_active_temp = previous.account_order.contains(id)
                && previous
                    .account_temporary
                    .get(id)
                    .is_some_and(|prev| prev.enabled());
            let mut progress = match ledger.get(id) {
                Some(existing) if was_active_temp && existing.completed_reason.is_none() => {
                    existing.clone()
                }
                _ => TemporaryProgress::default(),
            };
            progress.completed_reason = None;
            sync_temporary_time_fields(&mut progress, temp, now);
            if temp.needs_usage()
                && let Some(usage) = self.quota.latest_unexpired_usage(id)
            {
                let _ = evaluate_temporary_progress(&mut progress, &usage, temp);
            }
            updated.insert(id.clone(), progress);
        }
        for (id, existing) in ledger.iter() {
            if updated.contains_key(id) || current.account_order.contains(id) {
                continue;
            }
            if !previous.account_temporary.contains_key(id) && existing.completed_reason.is_some() {
                updated.insert(id.clone(), existing.clone());
            }
        }
        *ledger = updated;
        self.save_temporary_ledger(&ledger)
    }

    pub(super) fn check_temporary_time_only(
        &self,
        id: &str,
        temp: &AccountTemporary,
    ) -> Option<String> {
        let now = unix_now() as i64;
        let mut ledger = self.quota.temporary.lock().unwrap();
        let entry = ledger.entry(id.to_string()).or_default();
        if entry.completed_reason.is_some() {
            *entry = TemporaryProgress::default();
        }
        let before = entry.clone();
        sync_temporary_time_fields(entry, temp, now);
        let changed = *entry != before;
        let reason = evaluate_temporary_time(entry, temp, now);
        if changed {
            let _ = self.save_temporary_ledger(&ledger);
        }
        reason
    }

    pub(super) fn evaluate_temporary_usage(
        &self,
        id: &str,
        usage: &Usage,
        temp: &AccountTemporary,
    ) -> ReserveStatus {
        let mut ledger = self.quota.temporary.lock().unwrap();
        let entry = ledger.entry(id.to_string()).or_default();
        if entry.completed_reason.is_some() {
            *entry = TemporaryProgress::default();
        }
        let before = entry.clone();
        let status = evaluate_temporary_progress(entry, usage, temp);
        if *entry != before {
            let _ = self.save_temporary_ledger(&ledger);
        }
        status
    }

    pub(super) fn retire_temporary_unlocked(
        &self,
        config: &mut SubscriptionConfig,
        id: &str,
        reason: String,
    ) -> anyhow::Result<()> {
        let was_present = config.account_order.iter().any(|item| item == id)
            || config.account_temporary.contains_key(id);
        let was_priority = config.account_priority.contains(&id.to_string());
        if was_priority {
            config.account_priority.retain(|item| item != id);
        } else {
            config.account_order.retain(|item| item != id);
        }
        config.account_temporary.remove(id);
        let reason = if was_priority {
            format!(
                "{}；已退出优先池，恢复自动分配",
                reason.replace("，已自动移出额度池", "")
            )
        } else {
            reason
        };
        if was_present {
            config.write_unchecked(&self.paths)?;
        }
        {
            let mut ledger = self.quota.temporary.lock().unwrap();
            ledger.insert(
                id.to_string(),
                TemporaryProgress {
                    completed_reason: Some(reason.clone()),
                    ..TemporaryProgress::default()
                },
            );
            self.save_temporary_ledger(&ledger)?;
        }
        if was_present {
            crate::runtime::append_log(
                &self.paths,
                "subscription.temporary.completed",
                json!({"recordId": id, "reason": reason}),
            );
        }
        Ok(())
    }

    pub(super) fn retire_temporary_account(&self, id: &str, reason: String) -> anyhow::Result<()> {
        let _guard = self.config_lock.lock().unwrap();
        let mut config = SubscriptionConfig::load(&self.paths)?;
        self.retire_temporary_unlocked(&mut config, id, reason)
    }

    pub(super) fn reconcile_temporary_with_usage(&self, id: &str, usage: &Usage) {
        let _guard = self.config_lock.lock().unwrap();
        let Ok(mut config) = SubscriptionConfig::load(&self.paths) else {
            return;
        };
        let Some(temp) = config
            .account_temporary
            .get(id)
            .filter(|t| t.enabled())
            .cloned()
        else {
            return;
        };
        if !config.account_order.iter().any(|entry| entry == id) {
            return;
        }
        if let Some(reason) = self.check_temporary_time_only(id, &temp) {
            let _ = self.retire_temporary_unlocked(&mut config, id, reason);
            return;
        }
        if temp.needs_usage()
            && let ReserveStatus::Reserved(reason) = self.evaluate_temporary_usage(id, usage, &temp)
        {
            let _ = self.retire_temporary_unlocked(&mut config, id, reason);
        }
    }

    pub(super) fn observe_headers_and_temporary(&self, id: &str, headers: &HeaderMap) {
        if let Some(usage) = self.quota.observe_headers(id, headers) {
            self.reconcile_temporary_with_usage(id, &usage);
        }
    }

    pub(super) fn observe_event_and_temporary(&self, id: &str, usage: Option<Usage>) {
        if let Some(usage) = self.quota.observe_event(id, usage) {
            self.reconcile_temporary_with_usage(id, &usage);
        }
    }

    pub async fn fetch_usage(&self, id: &str) -> anyhow::Result<Usage> {
        let started = Instant::now();
        let usage = AccountVault::new(self.paths.clone())
            .fetch_usage(id)
            .await?;
        let usage = self.quota.observe(id, Some(usage), Some(started)).unwrap();
        self.reconcile_temporary_with_usage(id, &usage);
        let available =
            usage.rate_limit.as_ref().is_some_and(|rate| {
                rate.allowed != Some(false) && rate.limit_reached != Some(true)
            }) && windows(&usage).next().is_some()
                && windows(&usage).all(|window| {
                    window
                        .limit_window_seconds
                        .is_some_and(|seconds| seconds > 0)
                        && window
                            .reset_at
                            .is_none_or(|reset| reset > unix_now() as i64)
                        && remaining(window).is_some_and(|value| value > 0.0)
                });
        if available {
            self.state.lock().unwrap().retain(|(record_id, _), state| {
                record_id != id || state.reason != CoolReason::Quota || state.observed_at > started
            });
        }
        Ok(usage)
    }

    fn evaluate_policies(
        &self,
        id: &str,
        usage: &Usage,
        reserve: Option<&AccountReserve>,
        temporary: Option<&AccountTemporary>,
    ) -> ReserveStatus {
        let mut unknown = false;
        if let Some(temp) = temporary {
            match self.evaluate_temporary_usage(id, usage, temp) {
                ReserveStatus::Reserved(reason) => {
                    let _ = self.retire_temporary_account(id, reason.clone());
                    return ReserveStatus::Reserved(reason);
                }
                ReserveStatus::Unknown => unknown = true,
                ReserveStatus::Ready => {}
            }
        }
        if let Some(reserve) = reserve {
            match evaluate(usage, reserve) {
                ReserveStatus::Reserved(reason) => return ReserveStatus::Reserved(reason),
                ReserveStatus::Unknown => unknown = true,
                ReserveStatus::Ready => {}
            }
        }
        if unknown {
            ReserveStatus::Unknown
        } else {
            ReserveStatus::Ready
        }
    }

    #[allow(dead_code)]
    pub(super) async fn check_reserve(
        &self,
        id: &str,
        reserve: &AccountReserve,
        client: &reqwest::Client,
        deadline: tokio::time::Instant,
    ) -> ReserveStatus {
        self.check_policies(id, Some(reserve), None, client, deadline)
            .await
    }

    pub(super) async fn check_policies(
        &self,
        id: &str,
        reserve: Option<&AccountReserve>,
        temporary: Option<&AccountTemporary>,
        client: &reqwest::Client,
        deadline: tokio::time::Instant,
    ) -> ReserveStatus {
        if let Some(temp) = temporary
            && let Some(reason) = self.check_temporary_time_only(id, temp)
        {
            let _ = self.retire_temporary_account(id, reason.clone());
            return ReserveStatus::Reserved(reason);
        }
        if reserve.is_none() && temporary.is_none_or(|t| !t.needs_usage()) {
            return ReserveStatus::Ready;
        }
        if let Some(cached) = self.quota.cached_entry(id, reserve, temporary) {
            return cached.map_or(ReserveStatus::Unknown, |usage| {
                self.evaluate_policies(id, &usage, reserve, temporary)
            });
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
        if let Some(cached) = self.quota.cached_entry(id, reserve, temporary) {
            return cached.map_or(ReserveStatus::Unknown, |usage| {
                self.evaluate_policies(id, &usage, reserve, temporary)
            });
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
                self.evaluate_policies(id, &usage, reserve, temporary)
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
        let mut items = Vec::new();
        let ledger = self.quota.temporary.lock().unwrap();
        for id in &config.account_order {
            if let Some(reserve) = config.account_reserves.get(id).filter(|r| r.enabled()) {
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
                items.push(json!({"recordId":id, "status":status, "reason":reason}));
            }
            if let Some(temp) = config.account_temporary.get(id).filter(|t| t.enabled()) {
                let now = unix_now() as i64;
                let progress = ledger.get(id);
                let mut parts = Vec::new();
                if let Some(target) = temp.weekly_remaining_percent {
                    parts.push(format!("周剩余 ≤ {target}% 后恢复自动分配"));
                }
                if let Some(limit) = temp.short_term_percent {
                    if let Some((base, last)) =
                        progress.and_then(|p| p.short_baseline_used.zip(p.short_last_used))
                    {
                        let consumed = (last - base).max(0.0);
                        if base < 0.0 {
                            parts.push(format!(
                                "5h 额度本次已用 {consumed:.1}% / {limit}%（已跨重置）"
                            ));
                        } else {
                            parts.push(format!(
                                "5h 额度本次已用 {consumed:.1}% / {limit}%（基线 {base:.1}%）"
                            ));
                        }
                    } else {
                        parts.push(format!("5h 额度目标 {limit}%（待首次用量确认）"));
                    }
                }
                if let Some(limit) = temp.long_term_percent {
                    if let Some((base, last)) =
                        progress.and_then(|p| p.long_baseline_used.zip(p.long_last_used))
                    {
                        let consumed = (last - base).max(0.0);
                        if base < 0.0 {
                            parts.push(format!(
                                "周额度本次已用 {consumed:.1}% / {limit}%（已跨重置）"
                            ));
                        } else {
                            parts.push(format!(
                                "周额度本次已用 {consumed:.1}% / {limit}%（基线 {base:.1}%）"
                            ));
                        }
                    } else {
                        parts.push(format!("周额度目标 {limit}%（待首次用量确认）"));
                    }
                }
                if let Some(mins) = temp.duration_minutes {
                    if let Some(exp) = progress.and_then(|p| p.expires_at) {
                        let rem_secs = exp.saturating_sub(now);
                        let rem_mins = if rem_secs > 0 {
                            (rem_secs + 59) / 60
                        } else {
                            0
                        };
                        parts.push(format!("限时 {mins} 分钟（剩余约 {rem_mins} 分钟）"));
                    } else {
                        parts.push(format!("限时 {mins} 分钟"));
                    }
                }
                if let Some(target) = temp.until_reset {
                    if let Some(reset_at) = progress.and_then(|p| p.target_reset_at) {
                        let rem_secs = reset_at.saturating_sub(now);
                        let rem_mins = if rem_secs > 0 {
                            (rem_secs + 59) / 60
                        } else {
                            0
                        };
                        parts.push(format!(
                            "直到下次{}刷新（剩余约 {rem_mins} 分钟）",
                            target.label()
                        ));
                    } else {
                        parts.push(format!("直到下次{}刷新（待首次用量确认）", target.label()));
                    }
                }
                items.push(json!({
                    "recordId": id,
                    "status": "temporary",
                    "reason": format!("临时使用中：{}", parts.join("，")),
                    "temporary": true,
                    "expiresAt": progress.and_then(|p| p.expires_at),
                    "targetResetAt": progress.and_then(|p| p.target_reset_at),
                }));
            }
        }
        for (id, progress) in ledger.iter() {
            if !config.account_temporary.contains_key(id)
                && let Some(reason) = &progress.completed_reason
            {
                items.push(json!({
                    "recordId": id,
                    "status": "temporary_completed",
                    "reason": reason,
                    "temporary": true
                }));
            }
        }
        items
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
        rate_limit_reset_credits: None,
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
