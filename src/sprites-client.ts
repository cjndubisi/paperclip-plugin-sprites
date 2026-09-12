/**
 * A minimal Fly.io Sprites REST client.
 *
 * Only the surface this plugin needs: sprite lifecycle, command execution, and
 * the filesystem endpoints that back workspace synchronization. Every call is
 * plain `fetch`, so the plugin has no runtime dependency beyond the Paperclip
 * plugin SDK.
 *
 * Base URL and auth are per the Sprites API: `https://api.sprites.dev/v1` with
 * `Authorization: Bearer <token>`.
 */

import { randomUUID } from "node:crypto";

export const DEFAULT_SPRITES_API_URL = "https://api.sprites.dev/v1";

/** Stream identifier bytes used by the non-TTY exec framing. */
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;
const STREAM_EXIT = 3;

/**
 * Conservative ceiling on the length of an exec request URL.
 *
 * The exec endpoint carries argv, env, and cwd as QUERY PARAMETERS, so command
 * size is URL size. Proxies in front of the API reject an over-long request
 * line with HTTP 414 before it ever reaches the sprite. Any command built from
 * user- or model-supplied text (an agent prompt, a patch, a commit message)
 * blows past that limit routinely, so the client must not assume argv is small.
 *
 * 4000 is deliberately below the usual 8 KiB request-line limit: the exact
 * ceiling is a property of whatever proxy is deployed, not of this client, so
 * the margin buys safety. It is only a hint — a 414 is still caught and retried
 * through the spill path, so an unexpectedly tighter limit self-heals.
 */
const EXEC_URL_MAX_CHARS = 4000;

/** Scratch directory inside the sprite for spilled command scripts. */
const REMOTE_EXEC_STAGING_ROOT = "/tmp/paperclip-exec";

/**
 * Quote a value for safe interpolation into a POSIX shell word.
 *
 * Wrapping in single quotes disables every expansion; the only character that
 * needs care is the single quote itself, which is closed, escaped, and
 * reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment names are interpolated into a shell script unquoted (only the
 * VALUE can be quoted), so a name must be a plain identifier. Rejecting
 * anything else keeps a crafted name from becoming shell syntax.
 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render a command as a shell script, so argv travels in a request BODY
 * instead of the URL.
 *
 * `exec` replaces the shell process, which keeps the exit code and signal
 * disposition of the real command rather than the wrapper's.
 */
export function buildExecScript(options: SpriteExecOptions): string {
  const lines: string[] = [];

  if (options.cwd) {
    // 127 mirrors the shell's "cannot execute" convention, so a bad cwd is not
    // mistaken for the command's own failure.
    lines.push(`cd ${shellQuote(options.cwd)} || exit 127`);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error(`Refusing to export an invalid environment variable name: ${key}`);
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  lines.push(`exec ${options.cmd.map(shellQuote).join(" ")}`);
  return `${lines.join("\n")}\n`;
}

export interface SpritesClientOptions {
  token: string;
  apiUrl?: string;
  /** Default per-request timeout. Individual calls may override it. */
  timeoutMs?: number;
}

export interface SpriteSummary {
  name: string;
  status?: string;
  url?: string;
  organization?: string;
}

export interface SpriteExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpriteExecOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export class SpritesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "SpritesApiError";
  }
}

/**
 * Decode the non-TTY exec response framing.
 *
 * The HTTP POST exec endpoint returns a byte stream where each chunk is
 * prefixed with a single stream-identifier byte: 1 = stdout, 2 = stderr,
 * 3 = exit (payload is the exit code). Treating the response as plain text
 * corrupts output with stray control bytes and loses the exit code, so the
 * framing MUST be decoded rather than read as a string.
 *
 * The framing carries no length prefix, so a chunk runs until the next frame
 * byte. We scan bytewise and treat a frame byte as a boundary only when it sits
 * at a chunk start, which is how the stream is produced.
 */
export function decodeExecFrames(raw: Uint8Array): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const decoder = new TextDecoder();
  const stdout: number[] = [];
  const stderr: number[] = [];
  let exitCode: number | null = null;

  let index = 0;
  let current: number | null = null;

  while (index < raw.length) {
    const byte = raw[index]!;
    if (byte === STREAM_STDOUT || byte === STREAM_STDERR || byte === STREAM_EXIT) {
      current = byte;
      index += 1;
      if (byte === STREAM_EXIT && index < raw.length) {
        exitCode = raw[index]!;
        index += 1;
        current = null;
      }
      continue;
    }
    if (current === STREAM_STDERR) stderr.push(byte);
    else stdout.push(byte);
    index += 1;
  }

  return {
    stdout: decoder.decode(new Uint8Array(stdout)),
    stderr: decoder.decode(new Uint8Array(stderr)),
    exitCode,
  };
}

export class SpritesClient {
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: SpritesClientOptions) {
    const token = options.token?.trim();
    if (!token) {
      throw new Error("A Sprites API token is required.");
    }
    this.token = token;
    this.apiUrl = (options.apiUrl?.trim() || DEFAULT_SPRITES_API_URL).replace(/\/+$/, "");
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
  }

  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.defaultTimeoutMs);
    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        ...rest,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(rest.headers ?? {}),
        },
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestOk(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const response = await this.request(path, init);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SpritesApiError(
        `Sprites API ${init.method ?? "GET"} ${path} failed with ${response.status}`,
        response.status,
        body,
      );
    }
    return response;
  }

  /** Create a sprite. Returns the created name. */
  async createSprite(input: {
    name: string;
    waitForCapacity?: boolean;
    urlAuth?: "sprite" | "public";
    timeoutMs?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.waitForCapacity !== undefined) body.wait_for_capacity = input.waitForCapacity;
    if (input.urlAuth) body.url_settings = { auth: input.urlAuth };

    await this.requestOk("/sprites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: input.timeoutMs,
    });
  }

  /** Fetch a sprite. Returns null when it does not exist. */
  async getSprite(name: string, timeoutMs?: number): Promise<SpriteSummary | null> {
    const response = await this.request(`/sprites/${encodeURIComponent(name)}`, { timeoutMs });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SpritesApiError(
        `Sprites API GET /sprites/${name} failed with ${response.status}`,
        response.status,
        body,
      );
    }
    return (await response.json()) as SpriteSummary;
  }

  /** Delete a sprite and every resource attached to it. Idempotent on 404. */
  async deleteSprite(name: string, timeoutMs?: number): Promise<void> {
    const response = await this.request(`/sprites/${encodeURIComponent(name)}`, {
      method: "DELETE",
      timeoutMs,
    });
    if (response.status === 404 || response.ok) return;
    const body = await response.text().catch(() => "");
    throw new SpritesApiError(
      `Sprites API DELETE /sprites/${name} failed with ${response.status}`,
      response.status,
      body,
    );
  }

  /** Update a sprite's URL authentication mode. */
  async updateUrlAuth(name: string, auth: "sprite" | "public", timeoutMs?: number): Promise<void> {
    await this.requestOk(`/sprites/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url_settings: { auth } }),
      timeoutMs,
    });
  }

  /**
   * Build the exec request URL for a command whose argv rides in the query
   * string. Exposed for tests, which assert the 414 threshold directly.
   */
  buildExecUrl(name: string, options: SpriteExecOptions): string {
    const params = new URLSearchParams();
    for (const part of options.cmd) params.append("cmd", part);
    if (options.cwd) params.set("dir", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) {
      params.append("env", `${key}=${value}`);
    }
    if (options.stdin !== undefined) params.set("stdin", "true");
    return `/sprites/${encodeURIComponent(name)}/exec?${params.toString()}`;
  }

  /**
   * Run one command through the HTTP exec endpoint.
   *
   * This is the one-shot, non-TTY path. It is the right transport for the
   * host's short control commands. A long-running agent turn must not rely on
   * the request staying open: the endpoint terminates the process group when
   * the request ends, so a durable turn detaches inside the sprite (see the
   * README on `setsid`).
   *
   * Argv travels in the QUERY STRING, so a large command exceeds the request
   * line limit and is rejected with HTTP 414 before reaching the sprite. When
   * the URL would be too long, the command is written into the sprite as a
   * script (a request BODY, which has no such limit) and the URL shrinks to a
   * fixed-size `sh <path>`. A 414 from the direct path is also retried this
   * way, so a proxy stricter than our estimate still succeeds.
   */
  async exec(name: string, options: SpriteExecOptions): Promise<SpriteExecResult> {
    const directUrl = this.buildExecUrl(name, options);

    if (directUrl.length > EXEC_URL_MAX_CHARS) {
      return await this.execViaScript(name, options);
    }

    let response: Response;
    try {
      response = await this.request(directUrl, {
        method: "POST",
        body: options.stdin,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        return { exitCode: null, stdout: "", stderr: "Command timed out.", timedOut: true };
      }
      throw error;
    }

    // A proxy may impose a tighter limit than our estimate. The command is
    // valid, only the transport was wrong, so retry it through the body path
    // rather than surfacing a 414 to the agent.
    if (response.status === 414) {
      return await this.execViaScript(name, options);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SpritesApiError(
        `Sprites API POST /sprites/${name}/exec failed with ${response.status}`,
        response.status,
        body,
      );
    }

    const raw = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeExecFrames(raw);
    return { ...decoded, timedOut: false };
  }

  /**
   * Run a command too large for the query string.
   *
   * The command becomes a script written through the filesystem endpoint (a
   * request body, so no length limit applies), and the exec URL degrades to a
   * constant-size `sh <path>` regardless of how big the command was. This is
   * what makes a full agent prompt executable.
   *
   * Secrets stay out of the URL on this path as a side effect: env values are
   * written into a file that only the sprite can read, rather than into a query
   * string that proxies and access logs capture.
   */
  private async execViaScript(
    name: string,
    options: SpriteExecOptions,
  ): Promise<SpriteExecResult> {
    const script = buildExecScript(options);
    const remoteScript = `${REMOTE_EXEC_STAGING_ROOT}/${randomUUID()}.sh`;

    await this.writeFile(name, remoteScript, script, options.timeoutMs);

    try {
      // A wrapper shell runs the script in a CHILD shell, then deletes it and
      // re-raises the child's status. The script ends in `exec`, which replaces
      // its own shell — so cleanup cannot live inside the script or in a trap
      // around it, and must sit in a parent that survives the replacement.
      const quoted = shellQuote(remoteScript);
      return await this.execDirect(name, {
        cmd: ["sh", "-c", `sh ${quoted}; rc=$?; rm -f ${quoted}; exit $rc`],
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      await this.exec(name, {
        cmd: ["rm", "-f", remoteScript],
        timeoutMs: 15_000,
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Issue one exec request with argv in the query string, with no size
   * fallback. Used by the spill path, whose own URL is already small — routing
   * it back through `exec` would risk infinite recursion.
   */
  private async execDirect(
    name: string,
    options: SpriteExecOptions,
  ): Promise<SpriteExecResult> {
    let response: Response;
    try {
      response = await this.request(this.buildExecUrl(name, options), {
        method: "POST",
        body: options.stdin,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        return { exitCode: null, stdout: "", stderr: "Command timed out.", timedOut: true };
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SpritesApiError(
        `Sprites API POST /sprites/${name}/exec failed with ${response.status}`,
        response.status,
        body,
      );
    }

    const raw = new Uint8Array(await response.arrayBuffer());
    return { ...decodeExecFrames(raw), timedOut: false };
  }

  /** Write raw bytes to a path inside the sprite. */
  async writeFile(
    name: string,
    remotePath: string,
    data: Uint8Array | string,
    timeoutMs?: number,
  ): Promise<void> {
    const params = new URLSearchParams({ path: remotePath, mkdir: "true" });
    await this.requestOk(`/sprites/${encodeURIComponent(name)}/fs/write?${params.toString()}`, {
      method: "PUT",
      body: data as BodyInit,
      timeoutMs,
    });
  }

  /** Read raw bytes from a path inside the sprite. */
  async readFile(name: string, remotePath: string, timeoutMs?: number): Promise<Uint8Array> {
    const params = new URLSearchParams({ path: remotePath });
    const response = await this.requestOk(
      `/sprites/${encodeURIComponent(name)}/fs/read?${params.toString()}`,
      { timeoutMs },
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Create a checkpoint. The endpoint streams NDJSON progress; we drain it. */
  async createCheckpoint(name: string, comment?: string, timeoutMs?: number): Promise<void> {
    await this.requestOk(`/sprites/${encodeURIComponent(name)}/checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(comment ? { comment } : {}),
      timeoutMs,
    });
  }
}
