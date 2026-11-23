//! The provider login (`auth.start`, `auth.respond`, `auth.cancel`): the
//! driver's login steps shown in the snapshot's `auth`, answered by the
//! user, never with what they submitted or what the provider said.

use std::sync::{Arc, Weak};

use roamgate_agents::js;
use roamgate_base::paths::random_uuid;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::util::*;
use super::{Answer, Inner, any_signal, start_work, throw_if};
use crate::driver::LoginInteraction;
use crate::errors::AssistantResult;
use crate::tools::BoxFuture;

struct Login {
    inner: Weak<Inner>,
    id: String,
    controller: CancellationToken,
}

impl LoginInteraction for Login {
    fn prompt(
        &self,
        prompt: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<String>> {
        let inner = self.inner.clone();
        let controller = self.controller.clone();
        Box::pin(async move {
            throw_if(Some(&controller))?;
            let inner = inner.upgrade().ok_or_else(|| err("Login cancelled"))?;
            let prompt_id = random_uuid();
            let signal = any_signal(&[&cancel, &controller]);
            let (sender, receiver) = oneshot::channel();
            {
                let mut s = inner.lock();
                let mut auth = match s.auth.clone() {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                auth.insert("status".into(), json!("waiting"));
                auth.insert("message".into(), json!("Complete the provider login step."));
                let mut shown = Map::new();
                shown.insert("id".into(), json!(prompt_id));
                shown.insert(
                    "type".into(),
                    prompt.get("type").cloned().unwrap_or(Value::Null),
                );
                shown.insert(
                    "message".into(),
                    json!(js::head16(js::sv(prompt.get("message")), 1000)),
                );
                if let Some(options) = prompt.get("options").and_then(Value::as_array) {
                    let options: Vec<Value> = options
                        .iter()
                        .map(|option| {
                            json!({
                                "id": option.get("id").cloned().unwrap_or(Value::Null),
                                "label": option.get("label").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect();
                    shown.insert("options".into(), Value::Array(options));
                }
                auth.insert("prompt".into(), Value::Object(shown));
                s.auth = Value::Object(auth);
                inner.publish(&mut s, true);
                if signal.is_cancelled() {
                    return Err(err("Login cancelled"));
                }
                s.answer = Some(Answer {
                    id: prompt_id.clone(),
                    sender,
                });
            }
            tokio::select! {
                answer = receiver => answer.unwrap_or_else(|_| Err(err("Login cancelled"))),
                _ = signal.cancelled() => {
                    let mut s = inner.lock();
                    if s.answer.as_ref().is_some_and(|answer| answer.id == prompt_id) {
                        s.answer = None;
                    }
                    Err(err("Login cancelled"))
                }
            }
        })
    }

    fn event(&self, event: Value) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let mut s = inner.lock();
        if self.controller.is_cancelled() || s.auth.get("id") != Some(&json!(self.id)) {
            return;
        }
        let auth = s.auth.as_object_mut().unwrap();
        auth.insert("status".into(), json!("working"));
        auth.insert(
            "message".into(),
            json!("Waiting for provider authorization..."),
        );
        let mut set_url = |url: Option<String>| match url {
            Some(url) => {
                auth.insert("url".into(), json!(url));
            }
            None => js::delete(auth, "url"),
        };
        match event.get("type").and_then(Value::as_str) {
            Some("auth_url") => set_url(auth_url(js::sv(event.get("url")))),
            Some("device_code") => {
                set_url(auth_url(js::sv(event.get("verificationUri"))));
                match event.get("userCode") {
                    Some(code) if !code.is_null() => {
                        auth.insert("user_code".into(), code.clone());
                    }
                    _ => js::delete(auth, "user_code"),
                }
            }
            _ => {}
        }
        inner.publish(&mut s, true);
    }
}

impl Inner {
    pub(super) async fn start_auth(self: &Arc<Self>, params: &Value) -> AssistantResult<()> {
        let (source, provider, method) = {
            let mut s = self.lock();
            self.idle(&s)?;
            let source = js::sv(s.config.get("credential_source")).to_owned();
            let provider = string500(params.get("provider"), "provider")?;
            let method = match params.get("method").and_then(Value::as_str) {
                Some(method @ ("api_key" | "oauth")) => method.to_owned(),
                _ => return Err(err("Invalid login method")),
            };
            s.changing = true;
            (source, provider, method)
        };
        let loaded = self.catalog().await;
        self.lock().changing = false;
        if loaded.is_err() {
            return Err(err("The provider catalog could not be loaded."));
        }
        let mut s = self.lock();
        if s.disposed {
            return Err(err("Ranger unavailable"));
        }
        let supported = s.providers.as_array().into_iter().flatten().any(|entry| {
            entry["id"] == provider.as_str()
                && entry["methods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|m| *m == method.as_str()))
        });
        if !supported {
            return Err(err("This provider does not support that login method"));
        }
        let id = random_uuid();
        let controller = CancellationToken::new();
        s.auth_controller = Some(controller.clone());
        s.auth = json!({
            "id": id,
            "provider": provider,
            "status": "working",
            "message": "Connecting provider...",
        });
        self.publish(&mut s, true);
        let inner = self.clone();
        let interaction = Arc::new(Login {
            inner: self.weak.clone(),
            id: id.clone(),
            controller: controller.clone(),
        });
        let auth_work = start_work(&mut s, async move {
            let result: AssistantResult<()> = async {
                inner
                    .driver
                    .login(&provider, &method, &source, interaction, controller.clone())
                    .await?;
                throw_if(Some(&controller))?;
                inner.catalog().await?;
                throw_if(Some(&controller))?;
                Ok(())
            }
            .await;
            let mut s = inner.lock();
            s.auth = match result {
                Ok(()) => json!({
                    "id": id,
                    "provider": provider,
                    "status": "completed",
                    "message": "Provider connected. Select a model to continue.",
                }),
                Err(_) if controller.is_cancelled() => Value::Null,
                Err(_) => json!({
                    "id": id,
                    "provider": provider,
                    "status": "failed",
                    "message": "Provider login failed. Try again.",
                }),
            };
            s.answer = None;
            s.auth_controller = None;
            inner.publish(&mut s, true);
        });
        s.auth_work = Some(auth_work);
        Ok(())
    }

    pub(super) fn respond_auth(&self, params: &Value) -> AssistantResult<()> {
        let mut s = self.lock();
        let active = !s.auth.is_null()
            && s.auth.get("id") == params.get("auth_id")
            && s.answer
                .as_ref()
                .is_some_and(|answer| params.get("prompt_id") == Some(&json!(answer.id)));
        if !active {
            return Err(err("This login prompt is no longer active"));
        }
        let value = params
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| js::len16(value) <= 20_000)
            .map(str::to_owned)
            .ok_or_else(|| err("Invalid login response"))?;
        let prompt = s.auth.get("prompt").cloned().unwrap_or(Value::Null);
        if prompt.get("type") == Some(&json!("select"))
            && !prompt["options"]
                .as_array()
                .is_some_and(|options| options.iter().any(|o| o["id"] == value.as_str()))
        {
            return Err(err("Invalid login choice"));
        }
        let pending = s.answer.take().unwrap();
        let auth = s.auth.as_object_mut().unwrap();
        js::delete(auth, "prompt");
        auth.insert("status".into(), json!("working"));
        auth.insert("message".into(), json!("Connecting provider..."));
        let _ = pending.sender.send(Ok(value));
        self.publish(&mut s, true);
        Ok(())
    }
}
