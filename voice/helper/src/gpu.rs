//! Whisper's GPU backend, loaded at run time. whisper.cpp is linked in for
//! the CPU only; its CUDA backend is a ggml module of its own
//! (`lib/libggml-cuda.so`, `lib/ggml-cuda.dll` on Windows, beside the
//! binary: the CUDA pack), built by linux/build.sh with ggml's
//! GGML_BACKEND_DL. When the module and the CUDA libraries it needs are
//! there, and the driver is, ggml registers its GPU and Whisper runs on
//! it; otherwise the module does not load and Whisper stays on the CPU.
//! The module takes ggml's base functions from this binary, which exports
//! them (.cargo/config.toml), so there is one ggml in the process.
//!
//! macOS has no module: Whisper's Metal backend is linked in.

use std::path::{Path, PathBuf};

/// The CUDA backend module's file name.
#[cfg(windows)]
const MODULE: &str = "ggml-cuda.dll";
#[cfg(not(windows))]
const MODULE: &str = "libggml-cuda.so";

/// Where the module is looked for: `lib/` beside the binary.
fn module_path(binary: &Path) -> Option<PathBuf> {
    Some(binary.parent()?.join("lib").join(MODULE))
}

/// Loads Whisper's CUDA backend when the CUDA pack is installed beside the
/// binary, before any Whisper model loads. Says on stderr which it is.
pub fn load_whisper_backend() {
    if cfg!(target_os = "macos") {
        return;
    }
    let Some(path) = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(module_path)
    else {
        return;
    };
    if !path.exists() {
        eprintln!(
            "Whisper runs on the CPU: no CUDA pack ({} is not there)",
            path.display()
        );
        return;
    }
    let Some(name) = path
        .to_str()
        .and_then(|path| std::ffi::CString::new(path).ok())
    else {
        return;
    };
    // SAFETY: a NUL-terminated path; ggml dlopens the module and registers
    // its backend, or logs why not and returns null.
    let backend = unsafe { whisper_rs_sys::ggml_backend_load(name.as_ptr()) };
    if backend.is_null() {
        eprintln!(
            "Whisper runs on the CPU: {} did not load (no NVIDIA driver, or a CUDA library missing)",
            path.display()
        );
        return;
    }
    // SAFETY: the backend ggml just registered.
    match unsafe { whisper_rs_sys::ggml_backend_reg_dev_count(backend) } {
        0 => eprintln!("Whisper runs on the CPU: CUDA found no GPU"),
        gpus => eprintln!("Whisper runs on the GPU: CUDA found {gpus} GPU(s)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_is_in_lib_beside_the_binary() {
        let path = module_path(Path::new("/opt/voice/roamgate-voice")).unwrap();
        assert_eq!(path, Path::new("/opt/voice/lib").join(MODULE));
    }
}
