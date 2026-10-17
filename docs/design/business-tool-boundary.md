# Generic development tools and independent business connectors

2026-10-17. The user requested that ROG's 15 personal-decision tools move into
the separate ai-decision repository as the independent `AI-decison` connector.
`local-tools` now registers only its 41 generic tools on every host: machine
routing, workspaces/files/commands/Git, and Codex instruction/skill synchronization.

No business adapter source, import, registration, tests or compiled artifact may
remain in any release channel. `release:verify` enforces this on ROG as well as
base/OMEN. The former business source now lives at
`C:/Users/Meta/Project/Scripts/Python/ai-decision/connector`; it owns its Tunnel,
startup, schemas, controller forwarding and ChatGPT catalog independently.

The existing development Tunnel ID and app identity remain unchanged. Reload
only that runtime and refresh its ChatGPT catalog after the new business app and
its existing scheduled task have been verified. Account/provider state and the
Codex application/launcher are not restarted by this migration.

2026-10-17 acceptance: the existing ROG runtime was reconnected at 11:25,
ready/healthy. After ChatGPT catalog refresh/retry, the existing ROG app showed
Write8 + Read33 =41 and no business tool names. The independent app showed16
business tools (the original15 plus the separately authorized Codex wake-up).
Its real Web reads, native hourly task reads, selected-account WSL model calls,
and a production delayed Codex completion passed. The launcher/account state was
not restarted. MCP14 tests, renderer21 tests, clean TypeScript build and ROG
release verification passed. Detailed run IDs and rollback live in ai-decision's
docs/operations/deployment.md.
