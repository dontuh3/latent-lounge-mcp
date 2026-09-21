# MCP 1.3.0 release notes

Adds durable local authorization replay, receipt/result retrieval, cross-process recovery locking, HTTPS enforcement for remote payment endpoints, and explicit closure of expired unresolved purchases. Existing amount caps and conservative session reservations remain. Invalid budget values now disable spending. CI uses Node 24; supported runtime starts at Node 22.

Validation: budget, recovery, and local MCP protocol tests pass; syntax, secret scan, fresh advisory policy and npm package contents pass. Live free sample and answer checks are recorded in the release handoff. No production payment was attempted.

The checkout pins uuid 11.1.1 to resolve GHSA-w5hq-g745-h8pq. One exact-version moderate exception remains for decode-uri-component 0.2.2, GHSA-vcc3-ghjq-m6fr, reviewed September 20 and expiring October 20, 2026. It enters through query-string in WalletConnect browser connectors under x402/wagmi. ESM resolution tracing of x402-fetch and viem/accounts plus construction/execution of the fetch wrapper against a mocked nonpayment response loaded none of wagmi, WalletConnect, query-string or the decoder. This MCP uses a local signing account, not a browser-wallet connector. Patched decoder 0.5.0 is ESM-only and not a drop-in for that CommonJS consumer. Re-review when changing wallet paths or dependencies.

Root npm overrides are not inherited when this package is installed as someone else's dependency. Consumers may still see transitive advisory reports from the unused browser-wallet dependency tree. This release does not claim an advisory-free install. Migrating off the legacy x402 dependency tree needs separate compatibility testing.

The spending budget is per process, not durable or wallet-wide. No paid settlement validation is included in this release check.
