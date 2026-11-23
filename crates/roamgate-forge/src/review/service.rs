//! The review service's forge ([`ReviewForge`]): review/service.ts's
//! `gitlab` argument (`checkout`, `find`, `context`) and the gitlab.ts
//! calls it makes with that context, on the checkout's host.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_review::diff::ReviewDiff;
use roamgate_review::model::{ReviewAnchor, ReviewComment, ReviewSession, ReviewThread};
use roamgate_review::service::host::{Ask, Load};
use roamgate_review::service::{LoadError, ReviewForge};
use serde_json::Value;

use super::cli::ForgeContext;
use super::gitlab::{
    self, MergeRequestInfo, ReviewCheckout, draft_reply, draft_thread, find_branch_merge_request,
    read_checkout,
};

/// A review's checkout as a forge context: its connection's host and
/// runner, at its root; an error for a connection this server does not
/// know.
pub type ContextOf = Arc<dyn Fn(&str, &str) -> Result<ForgeContext, String> + Send + Sync>;

/// Merge and pull requests for the review service.
pub struct MergeRequestForge {
    context_of: ContextOf,
    /// Project ids by host and path, asked once (review's `reviewProjectIds`).
    project_ids: Arc<Mutex<HashMap<String, i64>>>,
}

impl MergeRequestForge {
    pub fn new(context_of: ContextOf) -> Self {
        Self {
            context_of,
            project_ids: Arc::default(),
        }
    }

    fn context(&self, session: &ReviewSession) -> Result<ForgeContext, String> {
        (self.context_of)(&session.connection_id, &session.root)
    }
}

fn merge_request(mr: &Value) -> Result<MergeRequestInfo, String> {
    serde_json::from_value(mr.clone()).map_err(|error| format!("not a merge request: {error}"))
}

fn info_value(mr: &MergeRequestInfo) -> Value {
    serde_json::to_value(mr).unwrap_or(Value::Null)
}

impl ReviewForge for MergeRequestForge {
    fn checkout(&self, session: &ReviewSession) -> Load<Value> {
        let context = self.context(session);
        Box::pin(async move {
            let context = context.map_err(LoadError::Failed)?;
            let checkout = read_checkout(&context).await?;
            serde_json::to_value(checkout).map_err(|error| LoadError::Failed(error.to_string()))
        })
    }

    fn find(&self, session: &ReviewSession, checkout: Value) -> Ask<Option<Value>> {
        let context = self.context(session);
        let ids = self.project_ids.clone();
        Box::pin(async move {
            let context = context?;
            let checkout: ReviewCheckout =
                serde_json::from_value(checkout).map_err(|error| error.to_string())?;
            let found = find_branch_merge_request(&context, &checkout, &ids).await?;
            Ok(found.map(|found| serde_json::to_value(found).unwrap_or(Value::Null)))
        })
    }

    fn read_merge_request(&self, session: &ReviewSession, url: &str) -> Ask<Value> {
        let context = self.context(session);
        let url = url.to_owned();
        Box::pin(async move {
            let mr = gitlab::read_merge_request(&context?, &url).await?;
            Ok(info_value(&mr))
        })
    }

    fn read_threads(&self, session: &ReviewSession, mr: &Value) -> Ask<Vec<ReviewThread>> {
        let context = self.context(session);
        let mr = merge_request(mr);
        let id = session.id.clone();
        Box::pin(async move { gitlab::read_merge_request_threads(&context?, &mr?, &id).await })
    }

    fn create_draft_note(
        &self,
        session: &ReviewSession,
        mr: &Value,
        anchor: ReviewAnchor,
        note: String,
        diff: Option<Value>,
    ) -> Ask<ReviewThread> {
        let context = self.context(session);
        let mr = merge_request(mr);
        let id = session.id.clone();
        Box::pin(async move {
            let (context, mr) = (context?, mr?);
            let diff: Option<ReviewDiff> = diff.and_then(|diff| serde_json::from_value(diff).ok());
            let draft = gitlab::create_draft_note(
                &context,
                &mr,
                &anchor,
                &note,
                diff.as_ref().map(|diff| diff.files.as_slice()),
            )
            .await?;
            Ok(draft_thread(&draft, &id, Some(&mr)))
        })
    }

    fn update_draft_note(
        &self,
        session: &ReviewSession,
        mr: &Value,
        draft_id: i64,
        note: String,
    ) -> Ask<ReviewThread> {
        let context = self.context(session);
        let mr = merge_request(mr);
        let id = session.id.clone();
        Box::pin(async move {
            let (context, mr) = (context?, mr?);
            let draft = gitlab::update_draft_note(&context, &mr, draft_id, &note).await?;
            Ok(draft_thread(&draft, &id, Some(&mr)))
        })
    }

    fn delete_draft_note(&self, session: &ReviewSession, mr: &Value, id: i64) -> Ask<()> {
        let context = self.context(session);
        let mr = merge_request(mr);
        Box::pin(async move { gitlab::delete_draft_note(&context?, &mr?, id).await })
    }

    fn create_draft_reply(
        &self,
        session: &ReviewSession,
        mr: &Value,
        discussion: &str,
        note: String,
    ) -> Ask<ReviewComment> {
        let context = self.context(session);
        let mr = merge_request(mr);
        let discussion = discussion.to_owned();
        Box::pin(async move {
            let draft = gitlab::create_draft_reply(&context?, &mr?, &discussion, &note).await?;
            Ok(draft_reply(&draft))
        })
    }
}
