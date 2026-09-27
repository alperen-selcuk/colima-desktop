//! Shared managed state: per-profile lifecycle locks, docker socket cache,
//! the log-stream registry, and the PTY terminal session registry.

use crate::kubeconfig::KubeconfigState;
use crate::pty::Session as PtySession;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::process::Child;

/// Tracks profiles with a lifecycle operation (start/stop/restart/delete/
/// kubernetes) currently in flight, and caches resolved docker sockets.
#[derive(Default)]
pub struct AppState {
    busy: Mutex<HashSet<String>>,
    docker_sockets: Mutex<HashMap<String, (String, Instant)>>,
    pub log_streams: Mutex<HashMap<String, Child>>,
    pub pty_sessions: Mutex<HashMap<String, PtySession>>,
    /// Per-session "fresh" flags for the app-managed kubeconfig (§2.1a).
    pub kubeconfig: KubeconfigState,
}

/// 30s cache TTL for resolved docker sockets, per §2.2.
const SOCKET_CACHE_TTL: Duration = Duration::from_secs(30);

/// RAII guard released (removing the profile from the busy set) on drop,
/// whichever way the operation ends (success, error, or panic unwind).
pub struct BusyGuard<'a> {
    state: &'a AppState,
    profile: String,
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.state.busy.lock().unwrap().remove(&self.profile);
    }
}

impl AppState {
    /// Attempt to mark `profile` as busy. Returns an error per §2.5 if an
    /// operation is already in flight for it; otherwise returns a guard
    /// that releases the lock on drop.
    pub fn try_lock_profile(&self, profile: &str) -> Result<BusyGuard<'_>, String> {
        let mut busy = self.busy.lock().unwrap();
        if !busy.insert(profile.to_string()) {
            return Err(format!(
                "another operation is in progress for profile {profile}"
            ));
        }
        Ok(BusyGuard {
            state: self,
            profile: profile.to_string(),
        })
    }

    /// Profiles with an operation currently in flight.
    pub fn busy_profiles(&self) -> Vec<String> {
        let mut v: Vec<String> = self.busy.lock().unwrap().iter().cloned().collect();
        v.sort();
        v
    }

    /// Return a cached docker socket for `profile` if resolved within the
    /// last 30s.
    pub fn cached_docker_socket(&self, profile: &str) -> Option<String> {
        let cache = self.docker_sockets.lock().unwrap();
        cache.get(profile).and_then(|(sock, at)| {
            if at.elapsed() < SOCKET_CACHE_TTL {
                Some(sock.clone())
            } else {
                None
            }
        })
    }

    /// Store a freshly resolved docker socket for `profile`.
    pub fn cache_docker_socket(&self, profile: &str, socket: String) {
        self.docker_sockets
            .lock()
            .unwrap()
            .insert(profile.to_string(), (socket, Instant::now()));
    }

    /// Invalidate the cached docker socket for `profile` (called after
    /// lifecycle ops that may change it, e.g. start/stop/delete).
    pub fn invalidate_docker_socket(&self, profile: &str) {
        self.docker_sockets.lock().unwrap().remove(profile);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_on_same_profile_fails() {
        let state = AppState::default();
        let _guard = state.try_lock_profile("default").unwrap();
        let err = match state.try_lock_profile("default") {
            Ok(_) => panic!("expected lock to fail"),
            Err(e) => e,
        };
        assert_eq!(err, "another operation is in progress for profile default");
    }

    #[test]
    fn lock_released_on_drop_allows_relock() {
        let state = AppState::default();
        {
            let _guard = state.try_lock_profile("default").unwrap();
        }
        assert!(state.try_lock_profile("default").is_ok());
    }

    #[test]
    fn different_profiles_lock_independently() {
        let state = AppState::default();
        let _g1 = state.try_lock_profile("default").unwrap();
        assert!(state.try_lock_profile("rosetta").is_ok());
    }

    #[test]
    fn docker_socket_cache_roundtrip() {
        let state = AppState::default();
        assert!(state.cached_docker_socket("default").is_none());
        state.cache_docker_socket("default", "unix:///tmp/docker.sock".into());
        assert_eq!(
            state.cached_docker_socket("default").as_deref(),
            Some("unix:///tmp/docker.sock")
        );
        state.invalidate_docker_socket("default");
        assert!(state.cached_docker_socket("default").is_none());
    }
}
