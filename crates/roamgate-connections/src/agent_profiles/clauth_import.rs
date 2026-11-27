//! Importing clauth's profiles as account profiles (D7): what an import
//! offers, and the `profiles` section it writes. clauth's sign-ins stay
//! its own (roamgate_accounts::clauth): an imported account reads them
//! until the user takes it over.

use std::path::Path;

use roamgate_accounts::clauth::{
    ClauthAccount, ClauthScan, account_id_for, default_agy, link_sign_in, managed_by_clauth,
};
use roamgate_accounts::{AccountAgent, account_dir};
use serde_json::{Map, Value, json};

use super::shared::{normalize_profiles_settings, profile_account_id, profile_agent, profile_name};
use super::store::{profiles_list, profiles_of};

/// A percent as clauth wrote it: a whole number stays one.
fn percent(value: f64) -> Value {
    if value.fract() == 0.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn has_profile(list: &[Value], name: &str) -> bool {
    list.iter()
        .any(|profile| profile_name(profile).eq_ignore_ascii_case(name))
}

/// What an import offers (`agent_profile.import.scan`): no secret.
pub fn scan_reply(scan: Option<&ClauthScan>, home: &Path, settings: &Value) -> Value {
    let list = profiles_list(&profiles_of(Some(settings)));
    let agy_found = default_agy(home);
    let agy_imported = list
        .iter()
        .any(|profile| profile_agent(profile) == "agy" && profile_account_id(profile).is_none());
    let agy = json!({"found": agy_found, "imported": agy_imported});
    let Some(scan) = scan else {
        return json!({"found": false, "accounts": [], "agy_default": agy});
    };
    let accounts: Vec<Value> = scan
        .accounts
        .iter()
        .map(|account| {
            json!({
                "name": account.name,
                "agent": account.agent.id(),
                "signed_in": account.signed_in,
                "importable": !account.api_key,
                "imported": has_profile(&list, &account.name),
                "in_chain": scan.chain.contains(&account.name),
            })
        })
        .collect();
    json!({
        "found": true,
        "daemon_running": scan.daemon_running,
        "accounts": accounts,
        "chain": scan.chain,
        "active": scan.active,
        "agy_default": agy,
    })
}

/// What an import did.
#[derive(Debug, Default, PartialEq)]
pub struct Imported {
    /// The `profiles` section to write.
    pub profiles: Value,
    pub imported: Vec<String>,
    /// Names left out, and why.
    pub skipped: Vec<(String, String)>,
}

/// Imports the chosen clauth profiles (`names`), and the user's own agy
/// as a plain agy profile when `agy_default`: each a new account profile
/// of the same name whose sign-in is clauth's, its chain, lines,
/// preferred, last resort, walk order and active profile carried over
/// (merged into an existing chain). Profiles of that name already there
/// are left as they are.
pub fn apply(
    scan: Option<&ClauthScan>,
    names: &[String],
    agy_default: bool,
    current: &Value,
    data_root: &Path,
) -> Imported {
    let mut profiles = profiles_of(Some(current));
    let mut list = profiles_list(&profiles);
    let mut done = Imported::default();
    let chosen: Vec<&ClauthAccount> = scan
        .map(|scan| {
            scan.accounts
                .iter()
                .filter(|account| names.contains(&account.name))
                .collect()
        })
        .unwrap_or_default();
    for name in names {
        if !chosen.iter().any(|account| &account.name == name) {
            done.skipped
                .push((name.clone(), "not a clauth profile".into()));
        }
    }
    let mut imported: Vec<&ClauthAccount> = Vec::new();
    for account in chosen {
        if account.api_key {
            done.skipped.push((
                account.name.clone(),
                "an API key profile, not an account".into(),
            ));
            continue;
        }
        if has_profile(&list, &account.name) {
            done.skipped.push((
                account.name.clone(),
                "a profile of that name is there".into(),
            ));
            continue;
        }
        let taken: Vec<String> = list
            .iter()
            .filter(|profile| profile_agent(profile) == account.agent.id())
            .filter_map(|profile| profile_account_id(profile).map(str::to_owned))
            .collect();
        let id = account_id_for(&account.name, &taken);
        // An account dir of that id left by an earlier import of it: its
        // clauth link is reused.
        let dir = account_dir(data_root, account.agent, &id);
        let linked = if managed_by_clauth(&dir).as_deref() == Some(account.name.as_str()) {
            Ok(dir)
        } else {
            link_sign_in(data_root, account, &id)
        };
        if let Err(error) = linked {
            done.skipped.push((
                account.name.clone(),
                format!("its sign-in cannot be linked: {error}"),
            ));
            continue;
        }
        list.push(
            json!({"name": account.name, "agent": account.agent.id(), "account": {"id": id}}),
        );
        done.imported.push(account.name.clone());
        imported.push(account);
    }
    if agy_default
        && !list
            .iter()
            .any(|profile| profile_agent(profile) == "agy" && profile_account_id(profile).is_none())
    {
        let name = if has_profile(&list, "Agy") {
            "Agy (own)"
        } else {
            "Agy"
        };
        list.push(json!({"name": name, "agent": "agy"}));
        done.imported.push(name.to_owned());
    }
    profiles["list"] = Value::Array(list);
    if let Some(scan) = scan
        && !imported.is_empty()
    {
        let mut chain = profiles
            .get("chain")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut accounts: Vec<Value> = chain
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // clauth's chain order first, then the other imports (Codex last).
        let mut order: Vec<&str> = scan
            .chain
            .iter()
            .filter(|name| imported.iter().any(|account| &account.name == *name))
            .map(String::as_str)
            .collect();
        for account in &imported {
            if !order.contains(&account.name.as_str()) && account.agent != AccountAgent::Codex {
                order.push(&account.name);
            }
        }
        for account in &imported {
            if !order.contains(&account.name.as_str()) {
                order.push(&account.name);
            }
        }
        for name in order {
            if !accounts.iter().any(|each| each.as_str() == Some(name)) {
                accounts.push(json!(name));
            }
        }
        chain.insert("accounts".into(), Value::Array(accounts));
        // clauth switches along its chain on its own.
        if !scan.chain.is_empty() {
            chain.entry("auto_switch").or_insert(json!(true));
        }
        let mut lines = chain
            .get("lines")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for account in &imported {
            let mut own = Map::new();
            if let Some(line) = account.fallback_threshold {
                own.insert("five_hour".into(), percent(line));
            }
            if let Some(line) = account.weekly_threshold {
                own.insert("weekly".into(), percent(line));
            }
            if !own.is_empty() {
                lines
                    .entry(account.name.clone())
                    .or_insert(Value::Object(own));
            }
        }
        if !lines.is_empty() {
            chain.insert("lines".into(), Value::Object(lines));
        }
        if let Some(preferred) = imported.iter().find(|account| account.preferred) {
            chain.entry("preferred").or_insert(json!(preferred.name));
            if !preferred.preferred_days.is_empty() {
                chain
                    .entry("preferred_days")
                    .or_insert(json!(preferred.preferred_days));
            }
        }
        if let Some(last) = imported.iter().find(|account| account.last_resort) {
            chain.entry("last_resort").or_insert(json!(last.name));
        }
        if let Some(walk) = scan.walk {
            chain.entry("walk").or_insert(json!(walk));
        }
        profiles["chain"] = Value::Object(chain);
        if let Some(active) = &scan.active
            && done.imported.contains(active)
        {
            profiles["default"] = json!(active);
        }
    }
    done.profiles = normalize_profiles_settings(Some(&profiles));
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_accounts::clauth::scan;

    fn fake_clauth(home: &Path) {
        let dir = home.join(".clauth");
        let write = |path: &str, text: &str| {
            let path = dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            "profiles.toml",
            "active_profile = \"work\"\nprofiles = [\"work\", \"perso\", \"glm\"]\nfallback_chain = [\"perso\", \"work\"]\nwalk_order = \"soonest-weekly-reset\"\n",
        );
        write(
            "codex-profiles.toml",
            "profiles = [\"codex\"]\nfallback_chain = []\n",
        );
        write(
            "profiles/work/config.toml",
            "fallback_threshold = 90\npreferred = true\npreferred_days = [\"sun\"]\n",
        );
        write(
            "profiles/work/credentials.json",
            r#"{"claudeAiOauth":{"refreshToken":"r"}}"#,
        );
        write("profiles/perso/config.toml", "weekly_threshold = 97\n");
        write("profiles/glm/config.toml", "base_url = \"https://gw\"\n");
        write("profiles/codex/config.toml", "harness = \"codex\"\n");
        write(
            "profiles/codex/auth.json",
            r#"{"tokens":{"refresh_token":"r"}}"#,
        );
        std::fs::create_dir_all(home.join(".gemini/antigravity-cli")).unwrap();
    }

    #[test]
    fn a_scan_says_what_is_there_without_secrets() {
        let temp = tempfile::tempdir().unwrap();
        fake_clauth(temp.path());
        let settings = json!({"profiles": normalize_profiles_settings(Some(&json!({
            "list": [{"name": "Perso", "agent": "claude", "env": {"A": "1"}}],
        })))});
        let reply = scan_reply(scan(temp.path()).as_ref(), temp.path(), &settings);
        assert_eq!(reply["found"], true);
        assert_eq!(reply["active"], "work");
        assert_eq!(
            reply["agy_default"],
            json!({"found": true, "imported": false})
        );
        let accounts = reply["accounts"].as_array().unwrap();
        assert_eq!(
            accounts[0],
            json!({"name": "work", "agent": "claude", "signed_in": true, "importable": true,
                   "imported": false, "in_chain": true})
        );
        assert_eq!(accounts[1]["imported"], true);
        assert_eq!(accounts[2]["importable"], false);
        assert_eq!(accounts[3]["agent"], "codex");
        assert!(!reply.to_string().contains("\"r\""));
        let nothing = scan_reply(None, &temp.path().join("x"), &settings);
        assert_eq!(nothing["found"], false);
    }

    #[test]
    fn an_import_writes_account_profiles_their_chain_and_the_default() {
        let temp = tempfile::tempdir().unwrap();
        fake_clauth(temp.path());
        let found = scan(temp.path());
        let data = temp.path().join("data");
        let names: Vec<String> = ["work", "perso", "glm", "codex", "nope"]
            .iter()
            .map(|n| (*n).to_owned())
            .collect();
        let done = apply(found.as_ref(), &names, true, &json!({}), &data);
        assert_eq!(done.imported, ["work", "perso", "codex", "Agy"]);
        let skipped: Vec<_> = done.skipped.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(skipped, ["nope", "glm"]);
        let profiles = &done.profiles;
        assert_eq!(profiles["default"], "work");
        assert_eq!(
            profiles["list"][0],
            json!({"name": "work", "agent": "claude", "account": {"id": "work"}})
        );
        assert_eq!(profiles["list"][3], json!({"name": "Agy", "agent": "agy"}));
        let chain = &profiles["chain"];
        assert_eq!(chain["accounts"], json!(["perso", "work", "codex"]));
        assert_eq!(chain["auto_switch"], true);
        assert_eq!(
            chain["lines"],
            json!({"work": {"five_hour": 90}, "perso": {"weekly": 97}})
        );
        assert_eq!(chain["preferred"], "work");
        assert_eq!(chain["preferred_days"], json!([0]));
        assert_eq!(chain["walk"], "soonest_reset");
        let work = account_dir(&data, AccountAgent::Claude, "work");
        assert_eq!(managed_by_clauth(&work).as_deref(), Some("work"));
        let codex = account_dir(&data, AccountAgent::Codex, "codex");
        assert!(std::fs::symlink_metadata(codex.join("auth.json")).is_ok());
        // Imported again: nothing new.
        let current = json!({"profiles": profiles});
        let again = apply(found.as_ref(), &names[..1], false, &current, &data);
        assert!(again.imported.is_empty());
        assert_eq!(again.profiles["list"].as_array().unwrap().len(), 4);
    }
}
