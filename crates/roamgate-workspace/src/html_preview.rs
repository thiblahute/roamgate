//! A workspace's HTML page rendered for the sandboxed preview
//! (workspace/html-preview.ts): scripts, bases and referrer overrides
//! dropped, local stylesheets, images and fonts inlined as data URLs within
//! budgets, HTTPS stylesheets left to the browser. lol_html rewrites the
//! page as Bun's HTMLRewriter (the same library) did; lightningcss bundles
//! and minifies the styles Bun.build bundled.
//!
//! Rendering is synchronous, reads included, as both libraries are: the
//! async callers run it on a blocking thread ([`render_html_preview_file`]).
//! Reads are one at a time, as the TS chained them.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::LazyLock;

use base64::Engine as _;
use lightningcss::rules::CssRule;
use lightningcss::rules::import::ImportRule;
use lightningcss::stylesheet::{MinifyOptions, ParserOptions, PrinterOptions, StyleSheet};
use lightningcss::targets::{Browsers, Targets};
use lightningcss::traits::ToCss;
use lightningcss::values::url::Url as CssUrl;
use lightningcss::visitor::{Visit, VisitTypes, Visitor};
use lol_html::html_content::ContentType;
use lol_html::{RewriteStrSettings, element, rewrite_str, text};
use roamgate_git::preview::{
    PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES, image_mime_for_path, is_html_path,
};

use crate::html_preview_files::{HtmlPreviewError, PreviewResource};

/// The preview's Content-Security-Policy.
pub const HTML_PREVIEW_CSP: &str = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' data: https:; img-src data:; font-src data:";
const MAX_RESOURCES: usize = 64;
const MAX_RESOURCE_BYTES: usize = 10 * 1024 * 1024;
const MAX_STYLE_BLOCKS: usize = 256;

static SCHEME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z\d+.-]*:").unwrap());
static DATA_URL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^data:").unwrap());
static RESOURCE_SYNTAX: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)url|image-set|@import").unwrap());
static DESCRIPTOR: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)$").unwrap());
static STYLE_END: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)</style").unwrap());

/// JS `String.prototype.trim`'s whitespace.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

/// The media type a resource of the page may be inlined with.
pub fn static_preview_mime(path: &str) -> Option<String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".css") {
        return Some("text/css".into());
    }
    let extension = lower.rsplit('.').next().unwrap_or("");
    if matches!(extension, "woff" | "woff2" | "ttf" | "otf") {
        return Some(format!("font/{extension}"));
    }
    image_mime_for_path(path).map(str::to_owned)
}

/// An HTTPS stylesheet the browser may fetch itself (no credentials).
pub fn https_stylesheet_url(source: &str) -> Option<String> {
    let value = js_trim(source);
    let absolute = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_owned()
    };
    let url = url::Url::parse(&absolute).ok()?;
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none())
        .then(|| url.as_str().to_owned())
}

/// encodeURIComponent.
fn encode_uri_component(value: &str) -> String {
    const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(value, KEEP).to_string()
}

/// Node's `posix.normalize` of an absolute path.
fn posix_normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let mut out = format!("/{}", parts.join("/"));
    if path.ends_with('/') && out != "/" {
        out.push('/');
    }
    out
}

/// A relative reference of the page or a stylesheet, as a path in the
/// workspace; `None` for fragments, other origins and schemes.
pub fn resource_path(source: &str, document_path: &str) -> Option<String> {
    let value = js_trim(source);
    if value.is_empty()
        || value.starts_with('#')
        || value.starts_with("//")
        || SCHEME.is_match(value)
    {
        return None;
    }
    let base = format!(
        "https://preview.invalid/{}",
        document_path
            .split('/')
            .map(encode_uri_component)
            .collect::<Vec<_>>()
            .join("/")
    );
    let url = url::Url::parse(&base).ok()?.join(value).ok()?;
    if url.scheme() != "https" || url.host_str() != Some("preview.invalid") || url.port().is_some()
    {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(url.path())
        .decode_utf8()
        .ok()?
        .replace('\\', "/");
    let path = posix_normalize(&decoded);
    if path.contains('\0') {
        return None;
    }
    Some(path.trim_start_matches('/').to_owned())
}

/// A file's text: UTF-8 without NUL, its byte order mark dropped (as
/// TextDecoder drops it).
pub fn preview_text(bytes: &[u8]) -> Result<&str, HtmlPreviewError> {
    let utf8 = || HtmlPreviewError::new("HTML preview requires UTF-8 text");
    if bytes.contains(&0) {
        return Err(utf8());
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    std::str::from_utf8(bytes).map_err(|_| utf8())
}

type Read<'r> = dyn FnMut(&str, usize) -> Result<PreviewResource, HtmlPreviewError> + 'r;
type Cached = Result<Option<Rc<PreviewResource>>, HtmlPreviewError>;

struct Renderer<'r> {
    document_path: String,
    read_resource: RefCell<&'r mut Read<'r>>,
    resources: RefCell<HashMap<String, Cached>>,
    total_bytes: Cell<usize>,
    style_blocks: Cell<usize>,
    embedded_bytes: Cell<usize>,
}

fn too_large(message: &str) -> HtmlPreviewError {
    HtmlPreviewError::with_status(message, 413)
}

impl Renderer<'_> {
    fn embedded(&self, value: String) -> Result<String, HtmlPreviewError> {
        self.embedded_bytes
            .set(self.embedded_bytes.get() + value.len());
        if self.embedded_bytes.get() > MAX_RESOURCE_BYTES * 2 {
            return Err(too_large("HTML preview output is too large"));
        }
        Ok(value)
    }

    fn read(&self, path: &str) -> Cached {
        if let Some(cached) = self.resources.borrow().get(path) {
            return cached.clone();
        }
        if self.resources.borrow().len() >= MAX_RESOURCES {
            return Err(too_large("HTML preview has too many resources"));
        }
        let Some(mime) = static_preview_mime(path) else {
            return Ok(None);
        };
        let result = self.read_new(path, &mime).or_else(|error| {
            if error.status == 413 {
                Err(error)
            } else {
                Ok(None)
            }
        });
        self.resources
            .borrow_mut()
            .insert(path.to_owned(), result.clone());
        result
    }

    fn read_new(&self, path: &str, mime: &str) -> Cached {
        let remaining = MAX_RESOURCE_BYTES.saturating_sub(self.total_bytes.get());
        if remaining == 0 {
            return Err(too_large("HTML preview resources are too large"));
        }
        let cap = if mime == "text/css" {
            PREVIEW_MAX_BYTES
        } else {
            PREVIEW_IMAGE_MAX_BYTES
        };
        let resource = (self.read_resource.borrow_mut())(path, cap.min(remaining))?;
        self.total_bytes
            .set(self.total_bytes.get() + resource.bytes.len());
        if self.total_bytes.get() > MAX_RESOURCE_BYTES {
            return Err(too_large("HTML preview resources are too large"));
        }
        Ok(
            (static_preview_mime(&resource.path).as_deref() == Some(mime))
                .then(|| Rc::new(resource)),
        )
    }

    fn asset_url(&self, value: &str, path: &str) -> Result<String, HtmlPreviewError> {
        let trimmed = js_trim(value);
        if DATA_URL.is_match(trimmed) || trimmed.starts_with('#') {
            return Ok(value.to_owned());
        }
        let Some(target) = resource_path(value, path) else {
            return Ok("data:,".into());
        };
        let Some(mime) = static_preview_mime(&target).filter(|m| m != "text/css") else {
            return Ok("data:,".into());
        };
        match self.read(&target)? {
            Some(resource) => self.embedded(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&resource.bytes)
            )),
            None => Ok("data:,".into()),
        }
    }

    /// A style sheet's text with its local imports bundled in, its URLs
    /// inlined, minified; as it is when it refers to nothing.
    fn css(&self, contents: &str, path: &str) -> Result<String, HtmlPreviewError> {
        if !RESOURCE_SYNTAX.is_match(contents) && !contents.contains('\\') {
            return Ok(contents.to_owned());
        }
        self.style_blocks.set(self.style_blocks.get() + 1);
        if self.style_blocks.get() > MAX_STYLE_BLOCKS {
            return Err(too_large("HTML preview has too many style blocks"));
        }
        let mut externals = Vec::new();
        let mut visiting = HashSet::from([path.to_owned()]);
        let body = self.bundle(contents, path, &mut externals, &mut visiting)?;
        let mut combined = externals.concat();
        combined.push_str(&body);
        let bundled = minify(&combined, path)
            .ok_or_else(|| HtmlPreviewError::new("Unable to prepare HTML preview styles"))?;
        self.embedded(bundled)
    }

    /// One sheet's rules after its imports' (as the bundler places them),
    /// unminified; HTTPS and refused imports go to `externals`.
    fn bundle(
        &self,
        contents: &str,
        path: &str,
        externals: &mut Vec<String>,
        visiting: &mut HashSet<String>,
    ) -> Result<String, HtmlPreviewError> {
        let unable = || HtmlPreviewError::new("Unable to prepare HTML preview styles");
        let options = ParserOptions {
            filename: path.to_owned(),
            error_recovery: true,
            ..ParserOptions::default()
        };
        let mut sheet = StyleSheet::parse(contents, options).map_err(|_| unable())?;
        let mut urls = UrlInliner {
            renderer: self,
            path,
        };
        sheet.visit(&mut urls)?;
        let mut imported = String::new();
        let mut rules = Vec::new();
        for rule in std::mem::take(&mut sheet.rules.0) {
            let CssRule::Import(import) = rule else {
                rules.push(rule);
                continue;
            };
            // Bun takes `@import url(x)` for a URL token, inlined as an
            // asset: a style sheet is no asset, so it stays as `data:,`.
            if import_is_url_token(contents, &import) {
                let url = self.asset_url(&import.url, path)?;
                externals.push(external_import(&import, url).ok_or_else(unable)?);
                continue;
            }
            if let Some(external) = https_stylesheet_url(&import.url) {
                externals.push(external_import(&import, external).ok_or_else(unable)?);
                continue;
            }
            let target = resource_path(&import.url, path)
                .filter(|t| static_preview_mime(t).as_deref() == Some("text/css"));
            let Some(target) = target else {
                externals
                    .push(external_import(&import, "data:text/css,".into()).ok_or_else(unable)?);
                continue;
            };
            let Some(resource) = self.read(&target)? else {
                continue;
            };
            if !visiting.insert(resource.path.clone()) {
                continue;
            }
            let text = self.bundle(
                preview_text(&resource.bytes)?,
                &resource.path,
                externals,
                visiting,
            )?;
            imported.push_str(&wrap_conditions(&import, text).ok_or_else(unable)?);
        }
        sheet.rules.0 = rules;
        let printed = sheet
            .to_css(PrinterOptions::default())
            .map_err(|_| unable())?;
        Ok(imported + &printed.code)
    }

    fn srcset(&self, value: &str) -> Result<String, HtmlPreviewError> {
        let mut candidates = Vec::new();
        let mut rest = value;
        while !js_trim(rest).is_empty() {
            rest = rest.trim_start_matches(|c: char| js_space(c) || c == ',');
            let end = rest.find(js_space).unwrap_or(rest.len());
            if end == 0 {
                break;
            }
            let url = &rest[..end];
            rest = &rest[end..];
            let mut descriptor = "";
            if !url.ends_with(',') {
                match rest.find(',') {
                    Some(comma) => {
                        descriptor = js_trim(&rest[..comma]);
                        rest = &rest[comma + 1..];
                    }
                    None => {
                        descriptor = js_trim(rest);
                        rest = "";
                    }
                }
            }
            if !descriptor.is_empty() && !DESCRIPTOR.is_match(descriptor) {
                continue;
            }
            let inlined = self.asset_url(url.trim_end_matches(','), &self.document_path)?;
            candidates.push(js_trim(&format!("{inlined} {descriptor}")).to_owned());
        }
        Ok(candidates.join(", "))
    }
}

/// An import left to the browser, with its conditions.
fn external_import(import: &ImportRule, url: String) -> Option<String> {
    let mut external = import.clone();
    external.url = url.into();
    Some(external.to_css_string(PrinterOptions::default()).ok()? + "\n")
}

/// Whether an import's address is written `url(...)`, read in the sheet's
/// text from the rule's start.
fn import_is_url_token(contents: &str, import: &ImportRule) -> bool {
    let Some(line) = contents.split('\n').nth(import.loc.line as usize) else {
        return false;
    };
    let column = (import.loc.column as usize).saturating_sub(1);
    let start: usize = line
        .char_indices()
        .scan(0usize, |units, (at, c)| {
            let here = *units;
            *units += c.len_utf16();
            Some((at, here))
        })
        .find(|(_, units)| *units >= column)
        .map_or(line.len(), |(at, _)| at);
    let line_start = contents
        .split('\n')
        .take(import.loc.line as usize)
        .map(|l| l.len() + 1)
        .sum::<usize>();
    let rest = &contents[line_start + start..];
    let lower = rest.to_ascii_lowercase();
    let quote = rest.find(['"', '\'']);
    match (lower.find("url("), quote) {
        (Some(url), Some(quote)) => url < quote,
        (Some(_), None) => true,
        _ => false,
    }
}

/// An imported sheet under its import's layer, supports and media
/// conditions.
fn wrap_conditions(import: &ImportRule, text: String) -> Option<String> {
    let mut text = text;
    if !import.media.media_queries.is_empty() {
        let media = import.media.to_css_string(PrinterOptions::default()).ok()?;
        text = format!("@media {media} {{\n{text}}}\n");
    }
    if let Some(supports) = &import.supports {
        let condition = supports.to_css_string(PrinterOptions::default()).ok()?;
        text = format!("@supports ({condition}) {{\n{text}}}\n");
    }
    if let Some(layer) = &import.layer {
        let name = match layer {
            Some(name) => format!(" {}", name.to_css_string(PrinterOptions::default()).ok()?),
            None => String::new(),
        };
        text = format!("@layer{name} {{\n{text}}}\n");
    }
    Some(text)
}

/// Bun's CSS bundler's default browsers: Chrome 87, Edge 88, Firefox 78,
/// Safari 14 (and iOS Safari 14), the prefixes and lowerings it adds.
fn bun_targets() -> Targets {
    let version = |major: u32| Some(major << 16);
    Targets::from(Browsers {
        chrome: version(87),
        edge: version(88),
        firefox: version(78),
        safari: version(14),
        ios_saf: version(14),
        ..Browsers::default()
    })
}

/// Minified for Bun's targets, ending with a newline as Bun's output does.
fn minify(text: &str, path: &str) -> Option<String> {
    let options = ParserOptions {
        filename: path.to_owned(),
        error_recovery: true,
        ..ParserOptions::default()
    };
    let mut sheet = StyleSheet::parse(text, options).ok()?;
    sheet
        .minify(MinifyOptions {
            targets: bun_targets(),
            ..MinifyOptions::default()
        })
        .ok()?;
    let printed = sheet
        .to_css(PrinterOptions {
            minify: true,
            targets: bun_targets(),
            ..PrinterOptions::default()
        })
        .ok()?;
    Some(printed.code + "\n")
}

struct UrlInliner<'a, 'r> {
    renderer: &'a Renderer<'r>,
    path: &'a str,
}

impl<'i> Visitor<'i> for UrlInliner<'_, '_> {
    type Error = HtmlPreviewError;

    fn visit_types(&self) -> VisitTypes {
        // Every kind: a URL may sit in an image, an image set or a token
        // list, which are only walked when their kind is asked for.
        VisitTypes::all()
    }

    fn visit_url(&mut self, url: &mut CssUrl<'i>) -> Result<(), Self::Error> {
        let inlined = self.renderer.asset_url(&url.url, self.path)?;
        url.url = inlined.into();
        Ok(())
    }
}

fn handler_error(error: HtmlPreviewError) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(error)
}

/// The page rendered for the preview; `read_resource` reads a workspace
/// path up to a byte limit (the page's stylesheets, images and fonts).
pub fn render_html_preview(
    document: &PreviewResource,
    read_resource: &mut Read<'_>,
) -> Result<String, HtmlPreviewError> {
    if !is_html_path(&document.path) {
        return Err(HtmlPreviewError::new("HTML preview requires an HTML file"));
    }
    if document.bytes.len() > PREVIEW_MAX_BYTES {
        return Err(too_large("HTML is too large to render"));
    }
    let source = preview_text(&document.bytes)?;
    let renderer = Renderer {
        document_path: document.path.clone(),
        read_resource: RefCell::new(read_resource),
        resources: RefCell::new(HashMap::new()),
        total_bytes: Cell::new(0),
        style_blocks: Cell::new(0),
        embedded_bytes: Cell::new(0),
    };
    let renderer = &renderer;
    let doc_path = document.path.as_str();
    let style_text = RefCell::new(String::new());
    let style_text = &style_text;
    let settings = RewriteStrSettings {
        element_content_handlers: vec![
            element!("base, script", |element| {
                element.remove();
                Ok(())
            }),
            element!("meta[name]", |element| {
                if element
                    .get_attribute("name")
                    .is_some_and(|name| name.to_lowercase() == "referrer")
                {
                    element.remove();
                }
                Ok(())
            }),
            element!("link", |element| {
                let rel = element
                    .get_attribute("rel")
                    .unwrap_or_default()
                    .to_lowercase();
                if !rel.split(js_space).any(|word| word == "stylesheet") {
                    element.remove();
                    return Ok(());
                }
                let href = element.get_attribute("href").unwrap_or_default();
                element.set_attribute("referrerpolicy", "no-referrer")?;
                if let Some(external) = https_stylesheet_url(&href) {
                    element.set_attribute("href", &external)?;
                    return Ok(());
                }
                let path = resource_path(&href, doc_path)
                    .filter(|p| static_preview_mime(p).as_deref() == Some("text/css"));
                let Some(path) = path else {
                    element.remove();
                    return Ok(());
                };
                let Some(resource) = renderer.read(&path).map_err(handler_error)? else {
                    element.remove();
                    return Ok(());
                };
                let text = preview_text(&resource.bytes).map_err(handler_error)?;
                let bundled = renderer.css(text, &resource.path).map_err(handler_error)?;
                let href = renderer
                    .embedded(format!(
                        "data:text/css;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bundled)
                    ))
                    .map_err(handler_error)?;
                element.set_attribute("href", &href)?;
                element.remove_attribute("integrity");
                element.remove_attribute("crossorigin");
                Ok(())
            }),
            element!("img, source, image, input[type=image]", |element| {
                for attribute in ["src", "href", "xlink:href"] {
                    if let Some(value) = element.get_attribute(attribute) {
                        let inlined = renderer
                            .asset_url(&value, doc_path)
                            .map_err(handler_error)?;
                        element.set_attribute(attribute, &inlined)?;
                    }
                }
                if let Some(value) = element.get_attribute("srcset") {
                    let inlined = renderer.srcset(&value).map_err(handler_error)?;
                    element.set_attribute("srcset", &inlined)?;
                }
                Ok(())
            }),
            element!("[style]", |element| {
                let style = element.get_attribute("style").unwrap_or_default();
                let bundled = renderer
                    .css(&format!("x{{{style}}}"), &format!("{doc_path}.css"))
                    .map_err(handler_error)?;
                element.set_attribute("style", &js_inner_braces(&bundled))?;
                Ok(())
            }),
            element!("style", |_element| {
                style_text.borrow_mut().clear();
                Ok(())
            }),
            text!("style", |chunk| {
                style_text.borrow_mut().push_str(chunk.as_str());
                if chunk.last_in_text_node() {
                    let text = std::mem::take(&mut *style_text.borrow_mut());
                    let bundled = renderer
                        .css(&text, &format!("{doc_path}.css"))
                        .map_err(handler_error)?;
                    let escaped = STYLE_END.replace_all(&bundled, "\\3c /style");
                    chunk.replace(&escaped, ContentType::Html);
                } else {
                    chunk.remove();
                }
                Ok(())
            }),
        ],
        ..RewriteStrSettings::new()
    };
    let html = rewrite_str(source, settings).map_err(|error| match error {
        lol_html::errors::RewritingError::ContentHandlerError(inner) => {
            match inner.downcast::<HtmlPreviewError>() {
                Ok(preview) => *preview,
                Err(other) => HtmlPreviewError::new(other.to_string()),
            }
        }
        other => HtmlPreviewError::new(other.to_string()),
    })?;
    if html.len() > MAX_RESOURCE_BYTES * 2 {
        return Err(too_large("HTML preview output is too large"));
    }
    Ok(html)
}

/// `value.slice(value.indexOf("{") + 1, value.lastIndexOf("}"))`.
fn js_inner_braces(value: &str) -> String {
    let start = value.find('{').map_or(0, |at| at + 1);
    let end = value.rfind('}').unwrap_or(value.len().saturating_sub(1));
    if end <= start {
        return String::new();
    }
    value[start..end].to_owned()
}

#[cfg(test)]
mod tests;
