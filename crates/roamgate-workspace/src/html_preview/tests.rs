//! html-preview.test.ts, at the render and read level: the response
//! headers of a preview are the file handlers'.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use roamgate_git::exec::{LocalRunner, RunFuture};
use roamgate_git::{GitContext, Invocation, Request, RunError, Runner};

use super::*;
use crate::html_preview_files::{AFTER_STAT, read_html_preview_file, render_html_preview_file};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(PNG)
        .unwrap()
}

/// Runs an SSH command line on this machine with bash, `base64` taking a
/// file argument as GNU's does, and an optional prefix of its own. The
/// login shell the line asks for runs without this machine's profile,
/// which is not under test and takes seconds in a busy toolbox.
struct FakeSsh {
    prefix: String,
    transferred: std::sync::Mutex<usize>,
}

impl Runner for FakeSsh {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            let command = match &request.invocation {
                Invocation::Ssh { command, .. } => command.clone(),
                Invocation::Local(_) => return Err(RunError("local".into())),
            };
            let command = command.replacen("bash -lc ", "bash -c ", 1);
            let line = format!(
                "base64() {{ if [ \"$#\" -eq 1 ]; then command base64 < \"$1\"; else command base64; fi; }}; export -f base64; {}{command}",
                self.prefix
            );
            let ran = LocalRunner::system()
                .run_local(
                    &[crate::test_support::bash(), "-c".into(), line],
                    None,
                    request.timeout,
                )
                .await?;
            *self.transferred.lock().unwrap() = ran.stdout.len();
            Ok(ran)
        })
    }
}

fn ssh(prefix: &str) -> (GitContext, Arc<FakeSsh>) {
    let runner = Arc::new(FakeSsh {
        prefix: prefix.to_owned(),
        transferred: std::sync::Mutex::new(0),
    });
    (
        GitContext::new(Some("example.invalid".into()), runner.clone()),
        runner,
    )
}

fn local() -> GitContext {
    GitContext::local(Arc::new(LocalRunner::system()))
}

fn contexts() -> Vec<GitContext> {
    vec![local(), ssh("").0]
}

fn resource(path: &str, bytes: impl Into<Vec<u8>>) -> PreviewResource {
    PreviewResource {
        path: path.into(),
        bytes: bytes.into(),
    }
}

fn root_of(dir: &tempfile::TempDir) -> &str {
    dir.path().to_str().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn renders_bounded_utf_8_html_within_its_limit_and_refuses_one_byte_more() {
    for cx in contexts() {
        let dir = tempfile::tempdir().unwrap();
        let mut html = "<!doctype html><h1>boundary marker</h1>".to_owned();
        while html.len() < PREVIEW_MAX_BYTES {
            html.push(' ');
        }
        fs::write(dir.path().join("page.HTM"), &html).unwrap();
        let rendered = render_html_preview_file(&cx, root_of(&dir), "page.HTM")
            .await
            .unwrap();
        assert!(rendered.contains("boundary marker"));
        assert_eq!(
            HTML_PREVIEW_CSP,
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' data: https:; img-src data:; font-src data:"
        );
        fs::write(dir.path().join("page.HTM"), html + "x").unwrap();
        let error = render_html_preview_file(&cx, root_of(&dir), "page.HTM")
            .await
            .unwrap_err();
        assert_eq!(error.status, 413, "{error:?}");
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn rejects_binary_files_directories_missing_files_and_symlink_escapes() {
    for cx in contexts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("binary.html"), [0u8, 255]).unwrap();
        fs::create_dir(root.join("directory.html")).unwrap();
        std::os::unix::fs::symlink(root.join(".."), root.join("outside")).unwrap();
        for path in [
            "binary.html",
            "directory.html",
            "missing.html",
            "outside/missing.html",
        ] {
            let error = render_html_preview_file(&cx, root_of(&dir), path)
                .await
                .unwrap_err();
            assert_eq!(error.status, 400, "{path}: {error:?}");
        }
        assert!(
            read_html_preview_file(&cx, root_of(&dir), "outside", 100)
                .await
                .is_err()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn inlines_relative_css_imports_images_and_fonts_without_reading_external_or_executable_resources()
 {
    for cx in contexts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("docs/styles")).unwrap();
        fs::write(
            root.join("docs/styles/main.css"),
            "@import \"theme.css\"; @import \"https://example.invalid/external.css\"; h1{background:url(../../pixel.png)} @font-face{font-family:demo;src:url(../../font.woff2)}",
        )
        .unwrap();
        fs::write(
            root.join("docs/styles/theme.css"),
            "h1{color:rgb(12,34,56)}",
        )
        .unwrap();
        fs::write(root.join("pixel.png"), png()).unwrap();
        fs::write(root.join("font.woff2"), "font-fixture").unwrap();
        fs::write(
            root.join("docs/page.html"),
            "<base href=\"https://example.invalid/\"><link rel=\"stylesheet\" href=\"styles/main.css\"><script src=\"local.js\"></script><script>throw 1</script><style>p{background:url(../pixel.png)}</style><h1 style=\"background-image:url(../pixel.png)\">Hello</h1><img src=\"../pixel.png\"><img srcset=\"../pixel.png 1x, ../pixel.png 2x\"><img src=\"https://example.invalid/track.png\">",
        )
        .unwrap();
        let result = render_html_preview_file(&cx, root_of(&dir), "docs/page.html")
            .await
            .unwrap();
        assert!(!result.contains("<base"));
        assert!(!result.contains("<script"));
        assert!(!result.contains("https://example.invalid"));
        assert!(result.contains(&format!("data:image/png;base64,{PNG}")));
        let encoded = result
            .split("data:text/css;base64,")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap();
        let css = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
        )
        .unwrap();
        assert!(css.contains("data:font/woff2;base64,"), "{css}");
        assert!(css.contains("data:image/png;base64,"), "{css}");
        assert!(
            css.contains("https://example.invalid/external.css"),
            "{css}"
        );
        assert!(css.contains("color:"), "{css}");
    }
}

#[test]
fn https_stylesheet_links_and_imports_stay_browser_owned_without_referrer_overrides() {
    let html = r#"<meta name="referrer" content="unsafe-url"><link rel="stylesheet" href="https://cdn.example.invalid/main.css" integrity="sha384-example" crossorigin="anonymous" referrerpolicy="unsafe-url"><link rel="stylesheet" href="//cdn.example.invalid/theme.css"><link rel="stylesheet" href="http://cdn.example.invalid/insecure.css"><link rel="stylesheet" href="https://example-user@cdn.example.invalid/private.css"><style>@import "https://cdn.example.invalid/import.css"; @import "//cdn.example.invalid/shared.css"; @import "http://cdn.example.invalid/insecure.css"; p { background:url(https://cdn.example.invalid/image.png) }</style><script src="https://cdn.example.invalid/app.js"></script>"#;
    let mut reads = Vec::new();
    let result = render_html_preview(&resource("page.html", html), &mut |path, _| {
        reads.push(path.to_owned());
        Err(HtmlPreviewError::new("Unexpected read"))
    })
    .unwrap();
    assert!(reads.is_empty());
    for file in ["main.css", "theme.css", "import.css", "shared.css"] {
        assert!(
            result.contains(&format!("https://cdn.example.invalid/{file}")),
            "{file} in {result}"
        );
    }
    assert!(result.contains(r#"referrerpolicy="no-referrer""#));
    assert!(result.contains(r#"integrity="sha384-example""#));
    assert!(result.contains(r#"crossorigin="anonymous""#));
    for forbidden in [
        "unsafe-url",
        "insecure.css",
        "private.css",
        "image.png",
        "app.js",
    ] {
        assert!(!result.contains(forbidden), "{forbidden} in {result}");
    }
}

#[tokio::test]
async fn local_read_detects_growth_after_stat_and_bounds_the_read() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("grow.html"), "<h1>small</h1>").unwrap();
    AFTER_STAT.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|path: &Path| {
            fs::write(path, vec![b'A'; PREVIEW_MAX_BYTES * 2]).unwrap();
        }));
    });
    let result =
        read_html_preview_file(&local(), root_of(&dir), "grow.html", PREVIEW_MAX_BYTES).await;
    AFTER_STAT.with(|hook| hook.borrow_mut().take());
    assert_eq!(result.unwrap_err().status, 413);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ssh_growth_is_detected_after_bounded_transfer_and_stat_rejection_transfers_no_body() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grow.html");
    fs::write(&path, "small").unwrap();
    let prefix = format!(
        "stat() {{ local result; result=\"$(command stat \"$@\")\" || return $?; printf '%s\\n' \"$result\"; head -c {} /dev/zero > {}; }}; export -f stat; ",
        PREVIEW_MAX_BYTES * 2,
        roamgate_git::shell_quote(path.to_str().unwrap())
    );
    let (cx, runner) = ssh(&prefix);
    let error = read_html_preview_file(&cx, root_of(&dir), "grow.html", PREVIEW_MAX_BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.status, 413);
    let transferred = *runner.transferred.lock().unwrap();
    assert!(transferred > PREVIEW_MAX_BYTES);
    assert!(transferred < (PREVIEW_MAX_BYTES + 1).div_ceil(3) * 4 + 100);
    let error = read_html_preview_file(&ssh("").0, root_of(&dir), "grow.html", PREVIEW_MAX_BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.status, 413);
}

#[cfg(unix)]
#[tokio::test]
async fn resources_cannot_follow_a_symlink_outside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(dir.path().join("secret.css"), "h1{color:red}").unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.css"), workspace.join("style.css")).unwrap();
    for cx in contexts() {
        assert!(
            read_html_preview_file(
                &cx,
                workspace.to_str().unwrap(),
                "style.css",
                PREVIEW_MAX_BYTES
            )
            .await
            .is_err()
        );
    }
}

#[test]
fn css_resource_reads_are_serialized_cached_and_limited_by_the_remaining_budget() {
    let mut reads = Vec::new();
    render_html_preview(
        &resource(
            "page.html",
            "<style>a{background:url(a.png)} b{background:url(b.png)} c{background:url(a.png)}</style>",
        ),
        &mut |path, _| {
            reads.push(path.to_owned());
            Ok(resource(path, png()))
        },
    )
    .unwrap();
    reads.sort();
    assert_eq!(reads, ["a.png", "b.png"]);
    let mut limits = Vec::new();
    render_html_preview(
        &resource(
            "page.html",
            r#"<img src="a.png"><img src="b.png"><img src="c.png">"#,
        ),
        &mut |path, limit| {
            limits.push(limit);
            Ok(resource(path, vec![0; limit.min(4 * 1024 * 1024)]))
        },
    )
    .unwrap();
    assert_eq!(limits, [5 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024]);
}

#[test]
fn escaped_css_resource_syntax_is_bundled() {
    let mut reads = Vec::new();
    let result = render_html_preview(
        &resource("page.html", r#"<style>@\69mport "theme.css";</style>"#),
        &mut |path, _| {
            reads.push(path.to_owned());
            Ok(resource(path, "h1{color:red}"))
        },
    )
    .unwrap();
    assert_eq!(reads, ["theme.css"]);
    assert!(result.contains("color:red"), "{result}");
    assert!(!result.contains("theme.css"));
}

#[test]
fn plain_inline_styles_do_not_consume_the_resource_processing_budget() {
    let html = r#"<p style="color:red">cell</p>"#.repeat(300);
    let result = render_html_preview(&resource("report.html", html.clone()), &mut |_, _| {
        Err(HtmlPreviewError::new("Unexpected resource read"))
    })
    .unwrap();
    assert_eq!(result, html);
}

#[test]
fn static_resource_and_output_budgets_fail_closed() {
    let images: String = (0..65).map(|i| format!(r#"<img src="{i}.png">"#)).collect();
    let error = render_html_preview(&resource("page.html", images), &mut |path, _| {
        Ok(resource(path, png()))
    })
    .unwrap_err();
    assert_eq!(error.status, 413);
    let error = render_html_preview(
        &resource(
            "page.html",
            r#"<img src="a.png"><img src="b.png"><img src="c.png">"#,
        ),
        &mut |path, _| Ok(resource(path, vec![0; 4 * 1024 * 1024])),
    )
    .unwrap_err();
    assert_eq!(error.status, 413);
    let mut reads = Vec::new();
    let result = render_html_preview(
        &resource(
            "page.html",
            r#"<img src="https://example.invalid/a.png"><link rel="stylesheet" href="//example.invalid/a.css"><img src="local.js"><img src="missing.png">"#,
        ),
        &mut |path, _| {
            reads.push(path.to_owned());
            Err(HtmlPreviewError::new("not found"))
        },
    )
    .unwrap();
    assert_eq!(reads, ["missing.png"]);
    assert!(result.contains(r#"href="https://example.invalid/a.css""#));
    assert!(!result.contains("https://example.invalid/a.png"));
}

#[test]
fn resolves_references_as_the_browser_does_inside_the_checkout() {
    assert_eq!(
        resource_path("../pixel.png", "docs/page.html").as_deref(),
        Some("pixel.png")
    );
    assert_eq!(
        resource_path("../../../x.png", "docs/page.html").as_deref(),
        Some("x.png")
    );
    assert_eq!(
        resource_path("a%20b.png?x#y", "d i r/p.html").as_deref(),
        Some("d i r/a b.png")
    );
    assert_eq!(
        resource_path("..\\x.png", "docs/page.html").as_deref(),
        Some("x.png")
    );
    assert_eq!(resource_path("#frag", "page.html"), None);
    assert_eq!(resource_path("//cdn/x.png", "page.html"), None);
    assert_eq!(resource_path("javascript:alert(1)", "page.html"), None);
    assert_eq!(resource_path("%ff.png", "page.html"), None);
    assert_eq!(
        https_stylesheet_url(" //cdn.example/a.css ").as_deref(),
        Some("https://cdn.example/a.css")
    );
    assert_eq!(https_stylesheet_url("https://u:p@cdn.example/a.css"), None);
    assert_eq!(https_stylesheet_url("a.css"), None);
}
