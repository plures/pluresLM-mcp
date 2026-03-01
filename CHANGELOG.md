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
