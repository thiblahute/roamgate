import { describe, expect, test } from "bun:test";
import { connectionClientScopeKey } from "./useConnectionClient";

describe("connection client scope keys", () => {
  test("isolates identical resources by connection and generation", () => {
    const alpha = { connectionId: "alpha", generation: 1 };
    const beta = { connectionId: "beta", generation: 1 };
    expect(connectionClientScopeKey(alpha, "same", "same")).not.toBe(
      connectionClientScopeKey(beta, "same", "same"),
    );
    expect(connectionClientScopeKey(alpha, "same", "same")).not.toBe(
      connectionClientScopeKey(
        { connectionId: "alpha", generation: 2 },
        "same",
        "same",
      ),
    );
  });

  test("keeps a view's key across a reconnect of the same runtime", () => {
    const before = {
      connectionId: "alpha",
      generation: 3,
      serverRuntimeGeneration: 1,
      viewEpoch: 2,
    };
    // A reconnect advances the client generation only.
    expect(connectionClientScopeKey({ ...before, generation: 4 }, "ui")).toBe(
      connectionClientScopeKey(before, "ui"),
    );
    // Another connection, a switch back, or a replaced runtime start anew.
    expect(
      connectionClientScopeKey({ ...before, viewEpoch: 3 }, "ui"),
    ).not.toBe(connectionClientScopeKey(before, "ui"));
    expect(
      connectionClientScopeKey({ ...before, serverRuntimeGeneration: 2 }, "ui"),
    ).not.toBe(connectionClientScopeKey(before, "ui"));
  });
});
