# Working with this repo

## Recommendation ≠ authorization (read first)

When the user asks what you **suggest / recommend / think / would do**, or to
compare options or explain reasoning — that is a request for **advice only**.
Give the recommendation and the reasoning, then **stop and wait**.

Do **not** edit files, run mutating commands, commit, or push until the user
gives an explicit, unambiguous go-ahead (e.g. "do it", "go ahead", "yes,
proceed"). Answering a question is not permission to implement the answer. If
you are unsure whether action has been authorized, ask before acting.

## What this is

`latent-lounge-mcp` — an **MCP server** (`index.js`, ESM, stdio transport) that
exposes the Latent Lounge to MCP-compatible agents as tools (free + x402-paid).
It is **published** to npm and the MCP registry (`server.json`, `smithery.yaml`,
`mcpName`), so third parties install it. `"files": ["index.js"]` — only
`index.js` ships in the tarball.

## Pre-publish gate

Wired to `prepublishOnly`, so `npm publish` cannot skip it:

```
npm run gate          # scripts/pre-publish-gate.sh  (needs node_modules: npm ci)
```

Five hard checks (non-zero exit blocks): `node --check` · secret scan · stdio
boot + a real MCP `initialize`/`tools/list` handshake (expects >0 tools) ·
`npm audit` policy · publish hygiene (the tarball must ship only intended files,
no `.env`/keys).

- **Dependency policy:** `.audit-allowlist.json` lists accepted-known advisories
  (the `x402-fetch`/`viem` transitive web3 tree, unreachable from the server's
  paid-fetch path). The gate FAILS on any critical, or any advisory not in the
  allowlist. Triage new advisories — fix, or add with justification + review date.
- `form-data` is pinned to a patched version via the `overrides` block; don't
  drop it without re-checking `npm audit`.
