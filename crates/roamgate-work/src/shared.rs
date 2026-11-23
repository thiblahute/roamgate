//! The board's logic the server uses from shared/work.ts (and
//! `parseAgentAddress` from shared/agentMessage.ts), held to
//! contract/vectors/work.json: the web keeps its TS copy, the server this
//! one (plan, section 6.4).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::model::{
    REVIEW_USER, ReviewThread, WORK_ASK_STATES, WORK_LANDING_DONE_STATES, WorkDoneRule, WorkItem,
    WorkLink, WorkOwner, WorkProject, is_work_state, limits,
};
use crate::text::{js_regex, js_trim, js_trim_end, slice_utf16, utf16_len};

/// A session's address, `connection/pane`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAddress {
    pub connection_id: String,
    pub pane_id: String,
}

static ADDRESS_PART: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:-]+$").expect("address"));

/// `parseAgentAddress`.
pub fn parse_agent_address(address: &str) -> Option<AgentAddress> {
    let trimmed = js_trim(address);
    let at = trimmed.find('/')?;
    if at == 0 || at == trimmed.len() - 1 {
        return None;
    }
    let connection_id = &trimmed[..at];
    let pane_id = &trimmed[at + 1..];
    if !ADDRESS_PART.is_match(connection_id) || !ADDRESS_PART.is_match(pane_id) {
        return None;
    }
    Some(AgentAddress {
        connection_id: connection_id.into(),
        pane_id: pane_id.into(),
    })
}

pub fn work_state_asks(state: &str) -> bool {
    WORK_ASK_STATES.contains(&state)
}

pub fn work_landing_makes_done(state: &str) -> bool {
    WORK_LANDING_DONE_STATES.contains(&state)
}

static WRITES_IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(something else|other|none of (these|the above))\b").expect("writes in")
});

/// `workAnswerWritesIn`.
pub fn work_answer_writes_in(answer: &str) -> bool {
    WRITES_IN.is_match(js_trim(answer))
}

/// `workAskOf`: the ask of a For you or Verify item, with its tappable
/// answers.
pub fn work_ask_of(
    state: &str,
    ask: Option<&str>,
    answers: Option<&[String]>,
) -> Option<(String, Vec<String>)> {
    let ask = ask.map(js_trim).filter(|ask| !ask.is_empty())?;
    if !work_state_asks(state) {
        return None;
    }
    Some((
        ask.to_owned(),
        answers
            .unwrap_or_default()
            .iter()
            .filter(|each| !work_answer_writes_in(each))
            .cloned()
            .collect(),
    ))
}

static SPACES: LazyLock<Regex> = LazyLock::new(|| js_regex("{S}+"));

/// `normalizeWorkAnswers`.
pub fn normalize_work_answers<S: AsRef<str>>(answers: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for raw in answers {
        let answer = SPACES.replace_all(raw.as_ref(), " ");
        let answer = js_trim(&answer);
        let short = if utf16_len(answer) > limits::ANSWER_CHARS {
            format!(
                "{}\u{2026}",
                js_trim_end(slice_utf16(answer, limits::ANSWER_CHARS - 1))
            )
        } else {
            answer.to_owned()
        };
        let key = short.to_lowercase();
        if short.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(short);
    }
    out.truncate(limits::ANSWERS);
    out
}

/// WORK_ID.
pub fn is_work_id(id: &str) -> bool {
    (8..=16).contains(&id.len())
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub const WORK_PROVISIONAL_TITLE_CHARS: usize = 80;

static IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").expect("image"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{S}*#+{S}*"));
static LIST_MARK: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{S}*(?:[-*+]|\d+[.)]){S}+"));

/// `provisionalWorkTitle`.
pub fn provisional_work_title(text: &str) -> String {
    for raw in text.split('\n') {
        let line = IMAGE.replace_all(raw, " ");
        let line = HEADING.replace(&line, "");
        let line = LIST_MARK.replace(&line, "");
        let line = SPACES.replace_all(&line, " ");
        let line = js_trim(&line);
        if line.is_empty() {
            continue;
        }
        return if utf16_len(line) > WORK_PROVISIONAL_TITLE_CHARS {
            format!(
                "{}\u{2026}",
                js_trim_end(slice_utf16(line, WORK_PROVISIONAL_TITLE_CHARS - 1))
            )
        } else {
            line.to_owned()
        };
    }
    "New item".into()
}

/// A project's id and parent, the parts the tree needs.
pub trait ProjectRef {
    fn id(&self) -> &str;
    fn parent(&self) -> Option<&str>;
}

impl ProjectRef for WorkProject {
    fn id(&self) -> &str {
        &self.id
    }
    fn parent(&self) -> Option<&str> {
        self.parent.as_deref()
    }
}

/// `workProjectFamily`: a project and its subprojects, the project first.
pub fn work_project_family<P: ProjectRef>(projects: &[P], id: &str) -> Vec<String> {
    let mut family = vec![id.to_owned()];
    let mut at = 0;
    while at < family.len() {
        for project in projects {
            if project.parent() == Some(family[at].as_str())
                && !family.iter().any(|known| known == project.id())
            {
                family.push(project.id().to_owned());
            }
        }
        at += 1;
    }
    family
}

/// `workTopProject`.
pub fn work_top_project<P: ProjectRef>(projects: &[P], id: &str) -> String {
    let mut seen = HashSet::new();
    let mut current = id.to_owned();
    while seen.insert(current.clone()) {
        let parent = projects
            .iter()
            .find(|each| each.id() == current)
            .and_then(ProjectRef::parent);
        match parent {
            Some(parent) if projects.iter().any(|each| each.id() == parent) => {
                current = parent.to_owned();
            }
            _ => break,
        }
    }
    current
}

pub const WORK_WORKSPACE_TAG_PREFIX: &str = "ws:";

static NOT_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").expect("slug"));

/// `workWorkspaceTag`.
pub fn work_workspace_tag(label: &str) -> Option<String> {
    let room = limits::TAG_CHARS - WORK_WORKSPACE_TAG_PREFIX.len();
    let stripped: String = label
        .nfkd()
        .filter(|each| !('\u{300}'..='\u{36F}').contains(each))
        .collect::<String>()
        .to_lowercase();
    let slug = NOT_SLUG.replace_all(&stripped, "-");
    let slug = slug.trim_start_matches('-');
    let slug = slice_utf16(slug, room).trim_end_matches('-');
    (!slug.is_empty()).then(|| format!("{WORK_WORKSPACE_TAG_PREFIX}{slug}"))
}

pub fn is_work_workspace_tag(tag: &str) -> bool {
    tag.starts_with(WORK_WORKSPACE_TAG_PREFIX) && tag.len() > WORK_WORKSPACE_TAG_PREFIX.len()
}

/// A workspace as the board places it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkPlace {
    pub connection_id: String,
    pub label: String,
    pub paths: Vec<String>,
    pub pane_ids: Vec<String>,
}

fn path_under(path: &str, root: &str) -> bool {
    let base = root.trim_end_matches('/');
    !base.is_empty() && (path == base || path.starts_with(&format!("{base}/")))
}

/// `workProjectForPaths`.
pub fn work_project_for_paths<'a>(
    projects: &'a [WorkProject],
    connection_id: &str,
    paths: &[Option<&str>],
) -> Option<&'a WorkProject> {
    for path in paths.iter().flatten() {
        if path.is_empty() {
            continue;
        }
        let mut best: Option<(&WorkProject, usize)> = None;
        for project in projects {
            for root in &project.roots {
                if root.connection_id == connection_id
                    && path_under(path, &root.path)
                    && best.is_none_or(|(_, length)| utf16_len(&root.path) > length)
                {
                    best = Some((project, utf16_len(&root.path)));
                }
            }
        }
        if let Some((project, _)) = best {
            return Some(project);
        }
    }
    None
}

/// A checkout a link may be in, on its connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkLinkRoot {
    pub connection_id: Option<String>,
    pub path: String,
}

/// `workLinkRoots`.
pub fn work_link_roots(link: &WorkLink, project: Option<&WorkProject>) -> Vec<WorkLinkRoot> {
    let roots = project
        .map(|each| each.roots.as_slice())
        .unwrap_or_default();
    let mut out: Vec<WorkLinkRoot> = Vec::new();
    let mut seen = HashSet::new();
    let mut put = |connection_id: Option<&str>, raw: &str| {
        let path = if utf16_len(raw) > 1 {
            raw.trim_end_matches('/')
        } else {
            raw
        };
        let key = format!("{}\n{path}", connection_id.unwrap_or(""));
        if path.is_empty() || !seen.insert(key) {
            return;
        }
        out.push(WorkLinkRoot {
            connection_id: connection_id
                .filter(|each| !each.is_empty())
                .map(str::to_owned),
            path: path.to_owned(),
        });
    };
    let own = match link {
        WorkLink::Commit { root, .. }
        | WorkLink::Branch { root, .. }
        | WorkLink::File { root, .. } => root.as_deref().filter(|root| !root.is_empty()),
        _ => None,
    };
    if let Some(own) = own {
        let mut best: Option<(&str, usize)> = None;
        for root in roots {
            if path_under(own, &root.path)
                && best.is_none_or(|(_, length)| utf16_len(&root.path) > length)
            {
                best = Some((&root.connection_id, utf16_len(&root.path)));
            }
        }
        put(best.map(|(connection, _)| connection), own);
    }
    for root in roots {
        put(Some(&root.connection_id), &root.path);
    }
    if let Some(WorkDoneRule::Branch {
        root,
        connection_id,
        ..
    }) = project.map(|each| &each.done)
    {
        put(connection_id.as_deref(), root);
    }
    out
}

/// `workPlaceScope`: the project a workspace stands in, its tag, and
/// whether it is that project's coordinator's.
pub fn work_place_scope<'a>(
    place: &WorkPlace,
    projects: &'a [WorkProject],
) -> Option<(&'a WorkProject, Option<String>, bool)> {
    let tag = work_workspace_tag(&place.label);
    let coordinating = projects.iter().find(|project| {
        project
            .coordinator
            .as_ref()
            .and_then(|coordinator| parse_agent_address(&coordinator.session))
            .is_some_and(|address| {
                address.connection_id == place.connection_id
                    && place.pane_ids.contains(&address.pane_id)
            })
    });
    if let Some(project) = coordinating {
        return Some((project, tag, true));
    }
    let paths: Vec<Option<&str>> = place.paths.iter().map(|path| Some(path.as_str())).collect();
    work_project_for_paths(projects, &place.connection_id, &paths)
        .map(|project| (project, tag, false))
}

/// `workPlaceTagFor`.
pub fn work_place_tag_for(
    place: &WorkPlace,
    projects: &[WorkProject],
    item_project: &str,
) -> Option<String> {
    let (project, tag, coordinator) = work_place_scope(place, projects)?;
    let tag = tag?;
    if coordinator {
        return None;
    }
    (work_top_project(projects, &project.id) == work_top_project(projects, item_project))
        .then_some(tag)
}

static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#").expect("hash"));

/// `normalizeWorkTag`.
pub fn normalize_work_tag(tag: &str) -> String {
    let tag = js_trim(tag).to_lowercase();
    let tag = HASH.replace(&tag, "");
    let tag = SPACES.replace_all(&tag, "-");
    slice_utf16(&tag, limits::TAG_CHARS).to_owned()
}

/// `normalizeWorkTags`.
pub fn normalize_work_tags<S: AsRef<str>>(tags: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag = normalize_work_tag(raw.as_ref());
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out.truncate(limits::TAGS_PER_ITEM);
    out
}

static TITLE_STATE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^\*\*([a-z-]+)\*\*{S}*[:-]?{S}*(.*)$"));
static TITLE_HEADING: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^#+{S}*"));
static TITLE_LIST: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^[-*]{S}+"));

/// `parseWorkTitle` (shared): a TODO thread's `**state** Title` line.
pub fn parse_title_line(line: &str) -> (Option<String>, String) {
    let first = js_trim(line.split('\n').next().unwrap_or(""));
    if let Some(found) = TITLE_STATE.captures(first) {
        let word = found[1].to_lowercase();
        let state = if word == "for-you" || word == "foryou" {
            "you".to_owned()
        } else {
            word
        };
        if is_work_state(&state) {
            return (Some(state), js_trim(&found[2]).to_owned());
        }
    }
    let title = TITLE_HEADING.replace(first, "");
    let title = TITLE_LIST.replace(&title, "");
    (None, title.into_owned())
}

/// A search of the board.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkQuery {
    pub words: Vec<String>,
    pub tags: Vec<String>,
    pub owners: Vec<String>,
    pub partial: Option<String>,
}

static QUERY_SPLIT: LazyLock<Regex> = LazyLock::new(|| js_regex("{S}+"));
static TRAILING_SPACE: LazyLock<Regex> = LazyLock::new(|| js_regex("{S}$"));

/// `parseWorkQuery`.
pub fn parse_work_query(query: &str) -> WorkQuery {
    let lower = query.to_lowercase();
    let all: Vec<&str> = QUERY_SPLIT
        .split(&lower)
        .filter(|word| !word.is_empty())
        .collect();
    let typing = !TRAILING_SPACE.is_match(query);
    let mut out = WorkQuery::default();
    for (at, word) in all.iter().enumerate() {
        if let Some(owner) = word.strip_prefix("owner:").filter(|rest| !rest.is_empty()) {
            if !out.owners.iter().any(|known| known == owner) {
                out.owners.push(owner.to_owned());
            }
            continue;
        }
        let tag = word
            .strip_prefix('#')
            .or_else(|| word.strip_prefix("tag:"))
            .filter(|rest| !rest.is_empty());
        if let Some(tag) = tag {
            let normal = normalize_work_tag(tag);
            if normal.is_empty() {
                continue;
            }
            if typing && at == all.len() - 1 {
                out.partial = Some(normal);
            } else if !out.tags.contains(&normal) {
                out.tags.push(normal);
            }
        } else if *word != "#" && *word != "tag:" {
            out.words.push((*word).to_owned());
        }
    }
    out
}

/// What `filterWorkItems` keeps.
#[derive(Debug, Clone, Default)]
pub struct WorkFilter {
    pub project: Option<String>,
    pub projects: Option<Vec<String>>,
    pub tags: Vec<String>,
    pub states: Option<Vec<String>>,
    pub owner: Option<String>,
    pub query: Option<String>,
}

/// `filterWorkItems`.
pub fn filter_work_items<'a>(items: &'a [WorkItem], filter: &WorkFilter) -> Vec<&'a WorkItem> {
    let query = parse_work_query(filter.query.as_deref().unwrap_or(""));
    let mut tags = filter.tags.clone();
    tags.extend(query.tags.iter().cloned());
    items
        .iter()
        .filter(|item| {
            if filter
                .project
                .as_ref()
                .is_some_and(|project| &item.project != project)
            {
                return false;
            }
            if filter
                .projects
                .as_ref()
                .is_some_and(|projects| !projects.contains(&item.project))
            {
                return false;
            }
            if !tags.is_empty() && !tags.iter().all(|tag| item.tags.contains(tag)) {
                return false;
            }
            if let Some(partial) = &query.partial
                && !item
                    .tags
                    .iter()
                    .any(|tag| tag.starts_with(partial.as_str()))
            {
                return false;
            }
            if let Some(states) = &filter.states
                && !states.is_empty()
                && !states.contains(&item.state)
            {
                return false;
            }
            if let Some(owner) = &filter.owner
                && item.owner.as_ref().map(|owner| owner.session.as_str()) != Some(owner.as_str())
            {
                return false;
            }
            if !query.owners.is_empty() {
                let session = item
                    .owner
                    .as_ref()
                    .map(|owner| owner.session.to_lowercase())
                    .unwrap_or_default();
                if !query.owners.contains(&session) {
                    return false;
                }
            }
            if !query.words.is_empty() {
                let mut hay = vec![item.title.clone()];
                hay.extend(item.tags.iter().cloned());
                hay.push(
                    item.owner
                        .as_ref()
                        .map(|owner| owner.session.clone())
                        .unwrap_or_default(),
                );
                let hay = hay.join("\n").to_lowercase();
                if !query.words.iter().all(|word| hay.contains(word.as_str())) {
                    return false;
                }
            }
            true
        })
        .collect()
}

static WINDOWS_ABSOLUTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("windows"));

/// `isAbsoluteWorkPath`.
pub fn is_absolute_work_path(path: &str) -> bool {
    path.starts_with('/') || WINDOWS_ABSOLUTE.is_match(path)
}

/// `workFileLinkPath`.
pub fn work_file_link_path(path: &str, root: Option<&str>) -> String {
    match root {
        Some(root) if !root.is_empty() && !is_absolute_work_path(path) => format!(
            "{}/{}",
            root.trim_end_matches(['/', '\\']),
            path.strip_prefix("./").unwrap_or(path)
        ),
        _ => path.to_owned(),
    }
}

/// `describeWorkLink`.
pub fn describe_work_link(link: &WorkLink) -> String {
    let short = |text: &str, max: usize| slice_utf16(text, max).to_owned();
    match link {
        WorkLink::Review { id, thread } => format!(
            "review {}{}",
            short(id, 8),
            thread
                .as_deref()
                .filter(|thread| !thread.is_empty())
                .map(|thread| format!(" thread {}", short(thread, 8)))
                .unwrap_or_default()
        ),
        WorkLink::Effort { id, part } => format!(
            "effort {id}{}",
            part.as_deref()
                .filter(|part| !part.is_empty())
                .map(|part| format!(" part {part}"))
                .unwrap_or_default()
        ),
        WorkLink::Pr { url } => url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .unwrap_or(url)
            .to_owned(),
        WorkLink::Commit { sha, subject, .. } => format!(
            "{}{}",
            short(sha, 10),
            subject
                .as_deref()
                .filter(|subject| !subject.is_empty())
                .map(|subject| format!(" {subject}"))
                .unwrap_or_default()
        ),
        WorkLink::Branch { name, .. } => format!("branch {name}"),
        WorkLink::Decision { path, id } => {
            format!("{} {id}", path.rsplit('/').next().unwrap_or(path))
        }
        WorkLink::File {
            path, root, line, ..
        } => format!(
            "file {}{}",
            work_file_link_path(path, root.as_deref()),
            line.filter(|line| *line > 0)
                .map(|line| format!(":{line}"))
                .unwrap_or_default()
        ),
        WorkLink::Item { id } => format!("after {}", short(id, 8)),
        WorkLink::Deploy { sha, branch } => {
            let branch = branch.as_deref().filter(|branch| !branch.is_empty());
            if sha == "decision" {
                return format!("decisions {}", branch.unwrap_or("ticked"));
            }
            format!(
                "landed {}{}",
                short(sha, 10),
                branch
                    .map(|branch| format!(" on {branch}"))
                    .unwrap_or_default()
            )
        }
        WorkLink::Chat { session, entry, .. } => format!(
            "message in {session}{}",
            entry
                .as_deref()
                .filter(|entry| !entry.is_empty())
                .map(|entry| format!(" {}", short(entry, 12)))
                .unwrap_or_default()
        ),
    }
}

/// `workDoneWhen`.
pub fn work_done_when(
    state: &str,
    links: &[WorkLink],
    project: Option<&WorkDoneRule>,
) -> Option<String> {
    if state == "done" {
        return None;
    }
    let commits = links.iter().filter(|link| link.kind() == "commit").count();
    let decisions = links
        .iter()
        .filter(|link| link.kind() == "decision")
        .count();
    if commits == 0 && decisions == 0 {
        return None;
    }
    let where_ = match project {
        None => "where its project says".to_owned(),
        Some(WorkDoneRule::Deployed) => "this Roamgate's deployed build".to_owned(),
        Some(WorkDoneRule::Branch { root, branch, .. }) => format!("{branch} in {root}"),
    };
    if !work_landing_makes_done(state) {
        let landed = links.iter().any(|link| link.kind() == "deploy");
        let waits = if state == "verify" {
            "the user verifies it"
        } else {
            "the user answers"
        };
        let stays = if state == "verify" {
            "in Verify"
        } else {
            "For you"
        };
        return Some(if landed {
            format!(
                "when {waits} and marks it done: it landed already, and stays {stays} until then"
            )
        } else {
            format!(
                "when {waits} and marks it done: its landing ({}) is only recorded, the item stays {stays}",
                if commits > 0 {
                    format!("its commit reaching {where_}")
                } else {
                    "its decisions ticked".to_owned()
                }
            )
        });
    }
    if commits > 0 {
        return Some(format!(
            "{} {where_}{}",
            if commits == 1 {
                "its commit reaches"
            } else {
                "one of its commits reaches"
            },
            if decisions > 0 {
                " (its decisions do not count: they rule only an item whose links are all decisions)"
            } else {
                ""
            }
        ));
    }
    Some(format!(
        "every decision is ticked (`- [x] **Dn**`, or its `### Dn` heading answered or decided) in the file{}, or in the checkout's working tree (said uncommitted then)",
        match project {
            Some(WorkDoneRule::Branch { branch, .. }) => format!(" on {branch}"),
            _ => " as committed".to_owned(),
        }
    ))
}

/// `describeWorkOwner`.
pub fn describe_work_owner(owner: &WorkOwner) -> String {
    match &owner.task {
        Some(task) if !task.is_empty() => {
            format!("{} (task {})", owner.session, slice_utf16(task, 8))
        }
        _ => owner.session.clone(),
    }
}

/// `new Date(text).getTime()` of a stored time, or None.
fn time_of(text: &str) -> Option<i64> {
    crate::text::parse_js_date(&serde_json::Value::String(text.to_owned()))
}

/// `workDescriptionThread`: the thread made with the item, else the
/// earliest bare one on it within a minute of it.
pub fn work_description_thread<'a>(
    threads: &'a [ReviewThread],
    created_at: &str,
) -> Option<&'a ReviewThread> {
    if let Some(marked) = threads.iter().find(|thread| thread.is_description()) {
        return Some(marked);
    }
    let made = time_of(created_at)?;
    let mut early: Vec<&ReviewThread> = threads
        .iter()
        .filter(|thread| {
            if !thread.has_work() || thread.work_truthy("quote") || thread.work_truthy("from") {
                return false;
            }
            time_of(&thread.created_at).is_some_and(|at| at >= made - 1_000 && at <= made + 60_000)
        })
        .collect();
    early.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    early.first().copied()
}

/// `workOpenQuestions`.
pub fn work_open_questions(threads: &[ReviewThread], created_at: &str) -> usize {
    let Some(description) =
        work_description_thread(threads, created_at).and_then(|thread| thread.comments.first())
    else {
        return 0;
    };
    threads
        .iter()
        .filter(|thread| {
            !thread.resolved
                && thread
                    .message("comment")
                    .and_then(serde_json::Value::as_str)
                    == Some(description.id.as_str())
                && thread
                    .message("quote")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|quote| !quote.is_empty())
                && thread
                    .comments
                    .first()
                    .is_some_and(|first| first.author != REVIEW_USER)
        })
        .count()
}

/// `workTagsOf`: the tags the items use, most used first.
pub fn work_tags_of(items: &[WorkItem]) -> Vec<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for item in items {
        for tag in &item.tags {
            match counts.iter_mut().find(|(each, _)| each == tag) {
                Some(entry) => entry.1 += 1,
                None => counts.push((tag.clone(), 1)),
            }
        }
    }
    counts.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| crate::text::locale_compare(&a.0, &b.0))
    });
    counts.into_iter().map(|(tag, _)| tag).collect()
}

/// `workProjectTree`: each parent followed by its subprojects, with their
/// depth (indices into `projects`).
pub fn work_project_tree<P: ProjectRef>(projects: &[P]) -> Vec<(usize, usize)> {
    let known: HashSet<&str> = projects.iter().map(ProjectRef::id).collect();
    let mut out = Vec::new();
    let mut placed: HashSet<String> = HashSet::new();
    fn walk<P: ProjectRef>(
        projects: &[P],
        at: usize,
        depth: usize,
        placed: &mut HashSet<String>,
        out: &mut Vec<(usize, usize)>,
    ) {
        if !placed.insert(projects[at].id().to_owned()) {
            return;
        }
        out.push((at, depth));
        for (child, project) in projects.iter().enumerate() {
            if project.parent() == Some(projects[at].id()) {
                walk(projects, child, depth + 1, placed, out);
            }
        }
    }
    for (at, project) in projects.iter().enumerate() {
        if project
            .parent()
            .is_none_or(|parent| !known.contains(parent))
        {
            walk(projects, at, 0, &mut placed, &mut out);
        }
    }
    // A cycle has no top: its projects stand at the top.
    for at in 0..projects.len() {
        walk(projects, at, 0, &mut placed, &mut out);
    }
    out
}

/// `workTagLabel`: a workspace's tag as its name's slug.
pub fn work_tag_label(tag: &str) -> &str {
    if is_work_workspace_tag(tag) {
        &tag[WORK_WORKSPACE_TAG_PREFIX.len()..]
    } else {
        tag
    }
}

static DOCUMENT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"(?m)^#{1,6}{S}+\S"));

/// `workDescriptionIsDocument`: it has a Markdown heading.
pub fn work_description_is_document(text: &str) -> bool {
    DOCUMENT.is_match(text)
}

static GITLAB_MR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/-/merge_requests/(\d+)").expect("gitlab"));
static GITHUB_PR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/pulls?/(\d+)").expect("github"));

/// `workPrRef`: `!123` (GitLab), `#123` (GitHub).
pub fn work_pr_ref(url: &str) -> Option<String> {
    if let Some(found) = GITLAB_MR.captures(url) {
        return Some(format!("!{}", &found[1]));
    }
    GITHUB_PR
        .captures(url)
        .map(|found| format!("#{}", &found[1]))
}

/// `workFileLinkName`: its label, else its file's name.
pub fn work_file_link_name(path: &str, label: Option<&str>) -> String {
    if let Some(label) = label {
        return label.to_owned();
    }
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_owned()
}

#[cfg(test)]
mod vector_tests {
    use super::*;
    use crate::model::{By, WorkCoordinator, WorkRoot};
    use crate::store::{normal_project, parse_done_rule};
    use roamgate_protocol::vectors;
    use serde_json::{Value, json};

    /// The web's own: their cases are held by bun test alone.
    const WEB_ONLY: &[&str] = &[
        "work.readableWorkLink",
        "work.summarizeWorkLinks",
        "work.workTagCompletions",
        "work.workQueryWithTag",
    ];

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn opt_str(value: &Value, key: &str) -> Option<String> {
        value.get(key).and_then(Value::as_str).map(str::to_owned)
    }

    fn item(value: &Value) -> WorkItem {
        WorkItem {
            id: opt_str(value, "id").unwrap_or_default(),
            project: opt_str(value, "project").unwrap_or_default(),
            title: opt_str(value, "title").unwrap_or_default(),
            state: opt_str(value, "state").unwrap_or_default(),
            tags: strings(&value["tags"]),
            owner: value.get("owner").and_then(|owner| {
                Some(WorkOwner {
                    session: opt_str(owner, "session")?,
                    task: opt_str(owner, "task"),
                })
            }),
            source: opt_str(value, "source"),
            links: value["links"]
                .as_array()
                .into_iter()
                .flatten()
                .map(link)
                .collect(),
            created_at: opt_str(value, "createdAt").unwrap_or_default(),
            updated_at: opt_str(value, "updatedAt").unwrap_or_default(),
            done_at: opt_str(value, "doneAt"),
            by: By::User,
            review: None,
            needs_triage: false,
            ask: opt_str(value, "ask"),
            answers: value.get("answers").map(strings),
            questions: None,
        }
    }

    fn link(value: &Value) -> WorkLink {
        crate::store::parse_work_link(value).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    fn project(value: &Value) -> WorkProject {
        normal_project(value).unwrap_or_else(|| WorkProject {
            id: opt_str(value, "id").unwrap_or_default(),
            name: opt_str(value, "name").unwrap_or_default(),
            roots: value["roots"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|root| WorkRoot {
                    connection_id: opt_str(root, "connectionId").unwrap_or_default(),
                    path: opt_str(root, "path").unwrap_or_default(),
                })
                .collect(),
            done: parse_done_rule(value.get("done")).unwrap_or(WorkDoneRule::Deployed),
            tags: None,
            coordinator: value.get("coordinator").and_then(|c| {
                Some(WorkCoordinator {
                    session: opt_str(c, "session")?,
                })
            }),
            parent: opt_str(value, "parent"),
        })
    }

    fn projects(value: &Value) -> Vec<WorkProject> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .map(project)
            .collect()
    }

    fn place(value: &Value) -> WorkPlace {
        WorkPlace {
            connection_id: opt_str(value, "connectionId").unwrap_or_default(),
            label: opt_str(value, "label").unwrap_or_default(),
            paths: strings(&value["paths"]),
            pane_ids: strings(&value["paneIds"]),
        }
    }

    fn index_of(list: &Value, id: &str) -> Value {
        list.as_array()
            .unwrap()
            .iter()
            .find(|each| each["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn call(name: &str, args: &[Value]) -> Value {
        let arg = |at: usize| args.get(at).cloned().unwrap_or(Value::Null);
        match name {
            "work.provisionalWorkTitle" => json!(provisional_work_title(arg(0).as_str().unwrap())),
            "work.normalizeWorkAnswers" => json!(normalize_work_answers(&strings(&arg(0)))),
            "work.parseWorkQuery" => {
                let query = parse_work_query(arg(0).as_str().unwrap());
                let mut out =
                    json!({"words": query.words, "tags": query.tags, "owners": query.owners});
                if let Some(partial) = query.partial {
                    out["partial"] = json!(partial);
                }
                out
            }
            "work.filterWorkItems" => {
                let list = arg(0);
                let items: Vec<WorkItem> = list.as_array().unwrap().iter().map(item).collect();
                let filter = arg(1);
                let kept = filter_work_items(
                    &items,
                    &WorkFilter {
                        project: opt_str(&filter, "project"),
                        projects: filter.get("projects").map(strings),
                        tags: strings(&filter["tags"]),
                        states: filter.get("states").map(strings),
                        owner: opt_str(&filter, "owner"),
                        query: opt_str(&filter, "query"),
                    },
                );
                Value::Array(
                    kept.iter()
                        .map(|kept| {
                            let at = items
                                .iter()
                                .position(|each| std::ptr::eq(each, *kept))
                                .unwrap();
                            list[at].clone()
                        })
                        .collect(),
                )
            }
            "work.workAskOf" => {
                let it = arg(0);
                let answers = it.get("answers").map(strings);
                match work_ask_of(
                    it["state"].as_str().unwrap_or(""),
                    it["ask"].as_str(),
                    answers.as_deref(),
                ) {
                    Some((ask, answers)) => json!({"ask": ask, "answers": answers}),
                    None => Value::Null,
                }
            }
            "work.workStateAsks" => json!(work_state_asks(arg(0).as_str().unwrap())),
            "work.workLandingMakesDone" => json!(work_landing_makes_done(arg(0).as_str().unwrap())),
            "work.workProjectFamily" => json!(work_project_family(
                &projects(&arg(0)),
                arg(1).as_str().unwrap()
            )),
            "work.workTopProject" => json!(work_top_project(
                &projects(&arg(0)),
                arg(1).as_str().unwrap()
            )),
            "work.workProjectTree" => {
                let list = arg(0);
                Value::Array(
                    work_project_tree(&projects(&list))
                        .into_iter()
                        .map(|(at, depth)| json!({"project": list[at], "depth": depth}))
                        .collect(),
                )
            }
            "work.workProjectForPaths" => {
                let list = arg(0);
                let paths: Vec<Option<String>> = arg(2)
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| path.as_str().map(str::to_owned))
                    .collect();
                let paths: Vec<Option<&str>> = paths.iter().map(Option::as_deref).collect();
                let all = projects(&list);
                match work_project_for_paths(&all, arg(1).as_str().unwrap(), &paths) {
                    Some(found) => index_of(&list, &found.id),
                    None => Value::Null,
                }
            }
            "work.workWorkspaceTag" => json!(work_workspace_tag(arg(0).as_str().unwrap())),
            "work.workTagLabel" => json!(work_tag_label(arg(0).as_str().unwrap())),
            "work.workPlaceScope" => {
                let list = arg(1);
                let all = projects(&list);
                match work_place_scope(&place(&arg(0)), &all) {
                    Some((found, tag, coordinator)) => {
                        json!({"project": index_of(&list, &found.id), "tag": tag, "coordinator": coordinator})
                    }
                    None => Value::Null,
                }
            }
            "work.workPlaceTagFor" => json!(work_place_tag_for(
                &place(&arg(0)),
                &projects(&arg(1)),
                arg(2).as_str().unwrap()
            )),
            "work.workLinkRoots" => {
                let project = arg(1);
                let project = (!project.is_null()).then(|| self::project(&project));
                Value::Array(
                    work_link_roots(&link(&arg(0)), project.as_ref())
                        .into_iter()
                        .map(|root| match root.connection_id {
                            Some(connection) => {
                                json!({"connectionId": connection, "path": root.path})
                            }
                            None => json!({"path": root.path}),
                        })
                        .collect(),
                )
            }
            "work.workDoneWhen" => {
                let it = item(&arg(0));
                let project = arg(1);
                let done =
                    (!project.is_null()).then(|| parse_done_rule(project.get("done")).unwrap());
                json!(work_done_when(&it.state, &it.links, done.as_ref()))
            }
            "work.workOpenQuestions" => {
                let threads: Vec<ReviewThread> = arg(0)
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|thread| ReviewThread::from_value(thread.clone()).unwrap())
                    .collect();
                json!(work_open_questions(
                    &threads,
                    arg(1)["createdAt"].as_str().unwrap_or("")
                ))
            }
            "work.workDescriptionIsDocument" => {
                json!(work_description_is_document(arg(0).as_str().unwrap()))
            }
            "work.workPrRef" => json!(work_pr_ref(arg(0).as_str().unwrap())),
            "work.workFileLinkPath" => {
                let it = arg(0);
                json!(work_file_link_path(
                    it["path"].as_str().unwrap(),
                    it["root"].as_str()
                ))
            }
            "work.workFileLinkName" => {
                let it = arg(0);
                json!(work_file_link_name(
                    it["path"].as_str().unwrap(),
                    it["label"].as_str()
                ))
            }
            other => panic!("no Rust function for {other}"),
        }
    }

    #[test]
    fn the_server_s_board_logic_holds_to_the_work_vectors() {
        let file = vectors::load("work");
        let mut checked = 0;
        for case in &file.cases {
            for each in &case.calls {
                let name = each.target();
                if WEB_ONLY.contains(&name.as_str()) {
                    continue;
                }
                let got = call(&name, &each.args);
                let want = each.result.clone().unwrap_or(Value::Null);
                let want = if vectors::is_undefined(&want) {
                    Value::Null
                } else {
                    want
                };
                assert_eq!(got, want, "{} > {name} {:?}", case.title(), each.args);
                checked += 1;
            }
        }
        assert!(checked > 40, "{checked}");
    }
}
