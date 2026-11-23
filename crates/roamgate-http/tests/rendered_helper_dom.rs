//! The cases of http/rendered-pages.test.ts that run the helper in a page
//! (happy-dom): the script Rust writes into a page
//! (`rendered_helper_source`, the contract asset with its arguments) run by
//! Bun in happy-dom, as the TS cases run renderedHelperSource's. Skipped,
//! saying why, when bun or the repository's happy-dom is missing
//! (`bun install` at the repository's root).

use std::path::{Path, PathBuf};
use std::process::Command;

use roamgate_http::rendered_pages::{
    RENDERED_STORAGE_MAX_CHARS, RENDERED_STORAGE_MAX_KEYS, rendered_helper_source,
};
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
        eprintln!("skipped: bun is not on PATH, the helper cannot run in a page");
        return None;
    }
    if !repo().join("node_modules/happy-dom/package.json").is_file() {
        eprintln!(
            "skipped: no node_modules/happy-dom (run `bun install` at the repository's root)"
        );
        return None;
    }
    found
}

/// A page of happy-dom running `script` (its window as the script's
/// globals), then `body`, which prints its findings as JSON.
const PRELUDE: &str = r#"
const { Window } = await import("happy-dom");
const script = await Bun.file(process.argv[1]).text();
const out = (value) => console.log(JSON.stringify(value));
function window() {
  return new Window({ settings: { disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
}
function run(win) { new Function("window", `with (window) { ${script} }`)(win); }
async function card() {
  const win = window();
  const timers = new Map();
  let next = 1;
  win.setTimeout = (fn) => { timers.set(next, fn); return next++; };
  win.clearTimeout = (id) => { timers.delete(id); };
  let selected = "";
  win.getSelection = () => ({ isCollapsed: !selected, toString: () => selected });
  Object.defineProperty(win, "parent", { value: {} });
  win.document.body.innerHTML =
    '<article><p id="t">Card text</p><a class="entry-link" href="/post/"></a>' +
    '<button id="b">b</button></article>';
  const link = win.document.querySelector("a");
  link.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
  let follows = 0;
  link.addEventListener("click", () => { follows++; });
  run(win);
  const click = (target, init = {}) => target.dispatchEvent(new win.MouseEvent("click", {
    bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, detail: 1, ...init }));
  const fire = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { win, text: win.document.getElementById("t"), button: win.document.getElementById("b"),
    click, fire, select: (text) => { selected = text; }, follows: () => follows,
    point: (on) => win.dispatchEvent(Object.assign(new win.Event("message"),
      { source: win.parent, data: { roamgate: "rendered", type: "pointMode", on } })) };
}
async function page() {
  const win = window();
  const posted = [];
  Object.defineProperty(win, "parent", { value: { postMessage: (m) => posted.push(m) } });
  run(win);
  return { win, posted, store: (name) => win[name] };
}
const writes = (posted) => posted.filter((m) => m.type === "storage");
"#;

/// What `body` printed, run against `script`; `None` when skipped.
fn in_page(script: &str, body: &str) -> Option<Value> {
    let bun = bun()?;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("helper.js");
    std::fs::write(&file, script).unwrap();
    let output = Command::new(bun)
        .current_dir(repo())
        .arg("-e")
        .arg(format!("{PRELUDE}\n{body}"))
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let last = stdout.lines().last().expect("the page printed nothing");
    Some(serde_json::from_str(last).unwrap())
}

fn plain() -> String {
    rendered_helper_source("/p/", None, None)
}

fn seeded(items: &[(&str, &str)]) -> String {
    let items: Vec<(String, String)> = items
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    rendered_helper_source("/p/", None, Some(&items))
}

// following a card

#[test]
fn a_plain_click_follows_the_card_after_the_delay() {
    let Some(found) = in_page(
        &plain(),
        "const s = await card(); s.click(s.text); const before = s.follows(); s.fire();
         out([before, s.follows()]); await s.win.happyDOM.close();",
    ) else {
        return;
    };
    assert_eq!(found, json!([0, 1]));
}

#[test]
fn a_double_click_does_not() {
    let Some(found) = in_page(
        &plain(),
        "const s = await card(); s.click(s.text, { detail: 1 }); s.click(s.text, { detail: 2 });
         s.fire(); out(s.follows()); await s.win.happyDOM.close();",
    ) else {
        return;
    };
    assert_eq!(found, json!(0));
}

#[test]
fn a_click_with_text_selected_or_on_a_button_does_not() {
    let Some(found) = in_page(
        &plain(),
        r#"const s = await card(); s.select("Card"); s.click(s.text); s.fire();
         const selected = s.follows(); s.select(""); s.click(s.button); s.fire();
         out([selected, s.follows()]); await s.win.happyDOM.close();"#,
    ) else {
        return;
    };
    assert_eq!(found, json!([0, 0]));
}

#[test]
fn a_selection_made_during_the_delay_stops_it() {
    let Some(found) = in_page(
        &plain(),
        r#"const s = await card(); s.click(s.text); s.select("Card"); s.fire();
         out(s.follows()); await s.win.happyDOM.close();"#,
    ) else {
        return;
    };
    assert_eq!(found, json!(0));
}

#[test]
fn point_mode_and_modifier_clicks_do_not() {
    let Some(found) = in_page(
        &plain(),
        "const s = await card(); s.click(s.text, { ctrlKey: true }); s.click(s.text, { button: 1 });
         s.fire(); const modified = s.follows(); s.point(true); s.click(s.text); s.fire();
         out([modified, s.follows()]); await s.win.happyDOM.close();",
    ) else {
        return;
    };
    assert_eq!(found, json!([0, 0]));
}

// the helper's storage shim

#[test]
fn a_synchronous_script_finds_the_seeded_items() {
    let Some(found) = in_page(
        &seeded(&[("pref-theme", "dark")]),
        r#"const { store } = await page(); const local = store("localStorage");
         out([local.getItem("pref-theme"), local.getItem("none"), local.length,
              local.key(0), local.key(1)]);"#,
    ) else {
        return;
    };
    assert_eq!(found, json!(["dark", null, 1, "pref-theme", null]));
}

#[test]
fn set_item_remove_item_and_clear_post_to_the_parent() {
    let Some(found) = in_page(
        &seeded(&[("a", "1")]),
        r#"const { store, posted } = await page(); const local = store("localStorage");
         local.setItem("b", "2"); local.setItem("b", "2"); local.removeItem("a");
         local.removeItem("a"); local.clear(); local.clear();
         out([writes(posted), local.length]);"#,
    ) else {
        return;
    };
    assert_eq!(
        found,
        json!([
            [
                {"roamgate": "rendered", "type": "storage", "op": "set", "key": "b", "value": "2"},
                {"roamgate": "rendered", "type": "storage", "op": "remove", "key": "a"},
                {"roamgate": "rendered", "type": "storage", "op": "clear"}
            ],
            0
        ])
    );
}

#[test]
fn values_are_strings_and_properties_act_as_items() {
    let Some(found) = in_page(
        &seeded(&[("a", "1")]),
        r#"const { store, posted } = await page(); const local = store("localStorage");
         const a = local.a; const missing = local.missing === undefined;
         local.n = 5; const n = local.n; const item = local.getItem("n"); const has = "n" in local;
         const keys = Object.keys(local); delete local.a;
         out([a, missing, n, item, has, keys, local.a === undefined,
              writes(posted).map((m) => m.op)]);"#,
    ) else {
        return;
    };
    assert_eq!(
        found,
        json!([
            "1",
            true,
            "5",
            "5",
            true,
            ["a", "n"],
            true,
            ["set", "remove"]
        ])
    );
}

#[test]
fn a_write_over_the_quota_is_refused() {
    let body = format!(
        r#"const {{ store, posted }} = await page(); const local = store("localStorage");
         let name = null;
         try {{ local.setItem("big", "x".repeat({RENDERED_STORAGE_MAX_CHARS})); }}
         catch (error) {{ name = error.name; }}
         for (let i = 0; i < {RENDERED_STORAGE_MAX_KEYS}; i += 1) local.setItem(`k${{i}}`, "v");
         let extra = false;
         try {{ local.setItem("extra", "v"); }} catch {{ extra = true; }}
         out([name, extra, local.getItem("extra"), writes(posted).length]);"#
    );
    let Some(found) = in_page(&seeded(&[]), &body) else {
        return;
    };
    assert_eq!(
        found,
        json!(["QuotaExceededError", true, null, RENDERED_STORAGE_MAX_KEYS])
    );
}

#[test]
fn session_storage_lives_in_the_page_and_posts_nothing() {
    let Some(found) = in_page(
        &seeded(&[("a", "1")]),
        r#"const { store, posted } = await page(); const session = store("sessionStorage");
         const seeded = session.getItem("a"); session.setItem("s", "1");
         out([seeded, session.getItem("s"), store("localStorage").getItem("s"),
              writes(posted).length]);"#,
    ) else {
        return;
    };
    assert_eq!(found, json!([null, "1", null, 0]));
}

#[test]
fn a_page_without_storage_keeps_what_the_browser_gives() {
    assert!(plain().ends_with(", null);})();"));
    let Some(found) = in_page(
        &plain(),
        r#"const { win } = await page();
         const desc = Object.getOwnPropertyDescriptor(win, "localStorage");
         out(desc?.get?.toString() ?? "");"#,
    ) else {
        return;
    };
    assert!(!found.as_str().unwrap().contains("storage"), "{found}");
}
