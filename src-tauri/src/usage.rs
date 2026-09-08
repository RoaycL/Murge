//! Bounded usage history — Rust port of `shared/usage.ts`,
//! `services/usage-history-store.ts` and `services/usage-history-service.ts`.
//!
//! The main process records per-sample traffic rates, integrates them into
//! hourly byte buckets and persists only aggregate buckets (never credentials,
//! hosts or raw profiles). Reads are always a valid, sorted, bounded list — an
//! empty or corrupt database is never an error.
//!
//! The traffic/connections sources attach in the Phase 3B/3D controller slice;
//! this module carries the model, the store and the query channels.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::error::IpcError;

pub const USAGE_BUCKET_MS: i64 = 3_600_000;
pub const USAGE_MAX_BUCKETS: usize = 24 * 30;

/// Per-window bucketing config: grid granularity and slot count.
fn window_config(window: &str) -> Option<(i64, i64)> {
    match window {
        "1h" => Some((USAGE_BUCKET_MS, 1)),
        "24h" => Some((USAGE_BUCKET_MS, 24)),
        "7d" => Some((24 * USAGE_BUCKET_MS, 7)),
        "30d" => Some((24 * USAGE_BUCKET_MS, 30)),
        _ => None,
    }
}

/// Align a timestamp down to the start of its bucket for the given grid.
pub fn usage_bucket_start(time: i64, bucket_ms: i64) -> i64 {
    time - time.rem_euclid(bucket_ms)
}

/// Align a timestamp down to the start of its hourly storage bucket.
#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
fn usage_hour_start(time: i64) -> i64 {
    usage_bucket_start(time, USAGE_BUCKET_MS)
}

/// Emit a number the way `JSON.stringify` would: integral values without a
/// decimal point, fractional values as floats.
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
fn is_non_negative(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    if number.is_finite() && number >= 0.0 {
        Some(number)
    } else {
        None
    }
}

/// Coerce one unknown value into a valid bucket, or None when unusable.
#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
pub fn coerce_usage_bucket(input: &Value) -> Option<Value> {
    let record = input.as_object()?;
    let bucket_start = is_non_negative(record.get("bucketStart")?)?;
    let up = is_non_negative(record.get("up")?)?;
    let down = is_non_negative(record.get("down")?)?;
    let mut bucket = Map::new();
    bucket.insert("bucketStart".into(), json!(bucket_start.floor() as i64));
    bucket.insert("up".into(), json!(up.round() as i64));
    bucket.insert("down".into(), json!(down.round() as i64));
    bucket.insert(
        "count".into(),
        json!(match record.get("count").and_then(is_non_negative) {
            Some(count) => count.floor() as i64,
            None => 0,
        }),
    );
    if record.get("countType").and_then(Value::as_str) == Some("connections") {
        bucket.insert("countType".into(), json!("connections"));
    }
    Some(Value::Object(bucket))
}

/// Coerce a persisted array into a valid bounded, sorted bucket list.
/// Non-coercible entries are dropped; the result is trimmed to the newest
/// `max_buckets` entries so a runaway file can never grow memory.
#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
pub fn coerce_usage_buckets(input: &Value, max_buckets: usize) -> Vec<Value> {
    let Some(entries) = input.as_array() else {
        return Vec::new();
    };
    let mut buckets: Vec<Value> = entries.iter().filter_map(coerce_usage_bucket).collect();
    buckets.sort_by_key(|bucket| bucket["bucketStart"].as_i64().unwrap_or(0));
    if buckets.len() > max_buckets {
        buckets.drain(..buckets.len() - max_buckets);
    }
    buckets
}

/// Aggregate stored hourly buckets into a window slice: exactly `span` slots
/// ending at the current slot, gaps filled with zero buckets.
pub fn aggregate_usage_window(
    buckets: &[Value],
    window: &str,
    now: i64,
    max_buckets: usize,
) -> Result<Value, IpcError> {
    let Some((grid_ms, span)) = window_config(window) else {
        return Err(IpcError::invalid_argument(format!(
            "usage window must be one of 1h, 24h, 7d, 30d (got {window:?})"
        )));
    };
    let aligned_now = usage_bucket_start(now, grid_ms);
    let window_start = aligned_now - (span - 1) * grid_ms;

    let mut grouped: std::collections::BTreeMap<i64, (f64, f64, f64)> = Default::default();
    for bucket in buckets {
        let slot = usage_bucket_start(bucket["bucketStart"].as_i64().unwrap_or(0), grid_ms);
        if slot < window_start || slot > aligned_now {
            continue;
        }
        let entry = grouped.entry(slot).or_insert((0.0, 0.0, 0.0));
        entry.0 += bucket["up"].as_f64().unwrap_or(0.0);
        entry.1 += bucket["down"].as_f64().unwrap_or(0.0);
        entry.2 += bucket["count"].as_f64().unwrap_or(0.0);
    }

    let mut out: Vec<Value> = Vec::new();
    let mut totals_up = 0.0;
    let mut totals_down = 0.0;
    let mut totals_count = 0.0;
    for slot in (window_start..=aligned_now).step_by(grid_ms as usize) {
        let (up, down, count) = grouped.get(&slot).copied().unwrap_or((0.0, 0.0, 0.0));
        out.push(json!({ "bucketStart": slot, "up": json_number(up), "down": json_number(down), "count": json_number(count) }));
        totals_up += up;
        totals_down += down;
        totals_count += count;
    }

    Ok(json!({
        "window": window,
        "bucketMs": grid_ms,
        "bucketCount": out.len(),
        "maxBuckets": max_buckets,
        "retentionHours": (max_buckets as i64 * USAGE_BUCKET_MS) / 3_600_000,
        "totals": { "up": json_number(totals_up), "down": json_number(totals_down), "total": json_number(totals_up + totals_down), "count": json_number(totals_count) },
        "buckets": out
    }))
}

/// The metric value used to rank one bucket.
fn usage_ranking_value(bucket: &Value, ranking: &str) -> f64 {
    match ranking {
        "down" => bucket["down"].as_f64().unwrap_or(0.0),
        "up" => bucket["up"].as_f64().unwrap_or(0.0),
        "total" => bucket["up"].as_f64().unwrap_or(0.0) + bucket["down"].as_f64().unwrap_or(0.0),
        "count" => bucket["count"].as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Rank a window's buckets by the chosen metric into a 1-based ordered list.
/// Zero-value buckets are omitted; the result is capped at `limit` when given.
pub fn rank_usage_buckets(buckets: &[Value], ranking: &str, limit: Option<usize>) -> Result<Vec<Value>, IpcError> {
    if !matches!(ranking, "down" | "up" | "total" | "count") {
        return Err(IpcError::invalid_argument(format!(
            "usage ranking must be one of down, up, total, count (got {ranking:?})"
        )));
    }
    let mut qualifying: Vec<&Value> = buckets
        .iter()
        .filter(|bucket| usage_ranking_value(bucket, ranking) > 0.0)
        .collect();
    qualifying.sort_by(|a, b| {
        let delta = usage_ranking_value(b, ranking) - usage_ranking_value(a, ranking);
        if delta != 0.0 {
            delta.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a["bucketStart"].as_i64().unwrap_or(0).cmp(&b["bucketStart"].as_i64().unwrap_or(0))
        }
    });
    if let Some(limit) = limit.filter(|limit| *limit > 0) {
        qualifying.truncate(limit);
    }
    Ok(qualifying
        .iter()
        .enumerate()
        .map(|(index, bucket)| {
            json!({
                "bucketStart": bucket["bucketStart"],
                "up": bucket["up"],
                "down": bucket["down"],
                "count": bucket["count"],
                "value": json_number(usage_ranking_value(bucket, ranking)),
                "rank": index + 1
            })
        })
        .collect())
}

/// Static capacity facts surfaced to the renderer.
pub fn usage_capacity(max_buckets: usize) -> Value {
    json!({
        "bucketMs": USAGE_BUCKET_MS,
        "maxBuckets": max_buckets,
        "retentionHours": (max_buckets as i64 * USAGE_BUCKET_MS) / 3_600_000
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub const USAGE_HISTORY_FILE: &str = "usage-history.json";

/// File-backed bounded usage-history store. Writes are atomic; reads are
/// coalesced so a stale or hand-edited file is a safe empty database. `None`
/// paths give the in-memory dev/test store.
pub struct UsageHistoryStore {
    file_path: Option<PathBuf>,
    /// Per-instance memory store (dev/tests); independent like the TS
    /// InMemoryUsageHistoryStore.
    memory: Mutex<Vec<Value>>,
    queue: Mutex<()>,
}

impl UsageHistoryStore {
    /// Resolve the database file under `<app-data>/usage-history/`.
    pub fn for_app_data_base(app_data_base: Option<PathBuf>) -> Self {
        UsageHistoryStore {
            file_path: app_data_base.map(|base| base.join("usage-history").join(USAGE_HISTORY_FILE)),
            memory: Mutex::new(Vec::new()),
            queue: Mutex::new(()),
        }
    }

#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
    /// In-memory store for the dev build and unit tests.
    pub fn in_memory() -> Self {
        UsageHistoryStore { file_path: None, memory: Mutex::new(Vec::new()), queue: Mutex::new(()) }
    }

    fn memory_guard(&self) -> std::sync::MutexGuard<'_, Vec<Value>> {
        self.memory.lock().expect("usage memory store poisoned")
    }

#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
    /// Read always returns a valid, sorted, bounded list. Before 0.8.5 `count`
    /// meant one traffic sample (saturating around 3600/hour); keep the byte
    /// history but reset that legacy counter once — newly persisted buckets
    /// carry the explicit `countType: "connections"` marker.
    pub fn read(&self) -> Vec<Value> {
        let _serial = self.queue.lock().expect("usage store queue poisoned");
        let Some(path) = self.file_path.as_ref() else {
            return self.memory_guard().clone();
        };
        self.prune_stale_temps(path);
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(_) => return Vec::new(),
        };
        let parsed = match serde_json::from_str::<Value>(&raw) {
            Ok(parsed) => parsed,
            Err(_) => return Vec::new(),
        };
        coerce_usage_buckets(&parsed, USAGE_MAX_BUCKETS)
            .into_iter()
            .map(|mut bucket| {
                if bucket.get("countType").and_then(Value::as_str) != Some("connections") {
                    bucket["count"] = json!(0);
                    bucket["countType"] = json!("connections");
                }
                bucket
            })
            .collect()
    }

    /// Atomic write: temp file in the same directory, then rename (with the
    /// Windows-friendly retry loop against EPERM/EACCES/EBUSY).
    pub fn write(&self, buckets: &[Value]) -> Result<(), IpcError> {
        let _serial = self.queue.lock().expect("usage store queue poisoned");
        let snapshot: Vec<Value> = buckets.to_vec();
        let Some(path) = self.file_path.as_ref() else {
            *self.memory_guard() = snapshot;
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                IpcError::internal(format!("unable to create usage-history directory: {error}"))
            })?;
        }
        let mut body = serde_json::to_string(&snapshot).expect("usage buckets serialize");
        body.push('\n');
        let tmp = path.with_file_name(format!(
            ".{USAGE_HISTORY_FILE}.{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let mut attempt = 0;
        loop {
            let result = fs::write(&tmp, &body).and_then(|()| fs::rename(&tmp, path));
            match result {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let retriable = matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Other
                    );
                    attempt += 1;
                    if !retriable || attempt > 4 {
                        let _ = fs::remove_file(&tmp);
                        return Err(IpcError::internal(format!(
                            "unable to persist {USAGE_HISTORY_FILE}: {error}"
                        )));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25 * (1 << attempt)));
                }
            }
        }
    }

#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
    /// Remove temp files left behind by an interrupted write.
    fn prune_stale_temps(&self, path: &PathBuf) {
        let Some(directory) = path.parent() else { return };
        let Ok(entries) = fs::read_dir(directory) else { return };
        let prefix = format!(".{USAGE_HISTORY_FILE}.");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) && name.ends_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// A minimal traffic sample the service integrates (rate in bytes/second).
#[allow(dead_code)] // attaches to the kernel /traffic stream (3B/3D controller slice)
pub struct UsageSample {
    pub up: f64,
    pub down: f64,
}

struct UsageState {
    buckets: Vec<Value>,
    current_bucket_start: Option<i64>,
    last_at: Option<i64>,
    last_persist_at: i64,
    active_connection_ids: std::collections::HashSet<String>,
    loaded: bool,
}

/// Bounded usage-history controller: integrates traffic rates into hourly byte
/// buckets, counts newly observed connections, keeps the bucket list capped.
pub struct UsageHistoryService {
    max_buckets: usize,
    store: UsageHistoryStore,
    persist_interval_ms: i64,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    state: Mutex<UsageState>,
}

impl UsageHistoryService {
    pub fn new(store: UsageHistoryStore) -> Self {
        UsageHistoryService {
            max_buckets: USAGE_MAX_BUCKETS,
            store,
            persist_interval_ms: 10_000,
            clock: Box::new(epoch_millis_now),
            state: Mutex::new(UsageState {
                buckets: Vec::new(),
                current_bucket_start: None,
                last_at: None,
                last_persist_at: 0,
                active_connection_ids: Default::default(),
                loaded: false,
            }),
        }
    }

    #[allow(dead_code)] // test seams; the record surface attaches in the 3B/3D controller slice
    /// Injectable clock for window alignment (tests).
    pub fn with_clock(mut self, clock: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    #[allow(dead_code)] // test seams; the record surface attaches in the 3B/3D controller slice
    /// Injectable persistence throttle (tests; 0 = persist every record).
    pub fn with_persist_interval_ms(mut self, persist_interval_ms: i64) -> Self {
        self.persist_interval_ms = persist_interval_ms;
        self
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, UsageState> {
        self.state.lock().expect("usage service mutex poisoned")
    }

    /// Load any persisted buckets; safe to call more than once.
    pub fn init(&self) {
        let mut state = self.guard();
        if state.loaded {
            return;
        }
        state.buckets = coerce_usage_buckets(&json!(self.store.read()), self.max_buckets);
        state.current_bucket_start = state.buckets.last().and_then(|b| b["bucketStart"].as_i64());
        state.loaded = true;
    }

    /// Record one traffic sample. Bytes integrate from the rate over the
    /// interval since the previous sample; a non-monotonic clock contributes
    /// zero bytes and never regresses the cursor.
#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
    pub fn record(&self, sample: &UsageSample, at: Option<i64>) -> Result<(), IpcError> {
        self.init();
        let mut state = self.guard();
        let time = at.unwrap_or_else(|| (self.clock)());
        let interval_ms = match state.last_at {
            Some(last) if time > last => time - last,
            _ => 0,
        };
        let factor = interval_ms as f64 / 1000.0;
        let up_bytes = sample.up * factor;
        let down_bytes = sample.down * factor;

        let current = self.ensure_bucket(&mut state, time);
        let object = current.as_object_mut().expect("bucket is an object");
        *object.get_mut("up").expect("up") = json_number(object["up"].as_f64().unwrap_or(0.0) + up_bytes);
        *object.get_mut("down").expect("down") = json_number(object["down"].as_f64().unwrap_or(0.0) + down_bytes);
        if state.last_at.is_none() || time > state.last_at.expect("checked") {
            state.last_at = Some(time);
        }
        self.trim_to_bound(&mut state);
        self.maybe_persist(&mut state, time)
    }

    /// Count actual newly observed connections instead of 1 Hz traffic ticks.
#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
    pub fn record_connections(&self, connection_ids: &[String], at: i64) -> Result<(), IpcError> {
        self.init();
        let mut state = self.guard();
        let current_ids: std::collections::HashSet<&String> = connection_ids.iter().collect();
        let added = current_ids
            .iter()
            .filter(|id| !state.active_connection_ids.contains(**id))
            .count();
        state.active_connection_ids = current_ids.into_iter().cloned().collect();
        if added == 0 {
            return Ok(());
        }
        let current = self.ensure_bucket(&mut state, at);
        let object = current.as_object_mut().expect("bucket is an object");
        *object.get_mut("count").expect("count") = json!(object["count"].as_i64().unwrap_or(0) + added as i64);
        object.insert("countType".into(), json!("connections"));
        self.trim_to_bound(&mut state);
        self.maybe_persist(&mut state, at)
    }

    /// Aggregate the bounded database into a window slice (read-back).
    pub fn get_window(&self, window: &str) -> Result<Value, IpcError> {
        let state = self.guard();
        aggregate_usage_window(&state.buckets, window, (self.clock)(), self.max_buckets)
    }

    /// Rank a window's buckets by the chosen metric (1-based ordered list).
    pub fn rank(&self, window: &str, ranking: &str, limit: Option<usize>) -> Result<Value, IpcError> {
        let state = self.guard();
        let snapshot = aggregate_usage_window(&state.buckets, window, (self.clock)(), self.max_buckets)?;
        let buckets = snapshot["buckets"].as_array().cloned().unwrap_or_default();
        Ok(Value::Array(rank_usage_buckets(&buckets, ranking, limit)?))
    }

    /// Drop the whole bounded database and persist the empty list.
    pub fn clear(&self) -> Result<(), IpcError> {
        let mut state = self.guard();
        state.buckets = Vec::new();
        state.current_bucket_start = None;
        state.last_at = None;
        state.active_connection_ids.clear();
        self.store.write(&[])?;
        state.last_persist_at = (self.clock)();
        Ok(())
    }

    /// Static capacity facts surfaced to the renderer.
    pub fn get_capacity(&self) -> Value {
        usage_capacity(self.max_buckets)
    }

    /// Persist the current bounded database immediately (e.g. on quit).
#[allow(dead_code)] // the record/flush surface attaches to the kernel traffic streams (3B/3D controller slice)
    pub fn flush(&self) -> Result<(), IpcError> {
        self.init();
        let state = self.guard();
        self.store.write(&state.buckets)?;
        drop(state);
        self.guard().last_persist_at = (self.clock)();
        Ok(())
    }

    fn trim_to_bound(&self, state: &mut UsageState) {
        while state.buckets.len() > self.max_buckets {
            state.buckets.remove(0);
        }
    }

    fn ensure_bucket<'s>(&self, state: &'s mut UsageState, time: i64) -> &'s mut Value {
        let bucket_start = usage_hour_start(time);
        if state.current_bucket_start != Some(bucket_start) {
            state.buckets.push(json!({
                "bucketStart": bucket_start, "up": 0, "down": 0, "count": 0, "countType": "connections"
            }));
            state.current_bucket_start = Some(bucket_start);
            state.last_persist_at = 0;
        }
        state.buckets.last_mut().expect("bucket was just pushed")
    }

    fn maybe_persist(&self, state: &mut UsageState, time: i64) -> Result<(), IpcError> {
        // 0 disables throttling; any positive value gates writes.
        if self.persist_interval_ms > 0 && time - state.last_persist_at < self.persist_interval_ms {
            return Ok(());
        }
        self.store.write(&state.buckets)?;
        state.last_persist_at = time;
        Ok(())
    }
}

fn epoch_millis_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn bucket(start: i64, up: i64, down: i64, count: i64) -> Value {
        json!({ "bucketStart": start, "up": up, "down": down, "count": count, "countType": "connections" })
    }

    #[test]
    fn coerce_bucket_drops_invalid_entries_and_bounds() {
        assert!(coerce_usage_bucket(&json!({ "bucketStart": -1, "up": 0, "down": 0 })).is_none());
        assert!(coerce_usage_bucket(&json!({ "bucketStart": 1, "up": "x", "down": 0 })).is_none());
        let coerced = coerce_usage_bucket(&json!({ "bucketStart": 100.4, "up": 10.6, "down": 2, "count": 3.2 })).unwrap();
        assert_eq!(coerced["bucketStart"], 100);
        assert_eq!(coerced["up"], 11);
        assert_eq!(coerced["count"], 3);
        assert!(coerced.get("countType").is_none());
        let raw = json!([bucket(2, 1, 1, 1), bucket(1, 1, 1, 1), "junk", bucket(3, 1, 1, 1)]);
        let coerced = coerce_usage_buckets(&raw, 2);
        assert_eq!(coerced.len(), 2, "newest retained");
        assert_eq!(coerced[0]["bucketStart"], 2, "sorted oldest-first within the bound");
    }

    #[test]
    fn window_aggregation_fills_slots_and_totals() {
        let hour = USAGE_BUCKET_MS;
        let now = hour * 10;
        let buckets = vec![bucket(now, 5, 7, 2), bucket(now - hour, 1, 1, 1), bucket(now - hour * 30, 100, 100, 1)];
        let snapshot = aggregate_usage_window(&buckets, "24h", now, 720).unwrap();
        assert_eq!(snapshot["bucketCount"], 24);
        assert_eq!(snapshot["buckets"][23]["up"], 5, "current slot is last");
        assert_eq!(snapshot["buckets"][22]["up"], 1);
        assert_eq!(snapshot["buckets"][0]["up"], 0, "gap slots are zero-filled");
        assert_eq!(snapshot["totals"]["up"], 6, "buckets outside the 24 slots are excluded");
        assert_eq!(snapshot["totals"]["total"], 14);
        assert_eq!(snapshot["retentionHours"], 720);
        assert_eq!(snapshot["maxBuckets"], 720);
        // The far bucket folds into a DAY slot for the 7d window.
        let day_grid = aggregate_usage_window(&buckets, "7d", now, 720).unwrap();
        assert_eq!(day_grid["bucketMs"], 24 * hour);
        assert_eq!(day_grid["bucketCount"], 7);
        assert_eq!(day_grid["totals"]["up"], 106, "30h-old bucket folds into yesterday's day slot");
        assert!(aggregate_usage_window(&buckets, "2h", now, 720).is_err());
    }

    #[test]
    fn ranking_orders_and_caps() {
        let hour = USAGE_BUCKET_MS;
        let now = hour * 3;
        let buckets = vec![bucket(now, 10, 1, 1), bucket(now - hour, 1, 9, 1), bucket(now - 2 * hour, 0, 0, 0)];
        let snapshot = aggregate_usage_window(&buckets, "24h", now, 720).unwrap();
        let ranked = rank_usage_buckets(snapshot["buckets"].as_array().unwrap(), "total", None).unwrap();
        assert_eq!(ranked.len(), 2, "zero buckets omitted");
        assert_eq!(ranked[0]["rank"], 1);
        assert_eq!(ranked[0]["bucketStart"], now, "11 (up 10 + down 1) outranks 10");
        assert_eq!(ranked[1]["bucketStart"], now - hour);
        assert_eq!(ranked[1]["rank"], 2);
        // A genuine tie ranks the EARLIER bucket first.
        let tied = vec![bucket(now, 10, 1, 0), bucket(now - hour, 10, 1, 0)];
        let tied_snapshot = aggregate_usage_window(&tied, "24h", now, 720).unwrap();
        let ranked = rank_usage_buckets(tied_snapshot["buckets"].as_array().unwrap(), "total", None).unwrap();
        assert_eq!(ranked[0]["bucketStart"], now - hour, "tie 11 vs 11 -> earlier first");
        assert_eq!(ranked[1]["bucketStart"], now);
        let ranked = rank_usage_buckets(snapshot["buckets"].as_array().unwrap(), "down", Some(1)).unwrap();
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0]["value"], 9);
        assert!(rank_usage_buckets(snapshot["buckets"].as_array().unwrap(), "bytes", None).is_err());
    }

    #[test]
    fn capacity_facts() {
        assert_eq!(usage_capacity(720)["retentionHours"], 720);
        assert_eq!(usage_capacity(720)["bucketMs"], USAGE_BUCKET_MS);
    }

    #[test]
    fn store_round_trip_compact_and_legacy_count_reset() {
        let temp = TempDir::new().unwrap();
        let store = UsageHistoryStore::for_app_data_base(Some(temp.path().to_path_buf()));
        store.write(&[bucket(1, 5, 6, 2)]).unwrap();
        let raw = fs::read_to_string(temp.path().join("usage-history/usage-history.json")).unwrap();
        assert!(raw.starts_with("[{\"bucketStart\":1,"), "compact JSON: {raw}");
        assert!(raw.ends_with("\n"));
        assert_eq!(store.read()[0]["count"], 2);
        // A legacy bucket without the marker resets its count.
        fs::write(
            temp.path().join("usage-history/usage-history.json"),
            "[{\"bucketStart\":1,\"up\":5,\"down\":6,\"count\":3600}]\n",
        )
        .unwrap();
        let read = store.read();
        assert_eq!(read[0]["count"], 0);
        assert_eq!(read[0]["countType"], "connections");
        // A corrupt file is an empty database, never an error.
        fs::write(temp.path().join("usage-history/usage-history.json"), "{oops").unwrap();
        assert!(store.read().is_empty());
    }

    #[test]
    fn stale_temps_are_pruned_on_read() {
        let temp = TempDir::new().unwrap();
        let store = UsageHistoryStore::for_app_data_base(Some(temp.path().to_path_buf()));
        fs::create_dir_all(temp.path().join("usage-history")).unwrap();
        let stale = temp.path().join("usage-history/.usage-history.json.stale.tmp");
        fs::write(&stale, "garbage").unwrap();
        store.write(&[bucket(1, 1, 1, 1)]).unwrap();
        assert!(store.read().len() == 1);
        assert!(!stale.exists(), "interrupted-write temp removed");
    }

    #[test]
    fn service_integrates_rate_over_interval() {
        let store = UsageHistoryStore::in_memory();
        let hour = USAGE_BUCKET_MS;
        let mut t = hour * 5;
        let service = UsageHistoryService::new(store)
            .with_clock(Box::new(move || hour * 5))
            .with_persist_interval_ms(0);
        service.record(&UsageSample { up: 1000.0, down: 500.0 }, Some(t)).unwrap();
        t += 2000; // 2 s at (1000, 500) B/s -> 2000 up / 1000 down
        service.record(&UsageSample { up: 1000.0, down: 500.0 }, Some(t)).unwrap();
        // A back-dated sample contributes zero and does not regress the cursor.
        service.record(&UsageSample { up: 9999.0, down: 9999.0 }, Some(t - 5000)).unwrap();
        t += 1000;
        service.record(&UsageSample { up: 1000.0, down: 500.0 }, Some(t)).unwrap();
        let window = service.get_window("1h").unwrap();
        assert_eq!(window["totals"]["up"], 3000);
        assert_eq!(window["totals"]["down"], 1500);
        assert_eq!(window["totals"]["count"], 0);
    }

    #[test]
    fn service_buckets_roll_hourly_and_bound() {
        let store = UsageHistoryStore::in_memory();
        let hour = USAGE_BUCKET_MS;
        let clock = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(hour * 5));
        let tick = clock.clone();
        let t = |value: i64| clock.store(value, std::sync::atomic::Ordering::SeqCst);
        let service = UsageHistoryService::new(store)
            .with_clock(Box::new(move || tick.load(std::sync::atomic::Ordering::SeqCst)))
            .with_persist_interval_ms(0);
        service.record(&UsageSample { up: 10.0, down: 0.0 }, Some(hour * 5)).unwrap();
        t(hour * 6); // next bucket
        service.record(&UsageSample { up: 20.0, down: 0.0 }, Some(hour * 6)).unwrap();
        let window = service.get_window("24h").unwrap();
        assert_eq!(window["buckets"].as_array().unwrap().len(), 24);
        // The second sample integrates 20 B/s over the full 3600 s hour.
        assert_eq!(window["totals"]["up"], 72000);
        assert_eq!(service.get_window("1h").unwrap()["totals"]["up"], 72000);
        // Bound: over-filling drops the oldest.
        for i in 0..(USAGE_MAX_BUCKETS + 5) {
            let time = hour * (6 + i as i64 + 1);
            t(time);
            service.record(&UsageSample { up: 1.0, down: 0.0 }, Some(time)).unwrap();
            let _ = i;
        }
        // The oldest buckets were dropped by the bound; each of the newest 24
        // slots holds 1 B/s integrated over its full hour.
        assert_eq!(service.get_window("24h").unwrap()["totals"]["up"], 24 * 3600);
        assert_eq!(service.get_window("1h").unwrap()["totals"]["up"], 3600);
    }

    #[test]
    fn service_counts_new_connections_only() {
        let service = UsageHistoryService::new(UsageHistoryStore::in_memory())
            .with_clock(Box::new(|| USAGE_BUCKET_MS * 7))
            .with_persist_interval_ms(0);
        let at = USAGE_BUCKET_MS * 7;
        service.record_connections(&["a".into(), "b".into()], at).unwrap();
        service.record_connections(&["a".into(), "b".into(), "c".into()], at + 1000).unwrap();
        service.record_connections(&["c".into()], at + 2000).unwrap();
        let window = service.get_window("1h").unwrap();
        assert_eq!(window["totals"]["count"], 3, "only newly observed ids count");
        service.clear().unwrap();
        assert_eq!(service.get_window("1h").unwrap()["totals"]["count"], 0);
        assert_eq!(service.get_capacity()["maxBuckets"], USAGE_MAX_BUCKETS);
    }

    #[test]
    fn service_persists_and_reloads_from_store() {
        let temp = TempDir::new().unwrap();
        let hour = USAGE_BUCKET_MS;
        let t = hour * 9;
        {
            let service = UsageHistoryService::new(UsageHistoryStore::for_app_data_base(Some(temp.path().to_path_buf())))
                .with_clock(Box::new(move || t))
                .with_persist_interval_ms(0);
            service.record(&UsageSample { up: 100.0, down: 0.0 }, Some(t)).unwrap();
            // The first sample integrates zero bytes (no prior interval); the
            // second one accumulates the rate over the 1 s step.
            service.record(&UsageSample { up: 100.0, down: 0.0 }, Some(t + 1000)).unwrap();
            service.flush().unwrap();
        }
        let reloaded = UsageHistoryService::new(UsageHistoryStore::for_app_data_base(Some(temp.path().to_path_buf())))
            .with_clock(Box::new(move || t + 1000));
        reloaded.init();
        let window = reloaded.get_window("1h").unwrap();
        assert_eq!(window["totals"]["up"], 100, "persisted buckets reload");
    }

    #[test]
    fn rank_channel_shape() {
        let service = UsageHistoryService::new(UsageHistoryStore::in_memory())
            .with_clock(Box::new(|| USAGE_BUCKET_MS * 2))
            .with_persist_interval_ms(0);
        let at = USAGE_BUCKET_MS * 2;
        service.record_connections(&["a".into(), "b".into(), "c".into()], at).unwrap();
        let ranked = service.rank("1h", "count", None).unwrap();
        assert_eq!(ranked.as_array().unwrap().len(), 1);
        assert_eq!(ranked[0]["value"], 3);
        assert_eq!(ranked[0]["rank"], 1);
        assert!(service.rank("1h", "nope", None).is_err());
    }
}
