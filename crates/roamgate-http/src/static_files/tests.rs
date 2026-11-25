//! http/static-files.test.ts, case for case.

use std::path::PathBuf;

use super::*;

fn web() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web")
}

fn files(public_dir: PathBuf) -> StaticFiles {
    StaticFiles {
        public_dir,
        built_public_dir: None,
        embedded: None,
    }
}

fn get(path: &str) -> StaticRequest<'_> {
    StaticRequest {
        method: "GET",
        raw_path: path,
        accept: None,
    }
}

fn header(response: &Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .map(|value| value.to_str().unwrap().to_owned())
}

fn json(response: &Response) -> Value {
    serde_json::from_slice(response.body()).unwrap()
}

fn original_manifest() -> Value {
    serde_json::from_slice(&std::fs::read(web().join("public/manifest.json")).unwrap()).unwrap()
}

fn named(mut manifest: Value, name: &str) -> Value {
    manifest["name"] = name.into();
    manifest["short_name"] = name.into();
    manifest
}

#[tokio::test]
async fn the_app_links_a_credentialed_standalone_manifest_with_existing_install_icons() {
    let html = std::fs::read_to_string(web().join("index.html")).unwrap();
    let link = html
        .split('<')
        .find(|tag| tag.starts_with("link") && tag.contains(r#"rel="manifest""#))
        .unwrap();
    assert!(link.contains(r#"href="/manifest.json""#));
    assert!(link.contains(r#"crossorigin="use-credentials""#));
    let response = files(web().join("public"))
        .serve(get("/manifest.json"), "")
        .await;
    assert_eq!(response.status(), 200);
    assert!(
        header(&response, "content-type")
            .unwrap()
            .contains("application/json")
    );
    let manifest = json(&response);
    for (key, value) in [
        ("id", "/"),
        ("name", "Roamgate"),
        ("short_name", "Roamgate"),
        ("start_url", "/"),
        ("scope", "/"),
        ("display", "standalone"),
    ] {
        assert_eq!(manifest[key], value);
    }
    let icons = manifest["icons"].as_array().unwrap();
    let sizes: Vec<&str> = icons
        .iter()
        .map(|icon| icon["sizes"].as_str().unwrap())
        .collect();
    assert_eq!(sizes, ["192x192", "512x512"]);
    for icon in icons {
        assert_eq!(icon["type"], "image/png");
        let bytes = std::fs::read(
            web()
                .join("public")
                .join(&icon["src"].as_str().unwrap()[1..]),
        )
        .unwrap();
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        assert_eq!(format!("{width}x{height}"), icon["sizes"].as_str().unwrap());
    }
}

#[tokio::test]
async fn source_runs_fall_back_to_the_built_public_directory() {
    let static_files = StaticFiles {
        public_dir: PathBuf::from("/nonexistent-roamgate-static-test"),
        built_public_dir: Some(web().join("public")),
        embedded: None,
    };
    let response = static_files.serve(get("/manifest.json"), "").await;
    assert_eq!(response.status(), 200);
    assert!(
        header(&response, "content-type")
            .unwrap()
            .contains("application/json")
    );
    assert_eq!(json(&response), original_manifest());
}

#[tokio::test]
async fn instance_names_update_both_manifest_labels_without_changing_installation_identity() {
    for suffix in ["Home", r#"Work "A" & <B>"#, "\u{5bb6}\u{91cc}", ""] {
        let response = files(web().join("public"))
            .serve(get("/manifest.json"), suffix)
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            header(&response, "cache-control").as_deref(),
            Some(REVALIDATE)
        );
        assert!(header(&response, "etag").is_none());
        let name = if suffix.is_empty() {
            "Roamgate".to_owned()
        } else {
            format!("Roamgate \u{b7} {suffix}")
        };
        assert_eq!(json(&response), named(original_manifest(), &name));
        // Key order kept: the labels change in place.
        let keys: Vec<String> = json(&response)
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let original: Vec<String> = original_manifest()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, original);
    }
}

#[tokio::test]
async fn entry_html_escapes_the_name_in_title_and_metadata_including_spa_routes() {
    let suffix = r#"</title><script>"&"#;
    let original = std::fs::read_to_string(web().join("index.html")).unwrap();
    for path in ["/", "/index.html", "/workspace/example"] {
        let request = StaticRequest {
            method: "GET",
            raw_path: path,
            accept: Some("text/html"),
        };
        let response = files(web()).serve(request, suffix).await;
        assert!(
            header(&response, "cache-control")
                .unwrap()
                .contains("no-cache")
        );
        let html = std::str::from_utf8(response.body()).unwrap();
        // What Bun's HTMLRewriter writes for the same name.
        assert!(
            html.contains("<title>Roamgate \u{b7} &lt;/title&gt;&lt;script&gt;\"&amp;</title>")
        );
        assert_eq!(html.matches("<title>").count(), 1);
        assert!(html.contains(
            r#"<meta name="application-name" content="Roamgate · </title><script>&quot;&" />"#
        ));
        assert!(html.contains(
            r#"<meta name="apple-mobile-web-app-title" content="Roamgate · </title><script>&quot;&" />"#
        ));
        assert_eq!(
            html.matches("<script").count(),
            original.matches("<script").count() + 2
        );
        assert!(html.contains(r#"href="/manifest.json""#));
        assert!(html.contains(r#"crossorigin="use-credentials""#));
    }
}

#[tokio::test]
async fn head_returns_naming_response_headers_without_a_body() {
    for (path, directory) in [
        ("/index.html", web()),
        ("/manifest.json", web().join("public")),
    ] {
        let request = StaticRequest {
            method: "HEAD",
            raw_path: path,
            accept: None,
        };
        let response = files(directory).serve(request, "Work").await;
        assert_eq!(response.status(), 200);
        assert!(response.body().is_empty());
        assert_eq!(
            header(&response, "cache-control").as_deref(),
            Some(REVALIDATE)
        );
    }
}

#[tokio::test]
async fn a_fresh_source_build_serves_instance_metadata_without_generated_web_assets() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("index.html"),
        "<title>SPA fallback must not replace manifest</title>",
    )
    .unwrap();
    let request = StaticRequest {
        method: "GET",
        raw_path: "/manifest.json",
        accept: Some("text/html"),
    };
    let response = files(root.path().to_owned()).serve(request, "Dev").await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        header(&response, "cache-control").as_deref(),
        Some(REVALIDATE)
    );
    assert_eq!(
        json(&response),
        named(original_manifest(), "Roamgate \u{b7} Dev")
    );
}

#[tokio::test]
async fn module_files_are_served_as_javascript_so_browsers_run_them() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("worker.mjs"), "export {};\n").unwrap();
    let response = files(root.path().to_owned())
        .serve(get("/worker.mjs"), "")
        .await;
    assert_eq!(response.status(), 200);
    assert!(
        header(&response, "content-type")
            .unwrap()
            .contains("text/javascript")
    );
}

#[tokio::test]
async fn refuses_writes_malformed_paths_and_escapes() {
    let static_files = files(web().join("public"));
    let post = StaticRequest {
        method: "POST",
        raw_path: "/manifest.json",
        accept: None,
    };
    let response = static_files.serve(post, "").await;
    assert_eq!(response.status(), 405);
    assert_eq!(header(&response, "allow").as_deref(), Some("GET, HEAD"));
    assert_eq!(static_files.serve(get("/%E0%A4%A"), "").await.status(), 400);
    assert_eq!(
        static_files
            .serve(get("/..%2F..%2Fetc%2Fpasswd"), "")
            .await
            .status(),
        404
    );
    assert_eq!(
        static_files.serve(get("/missing.js"), "").await.status(),
        404
    );
}

/// A release binary's build, in memory: after the public directory, with
/// the entry document for page navigations, named after the instance.
#[tokio::test]
async fn a_binary_serves_the_build_it_carries_after_the_public_directory() {
    let public = tempfile::tempdir().unwrap();
    std::fs::write(public.path().join("own.txt"), "public").unwrap();
    std::fs::write(public.path().join("both.txt"), "public").unwrap();
    let embedded = EmbeddedFiles(std::sync::Arc::new(|name: &str| match name {
        "index.html" => Some(Bytes::from_static(
            b"<html><head><title>x</title></head><body>app</body></html>",
        )),
        "both.txt" | "assets/app.js" => Some(Bytes::from_static(b"embedded")),
        _ => None,
    }));
    let static_files = StaticFiles {
        public_dir: public.path().to_owned(),
        built_public_dir: None,
        embedded: Some(embedded),
    };
    let body = |response: &Response| String::from_utf8(response.body().to_vec()).unwrap();
    let response = static_files.serve(get("/both.txt"), "").await;
    assert_eq!(body(&response), "public");
    let response = static_files.serve(get("/assets/app.js"), "").await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        header(&response, "content-type").unwrap(),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(body(&response), "embedded");
    let page = StaticRequest {
        method: "GET",
        raw_path: "/settings",
        accept: Some("text/html"),
    };
    let response = static_files.serve(page, "Desk").await;
    assert_eq!(response.status(), 200);
    assert!(body(&response).contains("<title>Roamgate · Desk</title>"));
    assert_eq!(
        header(&response, "cache-control").unwrap(),
        "private, no-cache, must-revalidate"
    );
    let head = StaticRequest {
        method: "HEAD",
        raw_path: "/assets/app.js",
        accept: None,
    };
    let response = static_files.serve(head, "").await;
    assert_eq!(response.status(), 200);
    assert!(response.body().is_empty());
    assert_eq!(
        static_files.serve(get("/missing.js"), "").await.status(),
        404
    );
}

#[test]
fn a_node_page_names_its_home_before_any_script() {
    let html = b"<html><head><title>x</title><script src=\"/a.js\"></script></head></html>";
    let marked =
        String::from_utf8(mark_node_page(html, "https://home.example", "local").unwrap()).unwrap();
    assert!(marked.starts_with(
        "<html><head><meta name=\"roamgate-node\" content=\"https://home.example\" data-connection-id=\"local\"><title>"
    ));
}
