//! The HTML preview as Bun renders it (plan section 8.3, Phase 6's exit:
//! preview rendering compared): pages with their stylesheets, imports,
//! images, fonts and inline styles rendered by
//! server/src/workspace/html-preview.ts and by `render_html_preview`, and
//! held equal. The page rewrite is the same library (lol_html) and must
//! match byte for byte; a style sheet is minified by Bun's CSS printer on
//! one side and lightningcss (which Bun's is a port of) on the other, so
//! the styles are compared once both are parsed and printed again by
//! lightningcss. Skipped, saying why, when bun is not on PATH.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine as _;
use lightningcss::stylesheet::{ParserOptions, PrinterOptions, StyleSheet};
use roamgate_workspace::html_preview::render_html_preview;
use roamgate_workspace::html_preview_files::{HtmlPreviewError, PreviewResource};
use serde_json::{Value, json};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the TS preview cannot be rendered");
    }
    found
}

const BUN_RENDER: &str = r#"
const { renderHtmlPreview } = await import(process.argv[1]);
const cases = JSON.parse(await Bun.stdin.text());
const out = [];
for (const { page, html, files } of cases) {
  try {
    out.push({ html: await renderHtmlPreview({ path: page, bytes: Buffer.from(html) },
      async (path, limit) => {
        const text = files[path];
        if (text === undefined) throw new Error("missing");
        const bytes = Buffer.from(text, "base64");
        if (bytes.length > limit) throw Object.assign(new Error("too large"), { status: 413 });
        return { path, bytes };
      }) });
  } catch (error) {
    out.push({ error: String(error.message), status: error.status ?? 0 });
  }
}
console.log(JSON.stringify(out));
"#;

fn cases() -> Vec<(String, String, BTreeMap<String, Vec<u8>>)> {
    let png = base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
        .unwrap();
    let files = |entries: &[(&str, &[u8])]| -> BTreeMap<String, Vec<u8>> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.to_vec()))
            .collect()
    };
    vec![
        (
            "docs/page.html".into(),
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="Referrer" content="x"><base href="https://example.invalid/"><title>T</title><link rel="stylesheet" href="styles/main.css" integrity="x" crossorigin><link rel="icon" href="favicon.png"><link rel="Alternate StyleSheet" href="styles/theme.css"><script>alert(1)</script></head><body><h1 style="background-image:url(../pixel.png); color: red">Hello &amp; bye</h1><p style="margin: 0 auto">plain</p><img src="../pixel.png" alt="a"><img srcset="../pixel.png 1x, ../pixel.png 2x, bad.png 3q"><picture><source srcset="../pixel.png 100w"></picture><svg><image href="../pixel.png"/></svg><input type="image" src="../pixel.png"><a href="other.html">link</a></body></html>"#.into(),
            files(&[
                ("docs/styles/main.css", b"@import \"theme.css\" screen; @import \"https://example.invalid/x.css\"; h1 { background: url(../../pixel.png) no-repeat; } @font-face { font-family: demo; src: url(../../font.woff2) format(\"woff2\"); }"),
                ("docs/styles/theme.css", b"h1 { color: rgb(12, 34, 56); margin: 0px 0px 0px 0px }"),
                ("pixel.png", &png),
                ("font.woff2", b"font-fixture"),
            ]),
        ),
        (
            "page.html".into(),
            r#"<style>p { background: url(missing.png) } a { background-image: image-set(url(pixel.png) 1x, url(pixel.png) 2x) } b { color: #ff0000 }</style><style>.plain { color: blue }</style><p>x</p>"#.into(),
            files(&[("pixel.png", &png)]),
        ),
        (
            "nested/a.htm".into(),
            "<style>@import 'b.css';</style><div style=\"background:url('../pixel.png')\"></div>".into(),
            files(&[("nested/b.css", b"@import 'c.css'; .b{color:green}"), ("nested/c.css", b"@import 'b.css'; .c{background:url(../pixel.png)}"), ("pixel.png", &png)]),
        ),
        (
            "esc.html".into(),
            "<style>@\\69mport \"a.css\" layer(base); @import url(b.css) supports(display: grid) (min-width: 10px); @import \"c.txt\"; .x::before { content: \"\\2014 caf\u{e9}\" } .y{background:url(\"sp ace.png\")}</style><p style=\"--v: url(pixel.png); width: calc(1px + 2px)\">\u{e9}</p>".into(),
            files(&[("a.css", b".a{color:#abcdef}"), ("b.css", b".b{display:grid}"), ("sp ace.png", &png), ("pixel.png", &png)]),
        ),
        (
            "big.html".into(),
            (0..70).map(|i| format!("<img src=\"{i}.png\">")).collect::<String>(),
            (0..70).map(|i| (format!("{i}.png"), png.clone())).collect(),
        ),
        ("page.txt".into(), "<p>no</p>".into(), files(&[])),
    ]
}

/// A page's styles parsed and printed by lightningcss, minified: the
/// inline style attributes and the data URLs of stylesheets decoded.
fn normalise(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    let marker = "data:text/css;base64,";
    while let Some(at) = rest.find(marker) {
        out.push_str(&rest[..at + marker.len()]);
        rest = &rest[at + marker.len()..];
        let end = rest.find('"').unwrap_or(rest.len());
        let css = base64::engine::general_purpose::STANDARD
            .decode(&rest[..end])
            .unwrap();
        out.push_str(&reprint(&String::from_utf8(css).unwrap()));
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn reprint(css: &str) -> String {
    let options = ParserOptions {
        error_recovery: true,
        ..ParserOptions::default()
    };
    let sheet = StyleSheet::parse(css, options).unwrap();
    sheet
        .to_css(PrinterOptions {
            minify: true,
            ..PrinterOptions::default()
        })
        .unwrap()
        .code
}

#[test]
fn previews_render_as_buns() {
    let Some(bun) = bun() else { return };
    let cases = cases();
    let input: Vec<Value> = cases
        .iter()
        .map(|(page, html, files)| {
            json!({
                "page": page,
                "html": html,
                "files": files.iter().map(|(k, v)| (k.clone(), json!(base64::engine::general_purpose::STANDARD.encode(v)))).collect::<serde_json::Map<_, _>>(),
            })
        })
        .collect();
    let mut child = Command::new(bun)
        .current_dir(repo().join("server"))
        .arg("-e")
        .arg(BUN_RENDER)
        .arg(repo().join("server/src/workspace/html-preview.ts"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write as _;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&input).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bun: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for ((page, html, files), bun) in cases.iter().zip(bun) {
        let rust = render_html_preview(
            &PreviewResource {
                path: page.clone(),
                bytes: html.clone().into_bytes(),
            },
            &mut |path, limit| {
                let bytes = files
                    .get(path)
                    .ok_or_else(|| HtmlPreviewError::new("missing"))?;
                if bytes.len() > limit {
                    return Err(HtmlPreviewError::with_status("too large", 413));
                }
                Ok(PreviewResource {
                    path: path.to_owned(),
                    bytes: bytes.clone(),
                })
            },
        );
        match (rust, bun.get("html").and_then(Value::as_str)) {
            (Ok(rust), Some(bun)) => {
                assert_eq!(normalise(&rust), normalise(bun), "{page}");
            }
            (Err(rust), None) => {
                assert_eq!(rust.message, bun["error"], "{page}");
            }
            (rust, _) => panic!("{page}: Rust {rust:?}, Bun {bun}"),
        }
    }
}
