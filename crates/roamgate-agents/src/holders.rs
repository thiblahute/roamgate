//! `task-output-holders.ts`: which files a process on this machine holds
//! open (a background command's output is written through one).

use std::collections::HashSet;

/// The paths of `paths` some process holds open; None where `/proc` does
/// not say (other platforms, or no paths asked about).
pub fn held_open_files(paths: &[String]) -> Option<HashSet<String>> {
    if !cfg!(target_os = "linux") || paths.is_empty() {
        return None;
    }
    let pids = std::fs::read_dir("/proc").ok()?;
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut held = HashSet::new();
    for pid in pids.filter_map(Result::ok) {
        let name = pid.file_name();
        if !name.to_string_lossy().bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(pid.path().join("fd")) else {
            continue;
        };
        for fd in fds.filter_map(Result::ok) {
            if let Ok(target) = std::fs::read_link(fd.path()) {
                let target = target.to_string_lossy().into_owned();
                if wanted.contains(target.as_str()) {
                    held.insert(target);
                }
            }
        }
    }
    Some(held)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "linux")]
    fn a_process_writing_a_background_command_s_output_holds_it_until_it_exits() {
        let dir = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(dir.path()).unwrap();
        let output = dir.join("b1.output").to_string_lossy().into_owned();
        let other = dir.join("other.output").to_string_lossy().into_owned();
        let file = std::fs::File::create(&output).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(file)
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let held = held_open_files(&[output.clone(), other.clone()]).unwrap();
        assert!(held.contains(&output));
        assert!(!held.contains(&other));
        child.kill().unwrap();
        child.wait().unwrap();
        let after = held_open_files(std::slice::from_ref(&output)).unwrap();
        assert!(!after.contains(&output));
    }

    #[test]
    fn no_paths_asked_about_means_nothing_to_look_for() {
        assert_eq!(held_open_files(&[]), None);
    }
}
