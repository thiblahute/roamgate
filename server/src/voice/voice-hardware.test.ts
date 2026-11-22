import { describe, expect, test } from "bun:test";
import {
  accelerationFor,
  detectHardware,
  GIB,
  type HardwareProbe,
  MIB,
  parseNvidiaSmi,
  parseOsRelease,
  parseRocmSmi,
  parseSystemProfiler,
  parseWindowsVideoControllers,
} from "./voice-hardware";

// As nvidia-smi printed them on the desktop (driver 615) and on an older
// driver without compute_cap.
const NVIDIA_SMI = "NVIDIA GeForce RTX 3060 Ti, 8192, 615.78.08, 8.6\n";
const NVIDIA_SMI_TWO =
  "NVIDIA GeForce RTX 4090, 24564, 550.54.14, 8.9\nNVIDIA GeForce GTX 1050, 2048, 550.54.14, 6.1\n";
const NVIDIA_SMI_OLD = "Tesla K80, 11441, 470.82.01\n";

const ROCM_SMI = JSON.stringify({
  card0: {
    "Card series": "Navi 14 [Radeon RX 5500/5500M / Pro 5500M]",
    "Card model": "0x7340",
    "Card vendor": "Advanced Micro Devices, Inc. [AMD/ATI]",
    "Card SKU": "D3220400",
    "VRAM Total Memory (B)": "8573157376",
    "VRAM Total Used Memory (B)": "1203888128",
  },
  system: { "Driver version": "6.12.0" },
});

const MAC_ARM = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Apple M2 Pro",
      sppci_model: "Apple M2 Pro",
      sppci_cores: "19",
      spdisplays_vendor: "sppci_vendor_Apple",
      spdisplays_mtlgpufamilysupport: "spdisplays_metal3",
    },
  ],
  SPHardwareDataType: [
    {
      chip_type: "Apple M2 Pro",
      physical_memory: "32 GB",
      number_processors: "proc 12:8:4",
    },
  ],
});

const MAC_INTEL = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Intel UHD Graphics 630",
      sppci_model: "Intel UHD Graphics 630",
      spdisplays_vendor: "sppci_vendor_intel",
      spdisplays_vram_shared: "1536 MB",
    },
    {
      _name: "AMD Radeon Pro 5500M",
      sppci_model: "AMD Radeon Pro 5500M",
      spdisplays_vendor: "sppci_vendor_amd",
      spdisplays_vram: "4 GB",
    },
  ],
  SPHardwareDataType: [{ physical_memory: "16 GB" }],
});

const WINDOWS = JSON.stringify([
  {
    Name: "NVIDIA GeForce RTX 3060",
    AdapterRAM: 4293918720,
    DriverVersion: "32.0.15.6094",
  },
  {
    Name: "Intel(R) UHD Graphics 770",
    AdapterRAM: 1073741824,
    DriverVersion: "31.0.101.4502",
  },
]);

/** A probe answering from canned outputs and files. */
function probe(
  platform: string,
  arch: string,
  outputs: Record<string, string>,
  files: Record<string, string> = {},
): HardwareProbe {
  return {
    platform,
    arch,
    capture: (argv) => {
      const key = Object.keys(outputs).find((prefix) =>
        argv.join(" ").startsWith(prefix),
      );
      return key === undefined ? null : (outputs[key] ?? null);
    },
    readFile: (path) => files[path] ?? null,
    listDir: (path) =>
      [
        ...new Set(
          Object.keys(files)
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1).split("/")[0] ?? ""),
        ),
      ].filter(Boolean),
    cpu: () => ({ model: "AMD Ryzen 9 3950X 16-Core Processor", cores: 32 }),
    ramBytes: () => 64 * GIB,
  };
}

const DRM_DESKTOP = {
  "/sys/class/drm/card1/device/vendor": "0x1002\n",
  "/sys/class/drm/card1/device/device": "0x7340\n",
  "/sys/class/drm/card1/device/mem_info_vram_total": "8573157376\n",
  "/sys/class/drm/card1-DP-1/status": "connected\n",
  "/sys/class/drm/card2/device/vendor": "0x10de\n",
  "/sys/class/drm/card2/device/device": "0x2489\n",
  "/etc/os-release":
    'NAME="Fedora Linux"\nPRETTY_NAME="Fedora Linux 43 (Workstation Edition)"\n',
};

describe("parsers", () => {
  test("nvidia-smi gives each GPU's memory, driver and compute capability", () => {
    expect(parseNvidiaSmi(NVIDIA_SMI)).toEqual([
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 3060 Ti",
        vramBytes: 8192 * MIB,
        driver: "615.78.08",
        computeCapability: "8.6",
      },
    ]);
    expect(parseNvidiaSmi(NVIDIA_SMI_TWO).map((gpu) => gpu.vramBytes)).toEqual([
      24564 * MIB,
      2048 * MIB,
    ]);
    expect(parseNvidiaSmi(NVIDIA_SMI_OLD)).toEqual([
      {
        vendor: "nvidia",
        name: "Tesla K80",
        vramBytes: 11441 * MIB,
        driver: "470.82.01",
      },
    ]);
    expect(parseNvidiaSmi("")).toEqual([]);
  });

  test("rocm-smi's cards, with their VRAM", () => {
    expect(parseRocmSmi(ROCM_SMI)).toEqual([
      {
        vendor: "amd",
        name: "Navi 14 [Radeon RX 5500/5500M / Pro 5500M]",
        vramBytes: 8573157376,
      },
    ]);
    expect(parseRocmSmi("not json")).toEqual([]);
  });

  test("system_profiler: Apple silicon shares the memory, an Intel Mac has its own", () => {
    expect(parseSystemProfiler(MAC_ARM)).toEqual({
      gpus: [
        {
          vendor: "apple",
          name: "Apple M2 Pro",
          unifiedMemory: true,
          vramBytes: 32 * GIB,
        },
      ],
      ramBytes: 32 * GIB,
      chip: "Apple M2 Pro",
    });
    const intel = parseSystemProfiler(MAC_INTEL);
    expect(intel.gpus).toEqual([
      {
        vendor: "intel",
        name: "Intel UHD Graphics 630",
        vramBytes: 1536 * MIB,
      },
      { vendor: "amd", name: "AMD Radeon Pro 5500M", vramBytes: 4 * GIB },
    ]);
    expect(intel.ramBytes).toBe(16 * GIB);
  });

  test("Windows video controllers, one or several", () => {
    expect(
      parseWindowsVideoControllers(WINDOWS).map((gpu) => gpu.vendor),
    ).toEqual(["nvidia", "intel"]);
    expect(
      parseWindowsVideoControllers(
        JSON.stringify({ Name: "AMD Radeon RX 6600", AdapterRAM: 4293918720 }),
      ),
    ).toEqual([
      { vendor: "amd", name: "AMD Radeon RX 6600", vramBytes: 4293918720 },
    ]);
  });

  test("os-release's pretty name", () => {
    expect(parseOsRelease('PRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe(
      "Ubuntu 24.04.1 LTS",
    );
    expect(parseOsRelease("PRETTY_NAME=Arch Linux\n")).toBe("Arch Linux");
  });
});

describe("detectHardware", () => {
  test("the desktop: CUDA on the NVIDIA card, the AMD one listed from DRM", () => {
    const hardware = detectHardware(
      probe("linux", "x64", { "nvidia-smi": NVIDIA_SMI }, DRM_DESKTOP),
    );
    expect(hardware.acceleration).toBe("cuda");
    expect(hardware.gpuBytes).toBe(8 * GIB);
    expect(hardware.osName).toBe("Fedora Linux 43 (Workstation Edition)");
    expect(hardware.gpus.map((gpu) => [gpu.vendor, gpu.name])).toEqual([
      ["nvidia", "NVIDIA GeForce RTX 3060 Ti"],
      ["amd", "AMD GPU 0x7340"],
    ]);
    expect(hardware.note).toBeUndefined();
  });

  test("AMD only: named by rocm-smi, the models on the CPU, and why", () => {
    const hardware = detectHardware(
      probe(
        "linux",
        "x64",
        { "rocm-smi": ROCM_SMI },
        {
          "/sys/class/drm/card0/device/vendor": "0x1002",
          "/sys/class/drm/card0/device/device": "0x7340",
        },
      ),
    );
    expect(hardware.gpus).toEqual([
      {
        vendor: "amd",
        name: "Navi 14 [Radeon RX 5500/5500M / Pro 5500M]",
        vramBytes: 8573157376,
      },
    ]);
    expect(hardware.acceleration).toBe("cpu");
    expect(hardware.note).toContain("no ROCm or Vulkan build");
  });

  test("an NVIDIA card without its driver's nvidia-smi is not used", () => {
    const hardware = detectHardware(
      probe(
        "linux",
        "x64",
        {},
        {
          "/sys/class/drm/card0/device/vendor": "0x10de",
          "/sys/class/drm/card0/device/device": "0x2489",
        },
      ),
    );
    expect(hardware.acceleration).toBe("cpu");
    expect(hardware.note).toContain("nvidia-smi");
  });

  test("Apple silicon runs on Metal with part of the unified memory", () => {
    const hardware = detectHardware(
      probe("darwin", "arm64", {
        system_profiler: MAC_ARM,
        sw_vers: "15.1\n",
      }),
    );
    expect(hardware.acceleration).toBe("metal");
    expect(hardware.ramBytes).toBe(32 * GIB);
    expect(hardware.gpuBytes).toBe(Math.round(32 * GIB * 0.7));
    expect(hardware.osName).toBe("macOS 15.1");
  });

  test("an Intel Mac runs everything on the CPU", () => {
    const hardware = detectHardware(
      probe("darwin", "x64", { system_profiler: MAC_INTEL }),
    );
    expect(hardware.acceleration).toBe("cpu");
    expect(hardware.note).toContain("Apple silicon");
  });

  test("Windows: nvidia-smi's size wins over the 32-bit AdapterRAM", () => {
    const hardware = detectHardware(
      probe("win32", "x64", {
        "nvidia-smi": "NVIDIA GeForce RTX 3060, 12288, 560.94, 8.6\n",
        "powershell.exe": WINDOWS,
      }),
    );
    expect(hardware.acceleration).toBe("cuda");
    expect(hardware.gpuBytes).toBe(12 * GIB);
    expect(hardware.gpus.map((gpu) => gpu.name)).toEqual([
      "NVIDIA GeForce RTX 3060",
      "Intel(R) UHD Graphics 770",
    ]);
  });

  test("no GPU at all", () => {
    expect(accelerationFor("linux", "x64", [], false, 8 * GIB)).toEqual({
      acceleration: "cpu",
      gpuBytes: 0,
    });
  });
});
