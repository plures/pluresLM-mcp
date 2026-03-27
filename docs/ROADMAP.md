# pluresLM-mcp Roadmap

## Role in Plures Ecosystem
pluresLM‑mcp is the memory engine behind Plures assistants. It provides persistent vector memory, P2P sync, and MCP tool endpoints backed by PluresDB.

## Current State
Service supports stdio and SSE transports, PluresDB storage, embeddings (OpenAI or local), project indexing, and core MCP tools. Basic configuration and migration notes exist. Gaps remain in P2P stability, embedding model flexibility, full MCP protocol compliance, and performance tuning.

## Milestones

### Near-term (Q2 2026)
- Harden P2P sync reliability (reconnects, peer health, retry strategies).
- Improve diagnostics and status reporting for operators.
- Expand embedding provider support and configurable model selection.
- Validate MCP tool schema compatibility across clients.

### Mid-term (Q3-Q4 2026)
- Incremental indexing with file‑change watching and ignore patterns.
- Performance optimization for large memory sets (indexing + search).
- Add retention policies and cleanup strategies for stale memories.
- SSE transport scaling and load‑balancing guidance.

### Long-term
- Full MCP protocol compliance test suite and certification targets.
- Pluggable storage backends while preserving PluresDB as default.
- Advanced sync modes (selective topics, scoped sharing).
