//! A page's text as served: its root-absolute URLs written under its
//! token (rewriteRootUrls), the URLs of its own origin made root-absolute
//! (localizeOwnOrigin), and the helper's script put first
//! (injectHelper, renderedHelperSource).

use std::sync::LazyLock;

use regex::{Captures, Regex};
use roamgate_base::assets::RENDERED_HELPER_JS;

use super::js;

/// Where a page's root-absolute URLs go and its frame's home
/// (shared/renderedPage.ts RenderedRootMap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootMap {
    pub base: String,
    pub to: String,
    pub home: Option<String>,
}

impl RootMap {
    /// `JSON.stringify` of it.
    pub fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"base\":{},\"to\":{}",
            js::json_string(&self.base),
            js::json_string(&self.to)
        );
        if let Some(home) = &self.home {
            out.push_str(&format!(",\"home\":{}", js::json_string(home)));
        }
        out.push('}');
        out
    }
}

/// A page or a style sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextKind {
    Html,
    Css,
}

/// A URL of a root-absolute path: `[^...]` after its `/` never a second `/`.
const CSS_URL: &str = r#"(?i)url\(\s*(?:"(/(?:[^"')\s/][^"')\s]*)?)"|'(/(?:[^"')\s/][^"')\s]*)?)'|(/(?:[^"')\s/][^"')\s]*)?))\s*\)"#;
const CSS_IMPORT: &str = r#"(?i)@import\s+(?:"(/(?:[^"'/][^"']*)?)"|'(/(?:[^"'/][^"']*)?)')"#;
const ATTR_QUOTED: &str = r#"(?i)(\s(?:src|href|action|poster|data|formaction)\s*=\s*)(?:"(/(?:[^"'/][^"']*)?)"|'(/(?:[^"'/][^"']*)?)')"#;
const ATTR_BARE: &str =
    r#"(?i)(\s(?:src|href|action|poster|data|formaction)\s*=\s*)(/(?:[^\s>"'/][^\s>"']*)?)"#;
const SRCSET: &str = r#"(?i)(\ssrcset\s*=\s*)(?:"([^"']*)"|'([^"']*)')"#;

static CSS_URL_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(CSS_URL));
static CSS_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(CSS_IMPORT));
static ATTR_QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(ATTR_QUOTED));
static ATTR_BARE_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(ATTR_BARE));
static SRCSET_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(SRCSET));

/// The first of the groups that matched, and the quote it stands for.
fn quoted<'t>(caps: &Captures<'t>, groups: &[(usize, &'static str)]) -> (&'static str, &'t str) {
    groups
        .iter()
        .find_map(|(group, quote)| caps.get(*group).map(|found| (*quote, found.as_str())))
        .unwrap_or(("", ""))
}

/// A `srcset`'s candidates, each one's URL mapped (`/^(\s*)(\S+)/`).
fn each_candidate(set: &str, map: &dyn Fn(&str) -> String) -> String {
    set.split(',')
        .map(|part| {
            let url_at = part
                .char_indices()
                .find(|(_, c)| !js::is_space(*c))
                .map_or(part.len(), |(at, _)| at);
            let rest = &part[url_at..];
            let url_end = rest
                .char_indices()
                .find(|(_, c)| js::is_space(*c))
                .map_or(rest.len(), |(at, _)| at);
            if url_end == 0 {
                return part.to_owned();
            }
            format!(
                "{}{}{}",
                &part[..url_at],
                map(&rest[..url_end]),
                &rest[url_end..]
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn rewrite_css(text: &str, one: &dyn Fn(&str) -> String) -> String {
    let urls = CSS_URL_RE.replace_all(text, |caps: &Captures| {
        let (quote, url) = quoted(caps, &[(1, "\""), (2, "'"), (3, "")]);
        format!("url({quote}{}{quote})", one(url))
    });
    CSS_IMPORT_RE
        .replace_all(&urls, |caps: &Captures| {
            let (quote, url) = quoted(caps, &[(1, "\""), (2, "'")]);
            format!("@import {quote}{}{quote}", one(url))
        })
        .into_owned()
}

/// Root-absolute URLs (`/assets/app.js`) of a page under a token would
/// reach Roamgate's root, and a sandboxed page sends no Referer to tell
/// whose they are: they are written under the token instead, in the page's
/// attributes and styles (`map` gives the new path, or `None` to leave one).
pub fn rewrite_root_urls(
    text: &str,
    kind: TextKind,
    map: &dyn Fn(&str) -> Option<String>,
) -> String {
    let one = |url: &str| -> String {
        if url.starts_with('/') && !url.starts_with("//") {
            map(url).unwrap_or_else(|| url.to_owned())
        } else {
            url.to_owned()
        }
    };
    if kind == TextKind::Css {
        return rewrite_css(text, &one);
    }
    let quoted_attrs = ATTR_QUOTED_RE.replace_all(text, |caps: &Captures| {
        let (quote, url) = quoted(caps, &[(2, "\""), (3, "'")]);
        format!("{}{quote}{}{quote}", &caps[1], one(url))
    });
    let bare_attrs = ATTR_BARE_RE.replace_all(&quoted_attrs, |caps: &Captures| {
        let whole = caps.get(0).unwrap();
        // `\/(?!\/)`: a lone `/` before another is no match.
        if quoted_attrs[whole.end()..].starts_with('/') {
            return whole.as_str().to_owned();
        }
        format!("{}\"{}\"", &caps[1], one(&caps[2]))
    });
    let sets = SRCSET_RE.replace_all(&bare_attrs, |caps: &Captures| {
        let (quote, set) = quoted(caps, &[(2, "\""), (3, "'")]);
        format!("{}{quote}{}{quote}", &caps[1], each_candidate(set, &one))
    });
    rewrite_css(&sets, &one)
}

const LINK_OR_META: &str = r"(?i)<(?:link|meta)(?:[^A-Za-z0-9_>][^>]*)?>";
const CANONICAL: &str = r#"(?i)(?<![A-Za-z0-9_])rel\s*=\s*["']?canonical(?![A-Za-z0-9_])"#;
const OG_URL: &str = r#"(?i)(?<![A-Za-z0-9_])property\s*=\s*["']?og:url(?![A-Za-z0-9_])"#;
const LINK_VALUE: &str =
    r#"(?i)(?<![A-Za-z0-9_])(?:href|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#;
const META: &str = r"(?i)<meta(?:[^A-Za-z0-9_>][^>]*)?>";
const SOCIAL: &str = r#"(?i)(?<![A-Za-z0-9_])(?:property|name)\s*=\s*["']?(?:og|twitter):"#;
const META_CONTENT: &str = r#"(?i)(\scontent\s*=\s*)(?:"([^"']*)"|'([^"']*)')"#;
const OWN_ATTRS: &str =
    "src|href|action|poster|data|formaction|data-src|data-href|data-url|data-poster";

static LINK_OR_META_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(LINK_OR_META));
static CANONICAL_RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| js::fancy(CANONICAL));
static OG_URL_RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| js::fancy(OG_URL));
static LINK_VALUE_RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| js::fancy(LINK_VALUE));
static META_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(META));
static SOCIAL_RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| js::fancy(SOCIAL));
static META_CONTENT_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(META_CONTENT));
static OWN_SRCSET_RE: LazyLock<Regex> = LazyLock::new(|| {
    js::regex(r#"(?i)(\s(?:srcset|data-srcset)\s*=\s*)(?:"([^"']*)"|'([^"']*)')"#)
});

/// The http(s) origin a page names as its own (`rel=canonical`, `og:url`).
fn own_origin(html: &str) -> Option<String> {
    for tag in LINK_OR_META_RE.find_iter(html) {
        let tag = tag.as_str();
        let named =
            CANONICAL_RE.is_match(tag).unwrap_or(false) || OG_URL_RE.is_match(tag).unwrap_or(false);
        if !named {
            continue;
        }
        let Ok(Some(value)) = LINK_VALUE_RE.captures(tag) else {
            continue;
        };
        let raw = (1..=3)
            .find_map(|group| value.get(group))
            .map(|found| found.as_str())
            .unwrap_or("");
        if raw.is_empty() {
            continue;
        }
        static AMP: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)&amp;").unwrap());
        let Ok(url) = url::Url::parse(&AMP.replace_all(raw, "&")) else {
            continue;
        };
        if url.scheme() != "http" && url.scheme() != "https" {
            continue;
        }
        return Some(url.origin().ascii_serialization());
    }
    None
}

/// A page of a site built for an origin (Hugo's `baseURL`, a dev server's
/// `http://localhost:1315/` or the published `https://blog.example/`) links
/// to itself by that origin, which would take its frame out of the files
/// shown here: the URLs under the origin it names in `rel=canonical` or
/// `og:url` are written as root-absolute paths, which [`rewrite_root_urls`]
/// then puts under the token. Other origins are left alone.
pub fn localize_own_origin(html: &str, map: &dyn Fn(&str) -> Option<String>) -> String {
    let Some(prefix) = own_origin(html) else {
        return html.to_owned();
    };
    let escaped = regex::escape(&prefix);
    let under = |url: &str| -> String {
        if let Some(rest) = url.strip_prefix(prefix.as_str()) {
            if rest.starts_with('/') {
                return rest.to_owned();
            }
            if rest.is_empty() {
                return "/".to_owned();
            }
        }
        url.to_owned()
    };
    let quoted_re = js::regex(&format!(
        r#"(?i)(\s(?:{OWN_ATTRS})\s*=\s*)(?:"({escaped}(?:/[^"']*)?)"|'({escaped}(?:/[^"']*)?)')"#
    ));
    let bare_re = js::regex(&format!(
        r#"(?i)(\s(?:{OWN_ATTRS})\s*=\s*)({escaped}(?:/[^\s>"']*)?)"#
    ));
    let style_re = js::regex(&format!(
        r#"(?i)url\(\s*(?:"({escaped}/[^"')\s]*)"|'({escaped}/[^"')\s]*)'|({escaped}/[^"')\s]*))\s*\)"#
    ));
    let quoted_attrs = quoted_re.replace_all(html, |caps: &Captures| {
        let (quote, url) = quoted(caps, &[(2, "\""), (3, "'")]);
        format!("{}{quote}{}{quote}", &caps[1], under(url))
    });
    let bare_attrs = bare_re.replace_all(&quoted_attrs, |caps: &Captures| {
        let whole = caps.get(0).unwrap();
        // `(?=[\s>])`: only a URL that ends the attribute.
        let ends = quoted_attrs[whole.end()..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || js::is_space(c));
        if !ends {
            return whole.as_str().to_owned();
        }
        format!("{}\"{}\"", &caps[1], under(&caps[2]))
    });
    let sets = OWN_SRCSET_RE.replace_all(&bare_attrs, |caps: &Captures| {
        let (quote, set) = quoted(caps, &[(2, "\""), (3, "'")]);
        format!("{}{quote}{}{quote}", &caps[1], each_candidate(set, &under))
    });
    let metas = META_RE.replace_all(&sets, |caps: &Captures| {
        let tag = &caps[0];
        if !SOCIAL_RE.is_match(tag).unwrap_or(false) {
            return tag.to_owned();
        }
        META_CONTENT_RE
            .replacen(tag, 1, |inner: &Captures| {
                let (quote, url) = quoted(inner, &[(2, "\""), (3, "'")]);
                let path = under(url);
                let value = if path == url {
                    path
                } else {
                    map(&path).unwrap_or(path)
                };
                format!("{}{quote}{value}{quote}", &inner[1])
            })
            .into_owned()
    });
    style_re
        .replace_all(&metas, |caps: &Captures| {
            let (quote, url) = quoted(caps, &[(1, "\""), (2, "'"), (3, "")]);
            format!("url({quote}{}{quote})", under(url))
        })
        .into_owned()
}

/// The helper, called with its prefix, as the body of a `<script>`
/// (rendered-helper.ts): the built contract asset inside a function, so
/// its one top-level `var` stays out of the page's globals. `root`
/// defaults to `{base: "/", to: prefix}`; `storage`, the listed site's
/// items in order, to `null`.
pub fn rendered_helper_source(
    prefix: &str,
    root: Option<&RootMap>,
    storage: Option<&[(String, String)]>,
) -> String {
    // `<` cannot occur in the prefix (a token path), so the script cannot
    // be closed early; escape it anyway.
    let quoted = js::json_string(prefix).replace('<', "\\u003c");
    let default_root;
    let root = match root {
        Some(root) => root,
        None => {
            default_root = RootMap {
                base: "/".to_owned(),
                to: prefix.to_owned(),
                home: None,
            };
            &default_root
        }
    };
    let rooted = root.to_json().replace('<', "\\u003c");
    // The items are the page's own, untrusted text: `<` (a `</script>`)
    // and the line separators are escaped so no value can end or break
    // the script.
    let stored = storage
        .map_or_else(|| "null".to_owned(), js::json_object)
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        "(function(){{{RENDERED_HELPER_JS}\nroamgateRenderedHelper({quoted}, {rooted}, {stored});}})();"
    )
}

static HEAD_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(r"(?i)<head(?:\s[^>]*)?>"));
static HTML_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(r"(?i)<html(?:\s[^>]*)?>"));
static DOCTYPE_RE: LazyLock<Regex> = LazyLock::new(|| js::regex(r"(?i)^\s*<!doctype[^>]*>"));

/// The helper's tag, right after `<head>` (or `<html>`, or first).
pub fn inject_helper(
    html: &str,
    nonce: &str,
    prefix: &str,
    root: Option<&RootMap>,
    storage: Option<&[(String, String)]>,
) -> String {
    let tag = format!(
        "<script nonce=\"{nonce}\">{}</script>",
        rendered_helper_source(prefix, root, storage)
    );
    let at = HEAD_RE
        .find(html)
        .or_else(|| HTML_RE.find(html))
        .or_else(|| DOCTYPE_RE.find(html))
        .map_or(0, |found| found.end());
    let mut out = String::with_capacity(html.len() + tag.len());
    out.push_str(&html[..at]);
    out.push_str(&tag);
    out.push_str(&html[at..]);
    out
}
