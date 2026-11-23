//! What a rendered review's page is served from (renderedAddress), with
//! the parts of shared/renderedPage.ts it needs: the listed sites a file
//! or URL is under, a review's URL cleaned, and a frame's home checked.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use super::{RenderedMode, RenderedSource, js, page_path};

/// A home: a relative directory path, "" or ending in `/`, no dot parts
/// (validHome).
pub fn valid_home(home: &str) -> bool {
    if home.is_empty() {
        return true;
    }
    if !home.ends_with('/') || js::length(home) > 1024 || home.contains(['?', '#', '\\']) {
        return false;
    }
    home[..home.len() - 1]
        .split('/')
        .all(|part| !part.is_empty() && !dot_part(part))
}

/// `/^(\.|%2e){1,2}$/i`.
pub(crate) fn dot_part(part: &str) -> bool {
    matches!(
        part.to_ascii_lowercase().as_str(),
        "." | ".." | "%2e" | "%2e%2e" | ".%2e" | "%2e."
    )
}

fn http_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return None;
    }
    Some(url)
}

fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// The listed directory an absolute file path is under, if any.
pub fn listed_directory<'s>(sites: &'s [String], path: &str) -> Option<&'s String> {
    if !path.starts_with('/') {
        return None;
    }
    sites
        .iter()
        .find(|site| site.starts_with('/') && path.starts_with(site.as_str()))
}

/// The listed site a URL is under, if any.
pub fn listed_site<'s>(sites: &'s [String], url: &str) -> Option<&'s String> {
    let parsed = http_url(url)?;
    let href = format!("{}{}", origin(&parsed), parsed.path());
    sites.iter().find(|site| href.starts_with(site.as_str()))
}

/// An http(s) URL a review may open, cleaned of credentials and fragment.
pub fn parse_site_url(value: &str) -> Option<String> {
    if js::length(value) > 2048 {
        return None;
    }
    let mut url = http_url(js::trim(value))?;
    url.set_fragment(None);
    Some(url.to_string())
}

/// The http(s) URL's directory: its origin and path up to the last `/`.
pub fn url_directory(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid URL".to_owned())?;
    let path = parsed.path();
    let directory = &path[..path.rfind('/').map_or(0, |slash| slash + 1)];
    Ok(format!("{}{directory}", origin(&parsed)))
}

/// What a review shows: a file of its checkout, or a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressTarget<'a> {
    Path(&'a str),
    Url(Option<&'a str>),
}

/// A listed site's root, when not the listed entry itself: the root set
/// for it in Settings (`explicit`), or the one found for its directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteRootChoice {
    pub root: String,
    pub explicit: bool,
}

/// The root of a listed site, when one is set or found.
pub type RootOf<'a> = dyn Fn(&str) -> Option<SiteRootChoice> + 'a;

pub struct AddressParams<'a> {
    pub target: AddressTarget<'a>,
    pub root: &'a str,
    pub sites: &'a [String],
    pub page: Option<&'a str>,
    /// The user turned scripts on for this file or site, listed or not.
    pub scripts: bool,
    pub root_of: Option<&'a RootOf<'a>>,
}

impl<'a> AddressParams<'a> {
    pub fn new(target: AddressTarget<'a>, root: &'a str, sites: &'a [String]) -> Self {
        Self {
            target,
            root,
            sites,
            page: None,
            scripts: false,
            root_of: None,
        }
    }
}

/// Where a page is served from, and the path under its token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedAddress {
    pub mode: RenderedMode,
    pub source: RenderedSource,
    pub rest: String,
    pub site: Option<String>,
    /// Its file's or URL's directory under the token (the entry's home).
    pub home: Option<String>,
}

static PAGE_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.x?html?$").unwrap());

/// What a rendered review's page is served from, and the path under its
/// token: an HTML file of the checkout (with the files of its directory),
/// or a site's URL. Listed sites and directories (the user's) run their
/// scripts; anything else is static. An error when there is no page.
pub fn rendered_address(params: &AddressParams<'_>) -> Result<RenderedAddress, String> {
    let site_root_of = |site: Option<&String>| -> Option<SiteRootChoice> {
        let site = site?;
        let found = (params.root_of?)(site)?;
        let top = if found.root.ends_with('/') {
            found.root.clone()
        } else {
            format!("{}/", found.root)
        };
        (site.starts_with(&top) && !top.split('/').any(|part| part == "." || part == ".."))
            .then_some(SiteRootChoice {
                root: top,
                explicit: found.explicit,
            })
    };
    let mode = |listed: bool| {
        if listed || params.scripts {
            RenderedMode::Site
        } else {
            RenderedMode::Static
        }
    };
    match params.target {
        AddressTarget::Path(path) => {
            if path.is_empty()
                || path.starts_with('/')
                || path.contains('\0')
                || path
                    .split('/')
                    .any(|part| part == ".." || part == "." || part.is_empty())
            {
                return Err("invalid path".to_owned());
            }
            if !PAGE_FILE.is_match(path) {
                return Err("only HTML files are shown as pages".to_owned());
            }
            let absolute = format!("{}/{path}", params.root.trim_end_matches('/'));
            // Served from the listed folder, or else the checkout: a page's
            // relative links reach their siblings and parents, nothing above.
            let site = listed_directory(params.sites, &absolute);
            let site_root = site_root_of(site);
            let or_root = |directory: &str| {
                if directory.is_empty() {
                    "/".to_owned()
                } else {
                    directory.to_owned()
                }
            };
            // Scripts on for this one file: only its own folder is served.
            let directory = match site {
                Some(site) => or_root(
                    site_root
                        .as_ref()
                        .map_or(site.as_str(), |found| found.root.as_str())
                        .trim_end_matches('/'),
                ),
                None if params.scripts => or_root(&absolute[..absolute.rfind('/').unwrap_or(0)]),
                None => params.root.to_owned(),
            };
            let skip = directory.trim_end_matches('/').len() + 1;
            let inside = absolute.get(skip..).unwrap_or("");
            let mut rest = inside
                .split('/')
                .map(js::encode_uri_component)
                .collect::<Vec<_>>()
                .join("/");
            let home = rest[..rest.rfind('/').map_or(0, |slash| slash + 1)].to_owned();
            if let Some(page) = params.page {
                // As the helper reports it: a path under the directory, its query.
                let path_part = page.split_once('?').map_or(page, |(path, _)| path);
                if page_path(path_part).is_none() {
                    return Err("invalid page".to_owned());
                }
                rest = page.to_owned();
            }
            Ok(RenderedAddress {
                mode: mode(site.is_some()),
                source: RenderedSource::Files {
                    root: directory,
                    site: site.cloned(),
                    // Its root is looked for above it until found or set.
                    walk: site.is_some() && site_root.is_none(),
                },
                rest,
                site: site.cloned(),
                home: (!home.is_empty()).then_some(home),
            })
        }
        AddressTarget::Url(value) => {
            let url = value
                .and_then(parse_site_url)
                .ok_or_else(|| "a rendered review shows a file or an http(s) URL".to_owned())?;
            let site = listed_site(params.sites, &url);
            // A site's root set in Settings: its root-absolute links start there.
            let explicit = site_root_of(site);
            let base = match (&explicit, site) {
                (Some(found), _) if found.explicit => found.root.clone(),
                (_, Some(site)) => site.clone(),
                _ => url_directory(&url)?,
            };
            let mut at = url.clone();
            if let Some(page) = params.page {
                let next = Url::parse(&base)
                    .and_then(|base| base.join(page))
                    .map_err(|_| "invalid page".to_owned())?
                    .to_string();
                if !next.starts_with(&base) {
                    return Err("the page is off the site".to_owned());
                }
                at = next;
            }
            let directory = url_directory(&url)?;
            let home = directory.strip_prefix(base.as_str()).unwrap_or("");
            Ok(RenderedAddress {
                mode: mode(site.is_some()),
                source: RenderedSource::Url {
                    base: base.clone(),
                    site: site.cloned(),
                },
                rest: at.get(base.len()..).unwrap_or("").to_owned(),
                site: site.cloned(),
                home: (!home.is_empty() && valid_home(home)).then(|| home.to_owned()),
            })
        }
    }
}
