# Optional AI Decision MCP facade

Only the ROG local-tools runtime (`CODEX_PLUS_MACHINE_ID=rog`) optionally registers five AI Decision tools when the private loopback bridge config exists. OMEN and Mac return before reading any bridge config and never expose these tools or access the service, even if a config file was copied there. This is a forwarding adapter, not an agent, planner, queue or second state store. AI Decision core and Todoist execution remain in the independent ROG project; this release does not install or start that service.

Implementation: `src/ai-decision-tools.ts`, registered by `mcp-server.ts`. Config: `%USERPROFILE%/AppData/Local/AI-Decision/bridge.json`; never commit its token. The endpoint must be local loopback HTTP. Outbound mutations and exact user replies remain validated and persisted by AI Decision Next.

Tool schemas must match `/home/meta/Project/Scripts/Python/ai-decision-next/src/ai_decision/mcp/gateway.py`. Task create/update, priority, description, memory expiry and next-review fields are typed. Do not weaken annotations or permission settings to suppress native confirmation. This facade is absent when no config file exists, so other machines keep their existing behavior.

Build using the existing TypeScript workflow. Validate host gating and listTools without creating a production decision. The 2026-10-01 deployment is files only: the user forbids starting/restarting Codex, its launcher or Tunnel merely for acceptance. Tool definitions change on the user's next normal runtime start; do not initiate a service reload. Later read_decision acceptance must not create a production decision.

The main project contains operational records and acceptance evidence. No browser cookies, tokens or personal task content belong in this repository.
