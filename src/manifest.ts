import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.sprites-sandbox-provider";

// The bundled-plugin boot reconcile refreshes a persisted manifest for an
// existing install only when PLUGIN_VERSION changes. A manifest edit without a
// version bump never reaches an install that already exists.
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Fly.io Sprites Sandbox Provider",
  description:
    "Provisions Fly.io Sprites as Paperclip execution environments. Each sprite is a persistent, hardware-isolated Firecracker microVM that sleeps when idle and wakes on demand.",
  author: "cjndubisi",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "sprites",
      kind: "sandbox_provider",
      displayName: "Fly.io Sprite",
      description:
        "Provisions a Fly.io Sprite per environment lease. Sprites keep their filesystem across runs, pause when idle, and expose an authenticated HTTPS URL for preview traffic.",
      // Sprites persist their filesystem by design and cost nothing while
      // asleep, so a retained lease is the natural mode: the next run reuses a
      // warm box with its toolchain already installed. The host still requires
      // the three verified lifecycle methods before it grants reuse, and an
      // omitted flag would silently force an ephemeral lease.
      supportsReusableLeases: true,
      configSchema: {
        type: "object",
        properties: {
          apiToken: {
            type: "string",
            format: "secret-ref",
            description:
              "Sprites API token. Paste a token or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to SPRITES_TOKEN if omitted.",
          },
          apiUrl: {
            type: "string",
            description:
              "Optional Sprites API base URL. Defaults to https://api.sprites.dev/v1.",
          },
          spriteNamePrefix: {
            type: "string",
            description:
              "Prefix for generated sprite names. Sprite names are unique per organization, so a prefix keeps Paperclip-managed sprites identifiable. Defaults to 'paperclip'.",
          },
          workspaceRoot: {
            type: "string",
            description:
              "Absolute directory inside the sprite that holds the run workspace. Defaults to /home/sprite/paperclip-workspace.",
          },
          setupCommand: {
            type: "string",
            description:
              "Optional shell command run once after a sprite is created, before the first run. Use it to install agent CLIs that the base image lacks (for example: npm install -g @earendil-works/pi-coding-agent pi-acp).",
          },
          urlAuth: {
            type: "string",
            enum: ["sprite", "public"],
            description:
              "URL authentication for the sprite's HTTPS endpoint. 'sprite' (default) requires Fly.io org authentication. 'public' serves the URL to anyone who has it — use only for preview links you intend to share.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Default timeout in milliseconds for provider API calls. Defaults to 120000.",
          },
          destroyOnRelease: {
            type: "boolean",
            description:
              "Destroy the sprite when its lease is released instead of letting it sleep. Off by default: a sleeping sprite costs nothing for compute and keeps its installed toolchain warm for the next run.",
          },
        },
        additionalProperties: false,
      },
    },
  ],
};

export default manifest;
export { PLUGIN_ID, PLUGIN_VERSION };
