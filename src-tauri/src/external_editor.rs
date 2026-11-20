//! 打开文件: hand a profile's YAML to the user's own editor — the program
//! chosen in 通用 · 配置文件编辑器, or the system default app for the file.

use std::path::Path;
use std::process::Command;

use crate::i18n::{t, tf};

/// Windows script launchers would flash a console window; programs (and
/// every other platform) start as they are.
fn is_script(editor: &Path) -> bool {
    editor
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false)
}

/// The command that opens `file`: `editor file`, or the platform's
/// "open with the default app" (Explorer asks which app to use when none is
/// associated with `.yaml`).
pub(crate) fn command_for(file: &Path, editor: &str) -> Command {
    let editor = editor.trim();
    if !editor.is_empty() {
        let mut command = Command::new(editor);
        command.arg(file);
        #[cfg(windows)]
        if is_script(Path::new(editor)) {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(windows))]
        let _ = is_script;
        return command;
    }
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    let mut command = Command::new(program);
    command.arg(file);
    command
}

/// Open `file` with `editor` (empty = system default). The editor runs on
/// its own; only a failure to start it is reported.
pub(crate) fn open(file: &Path, editor: &str) -> Result<(), String> {
    if !file.is_file() {
        return Err(tf("editor.fileMissing", &[&file.display().to_string()]));
    }
    let editor = editor.trim();
    if !editor.is_empty() && !Path::new(editor).is_file() {
        return Err(tf("editor.missing", &[editor]));
    }
    command_for(file, editor)
        .spawn()
        .map(|_| ())
        .map_err(|error| tf("editor.launchFailed", &[&error.to_string()]))
}

/// Native picker for the editor program; `None` when the user cancels.
pub(crate) async fn pick() -> Option<String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(t("editor.pickTitle"));
    if cfg!(windows) {
        dialog = dialog.add_filter(t("editor.programs"), &["exe", "cmd", "bat"]);
    }
    dialog
        .pick_file()
        .await
        .map(|handle| handle.path().to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chosen_editor_gets_the_file_as_its_only_argument() {
        let command = command_for(Path::new("/data/profiles/a.yaml"), " /usr/bin/code ");
        assert_eq!(command.get_program(), "/usr/bin/code");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec!["/data/profiles/a.yaml"]);
    }

    #[test]
    fn no_editor_uses_the_system_default_app() {
        let command = command_for(Path::new("/data/profiles/a.yaml"), "");
        let expected = if cfg!(windows) {
            "explorer"
        } else if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        assert_eq!(command.get_program(), expected);
    }

    #[test]
    fn script_launchers_are_detected_case_insensitively() {
        assert!(is_script(Path::new("C:/Tools/code.CMD")));
        assert!(is_script(Path::new("edit.bat")));
        assert!(!is_script(Path::new("Code.exe")));
    }

    #[test]
    fn missing_file_or_editor_is_reported_before_spawning() {
        let temp = tempfile::TempDir::new().unwrap();
        let missing = temp.path().join("gone.yaml");
        assert!(open(&missing, "").is_err());
        let file = temp.path().join("a.yaml");
        std::fs::write(&file, "proxies: []\n").unwrap();
        let error = open(&file, &temp.path().join("no-editor").to_string_lossy()).unwrap_err();
        assert!(error.contains("no-editor"));
    }
}
