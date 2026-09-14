import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertArchiveMembersAreSafe,
  gitContentList,
  isContainedWithin,
  tarExcludeArgs,
} from "./file-sync.js";

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

/**
 * A checkout exercising every ignore rule that distinguishes git's answer from
 * tar's: a negation, a force-added file matching an ignore pattern, an ignored
 * directory, a nested .gitignore, and .git/info/exclude.
 */
async function makeGitRepo(): Promise<string> {
  const repo = await makeTempDir();
  const git = (...args: string[]) => execFileAsync("git", ["-C", repo, ...args]);
  const write = async (relative: string, contents: string) => {
    await fs.mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
    await fs.writeFile(path.join(repo, relative), contents);
  };

  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");

  await write(".gitignore", "*.log\n!keep.log\nbuild/\nsecrets.txt\nnode_modules\n");
  await write("app.ts", "export const x = 1;\n");
  await write("debug.log", "ignored\n");
  await write("keep.log", "negated\n");
  await write("secrets.txt", "tracked despite the pattern\n");
  await write("build/out.js", "artifact\n");
  await write("node_modules/pkg/index.js", "dependency\n");

  await git("add", "-A");
  await git("add", "-f", "secrets.txt");
  await git("commit", "-qm", "initial");

  await fs.appendFile(path.join(repo, ".git/info/exclude"), "excluded-by-info.txt\n");
  await write("excluded-by-info.txt", "ignored via info/exclude\n");
  // Uncommitted output, exactly what an agent produces mid-run.
  await write("NEW-WORK.md", "agent output\n");

  return repo;
}

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
  it("maps explicit patterns to tar --exclude flags", () => {
    expect(tarExcludeArgs([".venv", "*.tmp"])).toEqual([
      "--exclude",
      ".venv",
      "--exclude",
      "*.tmp",
    ]);
  });

  it("returns nothing when no patterns are given", () => {
    expect(tarExcludeArgs(undefined)).toEqual([]);
  });
});

describe("gitContentList", () => {
  it("returns null outside a git checkout so the caller archives everything", async () => {
    const plain = await makeTempDir();
    await fs.writeFile(path.join(plain, "notes.txt"), "no git here\n");
    expect(await gitContentList(plain)).toBeNull();
  });

  it("matches git's own content list and always includes .git", async () => {
    const repo = await makeGitRepo();
    const list = await gitContentList(repo);
    expect(list).not.toBeNull();
    const entries = list!.split("\0").filter(Boolean);

    // git's definition of content: tracked + untracked-not-ignored.
    expect(entries).toContain("app.ts");
    expect(entries).toContain("NEW-WORK.md");
    // History must travel or sandbox commits are lost.
    expect(entries).toContain(".git");
    // Ignored, regenerable output stays behind.
    expect(entries.some((e) => e.startsWith("node_modules/"))).toBe(false);
    expect(entries.some((e) => e.startsWith("build/"))).toBe(false);
  });

  it("keeps files tar --exclude-vcs-ignores would wrongly drop", async () => {
    // These two cases are why enumeration comes from git rather than tar:
    // tar re-implements pattern matching without the index and drops both,
    // which would silently destroy committed work on the way out of a sandbox.
    const repo = await makeGitRepo();
    const entries = (await gitContentList(repo))!.split("\0").filter(Boolean);
    expect(entries).toContain("keep.log"); // negated by "!keep.log"
    expect(entries).toContain("secrets.txt"); // tracked via `git add -f`
  });

  it("honours .git/info/exclude, which tar does not consult", async () => {
    const repo = await makeGitRepo();
    const entries = (await gitContentList(repo))!.split("\0").filter(Boolean);
    expect(entries).not.toContain("excluded-by-info.txt");
  });
});
