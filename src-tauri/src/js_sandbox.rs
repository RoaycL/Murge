//! The sealed JS override sandbox — Rust port of the `node:vm` surface in
//! `apply-overrides.ts` (`runJsOverride` + `validateJsOverride`), un-staging
//! the `js` override kind.
//!
//! Engine: `boa_engine` (pure-Rust ECMAScript). The TS `createContext`
//! sandbox exposes ONLY a shadow `console` — no `require`, `process`, `fs` or
//! other Node globals — and every script is bounded by a hard timeout so a
//! runaway loop cannot stall the host. Boa's equivalent bound is the loop
//! iteration trap (`RuntimeLimits::set_loop_iteration_limit`) plus the
//! default recursion/stack limits; the TS bound is wall-clock 2000 ms per
//! `runInContext`. Both abort a runaway script with an error; the wall-clock
//! vs iteration-count difference is documented in
//! docs/tauri/phase3/README.md.
//!
//! Error copy: the Chinese prefixes are byte-exact
//! (`JS 覆写脚本执行失败：` / `JS 覆写 main(config) 执行失败：` /
//! `JS 覆写脚本无法解析：` / `JS 覆写未定义 main(config) 函数`); the embedded
//! engine message after the prefix is engine-specific text (boa vs V8),
//! matching the TS `error.message.split('\n')[0]` shape.

use boa_engine::{Context, JsValue, Source, js_string};

/// The TS `timeout: 2000` is wall-clock; the loop trap is the engine-native
/// bound with equivalent effect (a runaway script aborts with an error).
const LOOP_ITERATION_LIMIT: u64 = 5_000_000;

/// The console shadow + the user script, evaluated as one unit. Writing the
/// shadow console IN the sandbox keeps `String(arg)` / `join` semantics
/// engine-native instead of approximating them through Rust formatting.
const CONSOLE_PREAMBLE: &str = r#"
globalThis.__messages = [];
globalThis.console = {
  log: (...args) => { __messages.push(args.map(String).join(' ')) },
  info: (...args) => { __messages.push(args.map(String).join(' ')) },
  warn: (...args) => { __messages.push(`warn: ${args.map(String).join(' ')}`) },
  error: (...args) => { __messages.push(`error: ${args.map(String).join(' ')}`) },
  debug: (...args) => { __messages.push(args.map(String).join(' ')) }
};
"#;

/// The exact snippet the TS runs to invoke `main(config)` (step 2).
const INVOKE_MAIN: &str =
    r#"(typeof main === "function") ? (globalThis.__overrideResult = main(config)) : null"#;

fn fresh_context() -> Context {
    let mut context = Context::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
    context
}

/// First line of the engine error text, matching the TS
/// `error.message.split('\n')[0]` shape.
fn first_line(error: &boa_engine::JsError) -> String {
    error.to_string().lines().next().unwrap_or_default().to_string()
}

/// Drain the sandbox `__messages` array into the warnings order. The array
/// holds only strings the sandbox pushed; anything exotic falls back to its
/// JS `String` form via `display`.
fn drain_messages(context: &mut Context) -> Vec<String> {
    let mut messages = Vec::new();
    let Ok(array_value) = context.global_object().get(js_string!("__messages"), context) else {
        return messages;
    };
    let Ok(array) = array_value.to_object(context) else {
        return messages;
    };
    let Ok(length_value) = array.get(js_string!("length"), context) else {
        return messages;
    };
    let length = length_value.to_number(context).unwrap_or(0.0) as usize;
    for index in 0..length {
        if let Ok(value) = array.get(index, context) {
            if let Some(text) = value.as_string() {
                messages.push(text.to_std_string_escaped());
            } else {
                messages.push(value.display().to_string());
            }
        }
    }
    messages
}

/// `isPlainObject` for the RETURNED value: object, not null, not an array
/// (the TS check also excludes Date/Map instances — a returned Date/Map is an
/// absurd `main` result; the JSON round-trip treats it as `{}` then).
fn returned_is_plain_object(value: &JsValue) -> bool {
    match value.as_object() {
        Some(object) => !object.is_array(),
        None => false,
    }
}

/// Read a global back through the JSON round-trip, mapping the engine error
/// to the generic failure path (only reachable for values JSON cannot
/// represent, e.g. BigInt — see the module doc).
fn value_to_json(value: &JsValue, context: &mut Context) -> Option<serde_json::Value> {
    if value.is_undefined() || value.is_bigint() {
        return None;
    }
    value.to_json(context).ok()
}

pub struct RunJsOverride {
    pub next: serde_json::Value,
    pub warnings: Vec<String>,
}

/// Run a JS override in a sealed sandbox and return the resulting config.
///
/// `main(config)` may mutate the shared config object and/or return a new
/// one; a returned plain object wins, otherwise the (possibly mutated)
/// config is used.
pub fn run_js_override(content: &str, config: &serde_json::Value) -> RunJsOverride {
    let mut warnings: Vec<String> = Vec::new();
    let mut context = fresh_context();

    // (1) Define `main` (and any helpers) from the user's body.
    let script = format!("{CONSOLE_PREAMBLE}\n{content}");
    if let Err(error) = context.eval(Source::from_bytes(script.as_bytes())) {
        warnings.push(format!("JS 覆写脚本执行失败：{}", first_line(&error)));
        return RunJsOverride {
            next: config.clone(),
            warnings,
        };
    }

    // (2) Invoke main(config) with the shared base config reference.
    let config_value = JsValue::from_json(config, &mut context).unwrap_or(JsValue::undefined());
    let global = context.global_object();
    if global
        .set(js_string!("config"), config_value.clone(), false, &mut context)
        .is_err()
    {
        warnings.push("JS 覆写 main(config) 执行失败：config 不可写".to_string());
        return RunJsOverride { next: config.clone(), warnings };
    }
    if let Err(error) = context.eval(Source::from_bytes(INVOKE_MAIN.as_bytes())) {
        warnings.push(format!("JS 覆写 main(config) 执行失败：{}", first_line(&error)));
    }

    let returned = context
        .global_object()
        .get(js_string!("__overrideResult"), &mut context)
        .unwrap_or(JsValue::undefined());

    // `main` may have mutated `config` in place; a returned object also wins.
    let next = if returned_is_plain_object(&returned) {
        value_to_json(&returned, &mut context)
    } else {
        value_to_json(&config_value, &mut context)
    }
    .unwrap_or_else(|| config.clone());

    let messages = drain_messages(&mut context);
    RunJsOverride {
        next,
        warnings: [warnings, messages].concat(),
    }
}

/// Dry-run a JS override body to confirm it defines `main(config)` without
/// actually invoking it. Returns the human-readable issue, or `None` when the
/// body is structurally valid. Safe: the body runs only in the sealed sandbox
/// and is never executed against a real config.
pub fn validate_js_override(content: &str) -> Option<String> {
    let mut context = fresh_context();
    let script = format!("{CONSOLE_PREAMBLE}\n{content}");
    if let Err(error) = context.eval(Source::from_bytes(script.as_bytes())) {
        return Some(format!("JS 覆写脚本无法解析：{}", first_line(&error)));
    }
    let main = context
        .global_object()
        .get(js_string!("main"), &mut context)
        .unwrap_or(JsValue::undefined());
    if main.is_callable() {
        None
    } else {
        Some("JS 覆写未定义 main(config) 函数".to_string())
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn main_mutation_lands_in_the_config() {
        let result = run_js_override(
            "function main(config) { config.mode = 'global' }",
            &json!({"mode": "rule"}),
        );
        assert_eq!(result.next, json!({"mode": "global"}));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn returned_object_wins_over_mutation() {
        let result = run_js_override(
            "function main(config) { config.mode = 'global'; return { replaced: true } }",
            &json!({"mode": "rule"}),
        );
        assert_eq!(result.next, json!({"replaced": true}));
    }

    #[test]
    fn console_messages_flow_into_warnings_in_call_order() {
        let result = run_js_override(
            "function main(c) { console.log('a', 1); console.warn('careful'); console.error('bad') }",
            &json!({}),
        );
        assert_eq!(
            result.warnings,
            vec!["a 1".to_string(), "warn: careful".to_string(), "error: bad".to_string()]
        );
    }

    #[test]
    fn a_throwing_body_reports_the_failure_prefix_and_keeps_the_config() {
        let result = run_js_override(
            "function main(c) { throw new Error('boom'); }",
            &json!({"mode": "rule"}),
        );
        assert_eq!(result.next, json!({"mode": "rule"}));
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].starts_with("JS 覆写 main(config) 执行失败："), "{}", result.warnings[0]);
    }

    #[test]
    fn a_syntax_error_reports_the_script_prefix() {
        let result = run_js_override("function main( {{{", &json!({}));
        assert_eq!(result.next, json!({}));
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].starts_with("JS 覆写脚本执行失败："), "{}", result.warnings[0]);
    }

    #[test]
    fn validate_accepts_a_main_definition() {
        assert_eq!(validate_js_override("function main(c) { c.mode = 'global' }"), None);
    }

    #[test]
    fn validate_rejects_a_missing_main() {
        assert_eq!(
            validate_js_override("const x = 1"),
            Some("JS 覆写未定义 main(config) 函数".to_string())
        );
    }

    #[test]
    fn validate_reports_parse_failures() {
        let issue = validate_js_override("function main( {{{").unwrap();
        assert!(issue.starts_with("JS 覆写脚本无法解析："), "{issue}");
    }

    #[test]
    fn a_runaway_loop_is_trapped_by_the_iteration_budget() {
        // The TS bound is the 2000 ms wall-clock; the engine-native equivalent
        // aborts with an error instead of hanging the host.
        let result = run_js_override(
            "function main(c) { let i = 0; while (true) { i++ } }",
            &json!({}),
        );
        assert_eq!(result.next, json!({}));
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].starts_with("JS 覆写 main(config) 执行失败："), "{}", result.warnings[0]);
    }

    #[test]
    fn node_globals_are_not_reachable() {
        let result = run_js_override(
            "function main(c) { c.leaked = typeof require + '|' + typeof process + '|' + typeof global }",
            &json!({}),
        );
        // Node-isms are all unreachable: the sandbox exposes only the standard
        // `globalThis` (ES2020), which carries no Node surface.
        assert_eq!(result.next, json!({"leaked": "undefined|undefined|undefined"}));
    }
}
