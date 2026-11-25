//! Directory junctions on Windows: a link to a directory that, unlike a
//! symbolic link, any user may make (no developer mode, no admin).

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

const GENERIC_WRITE: u32 = 0x4000_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

/// The NT path a junction names: `\??\C:\dir`, `\??\UNC\server\share`.
fn nt_path(target: &Path) -> Vec<u16> {
    let text = target.as_os_str().to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let nt = match text.strip_prefix(r"UNC\") {
        Some(rest) => format!(r"\??\UNC\{rest}"),
        None => match text.strip_prefix(r"\\") {
            Some(rest) => format!(r"\??\UNC\{rest}"),
            None => format!(r"\??\{text}"),
        },
    };
    std::ffi::OsStr::new(&nt).encode_wide().collect()
}

/// Makes `link` a junction to the directory `target` (absolute).
pub fn create(target: &Path, link: &Path) -> io::Result<()> {
    std::fs::create_dir(link)?;
    let made = set(target, link);
    if made.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    made
}

fn set(target: &Path, link: &Path) -> io::Result<()> {
    let too_long = || io::Error::new(io::ErrorKind::InvalidInput, "junction target too long");
    let short = |value: usize| u16::try_from(value).map_err(|_| too_long());
    let substitute = nt_path(target);
    let print: Vec<u16> = target.as_os_str().encode_wide().collect();
    // REPARSE_DATA_BUFFER's MountPointReparseBuffer: the offsets and
    // lengths of both names, then the names, each ended by a NUL the
    // lengths leave out.
    let substitute_bytes = substitute.len() * 2;
    let print_bytes = print.len() * 2;
    let data_length = 8 + substitute_bytes + 2 + print_bytes + 2;
    let mut buffer: Vec<u8> = Vec::with_capacity(8 + data_length);
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend_from_slice(&short(data_length)?.to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    for value in [0, substitute_bytes, substitute_bytes + 2, print_bytes] {
        buffer.extend_from_slice(&short(value)?.to_le_bytes());
    }
    for unit in substitute.iter().chain(&[0]).chain(&print).chain(&[0]) {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    let buffer_length = u32::try_from(buffer.len()).map_err(|_| too_long())?;
    let directory = std::fs::OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(link)?;
    let mut returned = 0u32;
    #[allow(unsafe_code)]
    // SAFETY: the handle is the open directory's, the buffer a whole
    // REPARSE_DATA_BUFFER of the length given, nothing is written back.
    let done = unsafe {
        windows_sys::Win32::System::IO::DeviceIoControl(
            directory.as_raw_handle(),
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer_length,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
