import path from "node:path";
import { randomUUID } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

import manifest from "./manifest.js";
import { buildSpriteName, parseDriverConfig, type SpritesDriverConfig } from "./config.js";
import { SpritesClient, SpritesApiError } from "./sprites-client.js";
import { syncIn, syncOut } from "./file-sync.js";

/**
 * Lease metadata this provider persists on the host.
 *
 * The host stores whatever the acquire handler returns and gives it back on
 * every later call, so this is the provider's only durable state. Keeping the
 * sprite name here means a worker restart never loses track of a live box.
 */
interface SpriteLeaseMetadata extends Record<string, unknown> {
  spriteName: string;
  remoteCwd: string;
  /** Whether the one-time setup command already ran for this sprite. */
  setupComplete?: boolean;
}

function readLeaseMetadata(lease: PluginEnvironmentLease): SpriteLeaseMetadata | null {
  const metadata = lease.metadata as SpriteLeaseMetadata | undefined;
  if (!metadata || typeof metadata.spriteName !== "string") return null;
  return metadata;
}

function requireClient(config: SpritesDriverConfig): SpritesClient {
  if (!config.apiToken) {
    throw new Error(
      "No Sprites API token configured. Set the environment's apiToken or the SPRITES_TOKEN variable.",
    );
  }
  return new SpritesClient({
    token: config.apiToken,
    apiUrl: config.apiUrl,
    timeoutMs: config.timeoutMs,
  });
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof SpritesApiError) {
    return `${error.message}${error.body ? `: ${error.body.slice(0, 400)}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Quote a value for safe interpolation into a `sh -c` script.
 *
 * Command assembly below builds shell scripts, so every caller-supplied value
 * must be quoted. Single-quoting with an escaped-quote sequence is the only
 * form that is safe for arbitrary bytes in POSIX sh.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the configured one-time setup command.
 *
 * A fresh sprite carries the base image's tools (node, git, tar, and the
 * preinstalled Claude/Codex/Gemini CLIs). An operator whose agent needs another
 * CLI supplies `setupCommand`. Per the sandbox runtime contract a failed
 * install is not fatal here: the launch-time probe is what fails loudly for a
 * missing CLI, and failing the whole lease would hide that clearer error.
 */
async function runSetupCommand(
  client: SpritesClient,
  spriteName: string,
  config: SpritesDriverConfig,
): Promise<void> {
  if (!config.setupCommand) return;
  try {
    const result = await client.exec(spriteName, {
      cmd: ["sh", "-c", config.setupCommand],
      timeoutMs: config.timeoutMs,
    });
    if (result.exitCode !== 0) {
      console.warn(
        `Sprites setup command exited ${result.exitCode} on ${spriteName}: ${result.stderr.slice(0, 400)}`,
      );
    }
  } catch (error) {
    console.warn(`Sprites setup command failed on ${spriteName}: ${formatErrorMessage(error)}`);
  }
}

const plugin = definePlugin({
  /**
   * The worker holds no cross-run state: every handler resolves its client from
   * the config the host passes in, and the sprite name lives in lease metadata
   * on the host. So setup has nothing to wire up, and a worker restart loses
   * nothing.
   */
  async setup(): Promise<void> {},

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.apiToken) {
      errors.push(
        "A Sprites API token is required. Set apiToken on the environment or SPRITES_TOKEN in the Paperclip host environment.",
      );
    }
    if (!path.posix.isAbsolute(config.workspaceRoot)) {
      errors.push("workspaceRoot must be an absolute POSIX path inside the sprite.");
    }
    if (config.urlAuth === "public") {
      warnings.push(
        "urlAuth is 'public': the sprite's HTTPS URL will be reachable by anyone who has it. Use it only for preview links you intend to share.",
      );
    }
    if (config.destroyOnRelease) {
      warnings.push(
        "destroyOnRelease is on: each released lease deletes its sprite, so every run reprovisions from a bare image and loses any installed toolchain.",
      );
    }

    return {
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },

  /**
   * Confirm the provider can reach the Sprites API with the configured token.
   * A probe must not create a sprite, so it lists instead.
   */
  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    if (!config.apiToken) {
      return {
        ok: false,
        summary: "No Sprites API token configured.",
        diagnostics: [
          {
            severity: "error",
            message:
              "Set apiToken on the environment, or SPRITES_TOKEN in the Paperclip host environment.",
            code: "sprites.missing_token",
          },
        ],
      };
    }

    try {
      const client = requireClient(config);
      // `getSprite` on a name that will not exist is the cheapest authenticated
      // call: 404 proves the credential works without touching real resources.
      await client.getSprite(`${config.spriteNamePrefix}-probe-${randomUUID().slice(0, 8)}`);
      return { ok: true, summary: `Reached the Sprites API at ${config.apiUrl}.` };
    } catch (error) {
      const message = formatErrorMessage(error);
      return {
        ok: false,
        summary: `Could not reach the Sprites API: ${message}`,
        diagnostics: [{ severity: "error", message, code: "sprites.api_unreachable" }],
      };
    }
  },

  /**
   * Create the sprite that backs this lease.
   *
   * A sprite comes up in one to two seconds, so acquisition provisions
   * unconditionally rather than maintaining a warm pool. Checkpoints cannot
   * seed a different sprite, so there is no golden-image path to take here.
   */
  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = requireClient(config);

    const spriteName = buildSpriteName({
      prefix: config.spriteNamePrefix,
      environmentId: params.environmentId,
      uniqueSuffix: randomUUID().replace(/-/g, ""),
    });

    await client.createSprite({
      name: spriteName,
      // Wait for capacity so the lease is usable the moment it is returned. A
      // sprite handed back before it has compute would fail the host's first
      // command with a confusing error.
      waitForCapacity: true,
      urlAuth: config.urlAuth ?? undefined,
      timeoutMs: config.timeoutMs,
    });

    const remoteCwd = params.requestedCwd?.trim() || config.workspaceRoot;
    await client.exec(spriteName, {
      cmd: ["sh", "-c", `mkdir -p ${shellQuote(remoteCwd)}`],
      timeoutMs: config.timeoutMs,
    });

    await runSetupCommand(client, spriteName, config);

    const metadata: SpriteLeaseMetadata = {
      spriteName,
      remoteCwd,
      setupComplete: true,
    };

    return {
      providerLeaseId: spriteName,
      metadata,
      // A sprite has no provider-side expiry: it sleeps when idle and costs
      // nothing while asleep. Returning no expiry tells the host to keep the
      // lease under its own policy rather than a provider deadline.
      expiresAt: null,
    };
  },

  /**
   * Resume a retained lease.
   *
   * A sprite wakes on its next request, so resuming is a liveness check rather
   * than a start command. If the box is gone the provider must say so, since
   * silently continuing would run the turn against a sprite that no longer
   * exists.
   */
  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = requireClient(config);
    const spriteName = params.providerLeaseId;

    const sprite = await client.getSprite(spriteName, config.timeoutMs);
    if (!sprite) {
      throw new Error(
        `Sprite ${spriteName} no longer exists, so its lease cannot be resumed.`,
      );
    }

    const previous = (params.leaseMetadata ?? {}) as Partial<SpriteLeaseMetadata>;
    const metadata: SpriteLeaseMetadata = {
      spriteName,
      remoteCwd: previous.remoteCwd ?? config.workspaceRoot,
      setupComplete: previous.setupComplete === true,
    };

    return { providerLeaseId: spriteName, metadata, expiresAt: null };
  },

  /**
   * Release the lease.
   *
   * The default is deliberately to do nothing: a sprite pauses on its own when
   * idle, compute billing stops, and the filesystem persists. That makes the
   * next run start warm with its toolchain intact. An operator who wants a
   * clean box each time sets `destroyOnRelease`.
   */
  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    if (!config.destroyOnRelease) return;

    try {
      const client = requireClient(config);
      await client.deleteSprite(params.providerLeaseId, config.timeoutMs);
    } catch (error) {
      console.warn(
        `Failed to destroy sprite ${params.providerLeaseId} on release: ${formatErrorMessage(error)}`,
      );
    }
  },

  /** Destroy the sprite. This is the unconditional teardown path. */
  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = requireClient(config);
    await client.deleteSprite(params.providerLeaseId, config.timeoutMs);
  },

  /** Ensure the workspace directory exists and report the realized cwd. */
  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const metadata = readLeaseMetadata(params.lease);
    if (!metadata) {
      throw new Error("Cannot realize a workspace without an acquired sprite lease.");
    }

    const client = requireClient(config);
    const remoteCwd = params.workspace.remotePath?.trim() || metadata.remoteCwd;

    const result = await client.exec(metadata.spriteName, {
      cmd: ["sh", "-c", `mkdir -p ${shellQuote(remoteCwd)}`],
      timeoutMs: config.timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create the workspace directory ${remoteCwd} in ${metadata.spriteName}: ${result.stderr}`,
      );
    }

    return { cwd: remoteCwd, metadata: { spriteName: metadata.spriteName } };
  },

  /**
   * Run one host-issued command in the sprite.
   *
   * Every command runs one-shot over the HTTP exec endpoint. That endpoint ends
   * the process group when the request completes, which is correct for the
   * host's short control commands. A durable agent turn must detach itself
   * inside the sprite; see the README.
   */
  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const metadata = readLeaseMetadata(params.lease);
    if (!metadata) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No sprite lease is available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const client = requireClient(config);

    // The host sends either a bare command with args, or a shell script as the
    // command. Passing the pieces through as separate `cmd` values preserves
    // argument boundaries; the API joins them into an argv, not a shell string.
    const cmd = [params.command, ...(params.args ?? [])];

    const result = await client.exec(metadata.spriteName, {
      cmd,
      cwd: params.cwd?.trim() || metadata.remoteCwd,
      env: params.env,
      stdin: params.stdin,
      timeoutMs: params.timeoutMs ?? config.timeoutMs,
    });

    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      metadata: { spriteName: metadata.spriteName },
    };
  },

  /** Transfer files from the host into the sprite. */
  async onEnvironmentSyncIn(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const config = parseDriverConfig(params.config);
    const metadata = readLeaseMetadata(params.lease);
    if (!metadata) {
      throw new Error("Cannot sync into a sprite without an acquired lease.");
    }
    return await syncIn({
      client: requireClient(config),
      spriteName: metadata.spriteName,
      operations: params.operations,
      timeoutMs: config.timeoutMs,
    });
  },

  /** Transfer files from the sprite back to the host. */
  async onEnvironmentSyncOut(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const config = parseDriverConfig(params.config);
    const metadata = readLeaseMetadata(params.lease);
    if (!metadata) {
      throw new Error("Cannot sync out of a sprite without an acquired lease.");
    }
    return await syncOut({
      client: requireClient(config),
      spriteName: metadata.spriteName,
      operations: params.operations,
      timeoutMs: config.timeoutMs,
    });
  },
});

export default plugin;
