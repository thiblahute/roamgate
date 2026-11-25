//! The review worktree of a project (`mr-reviews/worktree.ts`):
//! `<clone>.worktrees/review`, sharing the clone's objects, checked out
//! detached on the request under review. The scripts run on the clone's
//! host; nothing is built, nothing is ever lost: local changes are kept on
//! a branch or discarded only when the user says so.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use crate::connection::{ShellResult, sh_quote};

/// `reviewWorktreePath`: gstreamer.git (a repository directory) gives
/// gstreamer.worktrees/review.
pub fn review_worktree_path(clone: &str) -> String {
    let trimmed = clone.trim_end_matches('/');
    let base = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    format!("{base}.worktrees/review")
}

/// `mrRef`: where a request's head is kept in the clone.
pub fn mr_ref(number: u64) -> String {
    format!("refs/roamgate/mr/{number}")
}

/// `forgeHeadRef`: the forge's ref of a request's head.
pub fn forge_head_ref(provider: &str, number: u64) -> String {
    if provider == "gitlab" {
        format!("refs/merge-requests/{number}/head")
    } else {
        format!("refs/pull/{number}/head")
    }
}

/// `projectUrl`: the project's https URL, to fetch from when no remote is
/// the project.
pub fn project_url(host: &str, project: &str) -> String {
    format!("https://{host}/{project}.git")
}

pub(crate) const GIT_ENV: &str =
    r#"export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes""#;

/// `ensureWorktreeScript`: creates the worktree (detached at `start`)
/// unless it is there; prints `EXISTS` or `CREATED`.
pub fn ensure_worktree_script(clone: &str, path: &str, start: &str) -> String {
    [
        "set -e".to_owned(),
        GIT_ENV.to_owned(),
        format!("cd {}", sh_quote(clone)),
        format!(
            "if [ -e {} ]; then echo EXISTS; exit 0; fi",
            sh_quote(&format!("{path}/.git"))
        ),
        format!(r#"mkdir -p "$(dirname {})""#, sh_quote(path)),
        format!(
            "s=$(git rev-parse --verify --quiet {} || git rev-parse HEAD)",
            sh_quote(&format!("{start}^{{commit}}"))
        ),
        format!(r#"git worktree add --detach {} "$s" >&2"#, sh_quote(path)),
        "echo CREATED".to_owned(),
    ]
    .join("\n")
}

/// `FetchWant`: a request whose head (and base) the clone should have.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FetchWant {
    pub number: u64,
    pub head_sha: String,
    /// The diff base: fetched with the target branch when missing.
    pub base_sha: Option<String>,
    pub target_branch: Option<String>,
}

impl FetchWant {
    /// A request's head, and its base with the target branch when the
    /// forge gave one (`want` of open.ts).
    pub fn of(item: &Obj) -> FetchWant {
        let base = item
            .get("baseSha")
            .and_then(Value::as_str)
            .filter(|sha| !sha.is_empty());
        FetchWant {
            number: js::num(item.get("number")).unwrap_or(0.0) as u64,
            head_sha: js::sv(item.get("headSha")).to_owned(),
            base_sha: base.map(str::to_owned),
            target_branch: base.map(|_| js::sv(item.get("targetBranch")).to_owned()),
        }
    }
}

fn filled(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// `fetchScript`: fetches the heads (and bases) of the requests that the
/// clone does not have yet, in one `git fetch`. Prints `HAVE n` /
/// `FETCHED n` / `MISSING n`.
pub fn fetch_script(clone: &str, source: &str, provider: &str, wants: &[FetchWant]) -> String {
    let mut lines = vec![
        GIT_ENV.to_owned(),
        format!("cd {} || exit 2", sh_quote(clone)),
        r#"specs=""; nums="""#.to_owned(),
    ];
    for want in wants {
        let spec = format!(
            "+{}:{}",
            forge_head_ref(provider, want.number),
            mr_ref(want.number)
        );
        let base = match (filled(&want.base_sha), filled(&want.target_branch)) {
            (Some(_), Some(target)) => format!(
                " {}",
                sh_quote(&format!(
                    "+refs/heads/{target}:refs/roamgate/target/{target}"
                ))
            ),
            _ => String::new(),
        };
        let have_base = match filled(&want.base_sha) {
            Some(sha) => format!(
                " && git cat-file -e {} 2>/dev/null",
                sh_quote(&format!("{sha}^{{commit}}"))
            ),
            None => String::new(),
        };
        lines.push(
            [
                format!(
                    "if git cat-file -e {} 2>/dev/null{have_base}; then",
                    sh_quote(&format!("{}^{{commit}}", want.head_sha))
                ),
                format!(
                    "  git update-ref {} {} 2>/dev/null || true",
                    sh_quote(&mr_ref(want.number)),
                    sh_quote(&want.head_sha)
                ),
                format!(r#"  echo "HAVE {}""#, want.number),
                "else".to_owned(),
                format!(
                    r#"  specs="$specs {}{base}"; nums="$nums {}""#,
                    sh_quote(&spec),
                    want.number
                ),
                "fi".to_owned(),
            ]
            .join("\n"),
        );
    }
    lines.extend([
        r#"[ -z "$specs" ] && exit 0"#.to_owned(),
        format!(
            "if eval git fetch --no-tags --quiet {} $specs >&2; then",
            sh_quote(source)
        ),
        r#"  for n in $nums; do echo "FETCHED $n"; done"#.to_owned(),
        "else".to_owned(),
        // One request gone (merged and its ref removed) must not keep the
        // others: one at a time then.
        "  for n in $nums; do".to_owned(),
        format!(
            r#"    case "{provider}" in gitlab) r="refs/merge-requests/$n/head" ;; *) r="refs/pull/$n/head" ;; esac"#
        ),
        format!(
            r#"    if git fetch --no-tags --quiet {} "+$r:refs/roamgate/mr/$n" >&2; then echo "FETCHED $n"; else echo "MISSING $n"; fi"#,
            sh_quote(source)
        ),
        "  done".to_owned(),
        "fi".to_owned(),
        "exit 0".to_owned(),
    ]);
    lines.join("\n")
}

/// What [`fetch_script`] said, by request number.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fetched {
    pub have: Vec<i64>,
    pub fetched: Vec<i64>,
    pub missing: Vec<i64>,
}

/// `parseFetch`.
pub fn parse_fetch(stdout: &str) -> Fetched {
    let mut out = Fetched::default();
    for line in stdout.split('\n') {
        let mut words = js::trim(line).split(' ');
        let word = words.next().unwrap_or("");
        let number = match words.next() {
            Some(n) => js::number_from_text(n),
            None => f64::NAN,
        };
        if !js::is_safe_integer(number) {
            continue;
        }
        let number = number as i64;
        match word {
            "HAVE" => out.have.push(number),
            "FETCHED" => out.fetched.push(number),
            "MISSING" => out.missing.push(number),
            _ => {}
        }
    }
    out
}

/// `statusScript`: the worktree's head and its local changes.
pub fn status_script(path: &str) -> String {
    [
        format!("cd {} || exit 2", sh_quote(path)),
        r#"printf "HEAD %s\n" "$(git rev-parse HEAD 2>/dev/null)""#.to_owned(),
        r#"printf "BRANCH %s\n" "$(git symbolic-ref -q --short HEAD 2>/dev/null)""#.to_owned(),
        "git status --porcelain=v1 -uall 2>/dev/null | head -200 | sed 's/^/C /'".to_owned(),
    ]
    .join("\n")
}

/// `WorktreeStatus`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorktreeStatus {
    pub head: String,
    pub branch: String,
    /// Changed paths, `XY path` as git prints them.
    pub changes: Vec<String>,
}

impl WorktreeStatus {
    /// `{head, branch, changes}`.
    pub fn to_json(&self) -> Value {
        json!({"head": self.head, "branch": self.branch, "changes": self.changes})
    }
}

/// `parseStatus`.
pub fn parse_status(stdout: &str) -> WorktreeStatus {
    let mut status = WorktreeStatus::default();
    for line in stdout.split('\n') {
        if let Some(head) = line.strip_prefix("HEAD ") {
            status.head = js::trim(head).to_owned();
        } else if let Some(branch) = line.strip_prefix("BRANCH ") {
            status.branch = js::trim(branch).to_owned();
        } else if let Some(change) = line.strip_prefix("C ") {
            status.changes.push(change.to_owned());
        }
    }
    status
}

/// `LocalChanges`: what to do with local changes before switching.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalChanges {
    Refuse,
    Wip,
    Discard,
}

impl LocalChanges {
    /// `"refuse"`, `"wip"` or `"discard"`.
    pub fn parse(text: &str) -> Option<LocalChanges> {
        match text {
            "refuse" => Some(LocalChanges::Refuse),
            "wip" => Some(LocalChanges::Wip),
            "discard" => Some(LocalChanges::Discard),
            _ => None,
        }
    }
}

static LABEL_UNSAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.-]+").expect("pattern"));

/// `checkoutScript`: checks out `sha` detached. With local changes:
/// `Refuse` prints DIRTY and changes nothing; `Wip` commits them all on a
/// new `review/<label>` branch (another name if taken) first and prints
/// `KEPT <branch>`; `Discard` resets and cleans, as the user asked.
pub fn checkout_script(path: &str, sha: &str, local: LocalChanges, label: &str) -> String {
    let branch = format!("review/{}", LABEL_UNSAFE.replace_all(label, "-"));
    let mut lines = vec![
        GIT_ENV.to_owned(),
        format!("cd {} || exit 2", sh_quote(path)),
        format!(
            r#"git cat-file -e {} 2>/dev/null || {{ echo "NOCOMMIT"; exit 3; }}"#,
            sh_quote(&format!("{sha}^{{commit}}"))
        ),
        r#"if [ -n "$(git status --porcelain=v1 -uall 2>/dev/null | head -1)" ]; then"#.to_owned(),
    ];
    match local {
        LocalChanges::Refuse => lines.push(r#"  echo "DIRTY"; exit 4"#.to_owned()),
        LocalChanges::Wip => lines.extend([
            format!("  b={}", sh_quote(&branch)),
            r#"  if git show-ref --verify --quiet "refs/heads/$b"; then b="$b-$(date +%Y%m%d-%H%M%S)"; fi"#.to_owned(),
            r#"  git checkout -q -b "$b" >&2 || exit 5"#.to_owned(),
            format!(
                "  git add -A >&2 && git commit -q --no-verify -m {} >&2 || exit 5",
                sh_quote(&format!("WIP review of {label}"))
            ),
            r#"  echo "KEPT $b""#.to_owned(),
        ]),
        LocalChanges::Discard => lines.extend([
            "  git reset -q --hard >&2 && git clean -fdq >&2 || exit 5".to_owned(),
            r#"  echo "DISCARDED""#.to_owned(),
        ]),
    }
    lines.extend([
        "fi".to_owned(),
        format!("git checkout -q --detach {} >&2 || exit 6", sh_quote(sha)),
        r#"echo "AT $(git rev-parse HEAD)""#.to_owned(),
    ]);
    lines.join("\n")
}

/// `CheckoutResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckoutResult {
    Done {
        head: String,
        kept: Option<String>,
        discarded: bool,
    },
    Dirty,
    Missing,
    Error {
        message: String,
    },
}

impl CheckoutResult {
    /// As Bun answers it: `{state, ...}`.
    pub fn to_json(&self) -> Value {
        let mut out = Obj::new();
        match self {
            CheckoutResult::Done {
                head,
                kept,
                discarded,
            } => {
                out.insert("state".into(), json!("done"));
                out.insert("head".into(), json!(head));
                if let Some(kept) = kept {
                    out.insert("kept".into(), json!(kept));
                }
                if *discarded {
                    out.insert("discarded".into(), json!(true));
                }
            }
            CheckoutResult::Dirty => {
                out.insert("state".into(), json!("dirty"));
            }
            CheckoutResult::Missing => {
                out.insert("state".into(), json!("missing"));
            }
            CheckoutResult::Error { message } => {
                out.insert("state".into(), json!("error"));
                out.insert("message".into(), json!(message));
            }
        }
        Value::Object(out)
    }
}

/// `parseCheckout`.
pub fn parse_checkout(result: &ShellResult) -> CheckoutResult {
    let lines: Vec<&str> = result.stdout.split('\n').map(js::trim).collect();
    if lines.contains(&"DIRTY") {
        return CheckoutResult::Dirty;
    }
    if lines.contains(&"NOCOMMIT") {
        return CheckoutResult::Missing;
    }
    let at = lines.iter().find_map(|line| line.strip_prefix("AT "));
    if result.code == 0
        && let Some(head) = at
    {
        return CheckoutResult::Done {
            head: head.to_owned(),
            kept: lines
                .iter()
                .find_map(|line| line.strip_prefix("KEPT "))
                .map(str::to_owned),
            discarded: lines.contains(&"DISCARDED"),
        };
    }
    let stderr = if result.stderr.is_empty() {
        "the checkout failed"
    } else {
        &result.stderr
    };
    CheckoutResult::Error {
        message: js::slice16(js::trim(stderr), -300, None),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    //! `worktree.test.ts`: the scripts run by `sh` on real repositories: a
    //! bare "forge" with merge request refs and a clone of it.

    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use super::*;
    use crate::clones::{ProjectRef, clones_script, match_clones, order_connections, parse_clones};

    /// `dir`'s real path as git and the scripts print it: `/` separators
    /// on Windows too.
    pub(crate) fn git_form(dir: &Path) -> PathBuf {
        let real = roamgate_base::paths::realpath(dir).unwrap();
        if cfg!(windows) {
            PathBuf::from(real.to_string_lossy().replace('\\', "/"))
        } else {
            real
        }
    }

    pub(crate) fn sh(script: &str, cwd: &Path) -> ShellResult {
        let output = Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.org")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.org")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::null())
            .output()
            .expect("sh");
        ShellResult {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    struct Forge {
        _dir: tempfile::TempDir,
        root: PathBuf,
        heads: [String; 2],
    }

    impl Forge {
        fn run(&self, script: &str) -> ShellResult {
            sh(script, &self.root)
        }
        fn clone_dir(&self) -> String {
            self.root.join("clone").display().to_string()
        }
    }

    fn forge() -> Forge {
        let dir = tempfile::Builder::new().prefix("mr-wt-").tempdir().unwrap();
        let root = git_form(dir.path());
        let setup = sh(
            r#"
    set -e
    git init -q -b main forge-src && cd forge-src
    git config user.email t@example.org && git config user.name T
    echo base > a.txt && git add a.txt && git commit -qm base
    git checkout -qb mr1 && echo one > b.txt && git add b.txt && git commit -qm one
    git checkout -q main && git checkout -qb mr2 && echo two > c.txt && git add c.txt && git commit -qm two
    git checkout -q main
    cd .. && git clone -q --bare forge-src forge.git
    cd forge.git
    git update-ref refs/merge-requests/1/head $(git rev-parse mr1)
    git update-ref refs/merge-requests/2/head $(git rev-parse mr2)
    git branch -D mr1 mr2 >/dev/null
    cd .. && git clone -q --no-local forge.git clone
    git -C clone remote rename origin upstream
    git -C clone remote set-url upstream https://gitlab.example.org/group/app.git
    git -C clone config "url.$PWD/forge.git.insteadOf" https://gitlab.example.org/group/app.git
    git -C clone remote add mine git@gitlab.example.org:me/app.git
  "#,
            &root,
        );
        assert_eq!(setup.code, 0, "{}", setup.stderr);
        let head = |n: u32| {
            sh(
                &format!("git -C forge.git rev-parse refs/merge-requests/{n}/head"),
                &root,
            )
            .stdout
            .trim()
            .to_owned()
        };
        let heads = [head(1), head(2)];
        Forge {
            _dir: dir,
            root,
            heads,
        }
    }

    fn want(number: u64, head: &str) -> FetchWant {
        FetchWant {
            number,
            head_sha: head.to_owned(),
            ..FetchWant::default()
        }
    }

    #[test]
    fn worktree_prefetch_detached_checkout_local_changes() {
        let f = forge();
        let clone = f.clone_dir();
        let wt = review_worktree_path(&clone);
        assert_eq!(wt, format!("{clone}.worktrees/review"));
        assert_eq!(
            f.run(&ensure_worktree_script(&clone, &wt, "upstream/main"))
                .stdout
                .trim(),
            "CREATED"
        );
        assert_eq!(
            f.run(&ensure_worktree_script(&clone, &wt, "upstream/main"))
                .stdout
                .trim(),
            "EXISTS"
        );
        let mut fetched = parse_fetch(
            &f.run(&fetch_script(
                &clone,
                "upstream",
                "gitlab",
                &[
                    want(1, &f.heads[0]),
                    want(2, &f.heads[1]),
                    want(9, &"f".repeat(40)),
                ],
            ))
            .stdout,
        );
        fetched.fetched.sort();
        assert_eq!(fetched.fetched, vec![1, 2]);
        assert_eq!(fetched.missing, vec![9]);
        // Prefetched: the next time is no fetch at all.
        assert_eq!(
            parse_fetch(
                &f.run(&fetch_script(
                    &clone,
                    "upstream",
                    "gitlab",
                    &[want(1, &f.heads[0])]
                ))
                .stdout
            )
            .have,
            vec![1]
        );
        let result = parse_checkout(&f.run(&checkout_script(
            &wt,
            &f.heads[0],
            LocalChanges::Refuse,
            "1",
        )));
        assert_eq!(
            result.to_json(),
            json!({"state": "done", "head": f.heads[0]})
        );
        assert_ne!(f.run(&format!("git -C {wt} symbolic-ref -q HEAD")).code, 0);
        // Local changes: refused, kept on a branch, or dropped on request.
        let wt_path = Path::new(&wt);
        std::fs::write(wt_path.join("b.txt"), "edited\n").unwrap();
        std::fs::write(wt_path.join("new.txt"), "untracked\n").unwrap();
        assert_eq!(
            parse_checkout(&f.run(&checkout_script(
                &wt,
                &f.heads[1],
                LocalChanges::Refuse,
                "1"
            ))),
            CheckoutResult::Dirty
        );
        assert_eq!(
            std::fs::read_to_string(wt_path.join("b.txt")).unwrap(),
            "edited\n"
        );
        let result =
            parse_checkout(&f.run(&checkout_script(&wt, &f.heads[1], LocalChanges::Wip, "1")));
        assert!(matches!(
            &result,
            CheckoutResult::Done { head, kept: Some(kept), .. } if *head == f.heads[1] && kept == "review/1"
        ));
        assert_eq!(
            f.run(&format!("git -C {clone} show review/1:b.txt")).stdout,
            "edited\n"
        );
        assert_eq!(
            f.run(&format!("git -C {clone} show review/1:new.txt"))
                .stdout,
            "untracked\n"
        );
        assert!(!wt_path.join("new.txt").exists());
        // A second WIP of the same request gets another branch.
        std::fs::write(wt_path.join("c.txt"), "again\n").unwrap();
        let result =
            parse_checkout(&f.run(&checkout_script(&wt, &f.heads[0], LocalChanges::Wip, "1")));
        let CheckoutResult::Done {
            kept: Some(kept), ..
        } = result
        else {
            panic!("{result:?}");
        };
        assert!(
            Regex::new(r"^review/1-\d{8}-\d{6}$")
                .unwrap()
                .is_match(&kept),
            "{kept}"
        );
        std::fs::write(wt_path.join("a.txt"), "drop me\n").unwrap();
        let result = parse_checkout(&f.run(&checkout_script(
            &wt,
            &f.heads[1],
            LocalChanges::Discard,
            "1",
        )));
        assert!(matches!(
            result,
            CheckoutResult::Done {
                discarded: true,
                ..
            }
        ));
        assert_eq!(
            std::fs::read_to_string(wt_path.join("a.txt")).unwrap(),
            "base\n"
        );
        // A head that is not there says so.
        assert_eq!(
            parse_checkout(&f.run(&checkout_script(
                &wt,
                &"e".repeat(40),
                LocalChanges::Refuse,
                "1"
            ))),
            CheckoutResult::Missing
        );
    }

    #[test]
    fn clones_the_main_checkout_and_the_remote_that_is_the_project() {
        let f = forge();
        let clone = f.clone_dir();
        let wt = review_worktree_path(&clone);
        assert_eq!(
            f.run(&ensure_worktree_script(&clone, &wt, "upstream/main"))
                .code,
            0
        );
        let scanned = parse_clones(
            &f.run(&clones_script(&[
                clone.clone(),
                wt.clone(),
                "/nonexistent".into(),
            ]))
            .stdout,
        );
        assert_eq!(
            scanned
                .iter()
                .map(|repo| repo.path.as_str())
                .collect::<Vec<_>>(),
            vec![clone.as_str()]
        );
        let project = ProjectRef {
            host: "gitlab.example.org".into(),
            project: "group/app".into(),
            provider: "gitlab".into(),
        };
        let again = parse_clones(&f.run(&clones_script(std::slice::from_ref(&clone))).stdout);
        let found = match_clones("local", &again, &project);
        assert_eq!(found.len(), 1);
        assert_eq!(
            (
                found[0].connection_id.as_str(),
                found[0].path.as_str(),
                found[0].remote.as_str()
            ),
            ("local", clone.as_str(), "upstream")
        );
        let other = ProjectRef {
            project: "group/other".into(),
            ..project
        };
        assert!(match_clones("local", &again, &other).is_empty());
    }

    #[test]
    fn a_repository_directory_with_linked_worktrees_gstreamer_git() {
        let f = forge();
        let setup = f.run(
            r#"
      set -e
      git init -q -b main repo.git && cd repo.git
      echo x > a && git add a && git commit -qm x
      git remote add origin https://gitlab.example.org/group/lay.git
      git worktree add -q ../lay-linked
    "#,
        );
        assert_eq!(setup.code, 0, "{}", setup.stderr);
        let linked = f.root.join("lay-linked").display().to_string();
        let scanned = parse_clones(&f.run(&clones_script(&[linked])).stdout);
        let repo = f.root.join("repo.git").display().to_string();
        assert_eq!(
            scanned
                .iter()
                .map(|repo| repo.path.as_str())
                .collect::<Vec<_>>(),
            vec![repo.as_str()]
        );
        assert_eq!(
            review_worktree_path(&repo),
            f.root.join("repo.worktrees/review").display().to_string()
        );
    }

    #[test]
    fn the_default_connection_first_then_this_machine_then_the_others() {
        assert_eq!(
            order_connections(vec![
                (false, false, "local"),
                (false, true, "laptop"),
                (true, true, "desktop"),
            ]),
            vec!["desktop", "local", "laptop"]
        );
    }

    #[test]
    fn status_and_fetch_parse_as_bun_reads_them() {
        let status = parse_status("HEAD abc \nBRANCH \nC  M a.txt\nC ?? b\n");
        assert_eq!(
            status.to_json(),
            json!({"head": "abc", "branch": "", "changes": [" M a.txt", "?? b"]})
        );
        let fetched = parse_fetch("HAVE 3\nFETCHED x\nMISSING  4\n  FETCHED 5  \n");
        assert_eq!(fetched.have, vec![3]);
        assert_eq!(fetched.fetched, vec![5]);
        assert_eq!(fetched.missing, vec![0]);
        let error = parse_checkout(&ShellResult {
            code: 6,
            stdout: String::new(),
            stderr: String::new(),
        });
        assert_eq!(
            error.to_json(),
            json!({"state": "error", "message": "the checkout failed"})
        );
    }
}
