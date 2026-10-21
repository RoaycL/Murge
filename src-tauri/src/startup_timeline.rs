//! Credential-free, monotonic launch milestones shared with diagnostic reports.
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Mark {
    stage: &'static str,
    elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    process_started_at: String,
    marks: Vec<Mark>,
}

struct Timeline {
    started: Instant,
    snapshot: Snapshot,
    setup_complete: bool,
    reconciliation_complete: bool,
}

impl Timeline {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            snapshot: Snapshot {
                process_started_at: chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                marks: Vec::new(),
            },
            setup_complete: false,
            reconciliation_complete: false,
        }
    }

    fn mark_at(&mut self, stage: &'static str, elapsed: Duration) {
        if (self.setup_complete && self.reconciliation_complete)
            || self.snapshot.marks.iter().any(|mark| mark.stage == stage)
        {
            return;
        }
        self.snapshot.marks.push(Mark {
            stage,
            elapsed_ms: (elapsed.as_nanos().saturating_add(500_000) / 1_000_000)
                .min(u64::MAX as u128) as u64,
        });
    }

    fn mark(&mut self, stage: &'static str) {
        self.mark_at(stage, self.started.elapsed());
    }
}

static TIMELINE: OnceLock<Mutex<Timeline>> = OnceLock::new();

fn timeline() -> &'static Mutex<Timeline> {
    TIMELINE.get_or_init(|| Mutex::new(Timeline::new()))
}

pub(crate) fn initialize() {
    let _ = timeline();
}

pub(crate) fn mark(stage: &'static str) {
    timeline().lock().unwrap().mark(stage);
}

pub(crate) fn setup_complete() {
    timeline().lock().unwrap().setup_complete = true;
}

pub(crate) fn reconciliation_complete() {
    let mut timeline = timeline().lock().unwrap();
    timeline.mark("managed-state-recovered");
    timeline.mark("runtime-reconciled");
    timeline.reconciliation_complete = true;
}

// The diagnostics collector is introduced by the separate backup/diagnostics PR.
#[allow(dead_code)]
pub(crate) fn snapshot() -> Snapshot {
    timeline().lock().unwrap().snapshot.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_monotonic_once_and_snapshot_is_detached() {
        let mut timeline = Timeline::new();
        timeline.mark_at("settings-ready", Duration::from_millis(12));
        timeline.mark_at("settings-ready", Duration::from_millis(99));
        timeline.mark_at("ipc-ready", Duration::from_millis(18));
        let mut snapshot = timeline.snapshot.clone();
        assert_eq!(snapshot.marks.len(), 2);
        assert_eq!(snapshot.marks[0].elapsed_ms, 12);
        assert_eq!(snapshot.marks[1].elapsed_ms, 18);
        assert!(chrono::DateTime::parse_from_rfc3339(&snapshot.process_started_at).is_ok());
        snapshot.marks.clear();
        assert_eq!(timeline.snapshot.marks.len(), 2);
    }

    #[test]
    fn public_snapshot_has_the_shared_diagnostic_shape_and_real_marks() {
        initialize();
        let before = snapshot();
        mark("settings-ready");
        let value = serde_json::to_value(snapshot()).unwrap();
        assert_eq!(value["processStartedAt"], before.process_started_at);
        let marks = value["marks"].as_array().unwrap();
        assert!(marks.iter().any(|mark| mark["stage"] == "settings-ready"));
        assert!(marks.iter().all(|mark| mark["elapsedMs"].is_u64()));
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn elapsed_milliseconds_round_like_the_electron_timeline() {
        let mut timeline = Timeline::new();
        timeline.mark_at("settings-ready", Duration::from_micros(1_499));
        timeline.mark_at("ipc-ready", Duration::from_micros(1_500));
        assert_eq!(timeline.snapshot.marks[0].elapsed_ms, 1);
        assert_eq!(timeline.snapshot.marks[1].elapsed_ms, 2);
    }

    #[test]
    fn seal_waits_for_both_async_reconciliation_and_setup_in_either_order() {
        for reconciliation_first in [false, true] {
            let mut timeline = Timeline::new();
            timeline.setup_complete = !reconciliation_first;
            timeline.reconciliation_complete = reconciliation_first;
            timeline.mark_at("window-created", Duration::ZERO);
            assert_eq!(timeline.snapshot.marks[0].elapsed_ms, 0);
            timeline.setup_complete = true;
            timeline.reconciliation_complete = true;
            timeline.mark_at("kernel-ready", Duration::from_secs(10));
            assert_eq!(timeline.snapshot.marks.len(), 1);
        }
    }
}
