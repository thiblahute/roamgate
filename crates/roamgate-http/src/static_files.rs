//! The web app's files (http/static-files.ts): the public directory, then
//! the built one, the SPA entry for page navigations, the manifest and the
//! entry document named after the instance (title suffix), and the default
//! manifest when no web build exists yet (a fresh source checkout).

use std::path::{Path, PathBuf};

use bytes::Bytes;
use roamgate_base::settings::instance_display_name;
use serde_json::Value;

use crate::response::{self, Response};
use crate::static_paths::{
    decode_static_pathname, is_static_request_method, resolve_public_file_path,
    should_serve_spa_entry,
};

/// web/public/manifest.json, served when no directory has one.
pub const DEFAULT_MANIFEST: &str = include_str!("../../../web/public/manifest.json");

const REVALIDATE: &str = "private, no-cache, must-revalidate";

/// A request for a static file.
#[derive(Debug, Clone, Copy)]
pub struct StaticRequest<'a> {
    pub method: &'a str,
    /// The raw (still encoded) URL path.
    pub raw_path: &'a str,
    pub accept: Option<&'a str>,
}

/// Where the files are: the configured directory, then the build's own.
#[derive(Debug, Clone)]
pub struct StaticFiles {
    pub public_dir: PathBuf,
    pub built_public_dir: Option<PathBuf>,
}

pub fn content_type(pathname: &str) -> &'static str {
    // .mjs: modules shipped as such (the PDF.js worker); a module of any
    // other type is refused by the browser.
    let ends = |suffix: &str| pathname.ends_with(suffix);
    if ends(".js") || ends(".mjs") {
        "text/javascript; charset=utf-8"
    } else if ends(".css") {
        "text/css; charset=utf-8"
    } else if ends(".html") {
        "text/html; charset=utf-8"
    } else if ends(".json") || ends(".map") {
        "application/json; charset=utf-8"
    } else if ends(".svg") {
        "image/svg+xml"
    } else if ends(".png") {
        "image/png"
    } else if ends(".jpg") || ends(".jpeg") {
        "image/jpeg"
    } else if ends(".webp") {
        "image/webp"
    } else if ends(".gif") {
        "image/gif"
    } else if ends(".ico") {
        "image/x-icon"
    } else if ends(".woff2") {
        "font/woff2"
    } else if ends(".woff") {
        "font/woff"
    } else if ends(".wasm") {
        "application/wasm"
    } else {
        "application/octet-stream"
    }
}

fn headers_for(pathname: &str) -> Vec<(&'static str, &'static str)> {
    let mut headers = vec![("content-type", content_type(pathname))];
    if pathname == "/index.html" || pathname == "/manifest.json" {
        // Revalidate both install metadata and the entry document after a
        // name change or update. Shared caches must not reuse
        // authenticated responses.
        headers.push(("cache-control", REVALIDATE));
    }
    headers
}

fn serve_manifest(head: bool, manifest: Value, title_suffix: &str) -> Response {
    let headers = headers_for("/manifest.json");
    if head {
        return response::with(200, &headers, Bytes::new());
    }
    let name = instance_display_name(title_suffix);
    let mut manifest = match manifest {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    manifest.insert("name".into(), Value::String(name.clone()));
    manifest.insert("short_name".into(), Value::String(name));
    response::json(200, &headers, &Value::Object(manifest))
}

/// The entry document with the instance's name in `<title>` and the two
/// app-name metadata, escaped by the rewriter (Bun's HTMLRewriter is
/// lol_html too).
pub fn name_entry_document(html: &[u8], name: &str) -> Result<Vec<u8>, String> {
    use lol_html::html_content::ContentType;
    use lol_html::{RewriteStrSettings, element, rewrite_str};
    let text = String::from_utf8_lossy(html);
    rewrite_str(
        &text,
        RewriteStrSettings {
            element_content_handlers: vec![
                element!("title", |el| {
                    el.set_inner_content(name, ContentType::Text);
                    Ok(())
                }),
                element!(
                    r#"meta[name="apple-mobile-web-app-title"], meta[name="application-name"]"#,
                    |el| {
                        el.set_attribute("content", name)?;
                        Ok(())
                    }
                ),
            ],
            ..RewriteStrSettings::new()
        },
    )
    .map(String::into_bytes)
    .map_err(|error| error.to_string())
}

async fn serve_file(head: bool, file: &Path, pathname: &str, title_suffix: &str) -> Response {
    let headers = headers_for(pathname);
    if head {
        return response::with(200, &headers, Bytes::new());
    }
    let Ok(bytes) = tokio::fs::read(file).await else {
        return response::text(404, &[], "not found");
    };
    if pathname == "/manifest.json" {
        let manifest = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        return serve_manifest(head, manifest, title_suffix);
    }
    if pathname != "/index.html" {
        return response::with(200, &headers, bytes);
    }
    match name_entry_document(&bytes, &instance_display_name(title_suffix)) {
        Ok(named) => response::with(200, &headers, named),
        Err(_) => response::text(500, &[], "Internal Server Error"),
    }
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|meta| meta.is_file())
}

impl StaticFiles {
    pub async fn serve(&self, request: StaticRequest<'_>, title_suffix: &str) -> Response {
        if !is_static_request_method(request.method) {
            return response::text(405, &[("allow", "GET, HEAD")], "method not allowed");
        }
        let Some(pathname) = decode_static_pathname(request.raw_path) else {
            return response::text(400, &[], "bad request");
        };
        let head = request.method == "HEAD";
        let serve_entry = pathname != "/manifest.json"
            && (pathname == "/index.html"
                || should_serve_spa_entry(request.method, request.accept));
        let directories = std::iter::once(&self.public_dir).chain(self.built_public_dir.iter());
        for directory in directories {
            let Some(file) = resolve_public_file_path(directory, &pathname) else {
                return response::text(404, &[], "not found");
            };
            if is_file(&file).await {
                return serve_file(head, &file, &pathname, title_suffix).await;
            }
            if serve_entry {
                let index = directory.join("index.html");
                if is_file(&index).await {
                    return serve_file(head, &index, "/index.html", title_suffix).await;
                }
            }
        }
        // Vite serves source assets before the first build, but proxies
        // this dynamic metadata route to the bridge. Keep the default
        // manifest available then too.
        if pathname == "/manifest.json" {
            let manifest = serde_json::from_str(DEFAULT_MANIFEST).unwrap_or(Value::Null);
            return serve_manifest(head, manifest, title_suffix);
        }
        response::text(404, &[], "not found")
    }
}

#[cfg(test)]
mod tests;
