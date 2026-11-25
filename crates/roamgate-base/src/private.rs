//! Private files: directories 0700, files 0600, opened without following a
//! symlink and refused when hard-linked, as the TS server's storage does
//! (session-secret.ts, review/storage.ts, activity/store.ts,
//! assistant/task-storage.ts).
//!
//! On Windows there is no O_NOFOLLOW (Node's `constants.O_NOFOLLOW ?? 0`),
//! modes are the read-only bit (Node's chmod) plus, for an owner-only mode
//! (0700, 0600), a protected DACL that only the account can use, inherited
//! by what is created under a directory ([`restrict_to_owner`]); std cannot
//! read a file's link count yet, so the single-link check is Unix only
//! there; the symlink checks of [`crate::paths`] still run.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

/// `mkdir -p` with mode 0700 for what it creates, then 0700 on `path`.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    create_dir_all_mode(path)?;
    set_mode(path, 0o700)
}

/// `mkdir -p` with mode 0700 for the directories it creates (Node's
/// `mkdirSync(path, { recursive: true, mode: 0o700 })`).
pub fn create_dir_all_mode(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// chmod, as Node does it: the mode on Unix, the read-only bit on Windows,
/// where an owner-only mode also leaves the path to this account
/// ([`restrict_to_owner`]; a file system without ACLs keeps what it has).
pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    let permissions = mode_permissions(&std::fs::metadata(path)?, mode);
    std::fs::set_permissions(path, permissions)?;
    if cfg!(windows) && mode & 0o077 == 0 {
        restrict_to_owner_or_warn(path);
    }
    Ok(())
}

/// [`restrict_to_owner`], a failure logged (FAT, some network shares).
pub fn restrict_to_owner_or_warn(path: &Path) {
    if let Err(error) = restrict_to_owner(path) {
        tracing::warn!(path = %path.display(), %error, "could not restrict to its owner");
    }
}

/// Leaves `path` to this account alone, as modes 0700 and 0600 do on Unix:
/// on Windows a protected DACL with one entry, the process's user with full
/// control, inherited by files and directories created under a directory
/// (no other account, group or inherited entry). Nothing off Windows.
pub fn restrict_to_owner(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        owner_acl::restrict(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod owner_acl {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW};
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAceEx, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, GetLengthSid, GetTokenInformation, InitializeAcl,
        OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// The process token's TOKEN_USER, in an 8-aligned buffer (its SID
    /// points inside it).
    fn token_user() -> io::Result<Vec<u64>> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: this process's pseudo handle; the token handle it gives
        // is closed below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut needed = 0u32;
        // SAFETY: a size query, no buffer.
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
        // SAFETY: the buffer holds at least `needed` bytes.
        let filled = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        let error = io::Error::last_os_error();
        // SAFETY: the handle OpenProcessToken gave.
        unsafe { CloseHandle(token) };
        if filled == 0 {
            return Err(error);
        }
        Ok(buffer)
    }

    pub fn restrict(path: &Path) -> io::Result<()> {
        let user = token_user()?;
        // SAFETY: GetTokenInformation wrote a TOKEN_USER at its start.
        let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        // SAFETY: a valid SID of the token.
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        let size =
            size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid_length;
        let mut buffer = vec![0u32; size.div_ceil(4)];
        let acl = buffer.as_mut_ptr().cast::<ACL>();
        let flags = if path.is_dir() {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            0
        };
        // SAFETY: a DWORD-aligned buffer of that many bytes, one entry
        // with the token's SID added to it.
        unsafe {
            if InitializeAcl(acl, (buffer.len() * 4) as u32, ACL_REVISION) == 0
                || AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, sid) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: a NUL-terminated path and the ACL built above.
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }
}

/// fchmod on an open file, as [`set_mode`]. On Windows a read-only bit
/// already as asked is left alone: changing it needs a handle that may
/// write attributes, and files are read through read-only ones.
pub fn set_file_mode(file: &File, mode: u32) -> io::Result<()> {
    let metadata = file.metadata()?;
    let permissions = mode_permissions(&metadata, mode);
    if cfg!(windows) && permissions == metadata.permissions() {
        return Ok(());
    }
    file.set_permissions(permissions)
}

#[cfg(unix)]
fn mode_permissions(_metadata: &std::fs::Metadata, mode: u32) -> std::fs::Permissions {
    use std::os::unix::fs::PermissionsExt;
    std::fs::Permissions::from_mode(mode)
}

#[cfg(not(unix))]
fn mode_permissions(metadata: &std::fs::Metadata, mode: u32) -> std::fs::Permissions {
    let mut permissions = metadata.permissions();
    permissions.set_readonly(mode & 0o200 == 0);
    permissions
}

/// The mode bits of a file (Unix), or what Node reports on Windows: 0o444
/// when read-only, else 0o666.
pub fn mode_of(metadata: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

/// The number of hard links of a file; 1 where it cannot be read.
pub fn link_count(metadata: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink()
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        1
    }
}

/// How [`open_nofollow`] opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    /// O_RDONLY | O_NOFOLLOW | O_NONBLOCK (a FIFO planted there cannot
    /// block the reader).
    Read,
    /// O_RDWR | O_NOFOLLOW.
    ReadWrite,
    /// O_RDWR | O_NOFOLLOW | O_CREAT | O_EXCL, mode 0600.
    CreateNew,
}

/// Opens `path` without following a symlink at its last component.
#[cfg(unix)]
pub fn open_nofollow(path: &Path, how: OpenMode) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags};
    let flags = match how {
        OpenMode::Read => OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        OpenMode::ReadWrite => OFlags::RDWR | OFlags::NOFOLLOW,
        OpenMode::CreateNew => OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CREATE | OFlags::EXCL,
    } | OFlags::CLOEXEC;
    let fd = rustix::fs::open(path, flags, Mode::from_raw_mode(0o600))?;
    Ok(File::from(fd))
}

/// Opens `path` (Windows has no O_NOFOLLOW; the callers check for links
/// before).
#[cfg(not(unix))]
pub fn open_nofollow(path: &Path, how: OpenMode) -> io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    match how {
        OpenMode::Read => options.read(true),
        OpenMode::ReadWrite => options.read(true).write(true),
        OpenMode::CreateNew => options.read(true).write(true).create_new(true),
    };
    options.open(path)
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Reads a private file: opened without following links (and without
/// blocking on a FIFO), refused unless a regular file with one link and at
/// most `max_size` bytes (`{invalid}: {path}` otherwise), then set to 0600.
/// None when it does not exist.
pub fn read_private_file(
    path: &Path,
    max_size: u64,
    invalid_label: &str,
) -> io::Result<Option<Vec<u8>>> {
    let mut file = match open_nofollow(path, OpenMode::Read) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || link_count(&metadata) != 1 || metadata.len() > max_size {
        return Err(invalid(format!("{invalid_label}: {}", path.display())));
    }
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    set_file_mode(&file, 0o600)?;
    Ok(Some(contents))
}

/// A storage file opened read-write (created when `create`), refused with
/// `invalid_message` unless a regular file with one link, and set to 0600
/// (review/storage.ts privateFile).
pub fn private_file(path: &Path, create: bool, invalid_message: &str) -> io::Result<()> {
    let file = open_nofollow(
        path,
        if create {
            OpenMode::CreateNew
        } else {
            OpenMode::ReadWrite
        },
    )?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || link_count(&metadata) != 1 {
        return Err(invalid(invalid_message.to_owned()));
    }
    set_file_mode(&file, 0o600)
}

/// The files beside a SQLite database that exist: each must be a regular
/// file with one link (closing another descriptor of a live database could
/// release its POSIX locks, so they are checked by path), then set to 0600.
pub fn protect_sidecars(paths: &[std::path::PathBuf], invalid_message: &str) -> io::Result<()> {
    for sidecar in paths {
        let metadata = match std::fs::symlink_metadata(sidecar) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.is_file() || link_count(&metadata) != 1 {
            return Err(invalid(invalid_message.to_owned()));
        }
        set_mode(sidecar, 0o600)?;
    }
    Ok(())
}

/// What `icacls` says of a private directory and a file made in it.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    fn acl(path: &Path) -> String {
        let output = std::process::Command::new("icacls")
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn a_private_directory_and_what_is_made_in_it_are_the_account_s_alone() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("private");
        create_private_dir(&dir).unwrap();
        let file = dir.join("secret.json");
        std::fs::write(&file, "{}").unwrap();
        let user = std::env::var("USERNAME").unwrap().to_lowercase();
        for path in [&dir, &file] {
            let text = acl(path).to_lowercase();
            assert!(text.contains(&user), "{text}");
            for other in ["everyone", "builtin\\users", "authenticated users"] {
                assert!(!text.contains(other), "{other} in {text}");
            }
            // One entry: the path's line and nothing more before the summary.
            let entries = text.lines().filter(|line| line.contains(":(")).count();
            assert_eq!(entries, 1, "{text}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_files_refuse_links_and_get_private_modes() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b");
        create_private_dir(&nested).unwrap();
        assert_eq!(
            std::fs::metadata(&nested).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(dir.path().join("a"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let file = nested.join("f");
        assert_eq!(read_private_file(&file, 10, "Invalid").unwrap(), None);
        std::fs::write(&file, "data").unwrap();
        set_mode(&file, 0o644).unwrap();
        assert_eq!(
            read_private_file(&file, 10, "Invalid").unwrap().unwrap(),
            b"data"
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let error = read_private_file(&file, 3, "Invalid thing").unwrap_err();
        assert!(error.to_string().starts_with("Invalid thing: "), "{error}");

        std::fs::hard_link(&file, nested.join("g")).unwrap();
        assert!(read_private_file(&file, 10, "Invalid").is_err());
        assert!(private_file(&file, false, "Invalid storage").is_err());
        std::fs::remove_file(nested.join("g")).unwrap();
        private_file(&file, false, "Invalid storage").unwrap();
        assert!(private_file(&file, true, "Invalid storage").is_err());

        let link = nested.join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_private_file(&link, 10, "Invalid").is_err());
        assert!(private_file(&link, false, "Invalid storage").is_err());

        let fresh = nested.join("fresh");
        private_file(&fresh, true, "Invalid storage").unwrap();
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let wal = nested.join("fresh-wal");
        std::fs::write(&wal, "").unwrap();
        set_mode(&wal, 0o644).unwrap();
        protect_sidecars(&[wal.clone(), nested.join("fresh-shm")], "Invalid storage").unwrap();
        assert_eq!(
            std::fs::metadata(&wal).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(&wal).unwrap();
        std::os::unix::fs::symlink(&file, &wal).unwrap();
        assert!(protect_sidecars(&[wal], "Invalid storage").is_err());
    }
}
