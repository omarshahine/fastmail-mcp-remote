# Fastmail MCP Remote Server

A Cloudflare Worker that provides MCP (Model Context Protocol) access to Fastmail email, contacts, and calendar via GitHub OAuth authentication.

## Quick Reference

```bash
# Development
npm start                    # Run locally at http://localhost:8788

# Deployment
npm run deploy               # Deploy to Cloudflare Workers

# Type checking
npm run type-check           # Run TypeScript type checker
npm run cf-typegen           # Regenerate Cloudflare types
```

## Project Structure

```
src/
├── index.ts              # Main entry point, MCP tools registration, FastmailMCP class
├── jmap-client.ts        # JMAP protocol client for Fastmail API
├── contacts-calendar.ts  # Contacts and calendar functionality
├── github-handler.ts     # GitHub OAuth flow handling
├── fastmail-auth.ts      # Fastmail authentication helpers
├── utils.ts              # Utility functions
└── workers-oauth-utils.ts # Cloudflare Workers OAuth utilities
```

## Architecture

- **Entry Point**: `src/index.ts` exports `FastmailMCP` Durable Object class
- **OAuth**: GitHub OAuth via `@cloudflare/workers-oauth-provider`
- **API Communication**: JMAP protocol to Fastmail API (`src/jmap-client.ts`)
- **State**: Cloudflare Durable Objects with SQLite for session management
- **Storage**: KV namespace (`OAUTH_KV`) for OAuth token storage

## Deployment

### First-Time Setup

1. **Login to Cloudflare**:
   ```bash
   npx wrangler login
   ```

2. **Create KV namespace** (if not exists):
   ```bash
   npx wrangler kv namespace create "OAUTH_KV"
   # Update wrangler.jsonc with the returned ID
   ```

3. **Create GitHub OAuth App** at https://github.com/settings/developers:
   - Homepage URL: `https://fastmail-mcp-remote.<subdomain>.workers.dev`
   - Callback URL: `https://fastmail-mcp-remote.<subdomain>.workers.dev/callback`

4. **Get Fastmail API Token** at https://www.fastmail.com/settings/security/tokens

5. **Set production secrets**:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put FASTMAIL_API_TOKEN
   npx wrangler secret put COOKIE_ENCRYPTION_KEY  # Use: openssl rand -hex 32
   ```

6. **Deploy**:
   ```bash
   npm run deploy
   ```

### Subsequent Deployments

```bash
npm run deploy
```

### Verify Deployment

Check worker status in Cloudflare dashboard or:
```bash
curl https://fastmail-mcp-remote.<subdomain>.workers.dev/
```

## Local Development

1. Copy `.dev.vars.example` to `.dev.vars` and fill in credentials
2. Run `npm start`
3. Test at `http://localhost:8788/sse`

Use MCP Inspector for testing:
```bash
npx @modelcontextprotocol/inspector@latest
# Enter http://localhost:8788/sse and authenticate
```

## Adding New Tools

1. Add the tool definition in `src/index.ts` within the `init()` method:
   ```typescript
   this.server.tool(
     "tool_name",
     "Tool description",
     { /* zod schema for params */ },
     async (params) => {
       // Implementation
       return { content: [{ text: "result", type: "text" }] };
     }
   );
   ```

2. If the tool needs JMAP functionality, add the method in `src/jmap-client.ts`

3. Update the `check_function_availability` tool's function list in `src/index.ts`

4. Update README.md with the new tool

## User Access Control

Edit `ALLOWED_USERNAMES` in `src/index.ts` to control which GitHub users can access:

```typescript
const ALLOWED_USERNAMES = new Set<string>([
  'omarshahine',
  // Add more usernames
]);
```

Empty set allows all authenticated GitHub users.

## Secrets Required

| Secret | Description |
|--------|-------------|
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `FASTMAIL_API_TOKEN` | Fastmail API token with required scopes |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex string for cookie encryption |

## Debugging

- **Cloudflare Dashboard**: Workers & Pages → fastmail-mcp-remote → Logs
- **Local logs**: Visible in terminal when running `npm start`
- **MCP Inspector**: Best tool for testing individual MCP tools

## Key Files

- `wrangler.jsonc` - Cloudflare Worker configuration (bindings, KV, Durable Objects)
- `.dev.vars` - Local development secrets (not committed)
- `.dev.vars.example` - Template for local secrets

## Protecting with Cloudflare Zero Trust Access

You can add an additional layer of security using Cloudflare Zero Trust Access with Service Tokens. This restricts access to the Worker to only clients that have the service token credentials.

### Option 1: One-Click Access (Email-based)

1. Go to **Workers & Pages** → select `fastmail-mcp-remote`
2. Go to **Settings** → **Domains & Routes**
3. For `workers.dev`, click **Enable Cloudflare Access**
4. Click **Manage Cloudflare Access** to configure allowed email addresses

### Option 2: Service Token Authentication (Machine-to-Machine)

For programmatic access (like MCP clients), use a Service Token:

#### 1. Create a Service Token

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. Navigate to **Access** → **Service Auth** → **Service Tokens**
3. Click **Create Service Token**
4. Name it (e.g., `fastmail-mcp-client`)
5. Set duration (recommend: 1 year or non-expiring for personal use)
6. Click **Generate token**
7. **Save the Client ID and Client Secret immediately** - the secret is only shown once!

```
CF-Access-Client-Id: <CLIENT_ID>.access
CF-Access-Client-Secret: <CLIENT_SECRET>
```

#### 2. Create an Access Application

1. In Zero Trust, go to **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:
   - **Name**: `Fastmail MCP Remote`
   - **Session Duration**: 24 hours (or preferred)
   - **Application domain**: `fastmail-mcp-remote.shahine.workers.dev`
4. Click **Next**

#### 3. Add a Service Auth Policy

1. In the application's **Policies** tab, click **Add a policy**
2. Configure:
   - **Policy name**: `Service Token Access`
   - **Action**: **Service Auth** (not Allow!)
   - **Include rule**:
     - Selector: **Service Token**
     - Value: Select your service token
3. Save the policy

#### 4. Client Authentication

Clients must include these headers on every request:

```bash
curl -H "CF-Access-Client-Id: <CLIENT_ID>" \
     -H "CF-Access-Client-Secret: <CLIENT_SECRET>" \
     https://fastmail-mcp-remote.shahine.workers.dev/sse
```

Or as a single JSON header (if configured):
```bash
curl -H 'Authorization: {"cf-access-client-id": "<CLIENT_ID>", "cf-access-client-secret": "<CLIENT_SECRET>"}' \
     https://fastmail-mcp-remote.shahine.workers.dev/sse
```

### Combining GitHub OAuth + Access Service Token

With both enabled:
1. Service Token authenticates the client to Cloudflare Access (outer layer)
2. GitHub OAuth authenticates the user within the MCP server (inner layer)

This provides defense-in-depth: even if someone discovers the Worker URL, they cannot access it without both the service token AND valid GitHub credentials.

### Validate Access JWT in Worker (Optional)

For additional security, validate the Access JWT in your Worker code:

```typescript
// The JWT is in the Cf-Access-Jwt-Assertion header
const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
// Validate against your Access application's AUD tag and JWKs URL
```

See: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
