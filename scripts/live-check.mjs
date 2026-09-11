/**
 * Live integration check against the real Sprites API.
 *
 * This is deliberately a script rather than a unit test: it creates and
 * destroys a real sprite, so it must never run in an unattended test suite.
 *
 *   node scripts/live-check.mjs
 *
 * The token is resolved without ever being typed on a command line (which
 * would leave it in shell history and in the process table). In order:
 *
 *   1. $SPRITES_TOKEN, if already exported.
 *   2. `pass show $SPRITES_TOKEN_PASS_PATH` (default
 *      cjndubisi/sprites/api-token), so the credential stays encrypted at rest
 *      in the password store.
 *
 * It exercises the provider's actual handlers end to end: acquire a lease,
 * realize a workspace, sync files in, execute a command, sync files back, then
 * destroy the lease.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sealed from "../dist/plugin.js";

// `definePlugin` returns a sealed object; the host calls handlers through
// `.definition`. The live check drives the same surface the host does.
const plugin = sealed.definition;

/**
 * Resolve the API token from the environment, falling back to the `pass`
 * password store.
 *
 * Reading from `pass` keeps the credential encrypted at rest and out of shell
 * history. `execFileSync` passes the path as an argv element rather than
 * through a shell, so a path containing shell metacharacters cannot be
 * interpreted as a command.
 */
function resolveToken() {
  const fromEnv = process.env.SPRITES_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const passPath = process.env.SPRITES_TOKEN_PASS_PATH?.trim() || "cjndubisi/sprites/api-token";
  try {
    const value = execFileSync("pass", ["show", passPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return value.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

const token = resolveToken();
if (!token) {
  console.error(
    [
      "No Sprites API token found.",
      "",
      "Store one in pass (preferred — stays encrypted at rest):",
      "  sprite login          # prints a token on first authentication",
      "  pass insert -m cjndubisi/sprites/api-token",
      "",
      "Or export it for this shell:",
      "  export SPRITES_TOKEN=\"org-slug/org-id/token-id/token-value\"",
    ].join("\n"),
  );
  process.exit(1);
}

const config = {
  apiToken: token,
  spriteNamePrefix: "pc-live",
  // Keep the check cheap: destroy the box as soon as the lease releases.
  destroyOnRelease: true,
};

const base = {
  driverKey: "sprites",
  companyId: "live-check-company",
  environmentId: "live-check-env",
  config,
};

let lease;
const started = Date.now();
const step = (message) =>
  console.log(`[${String(Date.now() - started).padStart(6)}ms] ${message}`);

try {
  step("probe");
  const probe = await plugin.onEnvironmentProbe({ ...base });
  if (!probe.ok) throw new Error(`Probe failed: ${probe.summary}`);
  step(`probe ok — ${probe.summary}`);

  step("acquire lease (creates a sprite)");
  lease = await plugin.onEnvironmentAcquireLease({
    ...base,
    runId: "live-check-run",
  });
  step(`lease acquired — sprite ${lease.providerLeaseId}`);

  step("realize workspace");
  const realized = await plugin.onEnvironmentRealizeWorkspace({
    ...base,
    lease,
    workspace: {},
  });
  step(`workspace at ${realized.cwd}`);

  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "sprites-live-"));
  await fs.writeFile(path.join(hostDir, "hello.txt"), "sent-from-host\n");

  step("sync in");
  const inResult = await plugin.onEnvironmentSyncIn({
    ...base,
    lease,
    operations: [
      {
        operationId: "op-in",
        files: [
          {
            sourcePath: hostDir,
            targetPath: realized.cwd,
            kind: "directory",
          },
        ],
      },
    ],
  });
  step(`sync in — ${JSON.stringify(inResult.operations)}`);

  step("execute: read the synced file back");
  const exec = await plugin.onEnvironmentExecute({
    ...base,
    lease,
    command: "cat",
    args: ["hello.txt"],
    cwd: realized.cwd,
  });
  if (exec.exitCode !== 0 || exec.stdout.trim() !== "sent-from-host") {
    throw new Error(
      `Unexpected exec result: exit=${exec.exitCode} stdout=${JSON.stringify(exec.stdout)} stderr=${JSON.stringify(exec.stderr)}`,
    );
  }
  step(`exec ok — stdout ${JSON.stringify(exec.stdout.trim())}, exit ${exec.exitCode}`);

  step("execute: confirm a non-zero exit code is reported");
  const failing = await plugin.onEnvironmentExecute({
    ...base,
    lease,
    command: "sh",
    args: ["-c", "echo to-stderr >&2; exit 3"],
    cwd: realized.cwd,
  });
  if (failing.exitCode !== 3) {
    throw new Error(`Expected exit code 3, received ${failing.exitCode}`);
  }
  step(`exit code propagated — ${failing.exitCode}, stderr ${JSON.stringify(failing.stderr.trim())}`);

  step("execute: write a file for the outbound sync");
  await plugin.onEnvironmentExecute({
    ...base,
    lease,
    command: "sh",
    args: ["-c", "echo made-in-sprite > produced.txt"],
    cwd: realized.cwd,
  });

  const outDir = path.join(hostDir, "returned");
  step("sync out");
  const outResult = await plugin.onEnvironmentSyncOut({
    ...base,
    lease,
    operations: [
      {
        operationId: "op-out",
        files: [
          {
            sourcePath: realized.cwd,
            targetPath: outDir,
            kind: "directory",
          },
        ],
      },
    ],
  });
  const returned = await fs.readFile(path.join(outDir, "produced.txt"), "utf8");
  if (returned.trim() !== "made-in-sprite") {
    throw new Error(`Unexpected returned content: ${JSON.stringify(returned)}`);
  }
  step(`sync out — ${JSON.stringify(outResult.operations)}, content ${JSON.stringify(returned.trim())}`);

  step("resume lease");
  const resumed = await plugin.onEnvironmentResumeLease({
    ...base,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
  });
  step(`resumed — sprite ${resumed.providerLeaseId}`);

  await fs.rm(hostDir, { recursive: true, force: true });
  console.log("\nLIVE CHECK PASSED");
} catch (error) {
  console.error("\nLIVE CHECK FAILED:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  if (lease?.providerLeaseId) {
    step("destroy lease");
    await plugin
      .onEnvironmentDestroyLease({
        ...base,
        providerLeaseId: lease.providerLeaseId,
      })
      .then(() => step("sprite destroyed"))
      .catch((error) => console.error("Cleanup failed:", error?.message ?? error));
  }
}
