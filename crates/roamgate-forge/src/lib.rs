//! Roamgate's forge layer (Rust migration plan, section 6.2): glab and gh
//! calls and what is kept of their answers.
//!
//! | Module | Role | Replaces |
//! |---|---|---|
//! | [`complexity`] | GitLab GraphQL complexity: estimates, refusals, batches under each host's learned budget | mr-reviews/complexity |
//! | [`gate`] | Calls per minute and at once per checkout and forge host, Retry-After and rate-limit pauses, ETag reuse, in-flight sharing | workspace/forge-calls |
//! | [`hosts`] | The hosts glab and gh have a login for, from their own config files | mr-reviews/hosts |
//! | [`mr_cache`] | The MR cache: `mr-cache/state.json`, TTLs by state, the `forge_cache` pushes, on `roamgate_base::swr::SwrCache` | mr-cache/* |
//! | [`pages`] | The pages of a paginated `glab api` or `gh api` answer | review/forge-cli `parseJsonPages` |

pub mod complexity;
pub mod gate;
pub mod hosts;
pub mod mr_cache;
pub mod pages;
