//! `createAssistantContext` (`assistant/context.ts`) on a [`ContextHost`]
//! (ported in S23; see the plan).

/// What the live context reads through: what Bun still owns.
pub trait ContextHost: Send + Sync + 'static {}
