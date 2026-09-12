/**
 * Regression tests for the HTTP 414 that broke every real agent turn.
 *
 * The exec endpoint carries argv in the QUERY STRING, so a command built from
 * model- or user-supplied text (an agent prompt, a patch, a commit body) puts
 * that whole text in the URL. Anything past the proxy's request-line limit is
 * rejected with 414 before it reaches the sprite, which made the provider work
 * in smoke tests and fail on every real issue.
 */
import { describe, expect, it, afterEach } from "vitest";
import { buildExecScript, shellQuote, SpritesClient } from "./sprites-client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** An issue-sized prompt: the payload that triggered the bug in production. */
const BIG_PROMPT = "Refactor the billing module. ".repeat(400);

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

/**
 * Stand in for the Sprites API, rejecting an over-long request line exactly as
 * a real proxy does so the test exercises the failure rather than describing it.
 */
function mockApi(options: { urlLimit: number; record: Recorded[] }) {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const entry: Recorded = {
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : undefined,
    };
    options.record.push(entry);

    if (entry.url.length > options.urlLimit) {
      return new Response("Request-URI Too Large", { status: 414 });
    }
    if (entry.url.includes("/fs/write")) {
      return new Response("", { status: 200 });
    }
    // Framed exec response: stdout "ok", exit 0.
    return new Response(new Uint8Array([1, 111, 107, 3, 0]), { status: 200 });
  }) as typeof fetch;
}

describe("oversize exec commands", () => {
  it("reproduces the 414: a real prompt does not fit in the exec URL", () => {
    const client = new SpritesClient({ token: "t" });
    const url = client.buildExecUrl("box", {
      cmd: ["pi", "--prompt", BIG_PROMPT],
    });
    // This is the bug: URL length scales with prompt length.
    expect(url.length).toBeGreaterThan(8192);
  });

  it("runs an oversize command without a 414 reaching the caller", async () => {
    const record: Recorded[] = [];
    mockApi({ urlLimit: 8192, record });

    const client = new SpritesClient({ token: "t" });
    const result = await client.exec("box", {
      cmd: ["pi", "--prompt", BIG_PROMPT],
      cwd: "/home/sprite/workspace",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(record.some((r) => r.url.length > 8192)).toBe(false);
  });

  it("sends the prompt in a request body, not the URL", async () => {
    const record: Recorded[] = [];
    mockApi({ urlLimit: 8192, record });

    await new SpritesClient({ token: "t" }).exec("box", {
      cmd: ["pi", "--prompt", BIG_PROMPT],
    });

    const write = record.find((r) => r.url.includes("/fs/write"));
    expect(write).toBeDefined();
    expect(write?.body).toContain("Refactor the billing module.");
    expect(record.every((r) => !r.url.includes("Refactor"))).toBe(true);
  });

  it("still uses the plain URL path for a small command", async () => {
    const record: Recorded[] = [];
    mockApi({ urlLimit: 8192, record });

    await new SpritesClient({ token: "t" }).exec("box", { cmd: ["echo", "hi"] });

    expect(record).toHaveLength(1);
    expect(record[0]?.url).toContain("cmd=echo");
    expect(record[0]?.url).not.toContain("/fs/write");
  });

  it("recovers when the proxy limit is tighter than our estimate", async () => {
    const record: Recorded[] = [];
    // 900 is below our 4000-char threshold, so the direct attempt is made and
    // really returns 414. Recovery must come from the response, not the guess.
    mockApi({ urlLimit: 900, record });

    const result = await new SpritesClient({ token: "t" }).exec("box", {
      cmd: ["bash", "-c", "echo " + "y".repeat(1200)],
    });

    expect(record[0]?.url.length).toBeGreaterThan(900);
    expect(result.exitCode).toBe(0);
  });

  it("keeps env values out of the URL", async () => {
    const record: Recorded[] = [];
    mockApi({ urlLimit: 8192, record });

    await new SpritesClient({ token: "t" }).exec("box", {
      cmd: ["pi", "--prompt", BIG_PROMPT],
      env: { OMNIROUTE_KEY: "sk-secret-value" },
    });

    expect(record.every((r) => !r.url.includes("sk-secret-value"))).toBe(true);
  });

  it("deletes the spilled script after the command runs", async () => {
    const record: Recorded[] = [];
    mockApi({ urlLimit: 8192, record });

    await new SpritesClient({ token: "t" }).exec("box", {
      cmd: ["pi", "--prompt", BIG_PROMPT],
    });

    const exec = record.find((r) => r.url.includes("/exec"));
    // URLSearchParams encodes a space as "+", which decodeURIComponent leaves
    // alone — normalise it before asserting on shell text.
    const decoded = decodeURIComponent((exec?.url ?? "").replace(/\+/g, " "));
    expect(decoded).toContain("rm -f");
    expect(decoded).toContain("/tmp/paperclip-exec/");
  });
});

describe("buildExecScript", () => {
  it("preserves argument boundaries through quoting", () => {
    const script = buildExecScript({ cmd: ["git", "commit", "-m", "two words"] });
    expect(script.trim()).toBe("exec 'git' 'commit' '-m' 'two words'");
  });

  it("neutralises shell metacharacters in an argument", () => {
    const script = buildExecScript({ cmd: ["echo", "$(rm -rf /); `id`"] });
    expect(script).toContain("'$(rm -rf /); `id`'");
  });

  it("rejects an environment name that could inject shell syntax", () => {
    expect(() =>
      buildExecScript({ cmd: ["true"], env: { "X; rm -rf /": "1" } }),
    ).toThrow(/invalid environment variable name/i);
  });

  it("exec replaces the shell so the real exit code survives", () => {
    expect(buildExecScript({ cmd: ["false"] })).toMatch(/^exec /m);
  });
});

describe("shellQuote", () => {
  it("escapes an embedded single quote so the word stays one argument", () => {
    // The previous duplicate in file-sync.ts emitted an extra backslash here,
    // which broke any path or pattern containing an apostrophe.
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
