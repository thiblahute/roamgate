//! Helpers of the crate's tests: a clock moved by hand (the TS tests'
//! `jest.useFakeTimers`), requests and bodies.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::{self, BoxStream, StreamExt};
use http::request::Parts;
use roamgate_base::clock::{BoxFuture, Clock, Interval, SharedClock};
use tokio::sync::mpsc;

pub const NOW: i64 = 1_700_000_000_000;

#[derive(Debug)]
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn at(now: i64) -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(now)))
    }

    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn monotonic(&self) -> f64 {
        self.now() as f64
    }
    fn sleep_until(&self, _deadline: i64) -> BoxFuture<()> {
        Box::pin(std::future::pending())
    }
    fn sleep(&self, _duration: Duration) -> BoxFuture<()> {
        Box::pin(std::future::pending())
    }
    fn interval(&self, _period: Duration) -> Interval {
        Interval::new(|| Box::pin(std::future::pending()))
    }
}

pub fn shared(clock: &Arc<ManualClock>) -> SharedClock {
    clock.clone()
}

pub type Body = BoxStream<'static, Result<Bytes, std::convert::Infallible>>;

/// A request's head: `headers` as (name, value).
pub fn parts(method: &str, uri: &str, headers: &[(&str, &str)]) -> Parts {
    let mut builder = http::Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(()).unwrap().into_parts().0
}

/// A body of these bytes.
pub fn body(text: impl Into<Vec<u8>>) -> Option<Body> {
    let bytes = Bytes::from(text.into());
    Some(stream::iter([Ok(bytes)]).boxed())
}

/// A body of these chunks.
pub fn chunks(parts: Vec<Vec<u8>>) -> Option<Body> {
    Some(stream::iter(parts.into_iter().map(|part| Ok(Bytes::from(part)))).boxed())
}

/// A body that waits for its text: `finish` sends it and ends the body.
pub fn slow_body() -> (Option<Body>, mpsc::UnboundedSender<Bytes>) {
    let (sender, mut receiver) = mpsc::unbounded_channel::<Bytes>();
    let body = stream::poll_fn(move |cx| receiver.poll_recv(cx).map(|chunk| chunk.map(Ok))).boxed();
    (Some(body), sender)
}

/// The `name=value` part of a response's Set-Cookie.
pub fn cookie_header(response: &crate::response::Response) -> String {
    let cookie = response
        .headers()
        .get("set-cookie")
        .expect("missing authentication cookie")
        .to_str()
        .unwrap();
    cookie.split(';').next().unwrap().to_owned()
}

pub fn get(response: &crate::response::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .map(|value| value.to_str().unwrap().to_owned())
}

pub fn json_of(response: &crate::response::Response) -> serde_json::Value {
    serde_json::from_slice(response.body()).unwrap()
}
