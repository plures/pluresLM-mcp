# PluresLM MCP Roadmap

## Role in OASIS
pluresLM‑mcp is the **memory engine** that powers OASIS agents and apps. It provides persistent vector memory, P2P sync, and MCP endpoints backed by PluresDB—enabling privacy‑preserving recall and multi‑agent orchestration.

## Current State
v2.11.0 supports stdio + SSE transports, PluresDB storage, embeddings, project indexing, and core MCP tools. Reliability and operational controls need hardening before broader OASIS deployment.

## Roadmap

### Phase 1 — Reliability & Ops Hardening (v2.12)
- Auto‑reconnect MCP sessions after daemon restart.
- Health endpoint: embedding model status, DB stats, storage limits.
- Graceful shutdown with request draining.
- Log rotation and disk usage controls.
- Memory usage monitoring + alerts.

### Phase 2 — Procedure Engine (v2.13)
- Full coverage of 10 step types (search, filter, sort, transform, store, update, delete, merge, conditional, parallel).
- Cron‑based scheduling with reliable execution.
- Procedure chaining and output passing.
- Praxis constraint integration during procedure execution.
- Metrics: execution time, success rate, memory impact.

### Phase 3 — Memory Intelligence (v3.0)
- Auto‑consolidation of duplicate memories.
- Relevance decay for stale memories.
- Context‑aware recall scoring.
- Memory importance scoring.
- Cross‑project linking for OASIS workflows.

### Phase 4 — Distribution (v3.1)
- Hyperswarm P2P sync with selective categories.
- Conflict resolution and encrypted sync.
- Team/shared memory spaces for collaborative commerce operations.

### Phase 5 — Ecosystem Interfaces (v4.0)
- VS Code, JetBrains, and Neovim clients.
- REST API for non‑MCP clients.
- Web dashboard for memory management.
