//! 打开文件: hand a profile's YAML to the user's own editor — the program
//! chosen in 通用 · 配置文件编辑器, or the system default app for the file.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::i18n::{t, tf};

/// Where working copies live: `<appData>/profile-edits/<id>/<name>.yaml`
/// (the system temp folder in dev, which keeps no app data).
pub(crate) fn staging_root(app_data_root: Option<&Path>) -> PathBuf {
    app_data_root
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir)
        .join("profile-edits")
}

/// A file name the editor can show: the profile name without characters
/// Windows refuses, never empty.
fn file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "profile".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Write a fresh working copy of `document` for profile `id` (replacing any
/// earlier one) and return its path.
pub(crate) fn stage(root: &Path, id: &str, name: &str, document: &str) -> Result<PathBuf, String> {
    let dir = root.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.yaml", file_stem(name)));
    std::fs::write(&path, document).map_err(|error| error.to_string())?;
    Ok(path)
}

/// The working copy of profile `id` as the editor last saved it; `None`
/// when there is none (never opened, or removed).
pub(crate) fn read_staged(root: &Path, id: &str) -> Result<Option<String>, String> {
    let dir = root.join(id);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("yaml") {
            return std::fs::read_to_string(&path)
                .map(Some)
                .map_err(|error| error.to_string());
        }
    }
    Ok(None)
}

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
    fn working_copy_round_trips_and_restaging_replaces_it() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = staging_root(Some(temp.path()));
        assert_eq!(read_staged(&root, "p1").unwrap(), None);
        let path = stage(&root, "p1", "机场: 订阅?", "proxies: []\n").unwrap();
        assert_eq!(path.file_name().unwrap(), "机场_ 订阅_.yaml");
        std::fs::write(&path, "proxies: [a]\n").unwrap();
        assert_eq!(
            read_staged(&root, "p1").unwrap().as_deref(),
            Some("proxies: [a]\n")
        );
        // Re-opening (e.g. after a rename) starts from the stored document.
        let renamed = stage(&root, "p1", "Home", "rules: []\n").unwrap();
        assert_eq!(renamed.file_name().unwrap(), "Home.yaml");
        assert!(!path.exists());
        assert_eq!(
            read_staged(&root, "p1").unwrap().as_deref(),
            Some("rules: []\n")
        );
        assert_eq!(file_stem(" .. "), "profile");
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
