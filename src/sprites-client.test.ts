import { describe, expect, it } from "vitest";
import { decodeExecFrames, SpritesClient } from "./sprites-client.js";

/**
 * The exec endpoint frames its response with a leading stream-identifier byte
 * per chunk. These tests pin that decoding, because reading the response as
 * plain text silently corrupts agent output with control bytes and drops the
 * exit code.
 */
describe("decodeExecFrames", () => {
  const encoder = new TextEncoder();

  function frame(parts: Array<[number, string] | [number]>): Uint8Array {
    const bytes: number[] = [];
    for (const part of parts) {
      bytes.push(part[0]);
      if (part.length > 1) bytes.push(...encoder.encode(part[1] as string));
    }
    return new Uint8Array(bytes);
  }

  it("separates stdout from stderr", () => {
    const raw = frame([
      [1, "hello"],
      [2, "a warning"],
    ]);
    const result = decodeExecFrames(raw);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("a warning");
  });

  it("reads the exit code from the exit frame", () => {
    const raw = new Uint8Array([1, ...encoder.encode("done"), 3, 7]);
    const result = decodeExecFrames(raw);
    expect(result.stdout).toBe("done");
    expect(result.exitCode).toBe(7);
  });

  it("reports a zero exit code distinctly from a missing one", () => {
    const withExit = decodeExecFrames(new Uint8Array([1, ...encoder.encode("ok"), 3, 0]));
    expect(withExit.exitCode).toBe(0);

    const withoutExit = decodeExecFrames(new Uint8Array([1, ...encoder.encode("ok")]));
    expect(withoutExit.exitCode).toBeNull();
  });

  it("keeps stdout free of the framing bytes", () => {
    // A naive text read leaves \u0001 and \u0003 in the output. This is the
    // exact corruption the decoder exists to prevent.
    const raw = new Uint8Array([1, ...encoder.encode("clean output"), 3, 0]);
    const result = decodeExecFrames(raw);
    expect(result.stdout).toBe("clean output");
    expect(result.stdout).not.toContain("\u0001");
    expect(result.stdout).not.toContain("\u0003");
  });

  it("decodes multi-byte UTF-8 that spans the buffer", () => {
    const raw = frame([[1, "café ☕"]]);
    expect(decodeExecFrames(raw).stdout).toBe("café ☕");
  });

  it("returns empty streams for an empty response", () => {
    const result = decodeExecFrames(new Uint8Array([]));
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBeNull();
  });
});

describe("SpritesClient construction", () => {
  it("rejects a missing token", () => {
    expect(() => new SpritesClient({ token: "" })).toThrow(/token is required/i);
  });

  it("trims a trailing slash from the API URL", async () => {
    const client = new SpritesClient({ token: "t", apiUrl: "https://example.test/v1/" });
    // The trimmed URL is private, so assert through a call instead.
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      await client.getSprite("box");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls[0]).toBe("https://example.test/v1/sprites/box");
  });
});
