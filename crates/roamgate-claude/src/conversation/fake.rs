//! A control context for the drivers' tests: answers each request as told,
//! and notes what was asked.

use std::collections::HashMap;
use std::sync::Mutex;

use roamgate_conversation::driver::{BoxFuture, ControlAnswer, ModelContext, Object};
use serde_json::{Value, json};

/// An answer as the TS tests write it: `{response?, error?}` or null.
pub fn answer(value: Value) -> Option<ControlAnswer> {
    let object = value.as_object()?;
    Some(ControlAnswer {
        error: object
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
        response: object.get("response").and_then(Value::as_object).cloned(),
    })
}

pub struct Context {
    answers: HashMap<String, Option<ControlAnswer>>,
    /// What a request with no answer of its own gets.
    otherwise: Option<ControlAnswer>,
    pub asked: Mutex<Vec<Value>>,
}

impl Context {
    /// `answers`: `{kind: answer}`; the others get `otherwise`.
    pub fn new(answers: Value, otherwise: Value) -> Self {
        let answers = answers
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .map(|(kind, value)| (kind.clone(), answer(value.clone())))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            answers,
            otherwise: answer(otherwise),
            asked: Mutex::new(Vec::new()),
        }
    }

    pub fn asked(&self) -> Value {
        Value::Array(self.asked.lock().expect("asked").clone())
    }
}

impl ModelContext for Context {
    fn control(&self, kind: &str, params: Object) -> BoxFuture<'_, Option<ControlAnswer>> {
        self.asked
            .lock()
            .expect("asked")
            .push(json!([kind, Value::Object(params)]));
        let answer = match self.answers.get(kind) {
            Some(answer) => answer.clone(),
            None => self.otherwise.clone(),
        };
        Box::pin(async move { answer })
    }
}
