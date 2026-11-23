//! The user's order of the reviews inbox (`shared/mrReviewsOrder.ts`): one
//! list of request keys applied within each section, changed only by
//! operations on the latest order. Held to `contract/vectors/mr-reviews-order.json`.

use std::collections::{HashMap, HashSet};

/// The sections, in the order they are shown.
pub const SECTIONS: [&str; 4] = ["pinned", "mine", "authored", "suggested"];

/// Requests kept in the user's order.
pub const MAX_ORDER: usize = 500;

/// The entries in the user's order; those not in it (new ones) come first.
/// `key` gives an entry's key.
pub fn order_entries<T: Clone>(
    entries: &[T],
    order: &[String],
    key: impl Fn(&T) -> &str,
) -> Vec<T> {
    if order.is_empty() {
        return entries.to_vec();
    }
    let mut at: HashMap<&str, usize> = HashMap::new();
    for (index, each) in order.iter().enumerate() {
        // A later duplicate wins, as `new Map(entries)` keeps the last.
        at.insert(each.as_str(), index);
    }
    let fresh = entries.iter().filter(|e| !at.contains_key(key(e)));
    let mut placed: Vec<&T> = entries.iter().filter(|e| at.contains_key(key(e))).collect();
    placed.sort_by_key(|e| at[key(e)]);
    fresh.cloned().chain(placed.into_iter().cloned()).collect()
}

/// `keys` with `key` moved just before or after `target`.
pub fn move_key(keys: &[String], key: &str, target: &str, after: bool) -> Vec<String> {
    if key == target || !keys.iter().any(|k| k == key) || !keys.iter().any(|k| k == target) {
        return keys.to_vec();
    }
    let mut rest: Vec<String> = keys.iter().filter(|k| *k != key).cloned().collect();
    let at = rest.iter().position(|k| k == target).unwrap_or(0) + usize::from(after);
    rest.insert(at, key.to_owned());
    rest
}

/// An order operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderOp {
    Top(Vec<String>),
    Bottom(Vec<String>),
    Before(Vec<String>, String),
    After(Vec<String>, String),
    /// The listed requests first, in this order; the rest follow unchanged.
    Arrange(Vec<String>),
}

impl OrderOp {
    pub fn keys(&self) -> &[String] {
        match self {
            OrderOp::Top(k) | OrderOp::Bottom(k) | OrderOp::Arrange(k) => k,
            OrderOp::Before(k, _) | OrderOp::After(k, _) => k,
        }
    }
}

/// The displayed sections, each in its shown order (indexed as [`SECTIONS`]).
pub type Sections = [Vec<String>; 4];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderOutcome {
    pub sections: Sections,
    /// Keys whose place changed.
    pub moved: Vec<String>,
    /// Keys that are not listed in the inbox.
    pub unknown: Vec<String>,
    /// Keys left alone: in another section than the target.
    pub elsewhere: Vec<String>,
}

fn section_of(sections: &Sections, key: &str) -> Option<usize> {
    sections.iter().position(|s| s.iter().any(|k| k == key))
}

/// Applies an operation: top, bottom and arrange act within each request's
/// own section; before and after place the keys beside the target.
pub fn apply_order_op(current: &Sections, operation: &OrderOp) -> OrderOutcome {
    let mut sections = current.clone();
    let mut unknown = Vec::new();
    let mut elsewhere = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for key in operation.keys() {
        if keys.contains(key) {
            continue;
        }
        if section_of(&sections, key).is_none() {
            unknown.push(key.clone());
        } else {
            keys.push(key.clone());
        }
    }
    let place = |sections: &mut Sections, name: usize, group: &[String], at: usize| {
        let rest: Vec<String> = sections[name]
            .iter()
            .filter(|k| !group.contains(k))
            .cloned()
            .collect();
        let at = at.min(rest.len());
        let mut out = rest[..at].to_vec();
        out.extend(group.iter().cloned());
        out.extend(rest[at..].iter().cloned());
        sections[name] = out;
    };
    match operation {
        OrderOp::Before(_, target) | OrderOp::After(_, target) => {
            let Some(home) = section_of(&sections, target) else {
                unknown.push(target.clone());
                return OrderOutcome {
                    sections,
                    moved: vec![],
                    unknown,
                    elsewhere,
                };
            };
            let group: Vec<String> = keys
                .iter()
                .filter(|key| {
                    if *key == target {
                        return false;
                    }
                    if section_of(&sections, key) == Some(home) {
                        return true;
                    }
                    elsewhere.push((*key).clone());
                    false
                })
                .cloned()
                .collect();
            let rest: Vec<&String> = sections[home]
                .iter()
                .filter(|k| !group.contains(k))
                .collect();
            let index = rest.iter().position(|k| *k == target).unwrap_or(0);
            let at = index + usize::from(matches!(operation, OrderOp::After(..)));
            place(&mut sections, home, &group, at);
        }
        _ => {
            for name in 0..SECTIONS.len() {
                let group: Vec<String> = keys
                    .iter()
                    .filter(|k| sections[name].contains(k))
                    .cloned()
                    .collect();
                if group.is_empty() {
                    continue;
                }
                let at = if matches!(operation, OrderOp::Bottom(_)) {
                    sections[name].len() - group.len()
                } else {
                    0
                };
                place(&mut sections, name, &group, at);
            }
        }
    }
    let mut moved = Vec::new();
    for name in 0..SECTIONS.len() {
        for (index, key) in sections[name].iter().enumerate() {
            if current[name].get(index) != Some(key) && keys.contains(key) {
                moved.push(key.clone());
            }
        }
    }
    OrderOutcome {
        sections,
        moved,
        unknown,
        elsewhere,
    }
}

/// The sections as one list, as the settings' `order` keeps them.
pub fn flatten_sections(sections: &Sections) -> Vec<String> {
    sections.iter().flatten().cloned().collect()
}

/// The new stored order: the displayed one, then the keys the old order had
/// that are not listed now, capped.
pub fn stored_order(displayed: &[String], previous: &[String]) -> Vec<String> {
    let seen: HashSet<&String> = displayed.iter().collect();
    displayed
        .iter()
        .chain(previous.iter().filter(|k| !seen.contains(k)))
        .take(MAX_ORDER)
        .cloned()
        .collect()
}

/// Indices of the longest increasing run of `values`.
fn longest_increasing(values: &[usize]) -> HashSet<usize> {
    let mut tails: Vec<usize> = Vec::new();
    let mut back: Vec<isize> = vec![-1; values.len()];
    for i in 0..values.len() {
        let (mut lo, mut hi) = (0usize, tails.len());
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if values[tails[mid]] < values[i] {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo > 0 {
            back[i] = tails[lo - 1] as isize;
        }
        if lo == tails.len() {
            tails.push(i);
        } else {
            tails[lo] = i;
        }
    }
    let mut out = HashSet::new();
    let mut at = tails.last().map_or(-1, |t| *t as isize);
    while at >= 0 {
        out.insert(at as usize);
        at = back[at as usize];
    }
    out
}

/// A whole list written by someone who last saw `base`, put on `current`:
/// only what they moved is applied, each just after the key that precedes
/// it in their list (the end stays the end).
pub fn rebase_order(base: &[String], theirs: &[String], current: &[String]) -> Vec<String> {
    let mut base_at: HashMap<&str, usize> = HashMap::new();
    for (index, key) in base.iter().enumerate() {
        base_at.insert(key.as_str(), index);
    }
    let known: Vec<&String> = theirs
        .iter()
        .filter(|k| base_at.contains_key(k.as_str()))
        .collect();
    let stay = longest_increasing(
        &known
            .iter()
            .map(|k| base_at[k.as_str()])
            .collect::<Vec<_>>(),
    );
    let mut moves: HashSet<&str> = known
        .iter()
        .enumerate()
        .filter(|(index, _)| !stay.contains(index))
        .map(|(_, k)| k.as_str())
        .collect();
    let have: HashSet<&str> = current.iter().map(String::as_str).collect();
    for key in theirs {
        if !base_at.contains_key(key.as_str()) && !have.contains(key.as_str()) {
            moves.insert(key);
        }
    }
    let mut out: Vec<String> = current.to_vec();
    for (at, key) in theirs.iter().enumerate() {
        if !moves.contains(key.as_str()) {
            continue;
        }
        out.retain(|each| each != key);
        if at == theirs.len() - 1 {
            out.push(key.clone());
            continue;
        }
        let mut before: isize = -1;
        let mut i = at as isize - 1;
        while i >= 0 && before < 0 {
            before = out
                .iter()
                .position(|k| *k == theirs[i as usize])
                .map_or(-1, |p| p as isize);
            i -= 1;
        }
        out.insert((before + 1) as usize, key.clone());
    }
    out.truncate(MAX_ORDER);
    out
}

/// "3 requests" / "1 request".
pub fn count(count: usize) -> String {
    format!("{count} request{}", if count == 1 { "" } else { "s" })
}
