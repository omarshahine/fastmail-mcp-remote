# Changelog

All notable changes to the Fastmail MCP Remote worker are documented here.
The NPM-published CLI (`fastmail-cli`) versions independently — see
`openclaw-plugin/CHANGELOG.md` or the NPM release history for its changes.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.12.0] - 2026-04-18

### Added
- **Code Mode endpoint** (`/mcp/code`) via Cloudflare Dynamic Workers — wraps
  all Fastmail tools into a single `code` tool, letting the LLM chain
  operations in one sandboxed V8 execution instead of 29+ round-trips.
- **Search + execute Code Mode pattern** — replaces the initial typed-API
  shape with a discovery/invocation split that scales better as the tool
  surface grows (#40).
- **Token-efficient MCP response format** — compact text encoding cuts
  payload size 5–7× versus the verbose default shape (#30).
- **Plugin approval gates for sensitive tools** — `send_email`,
  `bulk_delete`, and other mutating operations now require explicit
  approval through the plugin's approval hook (#38).
- **MCP elicitation-based send confirmation** — uses the MCP elicitation
  capability for interactive confirmation before dispatch (#36); made
  opt-in when `agents` 0.9.0 changed default behavior (#41).
- **Sliding-window token renewal** — server refreshes tokens proactively
  before expiry so active sessions don't break mid-operation.
- **`X-Token-Expires-At` response header** — lets the CLI track
  server-side renewals and avoid stale-token surprises (#43).
- Homepage improvements: terminal-mockup hero, dynamic version badge with
  GitHub API fallback, and "Star on GitHub" / Sponsor buttons.

### Changed
- **OpenClaw plugin migrated to `definePluginEntry`** SDK shape (#35).
- **Agents SDK** upgraded to 0.9.0; send confirmation flow made opt-in to
  preserve prior behavior (#41). Intermediate bump to 0.7.6 (#31).
- Hook registration switched from `api.registerHook()` to typed `api.on()`.
- Cloudflare MCP servers consolidated: product-specific servers replaced
  with the Code Mode API server, and leftover duplicates removed.

### Fixed
- **`GET`/`DELETE` on `/mcp` no longer hang the Worker** — these verbs are
  now explicitly rejected instead of tying up the request (#39).
- **Loopback `redirect_uri` validation ignores port** per RFC 8252 §7.3,
  so ephemeral CLI callback ports no longer fail OAuth validation.
- **Token-renewal KV write wrapped in try/catch** — a KV failure during
  refresh no longer takes down the request.
- `openclaw` moved from `peerDependencies` to `dependencies` so plugin
  installs resolve cleanly without host-side coordination.

### Infrastructure
- **NPM trusted publishing (OIDC)** replaces the long-lived `NPM_TOKEN`
  secret for CLI releases.
- **Automated CLI publish workflow** triggers on `fastmail-cli-v*` tags.
- **Version Consistency workflow** — placeholder for future drift checks
  between root and `openclaw-plugin/` versions.
- CI now installs deps before `tsc --noEmit` verification.
- OpenClaw compat range and build metadata declared in plugin manifest.

## [1.11.0] - 2026-03-05

Prior releases — see `git log v1.0.0..v1.11.0` for history. Notable
themes across this range: JMAP client buildout, contacts/calendar
support, memos (yellow-highlight email annotations via `$memo` keyword),
HTML→Markdown conversion using Turndown + linkedom in Workers, the
initial OpenClaw plugin publish to NPM as `fastmail-cli`, and Cloudflare
Access OAuth with per-user allowlist.

[1.12.0]: https://github.com/omarshahine/fastmail-mcp-remote/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/omarshahine/fastmail-mcp-remote/releases/tag/v1.11.0
