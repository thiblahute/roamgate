//! Roamgate's HTTP and RPC surface (Rust migration plan, section 6.2). For
//! now the settings family's handlers (S13): the settings RPCs that answer
//! from settings.json alone and `/api/instance-settings`, on the one
//! settings.json writer. The axum app, auth and the `/ws` transport come
//! with the front (Phase 7).

pub mod settings;
