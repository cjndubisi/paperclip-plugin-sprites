/**
 * Workspace file synchronization between the host and a sprite.
 *
 * This module implements the two transfer directions the host asks for. It is
 * a boundary surface: outbound synchronization is one of only two authorities
 * sandbox code holds over the host, so every host destination is validated
 * here, on the host, before any byte is written.
 *
 * Transfers use `tar` streamed through the Sprites filesystem endpoints. A
 * directory becomes one archive rather than a file-per-request walk, which
 * keeps a large workspace to a bounded number of API calls.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  PluginEnvironmentSyncResult,
  PluginSyncFileMapping,
  PluginSyncOperation,
} from "@paperclipai/plugin-sdk";

import type { SpritesClient } from "./sprites-client.js";

const execFileAsync = promisify(execFile);

/** Scratch directory inside the sprite for staged archives. */
const REMOTE_STAGING_ROOT = "/tmp/paperclip-sync";

interface SyncInput {
  client: SpritesClient;
  spriteName: string;
  operations: PluginSyncOperation[];
  timeoutMs: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reject a path that escapes its destination root.
 *
 * The host is the trust boundary for inbound bytes, so a tar member that
 * resolves outside the intended root must never be extracted. `path.resolve`
 * collapses `..` segments, and the separator suffix stops `/tmp/rootkit` from
 * passing as a child of `/tmp/root`.
 */
export function isContainedWithin(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Validate every member of an archive before it is extracted onto the host.
 *
 * `tar -tf` lists members without writing anything, so this runs as a gate
 * ahead of extraction. Absolute members and `..` traversal are both rejected:
 * either one would let sandbox code place a file outside the destination root
 * and defeat the boundary.
 */
export async function assertArchiveMembersAreSafe(
  archivePath: string,
  destinationRoot: string,
): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tf", archivePath], {
    maxBuffer: 32 * 1024 * 1024,
  });

  for (const rawEntry of stdout.split("\n")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    if (path.isAbsolute(entry) || entry.startsWith("/")) {
      throw new Error(`Refusing to extract an absolute archive member: ${entry}`);
    }
    if (entry.split("/").includes("..")) {
      throw new Error(`Refusing to extract an archive member with a traversal segment: ${entry}`);
    }
    const target = path.resolve(destinationRoot, entry);
    if (!isContainedWithin(destinationRoot, target)) {
      throw new Error(`Refusing to extract an archive member outside the destination: ${entry}`);
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function countFilesAndBytes(target: string): Promise<{ files: number; bytes: number }> {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return { files: 0, bytes: 0 };
  if (stat.isFile()) return { files: 1, bytes: stat.size };

  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const entryStat = await fs.stat(entryPath).catch(() => null);
      if (!entryStat) continue;
      files += 1;
      bytes += entryStat.size;
    }
  };
  await walk(target);
  return { files, bytes };
}

function tarExcludeArgs(exclude: string[] | undefined): string[] {
  return (exclude ?? []).flatMap((pattern) => ["--exclude", pattern]);
}

/** Transfer one mapping from the host into the sprite. */
async function syncMappingIn(
  input: SyncInput,
  mapping: PluginSyncFileMapping,
): Promise<{ files: number; bytes: number }> {
  const { client, spriteName, timeoutMs } = input;

  if (!(await pathExists(mapping.sourcePath))) {
    return { files: 0, bytes: 0 };
  }

  const counts = await countFilesAndBytes(mapping.sourcePath);

  if (mapping.kind === "file") {
    const data = await fs.readFile(mapping.sourcePath);
    await client.writeFile(spriteName, mapping.targetPath, data, timeoutMs);
    if (mapping.mode !== undefined) {
      // The sandbox is the trust boundary for its own files, so applying the
      // mode after the write is acceptable here: the brief window exposes the
      // bytes only to code already running in this sprite.
      await client.exec(spriteName, {
        cmd: [
          "sh",
          "-c",
          `chmod ${mapping.mode.toString(8)} ${shellQuote(mapping.targetPath)}`,
        ],
        timeoutMs,
      });
    }
    return counts;
  }

  const hostStaging = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sprites-in-"));
  const archiveName = `${randomUUID()}.tar`;
  const hostArchive = path.join(hostStaging, archiveName);
  const remoteArchive = path.posix.join(REMOTE_STAGING_ROOT, archiveName);

  try {
    await execFileAsync("tar", [
      "-cf",
      hostArchive,
      ...tarExcludeArgs(mapping.exclude),
      "-C",
      mapping.sourcePath,
      ".",
    ]);

    const archive = await fs.readFile(hostArchive);
    await client.writeFile(spriteName, remoteArchive, archive, timeoutMs);

    const extract = await client.exec(spriteName, {
      cmd: [
        "sh",
        "-c",
        `mkdir -p ${shellQuote(mapping.targetPath)} && tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(mapping.targetPath)} && rm -f ${shellQuote(remoteArchive)}`,
      ],
      timeoutMs,
    });
    if (extract.exitCode !== 0) {
      throw new Error(
        `Failed to extract the workspace archive in ${spriteName}: ${extract.stderr}`,
      );
    }

    return counts;
  } finally {
    await fs.rm(hostStaging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Transfer one mapping from the sprite back to the host. */
async function syncMappingOut(
  input: SyncInput,
  mapping: PluginSyncFileMapping,
): Promise<{ files: number; bytes: number }> {
  const { client, spriteName, timeoutMs } = input;

  if (mapping.kind === "file") {
    const data = await client.readFile(spriteName, mapping.sourcePath, timeoutMs);
    await fs.mkdir(path.dirname(mapping.targetPath), { recursive: true });
    // Create with the requested mode so the bytes never sit world-readable on
    // the host, even briefly. A host file is outside the sandbox boundary.
    await fs.writeFile(mapping.targetPath, data, { mode: mapping.mode ?? 0o600 });
    if (mapping.mode !== undefined) {
      await fs.chmod(mapping.targetPath, mapping.mode).catch(() => undefined);
    }
    return { files: 1, bytes: data.byteLength };
  }

  const hostStaging = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sprites-out-"));
  const archiveName = `${randomUUID()}.tar`;
  const remoteArchive = path.posix.join(REMOTE_STAGING_ROOT, archiveName);
  const hostArchive = path.join(hostStaging, archiveName);

  try {
    const excludeArgs = (mapping.exclude ?? [])
      .map((pattern) => `--exclude ${shellQuote(pattern)}`)
      .join(" ");

    const archiveResult = await client.exec(spriteName, {
      cmd: [
        "sh",
        "-c",
        `mkdir -p ${shellQuote(REMOTE_STAGING_ROOT)} && tar -cf ${shellQuote(remoteArchive)} ${excludeArgs} -C ${shellQuote(mapping.sourcePath)} .`,
      ],
      timeoutMs,
    });
    if (archiveResult.exitCode !== 0) {
      throw new Error(
        `Failed to archive ${mapping.sourcePath} in ${spriteName}: ${archiveResult.stderr}`,
      );
    }

    const archive = await client.readFile(spriteName, remoteArchive, timeoutMs);
    await fs.writeFile(hostArchive, archive, { mode: 0o600 });

    await fs.mkdir(mapping.targetPath, { recursive: true });
    // Validate every member on the host BEFORE extraction. The archive was
    // produced inside the sandbox, so its contents are untrusted input.
    await assertArchiveMembersAreSafe(hostArchive, mapping.targetPath);

    await execFileAsync("tar", ["-xf", hostArchive, "-C", mapping.targetPath]);

    await client
      .exec(spriteName, {
        cmd: ["sh", "-c", `rm -f ${shellQuote(remoteArchive)}`],
        timeoutMs,
      })
      .catch(() => undefined);

    return await countFilesAndBytes(mapping.targetPath);
  } finally {
    await fs.rm(hostStaging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function syncIn(input: SyncInput): Promise<PluginEnvironmentSyncResult> {
  const operations: PluginEnvironmentSyncResult["operations"] = [];

  for (const operation of input.operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;

    for (const mapping of operation.files) {
      const counts = await syncMappingIn(input, mapping);
      filesTransferred += counts.files;
      bytesTransferred += counts.bytes;
    }

    // Post-upload commands run in array order and fail fast, so a failed step
    // stops the operation rather than leaving later steps to run against a
    // half-prepared workspace.
    //
    // `command` is an opaque, adapter-authored shell string. The contract says
    // to execute it verbatim, so it goes to `sh -c` without rewriting or
    // concatenation — splitting or re-quoting it here would change its meaning.
    for (const command of operation.postUploadCommands ?? []) {
      const result = await input.client.exec(input.spriteName, {
        cmd: ["sh", "-c", command.command],
        cwd: command.cwd,
        timeoutMs: command.timeoutMs ?? input.timeoutMs,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Post-upload command failed in ${input.spriteName}: ${result.stderr || result.stdout}`,
        );
      }
    }

    operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }

  return { operations };
}

export async function syncOut(input: SyncInput): Promise<PluginEnvironmentSyncResult> {
  const operations: PluginEnvironmentSyncResult["operations"] = [];

  for (const operation of input.operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;

    for (const mapping of operation.files) {
      const counts = await syncMappingOut(input, mapping);
      filesTransferred += counts.files;
      bytesTransferred += counts.bytes;
    }

    operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }

  return { operations };
}
