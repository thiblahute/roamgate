//! review/forge-writes.test.ts: Roamgate never publishes to a forge from
//! the review code: the only writes are the user's drafts (GitLab draft
//! notes, the pending GitHub review's comments and body). This reads the
//! sources and lists every write they can make. (The merge request
//! reviews' code, mr-reviews, joins these sources when it moves here.)

use std::path::Path;

use regex::Regex;

fn sources() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/review");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            (name.ends_with(".rs") && name != "testkit.rs")
                .then(|| (name, std::fs::read_to_string(&path).unwrap()))
        })
        .collect();
    files.sort();
    assert!(files.len() >= 5, "{files:?}");
    files
}

#[test]
fn the_only_gitlab_writes_are_draft_notes_and_their_images() {
    let call = Regex::new(r#"(?s)glab\(\s*context,\s*[^,]+,\s*"(POST|PUT|DELETE)",\s*(.*?),\s*\n"#)
        .unwrap();
    let mut writes = Vec::new();
    for (name, text) in sources() {
        for found in call.captures_iter(&text) {
            writes.push(format!("{name} {} {}", &found[1], found[2].trim()));
        }
    }
    assert!(!writes.is_empty());
    // An image of a draft is uploaded to its project as the draft is
    // written: seen by nobody until the user submits a review naming it.
    let allowed = Regex::new(
        r#"draft_notes|"graphql"|^gitlab\.rs POST &format!\("projects/\{\}/uploads", encode_uri_component\(&mr\.project\)\)$"#,
    )
    .unwrap();
    for write in &writes {
        assert!(allowed.is_match(write), "{write}");
    }
}

#[test]
fn the_only_github_mutations_are_the_pending_reviews_drafts() {
    let allowed = [
        "addPullRequestReview",
        "addPullRequestReviewThread",
        "addPullRequestReviewThreadReply",
        "updatePullRequestReviewComment",
        "deletePullRequestReviewComment",
        "updatePullRequestReview",
    ];
    let mutation = Regex::new(r"mutation\([^)]*\)\s*\{\{?\s*(\w+)").unwrap();
    let mut found: Vec<String> = Vec::new();
    for (_, text) in sources() {
        for each in mutation.captures_iter(&text) {
            found.push(each[1].to_owned());
        }
    }
    assert!(!found.is_empty());
    let odd: Vec<&String> = found
        .iter()
        .filter(|name| !allowed.contains(&name.as_str()))
        .collect();
    assert!(odd.is_empty(), "{odd:?}");
    let all = sources()
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    // Nothing submits, publishes, resolves or comments publicly.
    for word in [
        "submitPullRequestReview",
        "resolveReviewThread",
        "addComment(",
        "bulk_publish",
        "/notes\"",
        "/notes\")",
        "resolved=true",
        "--method PATCH",
    ] {
        assert!(!all.contains(word), "{word}");
    }
    // No REST write to GitHub at all: a gh call that is not a GET is a
    // GraphQL one.
    let gh =
        Regex::new(r#"(?s)gh_api\(\s*[^,]+,\s*[^,]+,\s*"(POST|PATCH|PUT|DELETE)",\s*([^,]+),"#)
            .unwrap();
    for each in gh.captures_iter(&all) {
        assert_eq!(each[2].trim(), "\"graphql\"", "{}", &each[0]);
    }
    // The GitLab GraphQL calls only read: there is no mutation outside
    // GitHub's pending review.
    for (name, text) in sources() {
        if name != "github.rs" {
            assert!(!text.contains("mutation"), "{name}");
        }
    }
}
