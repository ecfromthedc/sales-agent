//! In-memory state store for carousels that are live in a Slack thread.
//!
//! When the pipeline finishes uploading a draft, it registers the draft here
//! keyed by `(channel, parent_ts)`. Reply and reaction handlers look up the
//! state by that key to route edit notes and `:ship_it:` signals.
//!
//! Why in-memory: drafts are ephemeral. Restart loses the ability to edit
//! in-flight drafts, but the PNGs are still on disk and the Slack thread is
//! intact — Eric can just re-fire if he needs to iterate after a restart.
//! Upgrade path to SQLite is straightforward (replace the inner map).
//!
//! TTL eviction runs lazily on every register/lookup: entries older than
//! [`TTL`] are removed. This keeps the map bounded without a sweeper task.
//!
//! The store is a process-global singleton — a single [`OnceLock`] backs it
//! so all subsystems (pipeline upload, socket-mode reply handler, slash
//! command handler) share state without threading an `Arc<DraftStore>`
//! through every signature.
use crate::types::CarouselDraft;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Drafts older than this are considered abandoned and dropped on access.
/// 24h matches a generous editing window — far longer than Eric typically
/// iterates on a single draft, but short enough that the map can't grow
/// unbounded.
pub const TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// Key for the draft map. `(channel, parent_ts)` uniquely identifies a draft
/// thread in Slack.
pub type DraftKey = (String, String);

/// Snapshot of a live draft. Cheap to clone — the underlying `CarouselDraft`
/// is `Clone`, the PNG paths are owned `PathBuf`s.
#[derive(Debug, Clone)]
pub struct DraftState {
    pub draft: CarouselDraft,
    pub png_paths: Vec<PathBuf>,
    /// Once locked (via `:ship_it:`), edit-note replies are ignored. The
    /// PNGs in the thread are considered the final cut.
    pub locked: bool,
    pub created_at: Instant,
    pub last_touched: Instant,
}

impl DraftState {
    fn fresh(draft: CarouselDraft, pngs: Vec<PathBuf>) -> Self {
        let now = Instant::now();
        Self {
            draft,
            png_paths: pngs,
            locked: false,
            created_at: now,
            last_touched: now,
        }
    }

    fn is_stale(&self) -> bool {
        self.created_at.elapsed() > TTL
    }
}

pub struct DraftStore {
    inner: RwLock<HashMap<DraftKey, DraftState>>,
}

impl DraftStore {
    fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    /// Insert a fresh draft. Any existing entry at this key is overwritten —
    /// regenerated drafts replace older ones cleanly.
    pub fn register(
        &self,
        channel: String,
        parent_ts: String,
        draft: CarouselDraft,
        pngs: Vec<PathBuf>,
    ) {
        self.evict_stale_internal();
        let key: DraftKey = (channel, parent_ts);
        let state = DraftState::fresh(draft, pngs);
        let mut guard = self
            .inner
            .write()
            .expect("DraftStore write lock poisoned");
        guard.insert(key, state);
    }

    /// Look up a draft. Returns a snapshot clone — caller can read without
    /// holding the lock. Returns `None` if the key is unknown or has expired.
    pub fn get(&self, channel: &str, parent_ts: &str) -> Option<DraftState> {
        self.evict_stale_internal();
        let guard = self.inner.read().expect("DraftStore read lock poisoned");
        let key = (channel.to_string(), parent_ts.to_string());
        guard.get(&key).cloned()
    }

    /// Mark a draft as locked. Returns `true` if the draft existed and was
    /// newly locked, `false` if it was already locked or absent.
    pub fn lock(&self, channel: &str, parent_ts: &str) -> bool {
        let mut guard = self.inner.write().expect("DraftStore write lock poisoned");
        let key = (channel.to_string(), parent_ts.to_string());
        match guard.get_mut(&key) {
            Some(state) if !state.locked => {
                state.locked = true;
                state.last_touched = Instant::now();
                true
            }
            _ => false,
        }
    }

    /// Replace the PNG paths after a targeted slide regen. Returns `false` if
    /// the key is missing or the draft is locked.
    pub fn update_pngs(&self, channel: &str, parent_ts: &str, pngs: Vec<PathBuf>) -> bool {
        let mut guard = self.inner.write().expect("DraftStore write lock poisoned");
        let key = (channel.to_string(), parent_ts.to_string());
        match guard.get_mut(&key) {
            Some(state) if !state.locked => {
                state.png_paths = pngs;
                state.last_touched = Instant::now();
                true
            }
            _ => false,
        }
    }

    /// Replace both the draft and its PNGs (used after a full re-generation).
    /// Returns `false` if the draft is locked or missing.
    pub fn replace(
        &self,
        channel: &str,
        parent_ts: &str,
        draft: CarouselDraft,
        pngs: Vec<PathBuf>,
    ) -> bool {
        let mut guard = self.inner.write().expect("DraftStore write lock poisoned");
        let key = (channel.to_string(), parent_ts.to_string());
        match guard.get_mut(&key) {
            Some(state) if !state.locked => {
                state.draft = draft;
                state.png_paths = pngs;
                state.last_touched = Instant::now();
                true
            }
            _ => false,
        }
    }

    /// Number of live (non-expired) drafts currently tracked.
    pub fn len(&self) -> usize {
        let guard = self.inner.read().expect("DraftStore read lock poisoned");
        guard.values().filter(|s| !s.is_stale()).count()
    }

    /// `true` when no live drafts are tracked. Pair with [`Self::len`].
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn evict_stale_internal(&self) {
        let mut guard = self.inner.write().expect("DraftStore write lock poisoned");
        guard.retain(|_k, v| !v.is_stale());
    }
}

static STORE: OnceLock<DraftStore> = OnceLock::new();

/// Process-global draft store. Lazily initialized on first use.
pub fn store() -> &'static DraftStore {
    STORE.get_or_init(DraftStore::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        CarouselDraft, CarouselFormat, ContentOrigin, SeedField, SlideContent,
    };

    fn dummy_draft(slug: &str) -> CarouselDraft {
        CarouselDraft {
            slug: slug.to_string(),
            format: CarouselFormat::Value,
            vol: 99,
            working_title: "Test".to_string(),
            hook: SlideContent {
                headline: Some("HOOK".into()),
                lede: None,
                accent_words: vec![],
                origin: ContentOrigin::LlmFilled,
            },
            build: None,
            payoff: None,
            cta: SlideContent {
                headline: Some("CTA".into()),
                lede: None,
                accent_words: vec![],
                origin: ContentOrigin::LlmFilled,
            },
            sources: vec![],
            seed_field: SeedField::Take,
        }
    }

    fn dummy_pngs() -> Vec<PathBuf> {
        vec![
            PathBuf::from("/tmp/slide-01.png"),
            PathBuf::from("/tmp/slide-02.png"),
        ]
    }

    #[test]
    fn register_and_get_round_trip() {
        let s = DraftStore::new();
        s.register("C1".into(), "1.0".into(), dummy_draft("a"), dummy_pngs());
        let got = s.get("C1", "1.0").expect("present");
        assert_eq!(got.draft.slug, "a");
        assert_eq!(got.png_paths.len(), 2);
        assert!(!got.locked);
    }

    #[test]
    fn get_missing_returns_none() {
        let s = DraftStore::new();
        assert!(s.get("C1", "0").is_none());
    }

    #[test]
    fn register_overwrites_existing() {
        let s = DraftStore::new();
        s.register("C1".into(), "1.0".into(), dummy_draft("a"), dummy_pngs());
        s.register("C1".into(), "1.0".into(), dummy_draft("b"), dummy_pngs());
        assert_eq!(s.get("C1", "1.0").unwrap().draft.slug, "b");
    }

    #[test]
    fn lock_succeeds_once_then_no_ops() {
        let s = DraftStore::new();
        s.register("C1".into(), "1.0".into(), dummy_draft("a"), dummy_pngs());
        assert!(s.lock("C1", "1.0"));
        assert!(s.get("C1", "1.0").unwrap().locked);
        // Second lock returns false (already locked).
        assert!(!s.lock("C1", "1.0"));
    }

    #[test]
    fn lock_missing_returns_false() {
        let s = DraftStore::new();
        assert!(!s.lock("C1", "1.0"));
    }

    #[test]
    fn update_pngs_skips_locked_drafts() {
        let s = DraftStore::new();
        s.register("C1".into(), "1.0".into(), dummy_draft("a"), dummy_pngs());
        s.lock("C1", "1.0");
        let updated = s.update_pngs("C1", "1.0", vec![PathBuf::from("/tmp/new.png")]);
        assert!(!updated, "must not update a locked draft");
        // Original PNGs preserved
        assert_eq!(s.get("C1", "1.0").unwrap().png_paths.len(), 2);
    }

    #[test]
    fn replace_swaps_draft_and_pngs() {
        let s = DraftStore::new();
        s.register("C1".into(), "1.0".into(), dummy_draft("a"), dummy_pngs());
        let ok = s.replace(
            "C1",
            "1.0",
            dummy_draft("b"),
            vec![PathBuf::from("/tmp/x.png")],
        );
        assert!(ok);
        let got = s.get("C1", "1.0").unwrap();
        assert_eq!(got.draft.slug, "b");
        assert_eq!(got.png_paths.len(), 1);
    }

    #[test]
    fn len_counts_only_fresh_entries() {
        let s = DraftStore::new();
        s.register("C1".into(), "1.0".into(), dummy_draft("a"), dummy_pngs());
        s.register("C1".into(), "2.0".into(), dummy_draft("b"), dummy_pngs());
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn global_store_is_singleton() {
        // Two calls return the same address — proves OnceLock is doing its job.
        let a = store() as *const _;
        let b = store() as *const _;
        assert_eq!(a, b);
    }
}
