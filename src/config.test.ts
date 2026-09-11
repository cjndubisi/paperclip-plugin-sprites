import { describe, expect, it } from "vitest";
import { buildSpriteName, parseDriverConfig } from "./config.js";
import manifest from "./manifest.js";

describe("parseDriverConfig", () => {
  it("applies defaults for an empty config", () => {
    const config = parseDriverConfig({});
    expect(config.apiUrl).toBe("https://api.sprites.dev/v1");
    expect(config.workspaceRoot).toBe("/home/sprite/paperclip-workspace");
    expect(config.spriteNamePrefix).toBe("paperclip");
    expect(config.timeoutMs).toBe(120_000);
    expect(config.destroyOnRelease).toBe(false);
  });

  it("treats a blank string as absent", () => {
    const config = parseDriverConfig({ apiUrl: "   ", spriteNamePrefix: "" });
    expect(config.apiUrl).toBe("https://api.sprites.dev/v1");
    expect(config.spriteNamePrefix).toBe("paperclip");
  });

  it("ignores a non-positive timeout", () => {
    expect(parseDriverConfig({ timeoutMs: 0 }).timeoutMs).toBe(120_000);
    expect(parseDriverConfig({ timeoutMs: -5 }).timeoutMs).toBe(120_000);
  });

  it("accepts only the two known URL auth values", () => {
    expect(parseDriverConfig({ urlAuth: "public" }).urlAuth).toBe("public");
    expect(parseDriverConfig({ urlAuth: "sprite" }).urlAuth).toBe("sprite");
    expect(parseDriverConfig({ urlAuth: "everyone" }).urlAuth).toBeNull();
  });

  it("prefers the configured token over the environment variable", () => {
    const previous = process.env.SPRITES_TOKEN;
    process.env.SPRITES_TOKEN = "from-env";
    try {
      expect(parseDriverConfig({ apiToken: "from-config" }).apiToken).toBe("from-config");
      expect(parseDriverConfig({}).apiToken).toBe("from-env");
    } finally {
      if (previous === undefined) delete process.env.SPRITES_TOKEN;
      else process.env.SPRITES_TOKEN = previous;
    }
  });
});

describe("buildSpriteName", () => {
  it("produces a DNS-safe name", () => {
    const name = buildSpriteName({
      prefix: "paperclip",
      environmentId: "3f9a2b1c-0000-4444-8888-aaaabbbbcccc",
      uniqueSuffix: "abc123",
    });
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.startsWith("paperclip-")).toBe(true);
  });

  it("strips characters that are illegal in a hostname", () => {
    const name = buildSpriteName({
      prefix: "My Company!",
      environmentId: "ENV_ID/42",
      uniqueSuffix: "XY..Z",
    });
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name).not.toContain("_");
    expect(name).not.toContain(".");
  });

  it("keeps the name within a comfortable hostname length", () => {
    const name = buildSpriteName({
      prefix: "a".repeat(40),
      environmentId: "b".repeat(40),
      uniqueSuffix: "c".repeat(40),
    });
    expect(name.length).toBeLessThanOrEqual(48);
  });

  it("varies by suffix so concurrent leases never collide", () => {
    const base = { prefix: "paperclip", environmentId: "env-1234" };
    const first = buildSpriteName({ ...base, uniqueSuffix: "aaa111" });
    const second = buildSpriteName({ ...base, uniqueSuffix: "bbb222" });
    expect(first).not.toBe(second);
  });
});

describe("manifest", () => {
  it("declares the capability required for environment drivers", () => {
    // The host rejects an install whose manifest declares drivers without this
    // capability, so the pairing is worth pinning.
    expect(manifest.capabilities).toContain("environment.drivers.register");
    expect(manifest.environmentDrivers?.length).toBe(1);
  });

  it("declares the driver as a sandbox provider", () => {
    const driver = manifest.environmentDrivers?.[0];
    expect(driver?.kind).toBe("sandbox_provider");
    expect(driver?.driverKey).toBe("sprites");
  });

  it("opts in to reusable leases explicitly", () => {
    // An omitted flag silently forces an ephemeral lease, which would discard
    // the warm toolchain a sprite is meant to keep.
    expect(manifest.environmentDrivers?.[0]?.supportsReusableLeases).toBe(true);
  });
});
