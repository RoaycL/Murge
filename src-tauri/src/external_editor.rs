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

/// Write `contents` readable by the owner only (profiles can carry proxy
/// credentials; the repository stores them `0600` too).
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())?;
    file.flush()
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// The stored document a working copy was made from.
const BASE_FILE: &str = ".base";

fn staged_copy(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("yaml")
        })
}

/// Prepare the working copy for profile `id` and return its path, plus
/// whether an earlier copy with unapplied edits was kept.
///
/// A copy is never thrown away with edits in it: one whose edits still apply
/// to the stored document (it has not changed since) is reused as is; when
/// the stored document moved on too (e.g. a subscription update), the old
/// copy is moved to `backup/` and a fresh one is made.
pub(crate) fn stage(
    root: &Path,
    id: &str,
    name: &str,
    document: &str,
) -> Result<(PathBuf, bool), String> {
    let dir = root.join(id);
    create_private_dir(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.yaml", file_stem(name)));
    if let Some(existing) = staged_copy(&dir) {
        let copy = std::fs::read_to_string(&existing).map_err(|error| error.to_string())?;
        let base = std::fs::read_to_string(dir.join(BASE_FILE)).ok();
        let edited = copy != document && base.as_deref() != Some(copy.as_str());
        if edited && base.as_deref() == Some(document) {
            if existing != path {
                std::fs::rename(&existing, &path).map_err(|error| error.to_string())?;
            }
            return Ok((path, true));
        }
        if edited {
            let backup = dir.join("backup");
            create_private_dir(&backup).map_err(|error| error.to_string())?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let stem = existing
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("profile")
                .to_string();
            std::fs::rename(&existing, backup.join(format!("{stem}-{stamp}.yaml")))
                .map_err(|error| error.to_string())?;
        } else {
            std::fs::remove_file(&existing).map_err(|error| error.to_string())?;
        }
    }
    write_private(&dir.join(BASE_FILE), document).map_err(|error| error.to_string())?;
    write_private(&path, document).map_err(|error| error.to_string())?;
    Ok((path, false))
}

/// Record that the working copy of profile `id` was applied: when the copy
/// still holds the `submitted` text, the stored document it became
/// (`stored`) is its new base. Without this, a later broken save in the
/// same copy looked like edits on an outdated base, and reopening the file
/// moved it to `backup/` instead of letting the user fix it in place.
/// A profile with no working copy, or one saved again since, is left alone.
pub(crate) fn note_applied(
    root: &Path,
    id: &str,
    submitted: &str,
    stored: &str,
) -> Result<(), String> {
    let dir = root.join(id);
    let Some(copy) = staged_copy(&dir) else {
        return Ok(());
    };
    match std::fs::read_to_string(&copy) {
        Ok(text) if text == submitted => {
            write_private(&dir.join(BASE_FILE), stored).map_err(|error| error.to_string())
        }
        _ => Ok(()),
    }
}

/// The working copy of profile `id` as the editor last saved it; `None`
/// when there is none (never opened, or removed).
pub(crate) fn read_staged(root: &Path, id: &str) -> Result<Option<String>, String> {
    match staged_copy(&root.join(id)) {
        Some(path) => std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|error| error.to_string()),
        None => Ok(None),
    }
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
    fn working_copy_round_trips_and_keeps_unapplied_edits() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = staging_root(Some(temp.path()));
        assert_eq!(read_staged(&root, "p1").unwrap(), None);
        let (path, kept) = stage(&root, "p1", "机场: 订阅?", "proxies: []\n").unwrap();
        assert!(!kept);
        assert_eq!(path.file_name().unwrap(), "机场_ 订阅_.yaml");
        // An edit not applied yet (e.g. it failed validation) survives a
        // re-open, under the profile's new name too.
        std::fs::write(&path, "proxies: [broken\n").unwrap();
        let (renamed, kept) = stage(&root, "p1", "Home", "proxies: []\n").unwrap();
        assert!(kept);
        assert_eq!(renamed.file_name().unwrap(), "Home.yaml");
        assert!(!path.exists());
        assert_eq!(
            read_staged(&root, "p1").unwrap().as_deref(),
            Some("proxies: [broken\n")
        );
        // The stored document moved on as well: the edit goes to backup/.
        let (fresh, kept) = stage(&root, "p1", "Home", "rules: []\n").unwrap();
        assert!(!kept);
        assert_eq!(
            read_staged(&root, "p1").unwrap().as_deref(),
            Some("rules: []\n")
        );
        let backups: Vec<_> = std::fs::read_dir(root.join("p1").join("backup"))
            .unwrap()
            .flatten()
            .map(|entry| std::fs::read_to_string(entry.path()).unwrap())
            .collect();
        assert_eq!(backups, vec!["proxies: [broken\n".to_string()]);
        // An applied edit (copy == stored) or an untouched copy is just refreshed.
        std::fs::write(&fresh, "rules: [x]\n").unwrap();
        let (_, kept) = stage(&root, "p1", "Home", "rules: [x]\n").unwrap();
        assert!(!kept);
        let (_, kept) = stage(&root, "p1", "Home", "rules: [y]\n").unwrap();
        assert!(!kept);
        assert_eq!(
            read_staged(&root, "p1").unwrap().as_deref(),
            Some("rules: [y]\n")
        );
        assert_eq!(file_stem(" .. "), "profile");
    }

    #[test]
    fn an_applied_edit_becomes_the_base_so_a_later_broken_save_is_kept() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = staging_root(Some(temp.path()));
        let (path, _) = stage(&root, "p1", "Home", "rules: []\n").unwrap();
        // A valid save is applied: the stored document is now that text.
        std::fs::write(&path, "rules: [a]\n").unwrap();
        note_applied(&root, "p1", "rules: [a]\n", "rules: [a]\n").unwrap();
        // Then a broken save that cannot be applied; reopening keeps it in
        // the editor instead of moving it to backup/.
        std::fs::write(&path, "rules: [broken\n").unwrap();
        let (_, kept) = stage(&root, "p1", "Home", "rules: [a]\n").unwrap();
        assert!(kept);
        assert_eq!(
            read_staged(&root, "p1").unwrap().as_deref(),
            Some("rules: [broken\n")
        );
        assert!(!root.join("p1").join("backup").exists());
        // An in-app save that did not come from the copy leaves the base alone.
        note_applied(&root, "p1", "rules: [other]\n", "rules: [other]\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("p1").join(BASE_FILE)).unwrap(),
            "rules: [a]\n"
        );
        // No working copy at all: nothing to do.
        note_applied(&root, "p2", "x", "x").unwrap();
        assert!(!root.join("p2").exists());
    }

    #[cfg(unix)]
    #[test]
    fn working_copy_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::TempDir::new().unwrap();
        let root = staging_root(Some(temp.path()));
        let (path, _) = stage(&root, "p1", "Home", "proxies: []\n").unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&root.join("p1")), 0o700);
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
