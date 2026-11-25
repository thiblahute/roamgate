//! Roamgate's server foundations (the Rust migration plan, section 6.2):
//! what every family of the server stands on.
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`env`](mod@env) | `ROAMGATE_*` over `HERDR_GUI_*`, an empty value counting | config/environment |
//! | [`paths`] | data paths and the legacy herdr-gui migration | config/data-paths |
//! | [`node`] | node mode: the home's origin, the node's own data root | (none) |
//! | [`private`] | 0700 directories, 0600 files, no symlinks, single links | the private-file checks |
//! | [`json_store`] | `AtomicJsonStore`: versioned JSON files, tmp, fsync, rename | the tmp-and-rename writers |
//! | [`sqlite`] | `SqliteDb::open`: PRAGMAs, user_version, safe path | the SQLite open paths |
//! | [`lock`] | the mkdir lock proper-lockfile takes, shared with the Bun server | proper-lockfile |
//! | [`session_secret`] | the session signing state under that lock | config/session-secret |
//! | [`settings`] | `SettingsStore`, the one owner of settings.json | config/gui-settings, ui-settings, overlay-tabs |
//! | [`assets`] | the embedded `contract/assets` files and the template filler | assets/ |
//! | [`credentials`] | the password and PIN rules | config/auth-token's checks |
//! | [`clock`] | `Clock`, `SystemClock`, `TestClock` and its control socket | utils/test-clock |
//! | [`loop_stall`] | late ticks of the runtime, logged | utils/loop-stall |
//! | [`error`] | `UserError` | AssistantUserError as a user error |
//! | [`json`] | record checks and parameter coercion | the `isRecord` copies |
//! | [`log`] | the log line format, as a `tracing` layer, and RPC log lines | utils/logger, utils/rpc-logging |
//! | [`secrets`] | finding credentials in text and diffs | utils/secrets |
//! | [`record`] | record mode's redacted JSONL recorder | contract-record/recorder, redact |
//! | [`swr`] | `SwrCache`: single flight, TTL per entry, LRU, budget | mr-cache core, review/memo |
//! | [`local_socket`] | Unix sockets at a path on every platform, Windows named pipes | Bun's `unix:` listeners, node:net pipes |
//! | [`unix_socket`] | Unix sockets at paths past `SUN_LEN` | Bun's long socket paths |

pub mod assets;
pub mod clock;
pub mod credentials;
pub mod env;
pub mod error;
pub mod json;
pub mod json_store;
pub mod local_socket;
pub mod lock;
pub mod log;
pub mod loop_stall;
pub mod node;
pub mod paths;
pub mod posix_shell;
pub mod private;
pub mod record;
pub mod revoked_sessions;
pub mod secrets;
pub mod session_secret;
pub mod settings;
pub mod sqlite;
pub mod swr;
pub mod unix_socket;
