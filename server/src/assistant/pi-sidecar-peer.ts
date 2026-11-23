/**
 * One side of the Pi sidecar's wire (contract/wire/pi-sidecar.md): requests
 * both ways with their replies, notifications, and `$/cancel`, which aborts
 * the signal of a request the other side sent.
 */
import {
  encodeMessage,
  errorToWire,
  type Id,
  INVALID_REQUEST,
  type Message,
  METHOD_NOT_FOUND,
  parseLine,
  wireToError,
} from "./pi-sidecar-protocol";

export class MethodNotFound extends Error {}

export type PeerHandlers = {
  /** `id` is the request's own: reverse requests made for it carry it. */
  request(
    method: string,
    params: unknown,
    signal: AbortSignal,
    id: Id,
  ): Promise<unknown>;
  notification(method: string, params: unknown): void;
};

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class PiSidecarPeer {
  private nextId = 1;
  private readonly pending = new Map<Id, Pending>();
  private readonly incoming = new Map<Id, AbortController>();
  private closedError: Error | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: PeerHandlers,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Requests in flight both ways. */
  get busy() {
    return this.pending.size + this.incoming.size;
  }

  get closed() {
    return this.closedError !== null;
  }

  request(method: string, params: unknown, signal?: AbortSignal) {
    return this.start(method, params, signal).reply;
  }

  /** A request, with the id its reverse requests and notifications carry. */
  start(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): { id: Id; reply: Promise<unknown> } {
    const id = this.nextId++;
    if (this.closedError)
      return { id, reply: Promise.reject(this.closedError) };
    if (signal?.aborted) return { id, reply: Promise.reject(signal.reason) };
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const cancel = () => this.notify("$/cancel", { id });
    signal?.addEventListener("abort", cancel, { once: true });
    this.pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener("abort", cancel);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", cancel);
        reject(error);
      },
    });
    this.send({ kind: "request", id, method, params });
    return { id, reply: promise };
  }

  notify(method: string, params: unknown) {
    if (this.closedError) return;
    this.send({ kind: "notification", method, params });
  }

  /** One line the other side wrote. */
  receive(line: string) {
    if (!line.trim()) return;
    const message = parseLine(line);
    if (!message) {
      this.log(`not a message: ${line.slice(0, 200)}`);
      return;
    }
    switch (message.kind) {
      case "result":
      case "error": {
        const pending =
          message.id === null ? undefined : this.pending.get(message.id);
        if (!pending) {
          this.log(`a reply to no request: ${String(message.id)}`);
          return;
        }
        this.pending.delete(message.id!);
        if (message.kind === "result") pending.resolve(message.result);
        else pending.reject(wireToError(message.error));
        return;
      }
      case "notification":
        if (message.method === "$/cancel") {
          const id = (message.params as { id?: Id } | null)?.id;
          if (id !== undefined)
            this.incoming.get(id)?.abort(new Error("Cancelled"));
          return;
        }
        try {
          this.handlers.notification(message.method, message.params);
        } catch (error) {
          this.log(`${message.method}: ${String(error)}`);
        }
        return;
      case "request":
        void this.serve(message.id, message.method, message.params);
    }
  }

  private async serve(id: Id, method: string, params: unknown) {
    if (this.incoming.has(id)) {
      this.send({
        kind: "error",
        id,
        error: { code: INVALID_REQUEST, message: "Duplicate request id" },
      });
      return;
    }
    const controller = new AbortController();
    this.incoming.set(id, controller);
    try {
      const result = await this.handlers.request(
        method,
        params,
        controller.signal,
        id,
      );
      this.send({ kind: "result", id, result: result ?? null });
    } catch (error) {
      this.send({
        kind: "error",
        id,
        error:
          error instanceof MethodNotFound
            ? { code: METHOD_NOT_FOUND, message: error.message }
            : errorToWire(error),
      });
    } finally {
      this.incoming.delete(id);
    }
  }

  /** The other side is gone: everything in flight fails with `error`. */
  close(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.incoming.values()) controller.abort(error);
  }

  private send(message: Message) {
    if (this.closedError) return;
    this.write(`${encodeMessage(message)}\n`);
  }
}
