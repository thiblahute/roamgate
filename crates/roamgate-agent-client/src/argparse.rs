//! Python's `argparse`, as far as `roamgate-review` uses it: the same
//! parsing (abbreviated options, `--`, `--opt=value`, mutually exclusive
//! groups, subcommands), the same errors (exit 2) and the same help, so
//! the Rust client reads and answers its command lines as the Python
//! client (contract/assets/python/roamgate-review.py) does. Help is never
//! colored (Python 3.14 colors it in a terminal only).

use std::sync::LazyLock;

use regex::Regex;

use crate::py::repr_str;

/// A parsed value.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    None,
    Bool(bool),
    Int(i64),
    Str(String),
    List(Vec<Val>),
}

impl Val {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(text) => Some(text),
            _ => None,
        }
    }

    /// Python's truth: `value in (None, False)` is what the client skips.
    pub fn is_none_or_false(&self) -> bool {
        matches!(self, Val::None | Val::Bool(false))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nargs {
    /// `None`: one value.
    One,
    /// `"?"`.
    Optional,
    /// `"*"`.
    ZeroOrMore,
    /// `nargs=0` (flags) or `nargs=N`.
    Exact(usize),
    /// A subcommand and all that follows.
    Parser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Store,
    StoreTrue,
    Append,
    Help,
    Subparsers,
}

#[derive(Clone, Copy)]
pub enum Ty {
    Str,
    Int,
    /// A `type=` function that never fails (`real_dir`).
    Map(fn(&str) -> String),
}

#[derive(Clone)]
pub struct Action {
    pub options: Vec<String>,
    pub dest: Option<String>,
    pub kind: Kind,
    pub nargs: Nargs,
    pub ty: Ty,
    pub choices: Option<Vec<String>>,
    pub required: bool,
    pub help: Option<String>,
    pub metavar: Option<Vec<String>>,
    /// None: `argparse.SUPPRESS`.
    pub default: Option<Val>,
}

/// An option (`--name`), storing one value, `None` by default.
pub fn opt(name: &str) -> Action {
    Action {
        options: vec![name.to_owned()],
        dest: Some(name.trim_start_matches('-').replace('-', "_")),
        kind: Kind::Store,
        nargs: Nargs::One,
        ty: Ty::Str,
        choices: None,
        required: false,
        help: None,
        metavar: None,
        default: Some(Val::None),
    }
}

/// A positional argument.
pub fn pos(dest: &str) -> Action {
    Action {
        options: vec![],
        dest: Some(dest.to_owned()),
        kind: Kind::Store,
        nargs: Nargs::One,
        ty: Ty::Str,
        choices: None,
        required: true,
        help: None,
        metavar: None,
        default: Some(Val::None),
    }
}

impl Action {
    pub fn help(mut self, help: &str) -> Self {
        self.help = Some(help.to_owned());
        self
    }
    pub fn int(mut self) -> Self {
        self.ty = Ty::Int;
        self
    }
    pub fn map(mut self, f: fn(&str) -> String) -> Self {
        self.ty = Ty::Map(f);
        self
    }
    /// `action="store_true"`.
    pub fn flag(mut self) -> Self {
        self.kind = Kind::StoreTrue;
        self.nargs = Nargs::Exact(0);
        self.default = Some(Val::Bool(false));
        self
    }
    /// `action="append"`.
    pub fn append(mut self) -> Self {
        self.kind = Kind::Append;
        self
    }
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }
    pub fn choices(mut self, choices: &[&str]) -> Self {
        self.choices = Some(choices.iter().map(|each| (*each).to_owned()).collect());
        self
    }
    pub fn metavar(mut self, names: &[&str]) -> Self {
        self.metavar = Some(names.iter().map(|each| (*each).to_owned()).collect());
        self
    }
    pub fn nargs(mut self, nargs: Nargs) -> Self {
        self.nargs = nargs;
        if !self.options.is_empty() {
            return self;
        }
        // Positionals with ? or * are not required.
        if matches!(nargs, Nargs::Optional | Nargs::ZeroOrMore) {
            self.required = false;
        }
        self
    }
    pub fn default(mut self, value: Val) -> Self {
        self.default = Some(value);
        self
    }
    /// `default=argparse.SUPPRESS`.
    pub fn suppress(mut self) -> Self {
        self.default = None;
        self
    }

    fn name(&self) -> String {
        if !self.options.is_empty() {
            return self.options.join("/");
        }
        if let Some(metavar) = &self.metavar {
            return metavar.join(" ");
        }
        if let Some(dest) = &self.dest {
            return dest.clone();
        }
        format!("{{{}}}", self.choices.clone().unwrap_or_default().join(","))
    }
}

/// A subcommand's parser, with its help line in the parent's list.
pub struct Sub {
    pub name: String,
    pub help: Option<String>,
    pub parser: Parser,
}

pub struct Parser {
    pub prog: String,
    pub description: Option<String>,
    actions: Vec<Action>,
    /// Mutually exclusive groups: required, and their actions.
    groups: Vec<(bool, Vec<usize>)>,
    subs: Vec<Sub>,
}

/// What parsing ended with when it did not give a namespace: printed, and
/// the exit code (help: 0 on stdout; an error: 2 on stderr).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exit {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The parsed arguments, in the order Python's namespace has them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Namespace(pub Vec<(String, Val)>);

impl Namespace {
    pub fn get(&self, key: &str) -> Option<&Val> {
        self.0.iter().find(|(name, _)| name == key).map(|(_, v)| v)
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn set(&mut self, key: &str, value: Val) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }
    pub fn remove(&mut self, key: &str) -> Option<Val> {
        let at = self.0.iter().position(|(name, _)| name == key)?;
        Some(self.0.remove(at).1)
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Val::as_str)
    }
    pub fn int(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Val::Int(value)) => Some(*value),
            _ => None,
        }
    }
    pub fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Val::Bool(true)))
    }
}

/// An `ArgumentError`: its argument's name and message.
struct ArgError {
    argument: Option<String>,
    message: String,
}

impl ArgError {
    fn new(argument: Option<&Action>, message: String) -> Self {
        Self {
            argument: argument.map(Action::name),
            message,
        }
    }
    fn text(&self) -> String {
        match &self.argument {
            Some(name) => format!("argument {name}: {}", self.message),
            None => self.message.clone(),
        }
    }
}

enum Stop {
    Error(ArgError),
    Exit(Exit),
}

impl From<ArgError> for Stop {
    fn from(error: ArgError) -> Self {
        Stop::Error(error)
    }
}

/// Takes a positional's strings (`take_action`).
type Take<'a> = dyn FnMut(&Parser, usize, Vec<String>) -> Result<(), Stop> + 'a;

struct OptTuple {
    action: Option<usize>,
    option: String,
    sep: Option<String>,
    explicit: Option<String>,
}

impl Parser {
    pub fn new(prog: &str, description: Option<&str>) -> Self {
        let mut parser = Self {
            prog: prog.to_owned(),
            description: description.map(str::to_owned),
            actions: vec![],
            groups: vec![],
            subs: vec![],
        };
        parser.actions.push(Action {
            options: vec!["-h".into(), "--help".into()],
            dest: None,
            kind: Kind::Help,
            nargs: Nargs::Exact(0),
            ty: Ty::Str,
            choices: None,
            required: false,
            help: Some("show this help message and exit".into()),
            metavar: None,
            default: None,
        });
        parser
    }

    pub fn add(&mut self, action: Action) -> usize {
        self.actions.push(action);
        self.actions.len() - 1
    }

    /// `add_mutually_exclusive_group(required=...)` with these actions.
    pub fn exclusive(&mut self, required: bool, actions: Vec<Action>) {
        let members = actions.into_iter().map(|action| self.add(action)).collect();
        self.groups.push((required, members));
    }

    /// `add_subparsers(dest=..., required=True)`.
    pub fn subcommands(&mut self, dest: &str, subs: Vec<Sub>) {
        let choices = subs.iter().map(|sub| sub.name.clone()).collect();
        self.subs = subs;
        self.actions.push(Action {
            options: vec![],
            dest: Some(dest.to_owned()),
            kind: Kind::Subparsers,
            nargs: Nargs::Parser,
            ty: Ty::Str,
            choices: Some(choices),
            required: true,
            help: None,
            metavar: None,
            default: Some(Val::None),
        });
    }

    /// `parse_args`: the namespace, or what to print and the exit code.
    pub fn parse_args(&self, args: &[String], width: usize) -> Result<Namespace, Exit> {
        let mut namespace = Namespace::default();
        let mut unrecognized = vec![];
        let extras = self.parse_known(args, &mut namespace, &mut unrecognized, width)?;
        let mut all = extras;
        all.extend(unrecognized);
        if !all.is_empty() {
            return Err(self.error(&format!("unrecognized arguments: {}", all.join(" ")), width));
        }
        Ok(namespace)
    }

    fn parse_known(
        &self,
        args: &[String],
        namespace: &mut Namespace,
        unrecognized: &mut Vec<String>,
        width: usize,
    ) -> Result<Vec<String>, Exit> {
        for action in &self.actions {
            if let (Some(dest), Some(default)) = (&action.dest, &action.default)
                && !namespace.has(dest)
            {
                namespace.set(dest, default.clone());
            }
        }
        match self.parse_inner(args, namespace, unrecognized, width) {
            Ok(extras) => Ok(extras),
            Err(Stop::Exit(exit)) => Err(exit),
            Err(Stop::Error(error)) => Err(self.error(&error.text(), width)),
        }
    }

    fn option_map(&self) -> Vec<(&str, usize)> {
        let mut map = vec![];
        for (index, action) in self.actions.iter().enumerate() {
            for option in &action.options {
                map.push((option.as_str(), index));
            }
        }
        map
    }

    fn find_option(&self, option: &str) -> Option<usize> {
        self.option_map()
            .into_iter()
            .find(|(name, _)| *name == option)
            .map(|(_, index)| index)
    }

    fn parse_optional(&self, arg: &str) -> Option<Vec<OptTuple>> {
        static NEGATIVE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^-\d+$|^-\d*\.\d+$").unwrap());
        if arg.is_empty() || !arg.starts_with('-') {
            return None;
        }
        if let Some(action) = self.find_option(arg) {
            return Some(vec![OptTuple {
                action: Some(action),
                option: arg.to_owned(),
                sep: None,
                explicit: None,
            }]);
        }
        if arg.chars().count() == 1 {
            return None;
        }
        if let Some((option, explicit)) = arg.split_once('=')
            && let Some(action) = self.find_option(option)
        {
            return Some(vec![OptTuple {
                action: Some(action),
                option: option.to_owned(),
                sep: Some("=".into()),
                explicit: Some(explicit.to_owned()),
            }]);
        }
        let tuples = self.option_tuples(arg);
        if !tuples.is_empty() {
            return Some(tuples);
        }
        if NEGATIVE.is_match(arg) {
            return None;
        }
        if arg.contains(' ') {
            return None;
        }
        Some(vec![OptTuple {
            action: None,
            option: arg.to_owned(),
            sep: None,
            explicit: None,
        }])
    }

    fn option_tuples(&self, arg: &str) -> Vec<OptTuple> {
        let mut result = vec![];
        let (prefix, sep, explicit) = match arg.split_once('=') {
            Some((prefix, explicit)) => (prefix, Some("=".to_owned()), Some(explicit.to_owned())),
            None => (arg, None, None),
        };
        if arg.starts_with("--") {
            for (option, action) in self.option_map() {
                if option.starts_with(prefix) {
                    result.push(OptTuple {
                        action: Some(action),
                        option: option.to_owned(),
                        sep: sep.clone(),
                        explicit: explicit.clone(),
                    });
                }
            }
        } else {
            let short: String = arg.chars().take(2).collect();
            let short_explicit: String = arg.chars().skip(2).collect();
            for (option, action) in self.option_map() {
                if option == short {
                    result.push(OptTuple {
                        action: Some(action),
                        option: option.to_owned(),
                        sep: Some(String::new()),
                        explicit: Some(short_explicit.clone()),
                    });
                } else if option.starts_with(prefix) {
                    result.push(OptTuple {
                        action: Some(action),
                        option: option.to_owned(),
                        sep: sep.clone(),
                        explicit: explicit.clone(),
                    });
                }
            }
        }
        result
    }

    fn nargs_pattern(action: &Action) -> String {
        let option = !action.options.is_empty();
        match action.nargs {
            Nargs::One => if option { "([A])" } else { "(-*A-*)" }.into(),
            Nargs::Optional => if option { "(A?)" } else { "(-*A?-*)" }.into(),
            Nargs::ZeroOrMore => if option { "(A*)" } else { "(-*[A-]*)" }.into(),
            Nargs::Parser => if option { "(A[AO]*)" } else { "(-*A[-AO]*)" }.into(),
            Nargs::Exact(count) => {
                if option {
                    format!("([AO]{{{count}}})")
                } else {
                    format!("((?:-*A){{{count}}}-*)")
                }
            }
        }
    }

    fn match_argument(action: &Action, pattern: &str) -> Result<usize, ArgError> {
        let regex = Regex::new(&format!("^{}", Self::nargs_pattern(action))).unwrap();
        match regex.captures(pattern) {
            Some(captures) => Ok(captures.get(1).map_or(0, |m| m.as_str().len())),
            None => {
                let message = match action.nargs {
                    Nargs::One => "expected one argument".to_owned(),
                    Nargs::Optional => "expected at most one argument".to_owned(),
                    Nargs::Exact(1) => "expected 1 argument".to_owned(),
                    Nargs::Exact(count) => format!("expected {count} arguments"),
                    _ => "expected at least one argument".to_owned(),
                };
                Err(ArgError::new(Some(action), message))
            }
        }
    }

    fn match_partial(actions: &[&Action], pattern: &str) -> Vec<usize> {
        for end in (1..=actions.len()).rev() {
            let joined: String = actions[..end]
                .iter()
                .map(|action| Self::nargs_pattern(action))
                .collect();
            let regex = Regex::new(&format!("^{joined}")).unwrap();
            if let Some(captures) = regex.captures(pattern) {
                let mut result: Vec<usize> = (1..captures.len())
                    .map(|group| captures.get(group).map_or(0, |m| m.as_str().len()))
                    .collect();
                let matched = captures.get(0).map_or(0, |m| m.end());
                if matched < pattern.len() && pattern.as_bytes()[matched] == b'O' {
                    while result.last() == Some(&0) {
                        result.pop();
                    }
                }
                return result;
            }
        }
        vec![]
    }

    fn parse_inner(
        &self,
        args: &[String],
        namespace: &mut Namespace,
        unrecognized: &mut Vec<String>,
        width: usize,
    ) -> Result<Vec<String>, Stop> {
        let mut conflicts: Vec<Vec<usize>> = vec![vec![]; self.actions.len()];
        for (_, members) in &self.groups {
            for (i, member) in members.iter().enumerate() {
                for (j, other) in members.iter().enumerate() {
                    if i != j {
                        conflicts[*member].push(*other);
                    }
                }
            }
        }
        let mut option_indices: Vec<(usize, Vec<OptTuple>)> = vec![];
        let mut pattern = String::new();
        let mut after_dashes = false;
        for (index, arg) in args.iter().enumerate() {
            if after_dashes {
                pattern.push('A');
                continue;
            }
            if arg == "--" {
                pattern.push('-');
                after_dashes = true;
                continue;
            }
            match self.parse_optional(arg) {
                None => pattern.push('A'),
                Some(tuples) => {
                    option_indices.push((index, tuples));
                    pattern.push('O');
                }
            }
        }
        let tuples_at = |index: usize| option_indices.iter().find(|(at, _)| *at == index);
        let mut seen: Vec<bool> = vec![false; self.actions.len()];
        let mut seen_non_default: Vec<bool> = vec![false; self.actions.len()];
        let mut extras: Vec<String> = vec![];
        let mut positionals: Vec<usize> = self
            .actions
            .iter()
            .enumerate()
            .filter(|(_, action)| action.options.is_empty())
            .map(|(index, _)| index)
            .collect();

        let take = |this: &Self,
                    index: usize,
                    strings: Vec<String>,
                    namespace: &mut Namespace,
                    unrecognized: &mut Vec<String>,
                    seen: &mut Vec<bool>,
                    seen_non_default: &mut Vec<bool>|
         -> Result<(), Stop> {
            let action = &this.actions[index];
            seen[index] = true;
            let value = this.values(action, &strings)?;
            if !action.options.is_empty() || !strings.is_empty() {
                seen_non_default[index] = true;
                for other in &conflicts[index] {
                    if seen_non_default[*other] {
                        return Err(ArgError::new(
                            Some(action),
                            format!("not allowed with argument {}", this.actions[*other].name()),
                        )
                        .into());
                    }
                }
            }
            this.act(index, value, namespace, unrecognized, width)
        };

        let max_option = option_indices.iter().map(|(at, _)| *at).max();
        let mut start = 0usize;
        if let Some(max_option) = max_option {
            while start <= max_option {
                let mut next = start;
                while next <= max_option && tuples_at(next).is_none() {
                    next += 1;
                }
                if start != next {
                    let end = self.consume_positionals(
                        start,
                        args,
                        &pattern,
                        &mut positionals,
                        &mut |this, index, strings| {
                            take(
                                this,
                                index,
                                strings,
                                namespace,
                                unrecognized,
                                &mut seen,
                                &mut seen_non_default,
                            )
                        },
                    )?;
                    if end > start {
                        start = end;
                        continue;
                    }
                    start = end;
                }
                if tuples_at(start).is_none() {
                    extras.extend(args[start..next].iter().cloned());
                    start = next;
                }
                // consume_optional
                let (_, tuples) = tuples_at(start).unwrap();
                if tuples.len() > 1 {
                    let options: Vec<&str> =
                        tuples.iter().map(|tuple| tuple.option.as_str()).collect();
                    return Err(ArgError::new(
                        None,
                        format!(
                            "ambiguous option: {} could match {}",
                            args[start],
                            options.join(", ")
                        ),
                    )
                    .into());
                }
                let tuple = &tuples[0];
                let mut action = tuple.action;
                let mut option = tuple.option.clone();
                let mut sep = tuple.sep.clone();
                let mut explicit = tuple.explicit.clone();
                let mut taken: Vec<(usize, Vec<String>)> = vec![];
                let stop;
                loop {
                    let Some(index) = action else {
                        extras.push(args[start].clone());
                        stop = start + 1;
                        break;
                    };
                    let current = &self.actions[index];
                    if let Some(arg) = explicit.clone() {
                        let count = Self::match_argument(current, "A").unwrap_or(usize::MAX);
                        let second = option.chars().nth(1).unwrap_or('-');
                        if count == 0 && second != '-' && !arg.is_empty() {
                            if sep.as_deref().is_some_and(|s| !s.is_empty()) || arg.starts_with('-')
                            {
                                return Err(ArgError::new(
                                    Some(current),
                                    format!("ignored explicit argument {}", repr_str(&arg)),
                                )
                                .into());
                            }
                            taken.push((index, vec![]));
                            let first: String = arg.chars().take(1).collect();
                            option = format!("-{first}");
                            match self.find_option(&option) {
                                Some(found) => {
                                    action = Some(found);
                                    let rest: String = arg.chars().skip(1).collect();
                                    if rest.is_empty() {
                                        sep = None;
                                        explicit = None;
                                    } else if let Some(value) = rest.strip_prefix('=') {
                                        sep = Some("=".into());
                                        explicit = Some(value.to_owned());
                                    } else {
                                        sep = Some(String::new());
                                        explicit = Some(rest);
                                    }
                                }
                                None => {
                                    extras.push(format!("-{arg}"));
                                    stop = start + 1;
                                    break;
                                }
                            }
                        } else if count == 1 {
                            taken.push((index, vec![arg]));
                            stop = start + 1;
                            break;
                        } else {
                            return Err(ArgError::new(
                                Some(current),
                                format!("ignored explicit argument {}", repr_str(&arg)),
                            )
                            .into());
                        }
                    } else {
                        let from = start + 1;
                        let count = Self::match_argument(current, &pattern[from..])?;
                        taken.push((index, args[from..from + count].to_vec()));
                        stop = from + count;
                        break;
                    }
                }
                for (index, strings) in taken {
                    take(
                        self,
                        index,
                        strings,
                        namespace,
                        unrecognized,
                        &mut seen,
                        &mut seen_non_default,
                    )?;
                }
                start = stop;
            }
        }
        let stop = self.consume_positionals(
            start,
            args,
            &pattern,
            &mut positionals,
            &mut |this, index, strings| {
                take(
                    this,
                    index,
                    strings,
                    namespace,
                    unrecognized,
                    &mut seen,
                    &mut seen_non_default,
                )
            },
        )?;
        extras.extend(args[stop.min(args.len())..].iter().cloned());

        let required: Vec<String> = self
            .actions
            .iter()
            .enumerate()
            .filter(|(index, action)| !seen[*index] && action.required)
            .map(|(_, action)| action.name())
            .collect();
        if !required.is_empty() {
            return Err(ArgError::new(
                None,
                format!(
                    "the following arguments are required: {}",
                    required.join(", ")
                ),
            )
            .into());
        }
        for (required, members) in &self.groups {
            if *required && !members.iter().any(|member| seen_non_default[*member]) {
                let names: Vec<String> = members
                    .iter()
                    .map(|member| self.actions[*member].name())
                    .collect();
                return Err(ArgError::new(
                    None,
                    format!("one of the arguments {} is required", names.join(" ")),
                )
                .into());
            }
        }
        Ok(extras)
    }

    fn consume_positionals(
        &self,
        mut start: usize,
        args: &[String],
        pattern: &str,
        positionals: &mut Vec<usize>,
        take: &mut Take<'_>,
    ) -> Result<usize, Stop> {
        let actions: Vec<&Action> = positionals.iter().map(|i| &self.actions[*i]).collect();
        let selected = pattern.get(start..).unwrap_or("");
        let counts = Self::match_partial(&actions, selected);
        let done = counts.len();
        for (position, count) in counts.into_iter().enumerate() {
            let index = positionals[position];
            let action = &self.actions[index];
            let mut strings: Vec<String> = args[start..start + count].to_vec();
            if action.nargs == Nargs::Parser {
                if pattern.as_bytes().get(start) == Some(&b'-')
                    && let Some(at) = strings.iter().position(|s| s == "--")
                {
                    strings.remove(at);
                }
            } else if pattern[start..start + count].contains('-')
                && let Some(at) = strings.iter().position(|s| s == "--")
            {
                strings.remove(at);
            }
            start += count;
            take(self, index, strings)?;
        }
        positionals.drain(..done);
        Ok(start)
    }

    fn value(&self, action: &Action, text: &str) -> Result<Val, ArgError> {
        match action.ty {
            Ty::Str => Ok(Val::Str(text.to_owned())),
            Ty::Map(f) => Ok(Val::Str(f(text))),
            Ty::Int => python_int(text).map(Val::Int).ok_or_else(|| {
                ArgError::new(
                    Some(action),
                    format!("invalid int value: {}", repr_str(text)),
                )
            }),
        }
    }

    fn check(&self, action: &Action, value: &Val) -> Result<(), ArgError> {
        let Some(choices) = &action.choices else {
            return Ok(());
        };
        let text = match value {
            Val::Str(text) => text.clone(),
            Val::Int(int) => int.to_string(),
            _ => String::new(),
        };
        if choices.contains(&text) {
            return Ok(());
        }
        Err(ArgError::new(
            Some(action),
            format!(
                "invalid choice: {} (choose from {})",
                repr_str(&text),
                choices.join(", ")
            ),
        ))
    }

    fn values(&self, action: &Action, strings: &[String]) -> Result<Val, ArgError> {
        if strings.is_empty() && action.nargs == Nargs::Optional {
            let value = if action.options.is_empty() {
                action.default.clone().unwrap_or(Val::None)
            } else {
                Val::None
            };
            return match value {
                Val::Str(text) => self.value(action, &text),
                other => Ok(other),
            };
        }
        if strings.is_empty() && action.nargs == Nargs::ZeroOrMore && action.options.is_empty() {
            return Ok(match &action.default {
                Some(Val::None) | None => Val::List(vec![]),
                Some(other) => other.clone(),
            });
        }
        if strings.len() == 1 && matches!(action.nargs, Nargs::One | Nargs::Optional) {
            let value = self.value(action, &strings[0])?;
            self.check(action, &value)?;
            return Ok(value);
        }
        if action.nargs == Nargs::Parser {
            let values: Vec<Val> = strings
                .iter()
                .map(|text| self.value(action, text))
                .collect::<Result<_, _>>()?;
            if let Some(first) = values.first() {
                self.check(action, first)?;
            }
            return Ok(Val::List(values));
        }
        let values: Vec<Val> = strings
            .iter()
            .map(|text| self.value(action, text))
            .collect::<Result<_, _>>()?;
        for value in &values {
            self.check(action, value)?;
        }
        Ok(Val::List(values))
    }

    fn act(
        &self,
        index: usize,
        value: Val,
        namespace: &mut Namespace,
        unrecognized: &mut Vec<String>,
        width: usize,
    ) -> Result<(), Stop> {
        let action = &self.actions[index];
        let dest = action.dest.clone().unwrap_or_default();
        match action.kind {
            Kind::Store => namespace.set(&dest, value),
            Kind::StoreTrue => namespace.set(&dest, Val::Bool(true)),
            Kind::Append => {
                let mut items = match namespace.get(&dest) {
                    Some(Val::List(items)) => items.clone(),
                    _ => vec![],
                };
                items.push(value);
                namespace.set(&dest, Val::List(items));
            }
            Kind::Help => {
                return Err(Stop::Exit(Exit {
                    code: 0,
                    stdout: self.format_help(width),
                    stderr: String::new(),
                }));
            }
            Kind::Subparsers => {
                let Val::List(values) = value else {
                    return Ok(());
                };
                let name = values
                    .first()
                    .and_then(Val::as_str)
                    .unwrap_or_default()
                    .to_owned();
                namespace.set(&dest, Val::Str(name.clone()));
                let rest: Vec<String> = values
                    .iter()
                    .skip(1)
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect();
                let Some(sub) = self.subs.iter().find(|sub| sub.name == name) else {
                    return Ok(());
                };
                let mut subspace = Namespace::default();
                let mut sub_unrecognized = vec![];
                let extras = sub
                    .parser
                    .parse_known(&rest, &mut subspace, &mut sub_unrecognized, width)
                    .map_err(Stop::Exit)?;
                for (key, value) in subspace.0 {
                    namespace.set(&key, value);
                }
                unrecognized.extend(extras);
                unrecognized.extend(sub_unrecognized);
            }
        }
        Ok(())
    }

    /// `parser.error(message)`: usage and the message on stderr, exit 2.
    fn error(&self, message: &str, width: usize) -> Exit {
        Exit {
            code: 2,
            stdout: String::new(),
            stderr: format!(
                "{}{}: error: {message}\n",
                self.format_usage(width),
                self.prog
            ),
        }
    }

    pub fn format_usage(&self, width: usize) -> String {
        let mut formatter = Formatter::new(&self.prog, width);
        formatter.items.push(Item::Usage(self.usage_parts()));
        formatter.format()
    }

    pub fn format_help(&self, width: usize) -> String {
        let mut formatter = Formatter::new(&self.prog, width);
        formatter.items.push(Item::Usage(self.usage_parts()));
        if let Some(description) = &self.description {
            formatter.items.push(Item::Text(description.clone()));
        }
        for (title, positional) in [("positional arguments", true), ("options", false)] {
            let entries: Vec<Entry> = self
                .actions
                .iter()
                .filter(|action| action.options.is_empty() == positional)
                .map(|action| self.entry(action))
                .collect();
            formatter.add_section(title, entries);
        }
        formatter.format()
    }

    fn entry(&self, action: &Action) -> Entry {
        let subs = if action.kind == Kind::Subparsers {
            self.subs
                .iter()
                .filter(|sub| sub.help.is_some())
                .map(|sub| Entry {
                    invocation: sub.name.clone(),
                    help: sub.help.clone(),
                    subs: vec![],
                })
                .collect()
        } else {
            vec![]
        };
        Entry {
            invocation: invocation(action),
            help: action.help.clone(),
            subs,
        }
    }

    /// `_get_actions_usage_parts`: each action's usage, groups kept
    /// together, then where the positionals start.
    fn usage_parts(&self) -> (Vec<String>, usize) {
        let group_of = |index: usize| {
            self.groups
                .iter()
                .position(|(_, members)| members.contains(&index))
        };
        let mut taken = vec![false; self.actions.len()];
        let mut optionals: Vec<(bool, Vec<usize>)> = vec![];
        let mut positionals: Vec<(bool, Vec<usize>)> = vec![];
        for (index, action) in self.actions.iter().enumerate() {
            if action.options.is_empty() {
                taken[index] = true;
                positionals.push((false, vec![index]));
            }
        }
        for (index, action) in self.actions.iter().enumerate() {
            if action.options.is_empty() || taken[index] {
                continue;
            }
            taken[index] = true;
            match group_of(index) {
                Some(group) => {
                    let (required, members) = &self.groups[group];
                    let mut list = vec![index];
                    for member in members {
                        if !taken[*member] && !self.actions[*member].options.is_empty() {
                            taken[*member] = true;
                            list.push(*member);
                        }
                    }
                    optionals.push((*required, list));
                }
                None => optionals.push((false, vec![index])),
            }
        }
        let mut parts: Vec<String> = vec![];
        let mut pos_start = None;
        let count = optionals.len();
        for (i, (required, group)) in optionals.into_iter().chain(positionals).enumerate() {
            let start = parts.len();
            if i == count {
                pos_start = Some(start);
            }
            let in_group = group.len() > 1;
            for index in &group {
                let action = &self.actions[*index];
                let part = if action.options.is_empty() {
                    let mut part = format_args(action, action.dest.as_deref().unwrap_or(""));
                    if in_group && part.starts_with('[') && part.ends_with(']') {
                        part = part[1..part.len() - 1].to_owned();
                    }
                    part
                } else {
                    let option = &action.options[0];
                    let mut part = if action.nargs == Nargs::Exact(0) {
                        option.clone()
                    } else {
                        format!("{option} {}", format_args(action, &default_metavar(action)))
                    };
                    if !(action.required || required || in_group) {
                        part = format!("[{part}]");
                    }
                    part
                };
                parts.push(part);
            }
            if in_group {
                parts[start] = format!("{}{}", if required { "(" } else { "[" }, parts[start]);
                let last = parts.len() - 1;
                for part in parts.iter_mut().take(last).skip(start) {
                    part.push_str(" |");
                }
                parts[last].push(if required { ')' } else { ']' });
            }
        }
        let pos_start = pos_start.unwrap_or(parts.len());
        (parts, pos_start)
    }
}

/// Python's `int(text)`: blanks around, a sign, digits with single
/// underscores between them.
fn python_int(text: &str) -> Option<i64> {
    static INT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[+-]?[0-9](?:_?[0-9])*$").unwrap());
    let trimmed = text.trim();
    if !INT.is_match(trimmed) {
        return None;
    }
    trimmed.replace('_', "").parse().ok()
}

fn default_metavar(action: &Action) -> String {
    action.dest.clone().unwrap_or_default().to_uppercase()
}

fn metavars(action: &Action, default: &str, size: usize) -> Vec<String> {
    if let Some(metavar) = &action.metavar {
        if metavar.len() > 1 {
            return metavar.clone();
        }
        return vec![metavar[0].clone(); size];
    }
    if let Some(choices) = &action.choices {
        return vec![format!("{{{}}}", choices.join(",")); size];
    }
    vec![default.to_owned(); size]
}

fn format_args(action: &Action, default: &str) -> String {
    match action.nargs {
        Nargs::One => metavars(action, default, 1)[0].clone(),
        Nargs::Optional => format!("[{}]", metavars(action, default, 1)[0]),
        Nargs::ZeroOrMore => format!("[{} ...]", metavars(action, default, 1)[0]),
        Nargs::Parser => format!("{} ...", metavars(action, default, 1)[0]),
        Nargs::Exact(count) => metavars(action, default, count).join(" "),
    }
}

fn invocation(action: &Action) -> String {
    if action.options.is_empty() {
        return metavars(action, action.dest.as_deref().unwrap_or(""), 1)[0].clone();
    }
    if action.nargs == Nargs::Exact(0) {
        return action.options.join(", ");
    }
    format!(
        "{} {}",
        action.options.join(", "),
        format_args(action, &default_metavar(action))
    )
}

/// An action in the help: how it is invoked, its help, and its
/// subcommands' lines.
struct Entry {
    invocation: String,
    help: Option<String>,
    subs: Vec<Entry>,
}

enum Item {
    Usage((Vec<String>, usize)),
    Text(String),
    Section(String, Vec<Entry>),
}

/// argparse's `HelpFormatter` (indent 2, help at column 24 at most).
struct Formatter {
    prog: String,
    width: usize,
    max_help_position: usize,
    action_max_length: usize,
    items: Vec<Item>,
}

impl Formatter {
    fn new(prog: &str, width: usize) -> Self {
        Self {
            prog: prog.to_owned(),
            width,
            max_help_position: 24.min(width.saturating_sub(20).max(4)),
            action_max_length: 0,
            items: vec![],
        }
    }

    fn add_section(&mut self, title: &str, entries: Vec<Entry>) {
        // Within the section: indent 2; subcommands' lines 4.
        for entry in &entries {
            let mut length = entry.invocation.chars().count() + 2;
            for sub in &entry.subs {
                length = length.max(sub.invocation.chars().count() + 4);
            }
            self.action_max_length = self.action_max_length.max(length);
        }
        self.items.push(Item::Section(title.to_owned(), entries));
    }

    fn format(&self) -> String {
        let mut parts = String::new();
        for item in &self.items {
            match item {
                Item::Usage(parts_and_start) => parts.push_str(&self.usage(parts_and_start)),
                Item::Text(text) => {
                    let width = self.width.max(11);
                    parts.push_str(&wrap(text, width, "", "").join("\n"));
                    parts.push_str("\n\n");
                }
                Item::Section(title, entries) => {
                    let mut body = String::new();
                    for entry in entries {
                        body.push_str(&self.action(entry, 2));
                    }
                    if !body.is_empty() {
                        parts.push_str(&format!("\n{title}:\n{body}\n"));
                    }
                }
            }
        }
        static LONG_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\n\n+").unwrap());
        if parts.is_empty() {
            return parts;
        }
        let help = LONG_BREAK.replace_all(&parts, "\n\n");
        format!("{}\n", help.trim_matches('\n'))
    }

    fn usage(&self, (parts, pos_start): &(Vec<String>, usize)) -> String {
        let prefix = "usage: ";
        let prog = self.prog.clone();
        let len = |text: &str| text.chars().count();
        let mut usage = std::iter::once(prog.clone())
            .chain(parts.iter().cloned())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let text_width = self.width;
        if len(prefix) + len(&usage) > text_width {
            let opt_parts = &parts[..*pos_start];
            let pos_parts = &parts[*pos_start..];
            let get_lines = |parts: &[String], indent: &str, prefix: Option<&str>| {
                let mut lines: Vec<String> = vec![];
                let mut line: Vec<String> = vec![];
                let indent_length = len(indent);
                let mut line_len = match prefix {
                    Some(prefix) => len(prefix) as isize - 1,
                    None => indent_length as isize - 1,
                };
                for part in parts {
                    let part_len = len(part) as isize;
                    if line_len + 1 + part_len > text_width as isize && !line.is_empty() {
                        lines.push(format!("{indent}{}", line.join(" ")));
                        line.clear();
                        line_len = indent_length as isize - 1;
                    }
                    line.push(part.clone());
                    line_len += part_len + 1;
                }
                if !line.is_empty() {
                    lines.push(format!("{indent}{}", line.join(" ")));
                }
                if prefix.is_some() && !lines.is_empty() {
                    lines[0] = lines[0].chars().skip(indent_length).collect();
                }
                lines
            };
            let lines = if (len(prefix) + len(&prog)) as f64 <= 0.75 * text_width as f64 {
                let indent = " ".repeat(len(prefix) + len(&prog) + 1);
                let with_prog = |rest: &[String]| {
                    let mut all = vec![prog.clone()];
                    all.extend(rest.iter().cloned());
                    all
                };
                if !opt_parts.is_empty() {
                    let mut lines = get_lines(&with_prog(opt_parts), &indent, Some(prefix));
                    lines.extend(get_lines(pos_parts, &indent, None));
                    lines
                } else if !pos_parts.is_empty() {
                    get_lines(&with_prog(pos_parts), &indent, Some(prefix))
                } else {
                    vec![prog.clone()]
                }
            } else {
                let indent = " ".repeat(len(prefix));
                let all: Vec<String> = opt_parts.iter().chain(pos_parts).cloned().collect();
                let mut lines = get_lines(&all, &indent, None);
                if lines.len() > 1 {
                    lines = get_lines(opt_parts, &indent, None);
                    lines.extend(get_lines(pos_parts, &indent, None));
                }
                std::iter::once(prog.clone()).chain(lines).collect()
            };
            usage = lines.join("\n");
        }
        format!("{prefix}{usage}\n\n")
    }

    fn action(&self, entry: &Entry, indent: usize) -> String {
        let help_position = (self.action_max_length + 2).min(self.max_help_position);
        let help_width = self.width.saturating_sub(help_position).max(11);
        let action_width = help_position.saturating_sub(indent + 2);
        let header = &entry.invocation;
        let mut out = String::new();
        let help = entry.help.as_deref().filter(|help| !help.is_empty());
        let indent_first = match help {
            None => {
                out.push_str(&format!("{}{header}\n", " ".repeat(indent)));
                0
            }
            Some(_) if header.chars().count() <= action_width => {
                out.push_str(&format!("{}{header:<action_width$}  ", " ".repeat(indent)));
                0
            }
            Some(_) => {
                out.push_str(&format!("{}{header}\n", " ".repeat(indent)));
                help_position
            }
        };
        if let Some(help) = help.filter(|help| !help.trim().is_empty()) {
            let lines = split_lines(help, help_width);
            if let Some(first) = lines.first() {
                out.push_str(&format!("{}{first}\n", " ".repeat(indent_first)));
            }
            for line in lines.iter().skip(1) {
                out.push_str(&format!("{}{line}\n", " ".repeat(help_position)));
            }
        } else if !out.ends_with('\n') {
            out.push('\n');
        }
        for sub in &entry.subs {
            out.push_str(&self.action(sub, indent + 2));
        }
        out
    }
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `HelpFormatter._split_lines`: blanks collapsed, then wrapped.
fn split_lines(text: &str, width: usize) -> Vec<String> {
    wrap(&collapse(text), width, "", "")
}

/// `textwrap.wrap` with its defaults (long words broken, broken after
/// hyphens, blanks dropped at the ends of lines).
pub fn wrap(text: &str, width: usize, initial: &str, subsequent: &str) -> Vec<String> {
    let text = collapse(text);
    let mut chunks: Vec<String> = word_chunks(&text);
    chunks.reverse();
    let len = |text: &str| text.chars().count();
    let mut lines: Vec<String> = vec![];
    while !chunks.is_empty() {
        let mut line: Vec<String> = vec![];
        let mut line_len = 0usize;
        let indent = if lines.is_empty() {
            initial
        } else {
            subsequent
        };
        let width = width.saturating_sub(len(indent));
        if chunks.last().is_some_and(|c| c.trim().is_empty()) && !lines.is_empty() {
            chunks.pop();
        }
        while let Some(chunk) = chunks.last() {
            let l = len(chunk);
            if line_len + l <= width {
                line_len += l;
                line.push(chunks.pop().unwrap());
            } else {
                break;
            }
        }
        if chunks.last().is_some_and(|chunk| len(chunk) > width) {
            let space_left = if width < 1 { 1 } else { width - line_len };
            if space_left > 0 {
                let chunk: Vec<char> = chunks.last().unwrap().chars().collect();
                let mut end = space_left;
                if chunk.len() > space_left {
                    let head: String = chunk[..space_left].iter().collect();
                    if let Some(hyphen) = head.rfind('-') {
                        let hyphen = head[..hyphen].chars().count();
                        if hyphen > 0 && chunk[..hyphen].iter().any(|c| *c != '-') {
                            end = hyphen + 1;
                        }
                    }
                }
                line.push(chunk[..end.min(chunk.len())].iter().collect());
                *chunks.last_mut().unwrap() = chunk[end.min(chunk.len())..].iter().collect();
                if chunks.last().is_some_and(String::is_empty) {
                    chunks.pop();
                }
            } else if line.is_empty()
                && let Some(chunk) = chunks.pop()
            {
                line.push(chunk);
            }
        }
        if line.last().is_some_and(|c| c.trim().is_empty()) {
            line.pop();
        }
        if !line.is_empty() {
            lines.push(format!("{indent}{}", line.concat()));
        }
    }
    lines
}

/// textwrap's `wordsep_re` chunks: words (split after a hyphen between
/// letters) and the blanks between them.
fn word_chunks(text: &str) -> Vec<String> {
    static WORDSEP: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
        let wp = r#"[\w!"'&.,?]"#;
        let lt = r"[^\d\W]";
        let ws = r"[\t\n\x0b\x0c\r ]";
        let nws = r"[^\t\n\x0b\x0c\r ]";
        fancy_regex::Regex::new(&format!(
            r"({ws}+|(?<={wp})-{{2,}}(?=\w)|{nws}+?(?:-(?:(?<={lt}{{2}}-)|(?<={lt}-{lt}-))(?={lt}-?{lt})|(?={ws}|\z)|(?<={wp})(?=-{{2,}}\w)))"
        ))
        .unwrap()
    });
    let mut chunks = vec![];
    let mut last = 0;
    for found in WORDSEP.find_iter(text).flatten() {
        if found.start() > last {
            chunks.push(text[last..found.start()].to_owned());
        }
        if !found.as_str().is_empty() {
            chunks.push(found.as_str().to_owned());
        }
        last = found.end();
    }
    if last < text.len() {
        chunks.push(text[last..].to_owned());
    }
    chunks
}

/// The width help is written for: `$COLUMNS` (given), else the
/// terminal's, else 80; less 2, as argparse.
pub fn help_width(columns: Option<String>) -> usize {
    let columns = columns
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|columns| *columns > 0)
        .map(|columns| columns as usize)
        .or_else(terminal_columns)
        .unwrap_or(80);
    columns.saturating_sub(2)
}

#[cfg(unix)]
fn terminal_columns() -> Option<usize> {
    let size = rustix::termios::tcgetwinsize(std::io::stdout()).ok()?;
    (size.ws_col > 0).then_some(size.ws_col as usize)
}

#[cfg(not(unix))]
fn terminal_columns() -> Option<usize> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_as_textwrap() {
        assert_eq!(
            wrap(
                "the Reviews board: your requests' lanes and next steps, overrides, order (TOOL, then its parameters as JSON)",
                54,
                "",
                ""
            ),
            vec![
                "the Reviews board: your requests' lanes and next",
                "steps, overrides, order (TOOL, then its parameters as",
                "JSON)"
            ]
        );
        assert_eq!(
            word_chunks("a goof-ball -- x"),
            vec!["a", " ", "goof-", "ball", " ", "--", " ", "x"]
        );
    }

    #[test]
    fn reads_ints_as_python() {
        assert_eq!(python_int(" 1_000 "), Some(1000));
        assert_eq!(python_int("-5"), Some(-5));
        assert_eq!(python_int("1__0"), None);
        assert_eq!(python_int("x"), None);
    }
}
