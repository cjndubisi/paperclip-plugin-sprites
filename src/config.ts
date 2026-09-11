/**
 * Driver configuration parsing.
 *
 * The host hands the worker an unvalidated `Record<string, unknown>` that came
 * from the environment's saved config. This module is the single place that
 * turns it into a typed, defaulted shape, so no handler reads a raw config key.
 */

import { DEFAULT_SPRITES_API_URL } from "./sprites-client.js";

export const DEFAULT_WORKSPACE_ROOT = "/home/sprite/paperclip-workspace";
export const DEFAULT_SPRITE_NAME_PREFIX = "paperclip";
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface SpritesDriverConfig {
  apiToken: string | null;
  apiUrl: string;
  spriteNamePrefix: string;
  workspaceRoot: string;
  setupCommand: string | null;
  urlAuth: "sprite" | "public" | null;
  timeoutMs: number;
  destroyOnRelease: boolean;
}

function readString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(config: Record<string, unknown>, key: string): boolean {
  return config[key] === true;
}

function readPositiveInteger(config: Record<string, unknown>, key: string): number | null {
  const value = config[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

/**
 * Resolve the API token.
 *
 * Config wins so one instance can drive several organizations. The
 * `SPRITES_TOKEN` environment variable is the fallback, which matches the
 * Sprites CLI and keeps a single-tenant deployment free of per-environment
 * secrets.
 */
function resolveToken(config: Record<string, unknown>): string | null {
  return readString(config, "apiToken") ?? (process.env.SPRITES_TOKEN?.trim() || null);
}

export function parseDriverConfig(config: Record<string, unknown>): SpritesDriverConfig {
  const urlAuthRaw = readString(config, "urlAuth");
  const urlAuth = urlAuthRaw === "public" || urlAuthRaw === "sprite" ? urlAuthRaw : null;

  return {
    apiToken: resolveToken(config),
    apiUrl: readString(config, "apiUrl") ?? DEFAULT_SPRITES_API_URL,
    spriteNamePrefix: readString(config, "spriteNamePrefix") ?? DEFAULT_SPRITE_NAME_PREFIX,
    workspaceRoot: readString(config, "workspaceRoot") ?? DEFAULT_WORKSPACE_ROOT,
    setupCommand: readString(config, "setupCommand"),
    urlAuth,
    timeoutMs: readPositiveInteger(config, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    destroyOnRelease: readBoolean(config, "destroyOnRelease"),
  };
}

/**
 * Build the sprite name for a lease.
 *
 * Sprite names are unique per organization and are part of the public URL, so
 * the name must be DNS-safe and stable for the lifetime of the lease. We derive
 * it from the environment id plus a short random suffix: the environment id ties
 * the box to its Paperclip environment for operators reading `sprite ls`, and
 * the suffix keeps two concurrent leases on one environment from colliding.
 */
export function buildSpriteName(input: {
  prefix: string;
  environmentId: string;
  uniqueSuffix: string;
}): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const prefix = normalize(input.prefix) || DEFAULT_SPRITE_NAME_PREFIX;
  // Keep only the leading segment of the environment id. A UUID's first group
  // is distinctive enough for a human scanning a sprite list, and the full id
  // would push the name past a comfortable hostname length.
  const environment = normalize(input.environmentId).slice(0, 8);
  const suffix = normalize(input.uniqueSuffix).slice(0, 6);

  return [prefix, environment, suffix].filter(Boolean).join("-").slice(0, 48);
}
