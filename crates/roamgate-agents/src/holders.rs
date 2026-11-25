//! `task-output-holders.ts`: which files a process on this machine holds
//! open (a background command's output is written through one). Linux
//! reads `/proc`, macOS asks the kernel (libproc, as lsof does, without
//! running it); Windows does not say.

use std::collections::HashSet;

/// The paths of `paths` some process holds open; None where this machine
/// does not say (Windows, an unreadable process table, or no paths asked
/// about): the caller then goes by the file alone.
pub fn held_open_files(paths: &[String]) -> Option<HashSet<String>> {
    if paths.is_empty() {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        linux(paths)
    }
    #[cfg(target_os = "macos")]
    {
        darwin::held_open_files(paths)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn linux(paths: &[String]) -> Option<HashSet<String>> {
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

/// libproc's process and file descriptor tables (sys/proc_info.h): the
/// processes of this user, their vnode descriptors and their paths.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod darwin {
    use std::collections::{HashMap, HashSet};
    use std::ffi::CStr;
    use std::mem::size_of;

    use libc::{PROC_PIDLISTFDS, PROX_FDTYPE_VNODE, c_int, proc_fdinfo, vnode_info_path};

    /// `PROC_PIDFDVNODEPATHINFO`: a vnode descriptor with its path.
    const PROC_PIDFDVNODEPATHINFO: c_int = 2;

    /// `struct proc_fileinfo`.
    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }

    /// `struct vnode_fdinfowithpath`.
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: vnode_info_path,
    }

    fn pids() -> Option<Vec<c_int>> {
        // SAFETY: a null buffer asks for the count only.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return None;
        }
        let mut pids = vec![0 as c_int; count as usize + 64];
        let bytes = (pids.len() * size_of::<c_int>()) as c_int;
        // SAFETY: the buffer holds `bytes` bytes of pids.
        let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if count <= 0 {
            return None;
        }
        pids.truncate(count as usize);
        Some(pids)
    }

    fn vnode_fds(pid: c_int) -> Vec<c_int> {
        // SAFETY: a null buffer asks for the size only.
        let bytes = unsafe { libc::proc_pidinfo(pid, PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return Vec::new();
        }
        let room = bytes as usize / size_of::<proc_fdinfo>() + 16;
        let mut fds: Vec<proc_fdinfo> = Vec::with_capacity(room);
        let size = (room * size_of::<proc_fdinfo>()) as c_int;
        // SAFETY: the buffer has room for `size` bytes; only what the
        // kernel wrote is kept.
        let bytes =
            unsafe { libc::proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), size) };
        if bytes <= 0 {
            return Vec::new();
        }
        // SAFETY: the kernel filled `bytes` bytes of whole entries.
        unsafe { fds.set_len(bytes as usize / size_of::<proc_fdinfo>()) };
        fds.into_iter()
            .filter(|fd| fd.proc_fdtype == PROX_FDTYPE_VNODE as u32)
            .map(|fd| fd.proc_fd)
            .collect()
    }

    fn fd_path(pid: c_int, fd: c_int) -> Option<String> {
        let mut info = std::mem::MaybeUninit::<VnodeFdInfoWithPath>::zeroed();
        let size = size_of::<VnodeFdInfoWithPath>() as c_int;
        // SAFETY: the buffer is one zeroed struct of `size` bytes.
        let bytes = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDVNODEPATHINFO,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if bytes != size {
            return None;
        }
        // SAFETY: the kernel filled the whole struct; zeroed before, so
        // the path is NUL-terminated within its MAXPATHLEN bytes.
        let info = unsafe { info.assume_init() };
        let path = unsafe { CStr::from_ptr(info.pvip.vip_path.as_ptr().cast()) };
        Some(path.to_string_lossy().into_owned())
    }

    pub fn held_open_files(paths: &[String]) -> Option<HashSet<String>> {
        // The kernel gives real paths (/private/var, not /var): each asked
        // path is matched by its real path too.
        let mut wanted: HashMap<String, &String> = HashMap::new();
        for path in paths {
            wanted.insert(path.clone(), path);
            if let Ok(real) = std::fs::canonicalize(path) {
                wanted.insert(real.to_string_lossy().into_owned(), path);
            }
        }
        let mut held = HashSet::new();
        for pid in pids()? {
            for fd in vnode_fds(pid) {
                if let Some(path) = fd_path(pid, fd)
                    && let Some(asked) = wanted.get(&path)
                {
                    held.insert((*asked).clone());
                }
            }
        }
        Some(held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
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
