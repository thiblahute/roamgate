//! What an executable is built for, read from its headers: the release
//! checks of binaries this machine cannot run (release.yml's `file` checks).

use anyhow::{Result, bail};

#[derive(Debug, PartialEq, Eq)]
pub struct Kind {
    /// linux, darwin or win32.
    pub os: &'static str,
    /// x64 or arm64.
    pub arch: &'static str,
    /// An ELF without an interpreter: runs without a libc on the host.
    pub static_elf: bool,
}

fn u16_le(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u64_le(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

fn elf(bytes: &[u8]) -> Option<Kind> {
    // ELFCLASS64, little endian.
    if bytes.get(4) != Some(&2) || bytes.get(5) != Some(&1) {
        return None;
    }
    let arch = match u16_le(bytes, 18)? {
        0x3e => "x64",
        0xb7 => "arm64",
        _ => return None,
    };
    let phoff = usize::try_from(u64_le(bytes, 32)?).ok()?;
    let phentsize = usize::from(u16_le(bytes, 54)?);
    let phnum = usize::from(u16_le(bytes, 56)?);
    let mut interpreter = false;
    for index in 0..phnum {
        // PT_INTERP
        if u32_le(bytes, phoff + index * phentsize)? == 3 {
            interpreter = true;
        }
    }
    Some(Kind {
        os: "linux",
        arch,
        static_elf: !interpreter,
    })
}

fn mach_o(bytes: &[u8]) -> Option<Kind> {
    let arch = match u32_le(bytes, 4)? {
        0x0100_0007 => "x64",
        0x0100_000c => "arm64",
        _ => return None,
    };
    Some(Kind {
        os: "darwin",
        arch,
        static_elf: false,
    })
}

fn pe(bytes: &[u8]) -> Option<Kind> {
    let header = usize::try_from(u32_le(bytes, 0x3c)?).ok()?;
    if bytes.get(header..header + 4)? != b"PE\0\0" {
        return None;
    }
    let arch = match u16_le(bytes, header + 4)? {
        0x8664 => "x64",
        0xaa64 => "arm64",
        _ => return None,
    };
    // PE32+ optional header.
    if u16_le(bytes, header + 24)? != 0x20b {
        return None;
    }
    Some(Kind {
        os: "win32",
        arch,
        static_elf: false,
    })
}

pub fn kind(bytes: &[u8]) -> Result<Kind> {
    let found = if bytes.starts_with(b"\x7fELF") {
        elf(bytes)
    } else if bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe]) {
        mach_o(bytes)
    } else if bytes.starts_with(b"MZ") {
        pe(bytes)
    } else {
        None
    };
    match found {
        Some(kind) => Ok(kind),
        None => bail!("not a 64-bit ELF, Mach-O or PE32+ executable for x64 or arm64"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_test_binary() {
        let me = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let kind = kind(&me).unwrap();
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        assert_eq!(kind.os, os);
        assert_eq!(
            kind.arch,
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            }
        );
    }

    #[test]
    fn rejects_other_files() {
        assert!(kind(b"#!/bin/sh\n").is_err());
        assert!(kind(b"\x7fELF").is_err());
        assert!(kind(b"MZ").is_err());
    }
}
