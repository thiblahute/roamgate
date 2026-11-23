use std::collections::BTreeMap;

use serde_json::json;

use super::*;

const NVIDIA_SMI: &str = "NVIDIA GeForce RTX 3060 Ti, 8192, 615.78.08, 8.6\n";
const NVIDIA_SMI_TWO: &str = "NVIDIA GeForce RTX 4090, 24564, 550.54.14, 8.9\nNVIDIA GeForce GTX 1050, 2048, 550.54.14, 6.1\n";
const NVIDIA_SMI_OLD: &str = "Tesla K80, 11441, 470.82.01\n";

fn rocm_smi() -> String {
    json!({
        "card0": {
            "Card series": "Navi 14 [Radeon RX 5500/5500M / Pro 5500M]",
            "Card model": "0x7340",
            "Card vendor": "Advanced Micro Devices, Inc. [AMD/ATI]",
            "Card SKU": "D3220400",
            "VRAM Total Memory (B)": "8573157376",
            "VRAM Total Used Memory (B)": "1203888128",
        },
        "system": {"Driver version": "6.12.0"},
    })
    .to_string()
}

fn mac_arm() -> String {
    json!({
        "SPDisplaysDataType": [{
            "_name": "Apple M2 Pro",
            "sppci_model": "Apple M2 Pro",
            "sppci_cores": "19",
            "spdisplays_vendor": "sppci_vendor_Apple",
            "spdisplays_mtlgpufamilysupport": "spdisplays_metal3",
        }],
        "SPHardwareDataType": [{"chip_type": "Apple M2 Pro", "physical_memory": "32 GB", "number_processors": "proc 12:8:4"}],
    })
    .to_string()
}

fn mac_intel() -> String {
    json!({
        "SPDisplaysDataType": [
            {"_name": "Intel UHD Graphics 630", "sppci_model": "Intel UHD Graphics 630", "spdisplays_vendor": "sppci_vendor_intel", "spdisplays_vram_shared": "1536 MB"},
            {"_name": "AMD Radeon Pro 5500M", "sppci_model": "AMD Radeon Pro 5500M", "spdisplays_vendor": "sppci_vendor_amd", "spdisplays_vram": "4 GB"},
        ],
        "SPHardwareDataType": [{"physical_memory": "16 GB"}],
    })
    .to_string()
}

fn windows() -> String {
    json!([
        {"Name": "NVIDIA GeForce RTX 3060", "AdapterRAM": 4293918720u64, "DriverVersion": "32.0.15.6094"},
        {"Name": "Intel(R) UHD Graphics 770", "AdapterRAM": 1073741824u64, "DriverVersion": "31.0.101.4502"},
    ])
    .to_string()
}

fn probe(
    platform: &str,
    arch: &str,
    outputs: &[(&str, String)],
    files: &[(&str, &str)],
) -> HardwareProbe {
    let outputs: Vec<(String, String)> = outputs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    let files: BTreeMap<String, String> = files
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let listed = files.clone();
    let read = files.clone();
    HardwareProbe {
        platform: platform.into(),
        arch: arch.into(),
        capture: Arc::new(move |argv| {
            let line = argv.join(" ");
            outputs
                .iter()
                .find(|(prefix, _)| line.starts_with(prefix.as_str()))
                .map(|(_, output)| output.clone())
        }),
        read_file: Arc::new(move |path| read.get(path).cloned()),
        list_dir: Arc::new(move |path| {
            let mut seen: Vec<String> = Vec::new();
            for file in listed.keys() {
                if let Some(rest) = file.strip_prefix(&format!("{path}/")) {
                    let first = rest.split('/').next().unwrap_or("").to_owned();
                    if !first.is_empty() && !seen.contains(&first) {
                        seen.push(first);
                    }
                }
            }
            seen
        }),
        cpu: Arc::new(|| Cpu {
            model: "AMD Ryzen 9 3950X 16-Core Processor".into(),
            cores: 32.0,
        }),
        ram_bytes: Arc::new(|| 64.0 * GIB),
    }
}

const DRM_DESKTOP: &[(&str, &str)] = &[
    ("/sys/class/drm/card1/device/vendor", "0x1002\n"),
    ("/sys/class/drm/card1/device/device", "0x7340\n"),
    (
        "/sys/class/drm/card1/device/mem_info_vram_total",
        "8573157376\n",
    ),
    ("/sys/class/drm/card1-DP-1/status", "connected\n"),
    ("/sys/class/drm/card2/device/vendor", "0x10de\n"),
    ("/sys/class/drm/card2/device/device", "0x2489\n"),
    (
        "/etc/os-release",
        "NAME=\"Fedora Linux\"\nPRETTY_NAME=\"Fedora Linux 43 (Workstation Edition)\"\n",
    ),
];

fn gpu(vendor: &str, name: &str, vram: Option<f64>) -> GpuInfo {
    GpuInfo {
        vram_bytes: vram,
        ..GpuInfo::new(vendor, name)
    }
}

#[test]
fn nvidia_smi_gives_each_gpu_s_memory_driver_and_compute_capability() {
    assert_eq!(
        parse_nvidia_smi(NVIDIA_SMI),
        vec![GpuInfo {
            driver: Some("615.78.08".into()),
            compute_capability: Some("8.6".into()),
            ..gpu("nvidia", "NVIDIA GeForce RTX 3060 Ti", Some(8192.0 * MIB))
        }]
    );
    assert_eq!(
        parse_nvidia_smi(NVIDIA_SMI_TWO)
            .iter()
            .map(|gpu| gpu.vram_bytes)
            .collect::<Vec<_>>(),
        vec![Some(24564.0 * MIB), Some(2048.0 * MIB)]
    );
    assert_eq!(
        parse_nvidia_smi(NVIDIA_SMI_OLD),
        vec![GpuInfo {
            driver: Some("470.82.01".into()),
            ..gpu("nvidia", "Tesla K80", Some(11441.0 * MIB))
        }]
    );
    assert!(parse_nvidia_smi("").is_empty());
}

#[test]
fn rocm_smi_s_cards_with_their_vram() {
    assert_eq!(
        parse_rocm_smi(&rocm_smi()),
        vec![gpu(
            "amd",
            "Navi 14 [Radeon RX 5500/5500M / Pro 5500M]",
            Some(8573157376.0)
        )]
    );
    assert!(parse_rocm_smi("not json").is_empty());
}

#[test]
fn system_profiler_apple_silicon_shares_the_memory_an_intel_mac_has_its_own() {
    assert_eq!(
        parse_system_profiler(&mac_arm()),
        Profile {
            gpus: vec![GpuInfo {
                unified_memory: Some(true),
                ..gpu("apple", "Apple M2 Pro", Some(32.0 * GIB))
            }],
            ram_bytes: Some(32.0 * GIB),
            chip: Some("Apple M2 Pro".into()),
        }
    );
    let intel = parse_system_profiler(&mac_intel());
    assert_eq!(
        intel.gpus,
        vec![
            gpu("intel", "Intel UHD Graphics 630", Some(1536.0 * MIB)),
            gpu("amd", "AMD Radeon Pro 5500M", Some(4.0 * GIB)),
        ]
    );
    assert_eq!(intel.ram_bytes, Some(16.0 * GIB));
}

#[test]
fn windows_video_controllers_one_or_several() {
    assert_eq!(
        parse_windows_video_controllers(&windows())
            .iter()
            .map(|gpu| gpu.vendor.clone())
            .collect::<Vec<_>>(),
        vec!["nvidia", "intel"]
    );
    assert_eq!(
        parse_windows_video_controllers(
            &json!({"Name": "AMD Radeon RX 6600", "AdapterRAM": 4293918720u64}).to_string()
        ),
        vec![gpu("amd", "AMD Radeon RX 6600", Some(4293918720.0))]
    );
}

#[test]
fn os_release_s_pretty_name() {
    assert_eq!(
        parse_os_release("PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n").as_deref(),
        Some("Ubuntu 24.04.1 LTS")
    );
    assert_eq!(
        parse_os_release("PRETTY_NAME=Arch Linux\n").as_deref(),
        Some("Arch Linux")
    );
}

#[test]
fn the_desktop_cuda_on_the_nvidia_card_the_amd_one_listed_from_drm() {
    let hardware = detect_hardware(&probe(
        "linux",
        "x64",
        &[("nvidia-smi", NVIDIA_SMI.into())],
        DRM_DESKTOP,
    ));
    assert_eq!(hardware.acceleration, "cuda");
    assert_eq!(hardware.gpu_bytes, 8.0 * GIB);
    assert_eq!(
        hardware.os_name.as_deref(),
        Some("Fedora Linux 43 (Workstation Edition)")
    );
    assert_eq!(
        hardware
            .gpus
            .iter()
            .map(|gpu| (gpu.vendor.clone(), gpu.name.clone()))
            .collect::<Vec<_>>(),
        vec![
            ("nvidia".to_owned(), "NVIDIA GeForce RTX 3060 Ti".to_owned()),
            ("amd".to_owned(), "AMD GPU 0x7340".to_owned())
        ]
    );
    assert!(hardware.note.is_none());
}

#[test]
fn amd_only_named_by_rocm_smi_the_models_on_the_cpu_and_why() {
    let hardware = detect_hardware(&probe(
        "linux",
        "x64",
        &[("rocm-smi", rocm_smi())],
        &[
            ("/sys/class/drm/card0/device/vendor", "0x1002"),
            ("/sys/class/drm/card0/device/device", "0x7340"),
        ],
    ));
    assert_eq!(
        hardware.gpus,
        vec![gpu(
            "amd",
            "Navi 14 [Radeon RX 5500/5500M / Pro 5500M]",
            Some(8573157376.0)
        )]
    );
    assert_eq!(hardware.acceleration, "cpu");
    assert!(hardware.note.unwrap().contains("no ROCm or Vulkan build"));
}

#[test]
fn an_nvidia_card_without_its_driver_s_nvidia_smi_is_not_used() {
    let hardware = detect_hardware(&probe(
        "linux",
        "x64",
        &[],
        &[
            ("/sys/class/drm/card0/device/vendor", "0x10de"),
            ("/sys/class/drm/card0/device/device", "0x2489"),
        ],
    ));
    assert_eq!(hardware.acceleration, "cpu");
    assert!(hardware.note.unwrap().contains("nvidia-smi"));
}

#[test]
fn apple_silicon_runs_on_metal_with_part_of_the_unified_memory() {
    let hardware = detect_hardware(&probe(
        "darwin",
        "arm64",
        &[("system_profiler", mac_arm()), ("sw_vers", "15.1\n".into())],
        &[],
    ));
    assert_eq!(hardware.acceleration, "metal");
    assert_eq!(hardware.ram_bytes, 32.0 * GIB);
    assert_eq!(hardware.gpu_bytes, js::round(32.0 * GIB * 0.7));
    assert_eq!(hardware.os_name.as_deref(), Some("macOS 15.1"));
}

#[test]
fn an_intel_mac_runs_everything_on_the_cpu() {
    let hardware = detect_hardware(&probe(
        "darwin",
        "x64",
        &[("system_profiler", mac_intel())],
        &[],
    ));
    assert_eq!(hardware.acceleration, "cpu");
    assert!(hardware.note.unwrap().contains("Apple silicon"));
}

#[test]
fn windows_nvidia_smi_s_size_wins_over_the_32_bit_adapterram() {
    let hardware = detect_hardware(&probe(
        "win32",
        "x64",
        &[
            (
                "nvidia-smi",
                "NVIDIA GeForce RTX 3060, 12288, 560.94, 8.6\n".into(),
            ),
            ("powershell.exe", windows()),
        ],
        &[],
    ));
    assert_eq!(hardware.acceleration, "cuda");
    assert_eq!(hardware.gpu_bytes, 12.0 * GIB);
    assert_eq!(
        hardware
            .gpus
            .iter()
            .map(|gpu| gpu.name.clone())
            .collect::<Vec<_>>(),
        vec!["NVIDIA GeForce RTX 3060", "Intel(R) UHD Graphics 770"]
    );
}

#[test]
fn no_gpu_at_all() {
    assert_eq!(
        acceleration_for("linux", "x64", &[], false, 8.0 * GIB),
        ("cpu", 0.0, None)
    );
}
