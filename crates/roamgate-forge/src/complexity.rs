//! GitLab GraphQL complexity (mr-reviews/complexity.ts): an estimate of a
//! query's complexity as GitLab counts it, the refusal GitLab answers when
//! a query goes over its limit, and a guard that packs units of a query
//! into batches under each host's budget, learning a host's real limit
//! from its refusals. Held to `contract/vectors/mr-complexity.json` with
//! the TS copy.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::Value;

/// GitLab's default limit for an authenticated query.
pub const GITLAB_MAX_COMPLEXITY: f64 = 250.0;
const DEFAULT_PAGE: f64 = 100.0;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Name(String),
    Punct(String),
    Args(String),
}

impl Token {
    fn text(&self) -> &str {
        match self {
            Token::Name(t) | Token::Punct(t) | Token::Args(t) => t,
        }
    }
}

fn tokens(query: &str) -> Vec<Token> {
    let chars: Vec<char> = query.chars().collect();
    let mut list = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == ',' {
            i += 1;
        } else if c == '(' {
            let start = i;
            let mut depth = 0;
            let mut in_string = false;
            while i < chars.len() {
                let c = chars[i];
                if in_string {
                    if c == '\\' {
                        i += 1;
                    } else if c == '"' {
                        in_string = false;
                    }
                } else if c == '"' {
                    in_string = true;
                } else if c == '(' {
                    depth += 1;
                } else if c == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                i += 1;
            }
            let end = i.min(chars.len());
            list.push(Token::Args(chars[start + 1..end].iter().collect()));
            i += 1;
        } else if chars[i..].starts_with(&['.', '.', '.']) {
            list.push(Token::Punct("...".into()));
            i += 3;
        } else if c == '_' || c.is_ascii_alphabetic() {
            let start = i;
            while i < chars.len() && (chars[i] == '_' || chars[i].is_ascii_alphanumeric()) {
                i += 1;
            }
            list.push(Token::Name(chars[start..i].iter().collect()));
        } else {
            list.push(Token::Punct(c.to_string()));
            i += 1;
        }
    }
    list
}

/// Whether `args` has `word` as a whole word followed by optional spaces
/// and a colon.
fn has_arg(args: &str, words: &[&str]) -> bool {
    words.iter().any(|word| {
        args.match_indices(word).any(|(at, _)| {
            let before = args[..at].chars().next_back();
            let boundary = before.is_none_or(|c| !(c == '_' || c.is_ascii_alphanumeric()));
            boundary && args[at + word.len()..].trim_start().starts_with(':')
        })
    })
}

fn page_limit(args: &str) -> Option<f64> {
    for word in ["first", "last"] {
        for (at, _) in args.match_indices(word) {
            let before = args[..at].chars().next_back();
            if before.is_some_and(|c| c == '_' || c.is_ascii_alphanumeric()) {
                continue;
            }
            let rest = args[at + word.len()..].trim_start();
            let Some(rest) = rest.strip_prefix(':') else {
                continue;
            };
            let digits: String = rest
                .trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(n) = digits.parse() {
                return Some(n);
            }
        }
    }
    None
}

fn resolver_cost(args: &str, children: f64) -> f64 {
    let mut cost = children + 1.0;
    if has_arg(args, &["sort"]) {
        cost += 1.0;
    }
    if has_arg(args, &["search"]) {
        cost += 5.0;
    }
    if !has_arg(args, &["iid", "iids"]) {
        let page = page_limit(args).unwrap_or(DEFAULT_PAGE).min(DEFAULT_PAGE);
        cost += cost * page * 0.01;
    }
    cost
}

/// GitLab's complexity of a query, as near as the query's text tells.
pub fn estimate_complexity(query: &str) -> f64 {
    let list = tokens(query);
    let mut at = 0;
    fn selection(list: &[Token], at: &mut usize) -> f64 {
        let mut cost = 0.0;
        while *at < list.len() && list[*at].text() != "}" {
            cost += field(list, at);
        }
        *at += 1;
        cost
    }
    fn field(list: &[Token], at: &mut usize) -> f64 {
        let token = list[*at].clone();
        *at += 1;
        let peek = |at: usize| list.get(at).map(Token::text);
        if token.text() == "..." {
            if peek(*at) == Some("on") {
                *at += 2;
            }
            if peek(*at) != Some("{") {
                return 0.0;
            }
            *at += 1;
            return selection(list, at);
        }
        let Token::Name(mut name) = token else {
            return 0.0;
        };
        if peek(*at) == Some(":") {
            *at += 1;
            if let Some(next) = list.get(*at) {
                name = next.text().to_owned();
            }
            *at += 1;
        }
        let args = match list.get(*at) {
            Some(Token::Args(args)) => {
                *at += 1;
                Some(args.clone())
            }
            _ => None,
        };
        let mut children = None;
        if peek(*at) == Some("{") {
            *at += 1;
            children = Some(selection(list, at));
        }
        if name == "__typename" {
            return 0.0;
        }
        if let Some(args) = args {
            return resolver_cost(&args, children.unwrap_or(0.0));
        }
        children.map_or(1.0, |children| 1.0 + children)
    }
    while at < list.len() && list[at].text() != "{" {
        at += 1;
    }
    if at >= list.len() {
        return 0.0;
    }
    at += 1;
    selection(&list, &mut at).ceil()
}

/// GitLab's refusal of a query over its limit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ComplexityRefusal {
    pub complexity: f64,
    pub max: f64,
}

/// The refusal in a message, if it is one.
pub fn refusal_in(message: &str) -> Option<ComplexityRefusal> {
    let lower = message.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("complexity of ") {
        let start = from + found + "complexity of ".len();
        from = start;
        let digits: String = lower[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if digits.is_empty() {
            continue;
        }
        let mut rest = &lower[start + digits.len()..];
        rest = rest.strip_prefix(',').unwrap_or(rest);
        let Some(rest) = rest.strip_prefix(" which exceeds ") else {
            continue;
        };
        let rest = rest.strip_prefix("the ").unwrap_or(rest);
        let rest = rest
            .strip_prefix("maximum")
            .or_else(|| rest.strip_prefix("max"));
        let Some(rest) = rest.and_then(|rest| rest.strip_prefix(" complexity of ")) else {
            continue;
        };
        let max: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if let (Ok(complexity), Ok(max)) = (digits.parse(), max.parse()) {
            return Some(ComplexityRefusal { complexity, max });
        }
    }
    None
}

/// The refusal in an answer's `errors`.
pub fn complexity_refusal(answer: &Value) -> Option<ComplexityRefusal> {
    match answer {
        Value::String(message) => refusal_in(message),
        _ => answer
            .get("errors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|error| error.get("message").and_then(Value::as_str))
            .find_map(refusal_in),
    }
}

/// What a host taught: its limit, and how far the estimates fall short.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HostLimit {
    pub max: f64,
    pub scale: f64,
}

/// Which forge a host is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Gitlab,
    Github,
}

/// A failed ask: its message (a refusal is read from it).
#[derive(Debug, Clone, PartialEq)]
pub struct AskError(pub String);

type OnLearn = Arc<dyn Fn(&str, HostLimit) + Send + Sync>;

/// Packs and runs queries under each host's learned budget.
#[derive(Clone, Default)]
pub struct ComplexityGuard {
    learned: Arc<Mutex<HashMap<String, HostLimit>>>,
    on_learn: Option<OnLearn>,
}

impl ComplexityGuard {
    pub fn new(on_learn: Option<OnLearn>) -> Self {
        Self {
            learned: Arc::default(),
            on_learn,
        }
    }

    pub fn budget(&self, host: &str, provider: Provider) -> f64 {
        if let Some(known) = self.learned.lock().unwrap().get(host) {
            return (known.max * known.scale).floor();
        }
        match provider {
            Provider::Gitlab => GITLAB_MAX_COMPLEXITY,
            Provider::Github => f64::INFINITY,
        }
    }

    pub fn learn(&self, host: &str, estimate: f64, refusal: ComplexityRefusal) {
        let next = {
            let mut learned = self.learned.lock().unwrap();
            let before = learned.get(host).map_or(1.0, |known| known.scale);
            let ratio = if estimate > 0.0 && refusal.complexity > 0.0 {
                estimate / refusal.complexity * 0.95
            } else {
                1.0
            };
            let next = HostLimit {
                max: refusal.max,
                scale: 1f64.min(before).min(ratio),
            };
            learned.insert(host.to_owned(), next);
            next
        };
        if let Some(on_learn) = &self.on_learn {
            on_learn(host, next);
        }
    }

    pub fn limit(&self, host: &str) -> Option<HostLimit> {
        self.learned.lock().unwrap().get(host).copied()
    }

    /// Batches of units whose query stays under the host's budget, at most
    /// `most` units each.
    pub fn pack<U: Clone>(
        &self,
        host: &str,
        provider: Provider,
        units: &[U],
        build: &dyn Fn(&[U]) -> String,
        most: usize,
    ) -> Vec<Vec<U>> {
        let limit = self.budget(host, provider);
        let mut batches = Vec::new();
        let mut current: Vec<U> = Vec::new();
        for unit in units {
            let mut candidate = current.clone();
            candidate.push(unit.clone());
            if !current.is_empty()
                && (candidate.len() > most || estimate_complexity(&build(&candidate)) > limit)
            {
                batches.push(std::mem::replace(&mut current, vec![unit.clone()]));
            } else {
                current = candidate;
            }
        }
        if !current.is_empty() {
            batches.push(current);
        }
        batches
    }

    /// Asks each batch; a refusal teaches the host's limit and splits the
    /// batch. A single unit refused is an error.
    pub async fn run<U, F, Fut>(
        &self,
        host: &str,
        provider: Provider,
        units: &[U],
        build: &dyn Fn(&[U]) -> String,
        ask: F,
        most: usize,
    ) -> Result<Vec<Value>, AskError>
    where
        U: Clone,
        F: Fn(String, Vec<U>) -> Fut,
        Fut: Future<Output = Result<Value, AskError>>,
    {
        let mut results = Vec::new();
        let mut queue: std::collections::VecDeque<Vec<U>> =
            self.pack(host, provider, units, build, most).into();
        while let Some(part) = queue.pop_front() {
            let query = build(&part);
            let refusal = match ask(query.clone(), part.clone()).await {
                Ok(answer) => {
                    let refused = if answer
                        .get("data")
                        .is_some_and(|d| !d.is_null() && d != &Value::Bool(false))
                    {
                        None
                    } else {
                        complexity_refusal(&answer)
                    };
                    match refused {
                        None => {
                            results.push(answer);
                            continue;
                        }
                        Some(refusal) => refusal,
                    }
                }
                Err(error) => match refusal_in(&error.0) {
                    Some(refusal) => refusal,
                    None => return Err(error),
                },
            };
            self.learn(host, estimate_complexity(&query), refusal);
            if part.len() < 2 {
                return Err(AskError(format!(
                    "Query has complexity of {}, which exceeds max complexity of {}",
                    refusal.complexity, refusal.max
                )));
            }
            let mut split = self.pack(host, provider, &part, build, most);
            if split.len() < 2 {
                let half = part.len().div_ceil(2);
                split = vec![part[..half].to_vec(), part[half..].to_vec()];
            }
            for each in split.into_iter().rev() {
                queue.push_front(each);
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests;
