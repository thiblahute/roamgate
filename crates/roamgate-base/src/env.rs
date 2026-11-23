//! The environment (contract/env.md): `ROAMGATE_<X>` takes precedence over
//! its legacy name `HERDR_GUI_<X>`, an explicitly empty value included
//! (config/environment.ts). Readers take an [`Env`], so tests give a map
//! instead of touching the process environment.

use std::collections::{BTreeMap, HashMap};

/// Where variables are read from.
pub trait Env: Send + Sync {
    /// The variable's value; None when unset (an empty value is Some("")).
    fn var(&self, name: &str) -> Option<String>;
}

/// The process environment.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    }
}

impl Env for HashMap<String, String> {
    fn var(&self, name: &str) -> Option<String> {
        self.get(name).cloned()
    }
}

impl Env for BTreeMap<String, String> {
    fn var(&self, name: &str) -> Option<String> {
        self.get(name).cloned()
    }
}

impl Env for [(&str, &str)] {
    fn var(&self, name: &str) -> Option<String> {
        self.iter()
            .rev()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| (*value).to_owned())
    }
}

impl<const N: usize> Env for [(&str, &str); N] {
    fn var(&self, name: &str) -> Option<String> {
        self.as_slice().var(name)
    }
}

/// `ROAMGATE_<suffix>`, else `HERDR_GUI_<suffix>`: a ROAMGATE_ value wins
/// even when empty.
pub fn roamgate_env(env: &dyn Env, suffix: &str) -> Option<String> {
    env.var(&format!("ROAMGATE_{suffix}"))
        .or_else(|| env.var(&format!("HERDR_GUI_{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roamgate_names_win_even_when_empty() {
        let both = [
            ("ROAMGATE_SETTINGS_PATH", "/new"),
            ("HERDR_GUI_SETTINGS_PATH", "/old"),
        ];
        assert_eq!(
            roamgate_env(&both, "SETTINGS_PATH").as_deref(),
            Some("/new")
        );
        let empty = [
            ("ROAMGATE_SETTINGS_PATH", ""),
            ("HERDR_GUI_SETTINGS_PATH", "/old"),
        ];
        assert_eq!(roamgate_env(&empty, "SETTINGS_PATH").as_deref(), Some(""));
        let legacy = [("HERDR_GUI_SETTINGS_PATH", "/old")];
        assert_eq!(
            roamgate_env(&legacy, "SETTINGS_PATH").as_deref(),
            Some("/old")
        );
        let none: [(&str, &str); 0] = [];
        assert_eq!(roamgate_env(&none, "SETTINGS_PATH"), None);
    }
}
