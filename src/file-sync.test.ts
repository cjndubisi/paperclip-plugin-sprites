import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { assertArchiveMembersAreSafe, isContainedWithin, tarExcludeArgs } from "./file-sync.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprites-sync-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("isContainedWithin", () => {
  it("accepts a direct child", () => {
    expect(isContainedWithin("/tmp/root", "/tmp/root/file.txt")).toBe(true);
  });

  it("accepts the root itself", () => {
    expect(isContainedWithin("/tmp/root", "/tmp/root")).toBe(true);
  });

  it("rejects a traversal escape", () => {
    expect(isContainedWithin("/tmp/root", "/tmp/root/../evil")).toBe(false);
  });

  it("rejects a sibling that shares the root's name prefix", () => {
    // Without the separator check, "/tmp/rootkit" passes a naive startsWith.
    expect(isContainedWithin("/tmp/root", "/tmp/rootkit")).toBe(false);
  });
});

/**
 * These tests exercise the host-side boundary control. The archive is produced
 * inside the sandbox, so a malicious member must be rejected BEFORE extraction
 * writes anything to a host path.
 */
describe("assertArchiveMembersAreSafe", () => {
  it("accepts an archive whose members stay inside the destination", async () => {
    const source = await makeTempDir();
    const destination = await makeTempDir();
    await fs.writeFile(path.join(source, "ok.txt"), "fine");

    const archive = path.join(await makeTempDir(), "safe.tar");
    await execFileAsync("tar", ["-cf", archive, "-C", source, "."]);

    await expect(assertArchiveMembersAreSafe(archive, destination)).resolves.toBeUndefined();
  });

  it("rejects an archive member that traverses out of the destination", async () => {
    const staging = await makeTempDir();
    const destination = await makeTempDir();

    const nested = path.join(staging, "payload");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "escape.txt"), "malicious");

    const archive = path.join(await makeTempDir(), "traversal.tar");
    // Build an archive whose member path is literally "../escape.txt".
    await execFileAsync("tar", ["-cf", archive, "-C", nested, "../payload/escape.txt"], {
      cwd: nested,
    }).catch(async () => {
      // Some tar builds refuse to store the traversal form directly. Fall back
      // to writing the archive by hand so the assertion still has a hostile
      // input to reject.
      const header = Buffer.alloc(512);
      header.write("../escape.txt", 0, "utf8");
      header.write("0000644\0", 100, "utf8");
      header.write("0000000\0", 108, "utf8");
      header.write("0000000\0", 116, "utf8");
      header.write("00000000004\0", 124, "utf8");
      header.write("00000000000\0", 136, "utf8");
      header.write("        ", 148, "utf8");
      header.write("0", 156, "utf8");
      let checksum = 0;
      for (const byte of header) checksum += byte;
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
      const body = Buffer.alloc(512);
      body.write("evil");
      await fs.writeFile(archive, Buffer.concat([header, body, Buffer.alloc(1024)]));
    });

    await expect(assertArchiveMembersAreSafe(archive, destination)).rejects.toThrow(
      /traversal|outside the destination/i,
    );
  });

  it("rejects an archive member with an absolute path", async () => {
    const destination = await makeTempDir();
    const archive = path.join(await makeTempDir(), "absolute.tar");

    const header = Buffer.alloc(512);
    header.write("/etc/cron.d/pwn", 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write("00000000004\0", 124, "utf8");
    header.write("00000000000\0", 136, "utf8");
    header.write("        ", 148, "utf8");
    header.write("0", 156, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    const body = Buffer.alloc(512);
    body.write("evil");
    await fs.writeFile(archive, Buffer.concat([header, body, Buffer.alloc(1024)]));

    await expect(assertArchiveMembersAreSafe(archive, destination)).rejects.toThrow(
      /absolute/i,
    );
  });
});

describe("tarExcludeArgs", () => {
  it("honours VCS ignore rules by default", () => {
    expect(tarExcludeArgs(undefined, true)).toEqual(["--exclude-vcs-ignores"]);
  });

  it("omits the VCS flag when the caller opts out", () => {
    expect(tarExcludeArgs(undefined, false)).toEqual([]);
  });

  it("keeps explicit patterns alongside the VCS flag", () => {
    expect(tarExcludeArgs([".venv"], true)).toEqual([
      "--exclude-vcs-ignores",
      "--exclude",
      ".venv",
    ]);
  });
});

describe("--exclude-vcs-ignores against a real checkout", () => {
  // The flag is GNU tar only. Both transfer legs in production run GNU tar
  // (the Paperclip host image and the Ubuntu sprite), but macOS ships bsdtar,
  // so this behavioural test is skipped there rather than asserting a flag the
  // local tar cannot honour.
  it("drops gitignored build output but keeps .git and tracked sources", async () => {
    const { stdout: tarHelp } = await execFileAsync("tar", ["--help"]).catch(() => ({ stdout: "" }));
    if (!tarHelp.includes("exclude-vcs-ignores")) {
      console.warn("skipping: local tar is not GNU tar (production uses GNU tar on both legs)");
      return;
    }

    const repo = await makeTempDir();
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules\ndist\n");
    await fs.writeFile(path.join(repo, "index.ts"), "export const x = 1;\n");
    await fs.mkdir(path.join(repo, "node_modules/big"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules/big/blob.bin"), "x".repeat(200_000));
    await fs.mkdir(path.join(repo, "dist"), { recursive: true });
    await fs.writeFile(path.join(repo, "dist/index.js"), "compiled\n");

    // A real git repo: --exclude-vcs-ignores reads the checkout's ignore rules.
    const git = (...args: string[]) => execFileAsync("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("add", "-A");
    await git("commit", "-qm", "initial");

    const archive = path.join(await makeTempDir(), "out.tar");
    await execFileAsync("tar", [
      "-cf",
      archive,
      ...tarExcludeArgs(undefined, true),
      "-C",
      repo,
      ".",
    ]);

    const { stdout } = await execFileAsync("tar", ["-tf", archive]);
    const members = stdout.split("\n").filter(Boolean);

    // Ignored, regenerable bytes stay behind.
    expect(members.some((m) => m.includes("node_modules/"))).toBe(false);
    expect(members.some((m) => m.includes("dist/"))).toBe(false);
    // Sources and git history must survive, or a sandbox commit would be lost.
    expect(members.some((m) => m.endsWith("index.ts"))).toBe(true);
    expect(members.some((m) => m.startsWith("./.git"))).toBe(true);
  });
});
