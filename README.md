# Paperclip Sandbox Provider — Fly.io Sprites

A [Paperclip](https://paperclip.inc) sandbox provider plugin that runs agent
work on [Fly.io Sprites](https://sprites.dev): persistent, hardware-isolated
Firecracker microVMs that sleep when idle and wake on demand.

Each environment lease is one sprite. The sprite keeps its filesystem between
runs, so an agent's toolchain, caches, and workspace survive; while it sleeps,
compute billing stops.

## Why

Running agents on the machine that also runs your control plane means build
caches, `node_modules`, and dev servers pile up on a box you care about, and one
agent's bad install becomes another's outage. A sprite gives each agent its own
computer with a blast radius of exactly one.

Because the control plane drives everything over the Sprites API, the human can
be anywhere — a phone browser is enough to assign work and read results.

## Status

Verified end to end against the live Sprites API: probe, lease acquisition,
workspace realization, file sync in and out, command execution with exit-code
propagation, lease resume, and teardown. See "Live check" below for how to
reproduce.

It does **not** yet implement the optional capabilities Daytona ships
(`incrementalSessionOutput`, `duplexCommandStream`, interactive setup, template
capture). The host treats an omitted capability as off, so the provider works
without them — output arrives batched per command rather than streamed.

## Install

```bash
npm install
npm run build
```

Then install the built plugin into Paperclip through the Plugin Manager, and add
an environment under Settings → Instance settings → Environments with
`driver: "sandbox"` and `provider: "sprites"`.

## Configuration

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiToken` | yes | `SPRITES_TOKEN` | Sprites API token. Store it as a Paperclip secret reference rather than pasting it into a shared config. |
| `apiUrl` | no | `https://api.sprites.dev/v1` | Override for a non-default endpoint. |
| `spriteNamePrefix` | no | `paperclip` | Prefix for generated sprite names, so Paperclip-managed boxes are identifiable in `sprite ls`. |
| `workspaceRoot` | no | `/home/sprite/paperclip-workspace` | Absolute path inside the sprite. |
| `setupCommand` | no | — | Shell command run once after creation. Use it to install agent CLIs the base image lacks. |
| `urlAuth` | no | `sprite` | `sprite` requires Fly.io org auth. `public` serves the URL to anyone who has it. |
| `timeoutMs` | no | `120000` | Default provider API call timeout. |
| `destroyOnRelease` | no | `false` | Destroy the sprite on release instead of letting it sleep. |

The base image ships `node`, `git`, `tar`, `tmux`, `bun`, and the `claude`,
`codex`, and `gemini` CLIs. For an agent that needs something else, set
`setupCommand`. For example, to add pi:

```
npm install -g @earendil-works/pi-coding-agent pi-acp && \
  ln -sf $(npm prefix -g)/bin/pi $HOME/.local/bin/pi && \
  ln -sf $(npm prefix -g)/bin/pi-acp $HOME/.local/bin/pi-acp
```

The symlinks matter: npm's global bin directory is not on the sprite's
non-interactive PATH, so a freshly installed CLI is invisible to
`command -v` without them.

## Two planes, kept separate

**Transport.** The host drives the agent over the exec endpoint. Agent
protocols such as ACP are JSON-RPC over stdio, and stdio travels through exec
directly — no listening port and no terminal are involved.

Do not put tmux in this path. tmux is a *terminal* multiplexer: it renders
output into a fixed-width display grid and hard-wraps lines. A 552-byte protocol
frame read back from an 80-column pane arrives as 81 bytes of truncated garbage
that fails to parse. Reserve tmux for a human attaching to watch a run.

**Preview.** A sprite's HTTPS URL is for humans looking at something — a PR
preview, or a link an agent posts into a task. Register the service with
`--http-port` and the proxy auto-starts it when a request arrives, so a preview
link posted days ago still works: the click wakes the sprite. Only one service
per sprite may hold an HTTP port.

## Long-running turns

The HTTP exec endpoint ends the process group when the request completes. That
is correct for the host's short control commands, and it is why a durable agent
turn must detach itself inside the sprite:

```sh
mkfifo /tmp/acp/in
setsid sh -c 'pi-acp < /tmp/acp/in > /tmp/acp/out 2>/tmp/acp/err' </dev/null >/dev/null 2>&1 &
# Hold the FIFO open, or the agent sees EOF and exits after one frame.
setsid sh -c 'exec 3>/tmp/acp/in; sleep 600' </dev/null >/dev/null 2>&1 &
```

Write request frames to the FIFO, read replies from the output file, and
correlate by JSON-RPC `id`. A single detached agent then answers frames across
many short connections.

## Checkpoints

Checkpoints are **sprite-scoped**. Restoring sprite A's checkpoint into sprite B
fails; a checkpoint is an undo button for one box, not a reusable base image.

This costs little in practice: creating a sprite takes one to two seconds, and
installing a full agent toolchain takes about eighteen. The provider therefore
provisions cold rather than maintaining a warm pool.

## Security boundary

Paperclip treats a sandbox as untrusted. Sandbox code holds exactly two
authorities over the host — outbound workspace synchronization and the Paperclip
HTTP bridge — and a boundary control must run *outside* the sandbox, because
code inside can change anything inside.

This provider's boundary control is in `src/file-sync.ts`. Every archive
produced inside a sprite is validated on the host before extraction: absolute
member paths, `..` traversal segments, and any member resolving outside the
destination root are rejected by `assertArchiveMembersAreSafe`. Host files are
written with their requested mode so the bytes never sit world-readable, even
briefly.

## Credentials

The Sprites API token is never stored in this repository. It is resolved at
runtime, in this order:

1. The environment's `apiToken` field, declared in the manifest as
   `format: "secret-ref"`. Paperclip stores a pasted value as a company secret
   and hands the worker a reference, so the token is scoped to one company and
   is not written to disk in plaintext. **Prefer this in production.**
2. The `SPRITES_TOKEN` environment variable on the Paperclip host. This is the
   single-tenant convenience path and matches the Sprites CLI.

### Getting a token

A Sprites token is **not** a `flyctl` token. They are different credentials for
different APIs — a `fm2_…` macaroon from `fly auth token` is rejected by
`api.sprites.dev`. A Sprites token has the form
`org-slug/org-id/token-id/token-value`.

Your Fly.io account is the *authority* that mints one; the token is the
*credential* the plugin uses. Get one either way:

```bash
sprite login        # OAuth via the browser; prints a token on first auth
# or create one in the dashboard at sprites.dev
```

### Storing it in `pass`

`scripts/live-check.mjs` reads the token from the [`pass`](https://passwordstore.org)
password store when `SPRITES_TOKEN` is not exported, so the credential stays
encrypted at rest and never enters shell history:

```bash
pass insert -m cjndubisi/sprites/api-token   # paste the token, Ctrl-D
node scripts/live-check.mjs                  # no env var needed
```

Override the entry path with `SPRITES_TOKEN_PASS_PATH`. Prefer this to
`export SPRITES_TOKEN=…` on a command line: an exported secret is visible in
shell history and, briefly, in the process table.

For a headless host, `sprite auth setup --token "$(pass show …)"` configures the
CLI without a browser.

Copy `.env.example` to `.env` for local work; `.env` is gitignored.

Never place model-gateway or provider credentials in argv, agent-visible
environment, or logs. An agent that can read its own credentials can leak them
into model context.

A `pre-commit` hook refuses commits containing credential-shaped strings:

```bash
git config core.hooksPath .githooks
```

That hook is a speed bump, not a guarantee. **A credential that has been pushed
is only remediated by rotating it.** Rewriting history does not remove objects
that are already on the remote — they stay reachable by SHA — and anything that
was public must be assumed scraped.

## Tests

```bash
npm test          # 27 unit tests, no network
npm run typecheck
```

The unit tests cover the exec stream framing, driver config parsing and
defaults, sprite-name generation, and the path-traversal defenses.

### Live check

`scripts/live-check.mjs` exercises the real API: it creates a sprite, syncs
files both ways, runs commands, resumes the lease, and destroys the sprite. It
is a script rather than a test because it creates billable resources.

```bash
npm run build
SPRITES_TOKEN=... node scripts/live-check.mjs
```

## Implementation notes

**Exec response framing.** The non-TTY exec endpoint prefixes each chunk with a
stream-identifier byte: `1` stdout, `2` stderr, `3` exit (payload is the exit
code). Reading the response as text corrupts output with stray control bytes and
loses the exit code, so `decodeExecFrames` decodes the framing.

**Lease metadata is the only durable state.** The worker keeps nothing across
runs: each handler builds its client from the config the host passes, and the
sprite name lives in host-held lease metadata. A worker restart loses nothing.

**Release does nothing by default.** A sprite pauses on its own and costs
nothing while asleep, so the next run starts warm. `destroyOnRelease` opts into
a clean box per run at the cost of reprovisioning.

## License

MIT
