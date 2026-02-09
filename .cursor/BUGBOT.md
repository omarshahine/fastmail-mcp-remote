# Bugbot Rules

## PII and Personal Path Detection

If a file contains paths matching `/Users/[username]/` (macOS home directory), then:
- Add a blocking bug: "Hardcoded macOS home directory path detected. Use wildcards or environment variables instead of personal paths."
- Suggest replacing with a wildcard pattern like `~/` or `*/`

If a file contains paths matching `C:\Users\[username]\` (Windows home directory), then:
- Add a blocking bug: "Hardcoded Windows home directory path detected. Use wildcards or environment variables instead of personal paths."

If a file contains what appears to be a personal username in a path (e.g., `/Users/[name]/`), then:
- Add a blocking bug: "Personal username detected in file. Remove or replace with a generic placeholder or wildcard."

## Email Address Detection

If a configuration file (wrangler.jsonc, wrangler.toml, *.d.ts, .env*, *.json) contains a real email address (not @example.com, @anthropic.com, @noreply, or @users.noreply.github.com), then:
- Add a **blocking** bug: "Real email address detected in configuration file. Move to a secret or environment variable to avoid committing PII to the repo. Use `wrangler secret put` for Cloudflare Workers."

If any other file contains an email address pattern (except @example.com, @anthropic.com, or @noreply addresses), then:
- Add a non-blocking bug: "Email address detected. Verify this is not personal information that should be parameterized or removed."

Exclude from email checks:
- CHANGELOG.md
- package-lock.json
- node_modules/
- Co-Authored-By lines in commit messages

## API Keys and Secrets

If a file contains patterns like `api_key=`, `token=`, `secret=`, or `password=` followed by a string value, then:
- Add a blocking bug: "Possible API key or secret detected. Use environment variables instead of hardcoding credentials."

Exclude from secret checks:
- .env.example files (these are templates)
- Documentation showing example patterns

## Phone Number Detection

If a file contains US phone number patterns (XXX-XXX-XXXX or similar), then:
- Add a non-blocking bug: "Possible phone number detected. Ensure this is not personal information."
