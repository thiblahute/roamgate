use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

fn setup() -> (tempfile::TempDir, CompanionMemoryFiles) {
    let root = tempfile::tempdir().unwrap();
    let files = CompanionMemoryFiles::new(root.path().join("memories"));
    (root, files)
}

fn fact(name: &str) -> String {
    format!("---\nname: {name}\ndescription: about {name}\ntype: user\n---\nThe fact of {name}.\n")
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0
}

fn write(files: &CompanionMemoryFiles, name: &str, text: &str) {
    std::fs::write(files.dir.join(name), text).unwrap();
}

#[test]
fn parses_frontmatter_and_a_file_without_it() {
    assert_eq!(parse_memory_file(&fact("Cat")).name, "Cat");
    assert_eq!(parse_memory_file("no frontmatter").body, "no frontmatter");
    assert_eq!(parse_memory_file("---\nname: only").name, "");
}

#[test]
fn lists_memories_never_the_index_or_stray_names() {
    let (_root, files) = setup();
    write(&files, "cat.md", &fact("Cat"));
    write(&files, "MEMORY.md", "- [Cat](cat.md) - c\n");
    write(&files, "notes.txt", "x");
    assert_eq!(
        files
            .list()
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>(),
        ["Cat"]
    );
}

#[test]
fn removes_a_memory_and_its_index_line_only() {
    let (_root, files) = setup();
    write(&files, "cat.md", &fact("Cat"));
    write(&files, "dog.md", &fact("Dog"));
    write(
        &files,
        "MEMORY.md",
        "- [Cat](cat.md) - c\n- [Dog](dog.md) - d\n",
    );
    assert!(files.remove("cat.md"));
    assert_eq!(
        files
            .list()
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>(),
        ["Dog"]
    );
    assert_eq!(
        std::fs::read_to_string(files.dir.join("MEMORY.md")).unwrap(),
        "- [Dog](dog.md) - d\n"
    );
}

#[test]
fn refuses_paths_out_of_the_directory_and_the_index() {
    let (_root, files) = setup();
    assert!(!files.remove("../x.md"));
    assert!(!files.remove("MEMORY.md"));
    assert_eq!(files.read("../../etc/passwd.md"), None);
}

#[test]
fn a_corrupted_file_is_listed_by_its_name_harmlessly() {
    let (_root, files) = setup();
    write(&files, "bad.md", "---\nname: \x00\n---\n");
    assert_eq!(
        files
            .list()
            .iter()
            .map(|m| m.file.as_str())
            .collect::<Vec<_>>(),
        ["bad.md"]
    );
}

#[test]
fn sweep_drops_a_file_that_lost_its_line_not_a_new_one() {
    let (_root, files) = setup();
    write(&files, "old.md", &fact("Old"));
    write(&files, "kept.md", &fact("Kept"));
    write(&files, "MEMORY.md", "- [Kept](kept.md) - k\n");
    files.sweep(now_ms() + 60_000.0);
    assert_eq!(
        files
            .list()
            .iter()
            .map(|m| m.file.as_str())
            .collect::<Vec<_>>(),
        ["kept.md"]
    );
    write(&files, "new.md", &fact("New"));
    files.sweep(now_ms() - 60_000.0);
    let mut names: Vec<String> = files.list().into_iter().map(|m| m.file).collect();
    names.sort();
    assert_eq!(names, ["kept.md", "new.md"]);
}

#[test]
fn the_indexs_title_names_a_memory_in_the_list() {
    let (_root, files) = setup();
    write(&files, "x.md", &fact("slug-title"));
    write(&files, "MEMORY.md", "- [Joli titre](x.md) - d\n");
    assert_eq!(files.list()[0].name, "Joli titre");
}

#[test]
fn sweep_keeps_the_index_within_what_a_session_loads() {
    let (_root, files) = setup();
    write(
        &files,
        "MEMORY.md",
        &"- line\n".repeat(MAX_INDEX_LINES + 50),
    );
    files.sweep(0.0);
    assert!(files.loaded_index().split('\n').count() <= MAX_INDEX_LINES);
}
