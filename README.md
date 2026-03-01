# @plures/pluresLM-mcp

MCP (Model Context Protocol) server for **pluresLM** — a **local-first, persistent vector memory** for AI coding assistants.

It exposes a small set of MCP **tools** and **resources** so editors like VS Code (Copilot MCP), Cursor, Continue, and Claude Desktop can store and recall long-term memory during coding sessions.

- Storage: local SQLite file (better-sqlite3)
- Retrieval: semantic vector search
- Embeddings: **Transformers.js (default, zero-config)** or OpenAI (optional)

## ✨ Zero-Config Usage

**No API keys required!** Just run:

```bash
npx @plures/pluresLM-mcp
```

The server uses **Transformers.js** to run embeddings locally in-process with the `bge-small-en-v1.5` model (384 dimensions).

> **Note:** First run will download the model (~100MB) to `~/.cache/pluresLM/transformers`. Subsequent runs are instant and fully offline.

## Install

```bash
# Run directly (recommended):
npx @plures/pluresLM-mcp

# Or install globally:
npm install -g @plures/pluresLM-mcp
```

## Configuration

All configuration is **optional**:

### Environment Variables

- `pluresLM_DB_PATH` (optional) — SQLite DB path (default: `~/.pluresLM/mcp.db`)
- `pluresLM_DEBUG` (optional) — set to `true` for debug logs to stderr
- `pluresLM_CACHE_DIR` (optional) — Transformers.js model cache directory (default: `~/.cache/pluresLM/transformers`)
- `OPENAI_API_KEY` (optional) — use OpenAI embeddings instead of local Transformers.js
- `OPENAI_EMBEDDING_MODEL` (optional) — OpenAI model to use (default: `text-embedding-3-small`)

### Using OpenAI (Optional)

If you prefer OpenAI embeddings over local Transformers.js:

1. Set `OPENAI_API_KEY` in your environment
2. The server will use OpenAI with 1536-dim embeddings

## Migration / Breaking Changes

> **Important:** Embedding dimensions are **not** interchangeable. Transformers.js uses **384‑dim** embeddings, while OpenAI uses **1536‑dim** embeddings by default.

If you already have an existing database:

- **Databases created with OpenAI embeddings must continue using `OPENAI_API_KEY`.**
  - Do **not** switch that database to Transformers.js; the stored vectors will be incompatible.
  - The server will detect dimension mismatches and provide a clear error message.
- There is **no automatic migration** between 384‑dim and 1536‑dim embeddings.
- To change providers (OpenAI ⇄ Transformers.js), you must either:
  - Point `pluresLM_DB_PATH` to a **new database**, or
  - Delete/recreate the existing DB and **re-index all memories**.
## Editor setup

### Zero-Config Examples

These examples require **no environment variables** and work out of the box:

#### VS Code (Copilot) — `mcp.json`

```json
{
  "mcpServers": {
    "pluresLM": {
      "command": "npx",
      "args": ["@plures/pluresLM-mcp"]
    }
  }
}
```

#### Cursor — `settings.json`

```json
{
  "mcpServers": {
    "pluresLM": {
      "command": "npx",
      "args": ["@plures/pluresLM-mcp"]
    }
  }
}
```

#### Continue.dev — `config.json`

```json
{
  "mcpServers": [
    {
      "name": "pluresLM",
      "command": "npx",
      "args": ["@plures/pluresLM-mcp"]
    }
  ]
}
```

#### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pluresLM": {
      "command": "npx",
      "args": ["@plures/pluresLM-mcp"]
    }
  }
}
```

### With OpenAI (Optional)

If you prefer OpenAI embeddings:

```json
{
  "mcpServers": {
    "pluresLM": {
      "command": "npx",
      "args": ["@plures/pluresLM-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

## Tools

### `memory_store`
Store a memory.

**Input**
- `content` (string, required)
- `tags` (string[], optional)
- `category` (string, optional)
- `source` (string, optional)

### `memory_search`
Semantic search.

**Input**
- `query` (string, required)
- `limit` (number, optional, default 5)
- `minScore` (number, optional, default 0.3)

### `memory_forget`
Delete by UUID `id` or by semantic `query`.

**Input**
- `id` (string, optional)
- `query` (string, optional)
- `threshold` (number, optional, default 0.8)

### `memory_profile`
Return the stored user profile summary (if any).

### `memory_index`
Index a directory by storing file contents as memories.

**Input**
- `directory` (string, required)
- `maxFiles` (number, optional, default 500)
- `maxBytesPerFile` (number, optional, default 200000)
- `category` (string, optional, default `project-context`)
- `tags` (string[], optional)

### `memory_stats`
Return database stats.

## Resources

- `memory://profile` — JSON user profile (if available)
- `memory://recent` — markdown list of the 20 most recent memory contents
- `memory://stats` — JSON stats

## How it works

This server provides local-first persistent memory with:

- **Local SQLite database** stores memory rows with embeddings
- **Embeddings**: 
  - Default: Transformers.js (`bge-small-en-v1.5`, 384-dim) — runs in-process, zero-config
  - Optional: OpenAI API (`text-embedding-3-small`, 1536-dim) — requires API key
- **Vector search**: In-process cosine similarity against stored embeddings
- **Indexing**: `memory_index` walks a directory, reads text files, and stores them for later retrieval

## Privacy

All memory data is stored **locally** on your machine at `pluresLM_DB_PATH` (default: `~/.pluresLM/mcp.db`).

### Network Usage

- **Transformers.js (default)**: One-time model download (~100MB) on first run, then 100% offline
- **OpenAI (optional)**: API calls for each embedding when `OPENAI_API_KEY` is set

No memory content is ever sent to external services except for embedding generation when using OpenAI.

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## License

AGPL-3.0
