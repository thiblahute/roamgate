import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * Connect a unix socket and write to it in one synchronous step, so the data
 * is in the socket before the peer's first read.
 *
 * Herdr's API server reads a new connection's request line without blocking
 * and sleeps 100 ms whenever nothing has arrived yet (CONNECTION_POLL_INTERVAL
 * in Herdr's src/api/server.rs). A client that connects, returns to its event
 * loop, then writes loses that race whenever Herdr's connection thread reads
 * first: through Bun.connect, half the calls of a burst of four did and
 * most of a burst of eight. Writing in the same step as connect() never lost
 * it.
 *
 * Linux only (glibc or musl); elsewhere, or on any failure, it returns null
 * and the caller connects the usual way.
 */
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_NONBLOCK = 0o4000;
const SOCK_CLOEXEC = 0o2000000;
const SUN_PATH_BYTES = 108;

type Libc = {
  socket(domain: number, type: number, protocol: number): number;
  connect(fd: number, address: ReturnType<typeof ptr>, length: number): number;
  write(fd: number, data: ReturnType<typeof ptr>, length: number): number;
  close(fd: number): number;
};

let libc: Libc | null | undefined;

function openLibc(): Libc | null {
  if (process.platform !== "linux") return null;
  const definitions = {
    socket: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    connect: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    write: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const;
  for (const name of [
    "libc.so.6",
    `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
  ]) {
    try {
      const { symbols } = dlopen(name, definitions);
      return {
        socket: (domain, type, protocol) =>
          symbols.socket(domain, type, protocol),
        connect: (fd, address, length) => symbols.connect(fd, address, length),
        write: (fd, data, length) => Number(symbols.write(fd, data, length)),
        close: (fd) => symbols.close(fd),
      };
    } catch {
      // Try the next libc.
    }
  }
  return null;
}

/**
 * A connected, non-blocking descriptor, or null when the synchronous path is
 * unavailable or failed (nothing is left open then). The caller writes with
 * writeDescriptor in the same synchronous step, then hands the descriptor to
 * Bun.connect({ fd }) or closes it with closeDescriptor.
 */
export function connectUnix(path: string): number | null {
  if (libc === undefined) libc = openLibc();
  if (!libc) return null;
  const pathBytes = Buffer.from(path);
  if (pathBytes.length >= SUN_PATH_BYTES || pathBytes.includes(0)) return null;
  // struct sockaddr_un: sa_family_t sun_family; char sun_path[108].
  const address = Buffer.alloc(2 + SUN_PATH_BYTES);
  address.writeUInt16LE(AF_UNIX, 0);
  pathBytes.copy(address, 2);
  const fd = libc.socket(
    AF_UNIX,
    SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC,
    0,
  );
  if (fd < 0) return null;
  // A non-blocking unix connect completes at once or fails (EAGAIN when the
  // listen backlog is full): either way there is nothing to wait for.
  if (libc.connect(fd, ptr(address), address.length) !== 0) {
    libc.close(fd);
    return null;
  }
  return fd;
}

/**
 * How many bytes of `data` the socket took; the rest is the caller's to
 * write. 0 on a full socket buffer, or on an error the socket reports again
 * on its next write.
 */
export function writeDescriptor(fd: number, data: Uint8Array): number {
  if (!libc || data.length === 0) return 0;
  const written = libc.write(fd, ptr(data), data.length);
  return written > 0 ? written : 0;
}

/** Closes a descriptor from connectUnix that nothing else owns yet. */
export function closeDescriptor(fd: number): void {
  libc?.close(fd);
}
