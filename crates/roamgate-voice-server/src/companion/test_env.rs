//! What a test server gives the voice setup instead of the real world
//! (`voice/voice-test-env.ts`), like the test clock: honoured only by a
//! build that honours the test clock, never by a release binary.
//!
//! - `ROAMGATE_TEST_VOICE_HARDWARE`: a JSON file holding the hardware
//!   GET /api/voice/setup reports, instead of this host's.
//! - `ROAMGATE_TEST_VOICE_MODELS_URL`: a base URL the model catalog's
//!   downloads go to instead: `https://host/path` becomes
//!   `<base>/host/path`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::hardware::VoiceHardware;
use crate::models::ModelPackage;

pub const TEST_VOICE_HARDWARE_ENV: &str = "ROAMGATE_TEST_VOICE_HARDWARE";
pub const TEST_VOICE_MODELS_URL_ENV: &str = "ROAMGATE_TEST_VOICE_MODELS_URL";

/// Whether this build honours them (the test clock's rule: a debug build
/// or the `test-clock` feature, as Bun honours them only from source).
pub const TEST_VOICE_HONOURED: bool = roamgate_base::clock::TEST_CLOCK_HONOURED;

/// Reads the hardware file, on each request.
pub type HardwareOverride = Arc<dyn Fn() -> Result<VoiceHardware, String> + Send + Sync>;

#[derive(Clone, Default)]
pub struct VoiceTestOverrides {
    pub hardware: Option<HardwareOverride>,
    pub packages: Option<Vec<ModelPackage>>,
}

/// A catalog URL sent to `base` instead.
pub fn test_model_url(url: &str, base: &str) -> String {
    let base = base.trim_end_matches('/');
    let rest = match url.find("://") {
        Some(at) if at > 0 && url[..at].bytes().all(|b| b.is_ascii_alphabetic()) => &url[at + 3..],
        _ => url,
    };
    format!("{base}/{rest}")
}

/// The overrides the environment asks for (none when it names neither
/// variable). Fails when a build that does not honour them is given one.
pub fn voice_test_overrides(
    env: &dyn Fn(&str) -> Option<String>,
    honoured: bool,
    packages: &[ModelPackage],
) -> Result<VoiceTestOverrides, String> {
    let hardware_path = env(TEST_VOICE_HARDWARE_ENV).filter(|v| !v.is_empty());
    let models_url = env(TEST_VOICE_MODELS_URL_ENV).filter(|v| !v.is_empty());
    if hardware_path.is_none() && models_url.is_none() {
        return Ok(VoiceTestOverrides::default());
    }
    if !honoured {
        return Err(format!(
            "{TEST_VOICE_HARDWARE_ENV} and {TEST_VOICE_MODELS_URL_ENV} are only honoured when the server runs from source, never by the standalone binary."
        ));
    }
    let mut overrides = VoiceTestOverrides::default();
    if let Some(path) = hardware_path {
        let path = PathBuf::from(path);
        // Read on each request, so a test can change it.
        overrides.hardware = Some(Arc::new(move || {
            let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            serde_json::from_str(&text).map_err(|error| error.to_string())
        }));
    }
    if let Some(base) = models_url {
        overrides.packages = Some(
            packages
                .iter()
                .map(|entry| {
                    let mut entry = entry.clone();
                    for file in &mut entry.files {
                        file.url = test_model_url(&file.url, &base);
                    }
                    entry
                })
                .collect(),
        );
    }
    Ok(overrides)
}

#[cfg(test)]
mod tests;
