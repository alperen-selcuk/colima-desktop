//! k3s version picker backend (docs/SPEC.md §6.5): fetches the list of k3s
//! releases from GitHub, caches it on disk for 24h, and parses colima's own
//! `--kubernetes-version` default out of `colima start --help`. All the
//! parsing/sorting/filtering logic is kept as pure, synchronous, unit-tested
//! functions; only the outermost `k3s_versions` command touches the network,
//! the filesystem cache, or spawns `colima`.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/k3s-io/k3s/releases";
const USER_AGENT: &str = "colima-desktop";
const CACHE_FILE_NAME: &str = "k3s-versions.json";
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// One k3s release, as surfaced to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K3sVersion {
    pub version: String,
    /// "1.31" style minor-version key, derived from `version`.
    pub minor: String,
    pub published_at: Option<String>,
    pub latest_in_minor: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionSource {
    Github,
    Cache,
    Builtin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K3sVersionsResponse {
    pub versions: Vec<K3sVersion>,
    pub colima_default: Option<String>,
    pub source: VersionSource,
    pub fetched_at: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure parsing / sorting / grouping helpers
// ---------------------------------------------------------------------------

/// A parsed `vMAJOR.MINOR.PATCH+k3sN` tag, ordered so that semver-desc sort
/// (by major, minor, patch, then k3s suffix) falls out of `Ord`/`sort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SemverKey {
    major: u32,
    minor: u32,
    patch: u32,
    k3s: u32,
}

/// Matches exactly `^v\d+\.\d+\.\d+\+k3s\d+$` and extracts the four numeric
/// components. No regex crate dependency needed for a pattern this simple.
fn parse_tag(tag: &str) -> Option<SemverKey> {
    let rest = tag.strip_prefix('v')?;
    let (version_part, k3s_part) = rest.split_once("+k3s")?;
    if k3s_part.is_empty() || !k3s_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut parts = version_part.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if parts.next().is_some() {
        return None; // extra dot-separated component
    }
    if major.is_empty() || minor.is_empty() || patch.is_empty() {
        return None;
    }
    if !major.bytes().all(|b| b.is_ascii_digit())
        || !minor.bytes().all(|b| b.is_ascii_digit())
        || !patch.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some(SemverKey {
        major: major.parse().ok()?,
        minor: minor.parse().ok()?,
        patch: patch.parse().ok()?,
        k3s: k3s_part.parse().ok()?,
    })
}

/// Whether `tag` matches the strict k3s version format
/// `^v\d+\.\d+\.\d+\+k3s\d+$`. Exposed for both the picker's filter and the
/// (mirrored) frontend/backend format validation.
pub fn is_valid_k3s_version_format(tag: &str) -> bool {
    parse_tag(tag).is_some()
}

/// A tag plus its optional publish timestamp, as fetched from GitHub — the
/// minimal shape the pure helpers below operate on (kept separate from the
/// GitHub JSON response shape so they're testable without any HTTP types).
#[derive(Debug, Clone)]
pub struct RawTag {
    pub tag_name: String,
    pub published_at: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
}

/// Filter to non-draft, non-prerelease tags matching the strict k3s version
/// format, discarding anything else (malformed tags, drafts, prereleases).
pub fn filter_valid_tags(tags: &[RawTag]) -> Vec<RawTag> {
    tags.iter()
        .filter(|t| !t.draft && !t.prerelease && is_valid_k3s_version_format(&t.tag_name))
        .cloned()
        .collect()
}

/// Sort tags by parsed semver, descending (newest first). Tags that somehow
/// don't parse (shouldn't happen after `filter_valid_tags`) sort last.
pub fn sort_semver_desc(tags: &mut [RawTag]) {
    tags.sort_by(|a, b| {
        let ka = parse_tag(&a.tag_name);
        let kb = parse_tag(&b.tag_name);
        match (ka, kb) {
            (Some(ka), Some(kb)) => kb.cmp(&ka),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
}

/// Build the final `K3sVersion` list from a semver-desc-sorted, filtered tag
/// list: derives `minor`, and marks `latestInMinor` on the first (i.e.
/// newest) tag seen for each `major.minor` key.
pub fn build_versions(sorted_tags: &[RawTag]) -> Vec<K3sVersion> {
    let mut seen_minors: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(sorted_tags.len());
    for tag in sorted_tags {
        let Some(key) = parse_tag(&tag.tag_name) else { continue };
        let minor_key = (key.major, key.minor);
        let latest_in_minor = seen_minors.insert(minor_key);
        out.push(K3sVersion {
            version: tag.tag_name.clone(),
            minor: format!("{}.{}", key.major, key.minor),
            published_at: tag.published_at.clone(),
            latest_in_minor,
        });
    }
    out
}

/// Parse colima's own default k3s version out of `colima start --help`
/// output, e.g. the line:
/// ```text
///       --kubernetes-version string   must match a k3s version https://github.com/k3s-io/k3s/releases (default "v1.31.2+k3s1")
/// ```
pub fn parse_colima_default_version(help_text: &str) -> Option<String> {
    let line = help_text.lines().find(|l| l.contains("--kubernetes-version"))?;
    let marker = "default \"";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Cache freshness: `now - cached_at < 24h`. Takes `now`/`cached_at` as
/// explicit params (rather than reading the clock) so tests can inject both.
pub fn cache_is_fresh(now: std::time::SystemTime, cached_at: std::time::SystemTime) -> bool {
    match now.duration_since(cached_at) {
        Ok(age) => age < CACHE_TTL,
        Err(_) => true, // cached_at is in the future (clock skew) — treat as fresh
    }
}

// ---------------------------------------------------------------------------
// Builtin fallback list — latest patch per k3s minor >= 1.28 as of the last
// time this list was refreshed against the real GitHub API (2026-09-27).
// Used when both the network fetch and the on-disk cache are unavailable.
// ---------------------------------------------------------------------------

pub const BUILTIN_VERSIONS: &[(&str, &str)] = &[
    // (version, published_at)
    ("v1.37.0+k3s1", "2026-09-14T15:50:04Z"),
    ("v1.36.4+k3s1", "2026-08-27T15:53:55Z"),
    ("v1.35.8+k3s1", "2026-08-27T15:06:43Z"),
    ("v1.34.11+k3s1", "2026-08-27T15:06:09Z"),
    ("v1.33.13+k3s2", "2026-08-04T19:40:10Z"),
    ("v1.32.13+k3s1", "2026-03-04T18:38:59Z"),
    ("v1.31.14+k3s1", "2025-11-20T21:45:20Z"),
    ("v1.30.14+k3s2", "2025-07-26T02:07:02Z"),
    ("v1.29.15+k3s1", "2025-03-25T22:09:59Z"),
    ("v1.28.15+k3s1", "2024-10-26T01:18:18Z"),
];

fn builtin_versions() -> Vec<K3sVersion> {
    let tags: Vec<RawTag> = BUILTIN_VERSIONS
        .iter()
        .map(|(tag, published_at)| RawTag {
            tag_name: tag.to_string(),
            published_at: Some(published_at.to_string()),
            draft: false,
            prerelease: false,
        })
        .collect();
    // Already newest-first and one-per-minor by construction, but run through
    // the same pipeline so behavior (minor/latestInMinor derivation) matches
    // exactly what a live fetch would produce.
    let mut tags = filter_valid_tags(&tags);
    sort_semver_desc(&mut tags);
    build_versions(&tags)
}

// ---------------------------------------------------------------------------
// GitHub API response shape + on-disk cache shape
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct DiskCache {
    fetched_at_unix: u64,
    versions: Vec<K3sVersion>,
}

async fn fetch_github_releases() -> Result<Vec<RawTag>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let mut all = Vec::new();
    for page in 1..=2u32 {
        let url = format!("{GITHUB_RELEASES_URL}?per_page=100&page={page}");
        let resp = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("GitHub API returned {}", resp.status()));
        }
        let releases: Vec<GithubRelease> = resp.json().await.map_err(|e| e.to_string())?;
        if releases.is_empty() {
            break;
        }
        all.extend(releases.into_iter().map(|r| RawTag {
            tag_name: r.tag_name,
            published_at: r.published_at,
            draft: r.draft,
            prerelease: r.prerelease,
        }));
    }
    Ok(all)
}

fn cache_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join(CACHE_FILE_NAME))
}

fn read_cache(app: &AppHandle) -> Option<(Vec<K3sVersion>, std::time::SystemTime)> {
    let path = cache_path(app)?;
    let content = std::fs::read_to_string(path).ok()?;
    let cache: DiskCache = serde_json::from_str(&content).ok()?;
    let at = std::time::UNIX_EPOCH + Duration::from_secs(cache.fetched_at_unix);
    Some((cache.versions, at))
}

fn write_cache(app: &AppHandle, versions: &[K3sVersion]) {
    let Some(path) = cache_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fetched_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cache = DiskCache { fetched_at_unix, versions: versions.to_vec() };
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = std::fs::write(path, json);
    }
}

fn system_time_to_iso(t: std::time::SystemTime) -> String {
    let unix = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Minimal RFC3339 formatting without pulling in a datetime crate: this is
    // only used for the fetchedAt display string.
    humantime_rfc3339(unix)
}

/// Format a unix timestamp as `YYYY-MM-DDTHH:MM:SSZ` without a datetime
/// dependency (Howard Hinnant's days-since-epoch civil calendar algorithm,
/// UTC only).
fn humantime_rfc3339(unix: u64) -> String {
    let days = unix / 86400;
    let secs_of_day = unix % 86400;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year_of_era = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year_of_era + 1 } else { year_of_era };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[tauri::command]
pub async fn k3s_versions(app: AppHandle, force_refresh: bool) -> Result<K3sVersionsResponse, String> {
    let cached = read_cache(&app);
    let now = std::time::SystemTime::now();

    if !force_refresh {
        if let Some((versions, cached_at)) = &cached {
            if cache_is_fresh(now, *cached_at) {
                let colima_default = colima_default_version().await;
                return Ok(K3sVersionsResponse {
                    versions: versions.clone(),
                    colima_default,
                    source: VersionSource::Cache,
                    fetched_at: Some(system_time_to_iso(*cached_at)),
                    error: None,
                });
            }
        }
    }

    match fetch_github_releases().await {
        Ok(raw_tags) => {
            let mut tags = filter_valid_tags(&raw_tags);
            sort_semver_desc(&mut tags);
            let versions = build_versions(&tags);
            write_cache(&app, &versions);
            let colima_default = colima_default_version().await;
            Ok(K3sVersionsResponse {
                versions,
                colima_default,
                source: VersionSource::Github,
                fetched_at: Some(system_time_to_iso(now)),
                error: None,
            })
        }
        Err(fetch_err) => {
            let colima_default = colima_default_version().await;
            // Serve stale cache on network error, if we have one.
            if let Some((versions, cached_at)) = cached {
                return Ok(K3sVersionsResponse {
                    versions,
                    colima_default,
                    source: VersionSource::Cache,
                    fetched_at: Some(system_time_to_iso(cached_at)),
                    error: Some(fetch_err),
                });
            }
            // No cache either: fall back to the embedded builtin list.
            Ok(K3sVersionsResponse {
                versions: builtin_versions(),
                colima_default,
                source: VersionSource::Builtin,
                fetched_at: None,
                error: Some(fetch_err),
            })
        }
    }
}

/// Run `colima start --help` and parse the `--kubernetes-version` default,
/// caching the result for the lifetime of the process (the flag's default
/// only changes across a colima binary upgrade, which requires an app
/// restart to pick up here anyway).
async fn colima_default_version() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    if let Some(cached) = CACHE.get() {
        return cached.clone();
    }
    let result = crate::exec::run("colima", &["start", "--help"])
        .await
        .ok()
        .and_then(|help| parse_colima_default_version(&help));
    let _ = CACHE.set(result.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(s: &str) -> RawTag {
        RawTag { tag_name: s.to_string(), published_at: None, draft: false, prerelease: false }
    }

    // --- parse_tag / is_valid_k3s_version_format ---------------------------

    #[test]
    fn valid_tag_parses() {
        assert!(is_valid_k3s_version_format("v1.31.2+k3s1"));
        assert!(is_valid_k3s_version_format("v1.30.0+k3s10"));
    }

    #[test]
    fn rejects_missing_k3s_suffix() {
        assert!(!is_valid_k3s_version_format("v1.31.2"));
    }

    #[test]
    fn rejects_missing_v_prefix() {
        assert!(!is_valid_k3s_version_format("1.31.2+k3s1"));
    }

    #[test]
    fn rejects_non_numeric_k3s_suffix() {
        assert!(!is_valid_k3s_version_format("v1.31.2+k3sX"));
    }

    #[test]
    fn rejects_extra_version_component() {
        assert!(!is_valid_k3s_version_format("v1.31.2.3+k3s1"));
    }

    #[test]
    fn rejects_prerelease_style_suffix() {
        assert!(!is_valid_k3s_version_format("v1.31.2-rc1+k3s1"));
    }

    #[test]
    fn rejects_empty_and_garbage() {
        assert!(!is_valid_k3s_version_format(""));
        assert!(!is_valid_k3s_version_format("not-a-version"));
        assert!(!is_valid_k3s_version_format("v1..2+k3s1"));
    }

    // --- filter_valid_tags --------------------------------------------------

    #[test]
    fn filter_drops_drafts_and_prereleases() {
        let tags = vec![
            tag("v1.31.2+k3s1"),
            RawTag { draft: true, ..tag("v1.32.0+k3s1") },
            RawTag { prerelease: true, ..tag("v1.33.0-rc1+k3s1") },
        ];
        let filtered = filter_valid_tags(&tags);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].tag_name, "v1.31.2+k3s1");
    }

    #[test]
    fn filter_drops_malformed_tags() {
        let tags = vec![tag("v1.31.2+k3s1"), tag("latest"), tag("v1.31.2")];
        let filtered = filter_valid_tags(&tags);
        assert_eq!(filtered.len(), 1);
    }

    // --- sort_semver_desc ----------------------------------------------------

    #[test]
    fn sorts_by_major_minor_patch_k3s_descending() {
        let mut tags = vec![
            tag("v1.30.0+k3s1"),
            tag("v1.31.2+k3s1"),
            tag("v1.31.2+k3s2"),
            tag("v1.31.10+k3s1"),
            tag("v1.9.0+k3s1"),
        ];
        sort_semver_desc(&mut tags);
        let names: Vec<&str> = tags.iter().map(|t| t.tag_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["v1.31.10+k3s1", "v1.31.2+k3s2", "v1.31.2+k3s1", "v1.30.0+k3s1", "v1.9.0+k3s1"]
        );
    }

    #[test]
    fn numeric_sort_not_lexicographic() {
        // v1.9 must sort BELOW v1.31 (numeric), not above it (lexicographic).
        let mut tags = vec![tag("v1.9.0+k3s1"), tag("v1.31.0+k3s1")];
        sort_semver_desc(&mut tags);
        assert_eq!(tags[0].tag_name, "v1.31.0+k3s1");
    }

    // --- build_versions / latestInMinor -------------------------------------

    #[test]
    fn marks_first_seen_per_minor_as_latest() {
        let mut tags = vec![
            tag("v1.31.2+k3s1"),
            tag("v1.31.1+k3s1"),
            tag("v1.30.5+k3s1"),
            tag("v1.30.4+k3s1"),
        ];
        sort_semver_desc(&mut tags);
        let versions = build_versions(&tags);
        assert_eq!(versions.len(), 4);
        assert_eq!(versions[0].version, "v1.31.2+k3s1");
        assert!(versions[0].latest_in_minor);
        assert_eq!(versions[1].version, "v1.31.1+k3s1");
        assert!(!versions[1].latest_in_minor);
        assert_eq!(versions[2].version, "v1.30.5+k3s1");
        assert!(versions[2].latest_in_minor);
        assert_eq!(versions[3].version, "v1.30.4+k3s1");
        assert!(!versions[3].latest_in_minor);
    }

    #[test]
    fn derives_minor_string() {
        let tags = vec![tag("v1.31.2+k3s1")];
        let versions = build_versions(&tags);
        assert_eq!(versions[0].minor, "1.31");
    }

    // --- parse_colima_default_version --------------------------------------

    #[test]
    fn parses_real_colima_help_line() {
        let help = "      --kubernetes-version string   must match a k3s version https://github.com/k3s-io/k3s/releases (default \"v1.31.2+k3s1\")";
        assert_eq!(parse_colima_default_version(help), Some("v1.31.2+k3s1".to_string()));
    }

    #[test]
    fn parses_default_from_full_help_text() {
        let help = "Usage:\n  colima start [flags]\n\nFlags:\n      --cpu int   number of CPUs (default 2)\n      --kubernetes-version string   must match a k3s version https://github.com/k3s-io/k3s/releases (default \"v1.30.0+k3s1\")\n      --memory int   memory in GiB (default 2)\n";
        assert_eq!(parse_colima_default_version(help), Some("v1.30.0+k3s1".to_string()));
    }

    #[test]
    fn returns_none_when_flag_absent() {
        let help = "Usage:\n  colima start [flags]\n\nFlags:\n      --cpu int   number of CPUs (default 2)\n";
        assert_eq!(parse_colima_default_version(help), None);
    }

    // --- cache_is_fresh ------------------------------------------------------

    #[test]
    fn cache_fresh_within_24h() {
        let now = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let cached_at = now - Duration::from_secs(60 * 60); // 1h ago
        assert!(cache_is_fresh(now, cached_at));
    }

    #[test]
    fn cache_stale_after_24h() {
        let now = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let cached_at = now - Duration::from_secs(25 * 60 * 60); // 25h ago
        assert!(!cache_is_fresh(now, cached_at));
    }

    #[test]
    fn cache_exactly_at_boundary_is_stale() {
        let now = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let cached_at = now - CACHE_TTL;
        assert!(!cache_is_fresh(now, cached_at));
    }

    // --- builtin_versions ----------------------------------------------------

    #[test]
    fn builtin_versions_are_all_valid_and_sorted() {
        let versions = builtin_versions();
        assert!(!versions.is_empty());
        for w in versions.windows(2) {
            let a = parse_tag(&w[0].version).unwrap();
            let b = parse_tag(&w[1].version).unwrap();
            assert!(b <= a, "builtin list must be sorted descending: {} then {}", w[0].version, w[1].version);
        }
        // Every minor >= 1.28 in the const table should appear exactly once
        // (each entry is already the latest patch for its minor).
        assert_eq!(versions.len(), BUILTIN_VERSIONS.len());
        assert!(versions.iter().all(|v| v.latest_in_minor));
    }

    #[test]
    fn builtin_versions_cover_minor_1_28_and_up() {
        let versions = builtin_versions();
        assert!(versions.iter().any(|v| v.minor == "1.28"));
        assert!(versions.iter().all(|v| {
            let (maj, min) = v.minor.split_once('.').unwrap();
            maj.parse::<u32>().unwrap() > 1 || min.parse::<u32>().unwrap() >= 28
        }));
    }
}

#[cfg(test)]
mod smoke_tests {
    use super::*;

    /// Real network smoke test against the actual GitHub API and this
    /// machine's actual `colima start --help`. Ignored by default: run
    /// explicitly with `cargo test -- --ignored k3s::smoke_tests`.
    #[tokio::test]
    #[ignore]
    async fn smoke_fetches_real_github_releases_and_colima_default() {
        let tags = fetch_github_releases().await.expect("github fetch should succeed");
        assert!(!tags.is_empty(), "expected at least one release from GitHub");

        let mut filtered = filter_valid_tags(&tags);
        sort_semver_desc(&mut filtered);
        let versions = build_versions(&filtered);
        assert!(!versions.is_empty());

        println!("first 5 real k3s versions fetched from GitHub:");
        for v in versions.iter().take(5) {
            println!("  {} (minor {}, publishedAt {:?}, latestInMinor {})", v.version, v.minor, v.published_at, v.latest_in_minor);
        }

        let colima_default = colima_default_version().await;
        println!("parsed colima default from real `colima start --help`: {colima_default:?}");
    }
}
