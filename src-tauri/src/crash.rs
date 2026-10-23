//! Last-resort panic reporting — the Rust side of Electron's startup
//! `dialog.showErrorBox`. A release build has no console, so a panic would
//! otherwise end the app without a trace: every panic goes to the app log,
//! and one on the main thread (startup, the event loop) also gets a dialog,
//! because the app exits right after it.

/// Install once, first thing in `run()`.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        let message = panic_message(info.payload());
        let location = info
            .location()
            .map(|location| format!(" at {}:{}", location.file(), location.line()))
            .unwrap_or_default();
        crate::file_log::diagnostic(&format!(
            "[panic] thread '{thread_name}' panicked{location}: {message}"
        ));
        // A worker-thread panic ends that task, not the app: log it only.
        if thread_name == "main" && tokio::runtime::Handle::try_current().is_err() {
            crate::file_log::flush_diagnostics_blocking();
            show_fatal_dialog(&message);
        }
    }));
}

pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown error".to_string())
}

fn show_fatal_dialog(message: &str) {
    let product = crate::brand::load_brand()
        .map(|brand| brand.product_name)
        .unwrap_or_else(|_| "Murge".to_string());
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(product.as_str())
        .set_description(format!(
            "{product} 遇到意外错误，即将退出。\n\n{message}\n\n详细信息已写入应用日志。"
        ))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_payloads_read_as_text() {
        let literal: Box<dyn std::any::Any + Send> = Box::new("invalid brand.config.json");
        assert_eq!(panic_message(literal.as_ref()), "invalid brand.config.json");
        let formatted: Box<dyn std::any::Any + Send> = Box::new(format!("code {}", 7));
        assert_eq!(panic_message(formatted.as_ref()), "code 7");
        let other: Box<dyn std::any::Any + Send> = Box::new(7_u8);
        assert_eq!(panic_message(other.as_ref()), "unknown error");
    }
}
