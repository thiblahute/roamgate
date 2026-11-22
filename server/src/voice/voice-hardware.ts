import { readdirSync, readFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import type {
  Acceleration,
  GpuInfo,
  VoiceHardware,
} from "../../../shared/voiceSetup";

/**
 * What the voice helper can run its models on (voice-setup.ts): the GPUs,
 * the memory and the CPU of this machine. The helper's GPU models (Whisper,
 * any-tts's Qwen3-TTS and Kokoro) run on CUDA on Linux, as
 * voice/helper/linux/build.sh builds it, and on Metal on macOS; anything
 * else runs them on the CPU, where Parakeet, Kokoro's ONNX model and the
 * turn and speaker models run anyway.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Share of unified memory Metal lets the GPU take, about. */
const UNIFIED_GPU_SHARE = 0.7;

export type HardwareProbe = {
  platform: string;
  arch: string;
  /** Runs a program, null when it is missing or fails. */
  capture: (argv: string[]) => string | null;
  readFile: (path: string) => string | null;
  listDir: (path: string) => string[];
  cpu: () => { model: string; cores: number };
  ramBytes: () => number;
};

export function systemProbe(
  platform: string = process.platform,
  arch: string = process.arch,
): HardwareProbe {
  return {
    platform,
    arch,
    capture: (argv) => {
      try {
        const result = Bun.spawnSync(argv, {
          stdout: "pipe",
          stderr: "ignore",
          timeout: 10_000,
        });
        return result.exitCode === 0 ? result.stdout.toString() : null;
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    cpu: () => {
      const list = cpus();
      return { model: list[0]?.model.trim() ?? "unknown", cores: list.length };
    },
    ramBytes: totalmem,
  };
}

/**
 * `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap
 * --format=csv,noheader,nounits`: one GPU a line, memory in MiB. Older
 * drivers have no compute_cap: the line has three fields.
 */
export function parseNvidiaSmi(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 2 || !fields[0]) continue;
    const mib = Number(fields[1]);
    gpus.push({
      vendor: "nvidia",
      name: fields[0],
      ...(Number.isFinite(mib) && mib > 0 ? { vramBytes: mib * MIB } : {}),
      ...(fields[2] ? { driver: fields[2] } : {}),
      ...(fields[3] && /^\d+\.\d+$/.test(fields[3])
        ? { computeCapability: fields[3] }
        : {}),
    });
  }
  return gpus;
}

/**
 * `rocm-smi --showproductname --showmeminfo vram --json`: an object per
 * card ("card0"), whose keys vary a little between ROCm versions.
 */
export function parseRocmSmi(output: string): GpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const gpus: GpuInfo[] = [];
  for (const [card, value] of Object.entries(parsed)) {
    if (!/^card\d+$/i.test(card) || !value || typeof value !== "object")
      continue;
    const fields = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, field]) => [
        key.toLowerCase(),
        String(field),
      ]),
    );
    const name =
      fields["card series"] ??
      fields["card model"] ??
      fields["marketing name"] ??
      "AMD GPU";
    const vram = Number(fields["vram total memory (b)"]);
    gpus.push({
      vendor: "amd",
      name,
      ...(Number.isFinite(vram) && vram > 0 ? { vramBytes: vram } : {}),
    });
  }
  return gpus;
}

const PCI_VENDORS: Record<string, GpuInfo["vendor"]> = {
  "0x10de": "nvidia",
  "0x1002": "amd",
  "0x8086": "intel",
};

/**
 * The GPUs Linux's DRM lists (/sys/class/drm/cardN/device): their vendor
 * and device ids, and amdgpu's VRAM size. Seen without any vendor tool.
 */
export function drmGpus(probe: HardwareProbe): GpuInfo[] {
  const root = "/sys/class/drm";
  const gpus: GpuInfo[] = [];
  for (const card of probe.listDir(root).sort()) {
    if (!/^card\d+$/.test(card)) continue;
    const device = join(root, card, "device");
    const vendorId = probe.readFile(join(device, "vendor"))?.trim();
    if (!vendorId) continue;
    const deviceId = probe.readFile(join(device, "device"))?.trim() ?? "";
    const vendor = PCI_VENDORS[vendorId] ?? "other";
    const vram = Number(
      probe.readFile(join(device, "mem_info_vram_total"))?.trim(),
    );
    const label = { nvidia: "NVIDIA", amd: "AMD", intel: "Intel" } as Record<
      string,
      string
    >;
    gpus.push({
      vendor,
      name: `${label[vendor] ?? vendorId} GPU ${deviceId}`.trim(),
      ...(Number.isFinite(vram) && vram > 0 ? { vramBytes: vram } : {}),
    });
  }
  return gpus;
}

/** "32 GB", "4096 MB": bytes. */
function sizeOf(text: unknown): number | undefined {
  const match = /^([\d.]+)\s*(GB|MB|TB)$/i.exec(String(text ?? "").trim());
  if (!match) return undefined;
  const unit = { MB: MIB, GB: GIB, TB: 1024 * GIB }[
    match[2]?.toUpperCase() as "MB" | "GB" | "TB"
  ];
  return Math.round(Number(match[1]) * unit);
}

/**
 * `system_profiler SPDisplaysDataType SPHardwareDataType -json`: the GPUs
 * (Apple silicon's shares the machine's memory) and the machine.
 */
export function parseSystemProfiler(output: string): {
  gpus: GpuInfo[];
  ramBytes?: number;
  chip?: string;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return { gpus: [] };
  }
  const hardware = (
    Array.isArray(parsed.SPHardwareDataType) ? parsed.SPHardwareDataType : []
  )[0] as Record<string, unknown> | undefined;
  const ramBytes = sizeOf(hardware?.physical_memory);
  const chip =
    typeof hardware?.chip_type === "string" ? hardware.chip_type : undefined;
  const gpus: GpuInfo[] = [];
  for (const entry of Array.isArray(parsed.SPDisplaysDataType)
    ? (parsed.SPDisplaysDataType as Record<string, unknown>[])
    : []) {
    const name = String(entry.sppci_model ?? entry._name ?? "GPU");
    const vendorText = String(entry.spdisplays_vendor ?? "").toLowerCase();
    const vendor: GpuInfo["vendor"] =
      vendorText.includes("apple") || /^apple /i.test(name)
        ? "apple"
        : vendorText.includes("amd") || vendorText.includes("ati")
          ? "amd"
          : vendorText.includes("intel")
            ? "intel"
            : vendorText.includes("nvidia")
              ? "nvidia"
              : "other";
    const vram = sizeOf(entry.spdisplays_vram ?? entry.spdisplays_vram_shared);
    gpus.push({
      vendor,
      name,
      ...(vendor === "apple"
        ? { unifiedMemory: true, ...(ramBytes ? { vramBytes: ramBytes } : {}) }
        : vram
          ? { vramBytes: vram }
          : {}),
    });
  }
  return { gpus, ramBytes, chip };
}

/**
 * PowerShell's `Get-CimInstance Win32_VideoController | Select-Object
 * Name,AdapterRAM,DriverVersion | ConvertTo-Json`: one object, or a list.
 * AdapterRAM is 32 bits: a card of 4 GB or more reads as 4 GB at most, so
 * nvidia-smi's size wins when it has one.
 */
export function parseWindowsVideoControllers(output: string): GpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as Record<
    string,
    unknown
  >[];
  return list
    .filter((entry) => entry && typeof entry.Name === "string")
    .map((entry) => {
      const name = String(entry.Name);
      const lower = name.toLowerCase();
      const ram = Number(entry.AdapterRAM);
      return {
        vendor: lower.includes("nvidia")
          ? "nvidia"
          : lower.includes("amd") || lower.includes("radeon")
            ? "amd"
            : lower.includes("intel")
              ? "intel"
              : "other",
        name,
        ...(Number.isFinite(ram) && ram > 0 ? { vramBytes: ram } : {}),
        ...(typeof entry.DriverVersion === "string"
          ? { driver: entry.DriverVersion }
          : {}),
      } satisfies GpuInfo;
    });
}

/** /etc/os-release's PRETTY_NAME. */
export function parseOsRelease(text: string): string | undefined {
  const match = /^PRETTY_NAME=(?:"([^"]*)"|(.*))$/m.exec(text);
  return (match?.[1] ?? match?.[2])?.trim() || undefined;
}

const NVIDIA_QUERY = [
  "nvidia-smi",
  "--query-gpu=name,memory.total,driver_version,compute_cap",
  "--format=csv,noheader,nounits",
];

function nvidiaGpus(probe: HardwareProbe): GpuInfo[] | null {
  const output =
    probe.capture(NVIDIA_QUERY) ??
    // Drivers before 510 have no compute_cap field.
    probe.capture([
      "nvidia-smi",
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader,nounits",
    ]);
  return output === null ? null : parseNvidiaSmi(output);
}

/** The hardware the voice helper would run on, here. */
export function detectHardware(probe: HardwareProbe): VoiceHardware {
  const { platform, arch } = probe;
  let ramBytes = probe.ramBytes();
  let cpu = probe.cpu();
  let osName: string | undefined;
  let gpus: GpuInfo[];
  let nvidiaSmi = false;
  if (platform === "darwin") {
    const profile = parseSystemProfiler(
      probe.capture([
        "system_profiler",
        "SPDisplaysDataType",
        "SPHardwareDataType",
        "-json",
      ]) ?? "",
    );
    gpus = profile.gpus;
    if (profile.ramBytes) ramBytes = profile.ramBytes;
    if (profile.chip && cpu.model === "unknown")
      cpu = { ...cpu, model: profile.chip };
    const version = probe.capture(["sw_vers", "-productVersion"])?.trim();
    osName = version ? `macOS ${version}` : "macOS";
  } else {
    const nvidia = nvidiaGpus(probe);
    nvidiaSmi = nvidia !== null && nvidia.length > 0;
    gpus = nvidia ?? [];
    if (platform === "win32") {
      const controllers = parseWindowsVideoControllers(
        probe.capture([
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json",
        ]) ?? "",
      );
      gpus.push(
        ...controllers.filter((gpu) => !(nvidiaSmi && gpu.vendor === "nvidia")),
      );
      osName = `Windows ${release()}`;
    } else {
      const rocm = parseRocmSmi(
        probe.capture([
          "rocm-smi",
          "--showproductname",
          "--showmeminfo",
          "vram",
          "--json",
        ]) ?? "",
      );
      const drm = drmGpus(probe).filter(
        (gpu) =>
          !(nvidiaSmi && gpu.vendor === "nvidia") &&
          !(rocm.length && gpu.vendor === "amd"),
      );
      gpus.push(...rocm, ...drm);
      const osRelease = probe.readFile("/etc/os-release");
      osName =
        (osRelease ? parseOsRelease(osRelease) : undefined) ??
        (platform === "linux" ? "Linux" : platform);
    }
  }
  const { acceleration, gpuBytes, note } = accelerationFor(
    platform,
    arch,
    gpus,
    nvidiaSmi,
    ramBytes,
  );
  return {
    platform,
    arch,
    ...(osName ? { osName } : {}),
    cpu,
    ramBytes,
    gpus,
    acceleration,
    gpuBytes,
    ...(note ? { note } : {}),
  };
}

/** Which GPU the helper's models run on, and how much memory they may take. */
export function accelerationFor(
  platform: string,
  arch: string,
  gpus: GpuInfo[],
  nvidiaSmi: boolean,
  ramBytes: number,
): { acceleration: Acceleration; gpuBytes: number; note?: string } {
  const nvidia = gpus.filter((gpu) => gpu.vendor === "nvidia");
  if (nvidia.length && nvidiaSmi && platform !== "darwin") {
    const gpuBytes = Math.max(...nvidia.map((gpu) => gpu.vramBytes ?? 0));
    return { acceleration: "cuda", gpuBytes };
  }
  if (platform === "darwin" && arch === "arm64")
    return {
      acceleration: "metal",
      gpuBytes: Math.round(ramBytes * UNIFIED_GPU_SHARE),
    };
  if (nvidia.length)
    return {
      acceleration: "cpu",
      gpuBytes: 0,
      note: "An NVIDIA GPU is here but nvidia-smi is not: with the NVIDIA driver installed, the GPU models can run on it.",
    };
  if (platform === "darwin")
    return {
      acceleration: "cpu",
      gpuBytes: 0,
      note: "The voice helper runs its GPU models with Metal on Apple silicon only: this Mac runs them on the CPU.",
    };
  const other = gpus.find(
    (gpu) => gpu.vendor === "amd" || gpu.vendor === "intel",
  );
  if (other)
    return {
      acceleration: "cpu",
      gpuBytes: 0,
      note: `The voice helper runs its GPU models with CUDA (NVIDIA) or Metal (Apple): ${other.name} is not used (no ROCm or Vulkan build), the models run on the CPU.`,
    };
  return { acceleration: "cpu", gpuBytes: 0 };
}

export { GIB, MIB };
