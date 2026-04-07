# PluresLM MCP Roadmap

## Current: v2.11.0

## Phase 1: Reliability (v2.12)
- [ ] Session recovery — auto-reconnect MCP sessions after daemon restart
- [ ] Health endpoint improvements — report embedding model status, DB stats
- [ ] Graceful shutdown — drain active requests before stopping
- [ ] Log rotation — prevent unbounded log growth
- [ ] Memory usage monitoring — alert when DB approaches storage limits

## Phase 2: Procedures Engine (v2.13)
- [ ] All 10 step types operational — search, filter, sort, transform, store, update, delete, merge, conditional, parallel
- [ ] Procedure scheduling — cron-based triggers with reliable execution
- [ ] Procedure chaining — output of one procedure feeds into another
- [ ] Praxis constraint integration — evaluate constraints during procedure execution
- [ ] Procedure metrics — execution time, success rate, memory impact

## Phase 3: Intelligence (v3.0)
- [ ] Auto-consolidation — periodic merge of duplicate/similar memories
- [ ] Relevance decay — reduce retrieval weight of stale memories
- [ ] Context-aware recall — use conversation topic to improve search precision
- [ ] Memory importance scoring — learn which memories are frequently retrieved
- [ ] Cross-project linking — discover relationships between indexed projects

## Phase 4: Distribution (v3.1)
- [ ] Multi-device sync — Hyperswarm P2P memory synchronization
- [ ] Selective sync — share specific memory categories across devices
- [ ] Conflict resolution — merge divergent memory graphs
- [ ] Encrypted sync — end-to-end encryption for P2P memory transfer
- [ ] Team sharing — shared memory spaces for collaborative development

## Phase 5: Ecosystem (v4.0)
- [ ] VS Code integration — dedicated panel for memory browsing/search
- [ ] JetBrains plugin — IntelliJ/PyCharm memory integration
- [ ] Neovim plugin — telescope-based memory search
- [ ] REST API — HTTP endpoints for non-MCP clients
- [ ] Web dashboard — browser-based memory management UI

