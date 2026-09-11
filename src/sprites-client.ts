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

export const DEFAULT_SPRITES_API_URL = "https://api.sprites.dev/v1";

/** Stream identifier bytes used by the non-TTY exec framing. */
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;
const STREAM_EXIT = 3;

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
   * Run one command through the HTTP exec endpoint.
   *
   * This is the one-shot, non-TTY path. It is the right transport for the
   * host's short control commands. A long-running agent turn must not rely on
   * the request staying open: the endpoint terminates the process group when
   * the request ends, so a durable turn detaches inside the sprite (see the
   * README on `setsid`).
   */
  async exec(name: string, options: SpriteExecOptions): Promise<SpriteExecResult> {
    const params = new URLSearchParams();
    for (const part of options.cmd) params.append("cmd", part);
    if (options.cwd) params.set("dir", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) {
      params.append("env", `${key}=${value}`);
    }
    if (options.stdin !== undefined) params.set("stdin", "true");

    let response: Response;
    try {
      response = await this.request(
        `/sprites/${encodeURIComponent(name)}/exec?${params.toString()}`,
        {
          method: "POST",
          body: options.stdin,
          timeoutMs: options.timeoutMs,
        },
      );
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
    const decoded = decodeExecFrames(raw);
    return { ...decoded, timedOut: false };
  }

  /** Write raw bytes to a path inside the sprite, creating parents. */
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
