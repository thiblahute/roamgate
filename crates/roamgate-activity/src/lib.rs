//! Roamgate's activity log (Rust migration plan, section 6.2): the
//! recorder, the store, the readers and the timeline of the activity
//! family (S13), and the time-report provider bridge (S12) with the day
//! input it builds from the log. Only the owner of the activity family
//! writes activity.sqlite; the readers open it read-only.
//!
//! | Module | What |
//! |---|---|
//! | [`recorder`] | the actor turning Herdr's states and a browser's presence into the log |
//! | [`store`] | activity.sqlite: schema, writes, the Event and Workspace views |
//! | [`reader`] | read-only access: timeline, pages, workspaces, status |
//! | [`timeline`] | the day spans and totals, and the date helpers |
//! | [`subjects`] | a workspace's subject: Workspaces tree groups, then subject roots |
//! | [`repo_info`] | a workspace's repository, read with git on its host |
//! | [`day_input`] | the activity settings and what the time-report provider gets for a day |
//! | [`protocol`] | ids, local times with their offset, agent states |
//! | [`collate`] | `localeCompare` for the strings the timeline sorts |
//! | [`time_report`] | the RPC: operations, argument checks, one provider run at a time per day, previews and submit |
//! | [`provider`] | one run of the provider: command line, body on stdin, an empty directory, the timeout, its errors |
//! | [`js`] | JSON as JavaScript parses it |

pub mod collate;
pub mod day_input;
pub mod js;
pub mod protocol;
pub mod provider;
pub mod reader;
pub mod recorder;
pub mod repo_info;
pub mod store;
pub mod subjects;
pub mod time_report;
pub mod timeline;

pub use provider::BoxFuture;
