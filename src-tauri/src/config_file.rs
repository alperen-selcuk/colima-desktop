//! Machine configuration editor backend (§6.4): reads and writes a
//! profile's raw `colima.yaml` text so the frontend can edit it with a form
//! while preserving comments and unknown keys (the actual YAML parsing for
//! that purpose lives in the frontend's `colimaConfig.ts`, which uses a
//! comment-preserving YAML document model; this module only deals with
//! finding the right file, validating it parses as a mapping, and writing
//! it back safely).

use crate::colima::colima_home;
use crate::validate::validate_profile_name;
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;

/// Upstream Colima's default `colima.yaml`, fully commented, embedded as the
/// last-resort fallback source when neither a profile's own config nor a
/// user template exist yet. See `resources/colima-default.yaml` for
/// attribution.
const BUILTIN_DEFAULT_YAML: &str = include_str!("../resources/colima-default.yaml");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigSource {
    Profile,
    Template,
    Builtin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfigRaw {
    pub content: String,
    pub source: ConfigSource,
    pub path: String,
    pub exists: bool,
}

/// The profile's own config file path: `<home>/<profile>/colima.yaml`.
fn profile_config_path_at(home: &std::path::Path, profile: &str) -> PathBuf {
    home.join(profile).join("colima.yaml")
}

/// The user template path: `<home>/_templates/default.yaml` (what `colima
/// template` edits).
fn template_path_at(home: &std::path::Path) -> PathBuf {
    home.join("_templates").join("default.yaml")
}

/// `profile_config_raw`: return the raw YAML text to seed the configuration
/// editor with, per the precedence in §6.4: the profile's own file, else the
/// user template, else the embedded upstream default. `path` is always the
/// profile's own file path (i.e. where a save will land), and `exists`
/// reflects whether that profile file currently exists on disk.
fn profile_config_raw_at(home: &std::path::Path, profile: &str) -> Result<ProfileConfigRaw, String> {
    validate_profile_name(profile)?;
    let path = profile_config_path_at(home, profile);

    if let Ok(content) = std::fs::read_to_string(&path) {
        return Ok(ProfileConfigRaw {
            content,
            source: ConfigSource::Profile,
            path: path.display().to_string(),
            exists: true,
        });
    }

    if let Ok(content) = std::fs::read_to_string(template_path_at(home)) {
        if !content.trim().is_empty() {
            return Ok(ProfileConfigRaw {
                content,
                source: ConfigSource::Template,
                path: path.display().to_string(),
                exists: false,
            });
        }
    }

    Ok(ProfileConfigRaw {
        content: BUILTIN_DEFAULT_YAML.to_string(),
        source: ConfigSource::Builtin,
        path: path.display().to_string(),
        exists: false,
    })
}

#[tauri::command]
pub async fn profile_config_raw(profile: String) -> Result<ProfileConfigRaw, String> {
    profile_config_raw_at(&colima_home(), &profile)
}

/// Validate that `content` parses as YAML and that the top-level value is a
/// mapping (object), which is what colima.yaml must be.
fn validate_yaml_mapping(content: &str) -> Result<(), String> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(content).map_err(|e| format!("invalid YAML: {e}"))?;
    match value {
        serde_yaml::Value::Mapping(_) => Ok(()),
        serde_yaml::Value::Null => Ok(()), // empty file: treated as an empty mapping
        _ => Err("invalid YAML: top-level document must be a mapping".to_string()),
    }
}

/// `save_profile_config_raw`: validate `content`, back up the existing file
/// (if any) to `colima.yaml.bak`, and write the new content atomically
/// (temp file in the same directory, then rename).
fn save_profile_config_raw_at(home: &std::path::Path, profile: &str, content: &str) -> Result<(), String> {
    validate_profile_name(profile)?;
    validate_yaml_mapping(content)?;

    let path = profile_config_path_at(home, profile);
    let dir = path
        .parent()
        .ok_or_else(|| "invalid profile path".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create profile directory: {e}"))?;

    if path.exists() {
        let backup = dir.join("colima.yaml.bak");
        std::fs::copy(&path, &backup).map_err(|e| format!("failed to back up existing config: {e}"))?;
    }

    write_atomically(&path, content)
}

#[tauri::command]
pub async fn save_profile_config_raw(profile: String, content: String) -> Result<(), String> {
    save_profile_config_raw_at(&colima_home(), &profile, &content)
}

/// Write `content` to `path` atomically: write to a temp file in the same
/// directory, flush+sync, then rename over the destination. Leaves no temp
/// file behind on success, and cleans it up on failure too.
fn write_atomically(path: &std::path::Path, content: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "invalid profile path".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "invalid profile path".to_string())?
        .to_string_lossy();
    let tmp_path = dir.join(format!(".{file_name}.tmp-{}", std::process::id()));

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("failed to write config: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("failed to write config: {e}"))?;
        file.sync_all().map_err(|e| format!("failed to write config: {e}"))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to write config: {e}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private temp directory used directly as the injected `home` for the
    /// `_at` functions under test. No process env var is ever touched, so
    /// these tests can run concurrently with anything else in the suite
    /// (including other modules' tests) without any locking.
    struct TempDir {
        dir: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "colima-desktop-test-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir { dir }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn source_precedence_prefers_profile_file() {
        let home = TempDir::new("precedence-profile");
        let profile_dir = home.dir.join("default");
        std::fs::create_dir_all(&profile_dir).unwrap();
        std::fs::write(profile_dir.join("colima.yaml"), "cpu: 9\n").unwrap();
        std::fs::create_dir_all(home.dir.join("_templates")).unwrap();
        std::fs::write(home.dir.join("_templates").join("default.yaml"), "cpu: 5\n").unwrap();

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Profile);
        assert!(result.exists);
        assert!(result.content.contains("cpu: 9"));
    }

    #[test]
    fn source_precedence_falls_back_to_template() {
        let home = TempDir::new("precedence-template");
        std::fs::create_dir_all(home.dir.join("_templates")).unwrap();
        std::fs::write(home.dir.join("_templates").join("default.yaml"), "cpu: 5\n").unwrap();

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Template);
        assert!(!result.exists);
        assert!(result.content.contains("cpu: 5"));
    }

    #[test]
    fn source_precedence_falls_back_to_builtin() {
        let home = TempDir::new("precedence-builtin");

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Builtin);
        assert!(!result.exists);
        assert!(result.content.contains("Colima is Copyright"));
        assert!(result.content.contains("cpu: 2"));
    }

    #[test]
    fn source_precedence_ignores_empty_template() {
        let home = TempDir::new("precedence-empty-template");
        std::fs::create_dir_all(home.dir.join("_templates")).unwrap();
        std::fs::write(home.dir.join("_templates").join("default.yaml"), "").unwrap();

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Builtin);
    }

    #[test]
    fn save_rejects_invalid_profile_name() {
        let home = TempDir::new("invalid-profile-name");
        let result = save_profile_config_raw_at(&home.dir, "../evil", "cpu: 2\n");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid profile name"));
    }

    #[test]
    fn save_rejects_invalid_yaml() {
        let home = TempDir::new("invalid-yaml");
        let result = save_profile_config_raw_at(&home.dir, "default", "cpu: [1, 2\n");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid YAML"));
    }

    #[test]
    fn save_rejects_non_mapping_yaml() {
        let home = TempDir::new("non-mapping-yaml");
        let result = save_profile_config_raw_at(&home.dir, "default", "- 1\n- 2\n");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mapping"));
    }

    #[test]
    fn save_creates_backup_of_existing_file() {
        let home = TempDir::new("backup");
        let profile_dir = home.dir.join("default");
        std::fs::create_dir_all(&profile_dir).unwrap();
        std::fs::write(profile_dir.join("colima.yaml"), "cpu: 1\n").unwrap();

        save_profile_config_raw_at(&home.dir, "default", "cpu: 2\n").unwrap();

        let backup = std::fs::read_to_string(profile_dir.join("colima.yaml.bak")).unwrap();
        assert_eq!(backup, "cpu: 1\n");
        let current = std::fs::read_to_string(profile_dir.join("colima.yaml")).unwrap();
        assert_eq!(current, "cpu: 2\n");
    }

    #[test]
    fn save_creates_profile_dir_if_missing() {
        let home = TempDir::new("create-dir");
        save_profile_config_raw_at(&home.dir, "brandnew", "cpu: 4\n").unwrap();
        let content = std::fs::read_to_string(home.dir.join("brandnew").join("colima.yaml")).unwrap();
        assert_eq!(content, "cpu: 4\n");
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let home = TempDir::new("atomic");
        let profile_dir = home.dir.join("default");
        std::fs::create_dir_all(&profile_dir).unwrap();

        save_profile_config_raw_at(&home.dir, "default", "cpu: 7\n").unwrap();

        let entries: Vec<_> = std::fs::read_dir(&profile_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["colima.yaml".to_string()]);
    }

    #[test]
    fn validate_yaml_mapping_accepts_mapping_and_empty() {
        assert!(validate_yaml_mapping("cpu: 2\n").is_ok());
        assert!(validate_yaml_mapping("").is_ok());
    }

    #[test]
    fn validate_yaml_mapping_rejects_scalar_and_sequence() {
        assert!(validate_yaml_mapping("just a string").is_err());
        assert!(validate_yaml_mapping("- 1\n- 2\n").is_err());
    }

    /// Real read-only smoke test against this machine's actual `~/.colima`
    /// files (colima 0.8.1, profile `default`). Ignored by default: run
    /// explicitly with `cargo test -- --ignored config_file::tests::smoke`.
    /// Never writes to `~/.colima` and never starts/stops colima.
    #[tokio::test]
    #[ignore]
    async fn smoke_reads_real_colima_home() {
        let result = profile_config_raw("default".to_string()).await.unwrap();
        assert!(result.exists, "expected ~/.colima/default/colima.yaml to exist on this machine");
        assert_eq!(result.source, ConfigSource::Profile);
        assert!(result.path.ends_with("default/colima.yaml"));
        // Must parse as a mapping, same rule enforced on save.
        validate_yaml_mapping(&result.content).expect("real colima.yaml should be a valid mapping");
        println!("real profile_config_raw: source={:?} path={} exists={} len={}",
            result.source, result.path, result.exists, result.content.len());
    }
}
