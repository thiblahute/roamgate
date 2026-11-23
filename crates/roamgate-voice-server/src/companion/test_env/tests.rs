use std::collections::HashMap;

use crate::models::{ModelFile, packages};

use super::*;

fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |name| vars.get(name).cloned()
}

#[test]
fn nothing_without_the_variables() {
    let overrides = voice_test_overrides(&env(&[]), false, packages()).unwrap();
    assert!(overrides.hardware.is_none() && overrides.packages.is_none());
}

#[test]
fn the_standalone_binary_refuses_them() {
    let error = voice_test_overrides(
        &env(&[("ROAMGATE_TEST_VOICE_MODELS_URL", "http://x")]),
        false,
        packages(),
    )
    .err()
    .unwrap();
    assert!(error.contains("only honoured when the server runs from source"));
}

#[test]
fn model_downloads_go_to_the_mirror_the_catalog_otherwise_unchanged() {
    assert_eq!(
        test_model_url(
            "https://huggingface.co/a/b/resolve/c/model.onnx",
            "http://127.0.0.1:9/m/"
        ),
        "http://127.0.0.1:9/m/huggingface.co/a/b/resolve/c/model.onnx"
    );
    let catalog = vec![ModelPackage {
        id: "p".into(),
        name: "P".into(),
        dir: "p".into(),
        files: vec![ModelFile {
            path: "f.bin".into(),
            url: "https://github.com/o/r/releases/download/v1/f.bin".into(),
            size: 3.0,
            sha256: "0".repeat(64),
        }],
    }];
    let overrides = voice_test_overrides(
        &env(&[("ROAMGATE_TEST_VOICE_MODELS_URL", "http://127.0.0.1:9")]),
        true,
        &catalog,
    )
    .unwrap();
    assert!(overrides.hardware.is_none());
    let mut expected = catalog.clone();
    expected[0].files[0].url =
        "http://127.0.0.1:9/github.com/o/r/releases/download/v1/f.bin".into();
    assert_eq!(overrides.packages, Some(expected));
}

#[test]
fn the_hardware_comes_from_the_file_read_on_each_request() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("hardware.json");
    let hardware = serde_json::json!({
        "platform": "linux",
        "arch": "x64",
        "cpu": {"model": "Parity CPU", "cores": 8},
        "ramBytes": 16.0 * 2f64.powi(30),
        "gpus": [],
        "acceleration": "cpu",
        "gpuBytes": 0,
    });
    std::fs::write(&path, hardware.to_string()).unwrap();
    let overrides = voice_test_overrides(
        &env(&[("ROAMGATE_TEST_VOICE_HARDWARE", &path.to_string_lossy())]),
        true,
        packages(),
    )
    .unwrap();
    let read = (overrides.hardware.as_ref().unwrap())().unwrap();
    assert_eq!(
        read,
        serde_json::from_value::<VoiceHardware>(hardware.clone()).unwrap()
    );
    assert_eq!(read.cpu.model, "Parity CPU");
    let mut changed = hardware;
    changed["ramBytes"] = serde_json::json!(1);
    std::fs::write(&path, changed.to_string()).unwrap();
    assert_eq!(
        (overrides.hardware.as_ref().unwrap())().unwrap().ram_bytes,
        1.0
    );
}
