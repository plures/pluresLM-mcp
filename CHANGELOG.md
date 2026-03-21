## [2.9.0] — 2026-03-21

- feat: Adopt @plures/praxis for declarative logic management (#9) (fc6af24)

## [2.8.0] — 2026-03-13

- feat: add stored procedure engine (c6ddece)

## [2.7.0] — 2026-03-13

- feat: add API key authentication for MCP endpoint (8e6bcb3)

## [2.6.2] — 2026-03-12

- fix: handle null args in tool handlers — category:null no longer filters by literal 'null' (42be0c4)

## [2.6.1] — 2026-03-12

- fix: unwrap PluresDB node wrappers and normalize vector/embedding field names (1729a31)

## [2.6.0] — 2026-03-11

- feat: multi-client session routing for HTTP transport (94d77ff)

## [2.5.1] — 2026-03-11

- fix: enable session tracking — stateless mode breaks tool calls (cfe42e7)

## [2.5.0] — 2026-03-11

- fix: use stateless HTTP transport for multi-client support (8a08337)
- feat: real StreamableHTTP transport + PLURES_DB_PATH support (49588f5)

## [2.4.0] — 2026-03-11

- feat: 100% Sprint Log tool parity - complete export/import/DSL tools (0634896)

## [2.3.0] — 2026-03-11

- feat: add Sprint Log compatibility - 13 missing tools (667eee9)
- polish: remove dead SSE import and add proper type safety (6a7dfbd)

## [2.2.0] — 2026-03-11

- feat: use PluresDB native HNSW vector search for scalability (5b1e2d9)

## [2.1.1] — 2026-03-11

- fix: syntax error in config.ts and correct HTTP transport (be9895c)
- docs: add complete v2.0 architecture reference (55b91de)

## [2.1.0] — 2026-03-11

- feat: PluresLM v2.0 - Remove SQLite completely, add SSE/HTTP transport (511de31)
- ci: add PR lane event relay to centralized merge FSM (d3ae447)
- Rename superlocalmemory to pluresLM in README (5eaf29f)

## [0.2.1] — 2026-03-01

- fix(ci): add id-token permission to release workflow (#4) (37641a9)

## [0.2.0] — 2026-02-20

- feat: replace OpenAI/Ollama with Transformers.js for zero-config operation (#2) (d1240f1)
- ci: add standardized release pipeline (19f275c)
- feat: MCP server for superlocalmemory v0.1.0 (2f2e647)
- Initial commit (a927cb5)

# Changelog

## 0.2.0 (Unreleased)

### ✨ Zero-Config Operation

- **BREAKING**: No longer requires `OPENAI_API_KEY` or Ollama installation
- **NEW**: Default embeddings via Transformers.js (bge-small-en-v1.5, 384-dim)
- **NEW**: In-process embedding generation with zero external dependencies
- **NEW**: Optional OpenAI embeddings via `OPENAI_API_KEY` environment variable
- **NEW**: Local MemoryDB implementation (no external package dependencies)
- **IMPROVED**: First-run downloads model (~100MB), subsequent runs are instant and offline
- **IMPROVED**: Privacy-focused: 100% local operation by default

### Migration Notes

- Existing databases with 1536-dim OpenAI embeddings: Set `OPENAI_API_KEY` to continue using OpenAI
- New installations: Work out of the box with no configuration
- Database dimension is determined by the configured embedding provider at startup; existing databases must use a provider with matching dimensions (no auto-detection of existing data)

## 0.1.0

- Initial release
- MCP tools: memory_store, memory_search, memory_forget, memory_profile, memory_index, memory_stats
- MCP resources: memory://profile, memory://recent, memory://stats
