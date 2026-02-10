# @plures/superlocalmemory-mcp

MCP (Model Context Protocol) server for **superlocalmemory** — a **local-first, persistent vector memory** for AI coding assistants.

It exposes a small set of MCP **tools** and **resources** so editors like VS Code (Copilot MCP), Cursor, Continue, and Claude Desktop can store and recall long-term memory during coding sessions.

- Storage: local SQLite file (better-sqlite3)
- Retrieval: semantic vector search
- Embeddings: OpenAI embeddings via `OPENAI_API_KEY`

## Install

> This package is intended to be run via MCP "server command" configs.

```bash
npm install -g @plures/superlocalmemory-mcp
# or run via npx (recommended):
npx @plures/superlocalmemory-mcp
```

## Configuration

Environment variables:

- `OPENAI_API_KEY` (**required**) — used to compute embeddings
- `SUPERLOCALMEMORY_DB_PATH` (optional) — SQLite DB path (default: `~/.superlocalmemory/mcp.db`)
- `SUPERLOCALMEMORY_DEBUG` (optional) — set to `true` for debug logs to stderr

## Editor setup

### VS Code (Copilot) — `mcp.json`

```json
{
  "mcpServers": {
    "superlocalmemory": {
      "command": "npx",
      "args": ["@plures/superlocalmemory-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-key",
        "SUPERLOCALMEMORY_DB_PATH": "~/.superlocalmemory/mcp.db"
      }
    }
  }
}
```

### Cursor — `settings.json`

Cursor uses an MCP servers configuration similar to:

```json
{
  "mcpServers": {
    "superlocalmemory": {
      "command": "npx",
      "args": ["@plures/superlocalmemory-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

### Continue.dev — `config.json`

```json
{
  "mcpServers": [
    {
      "name": "superlocalmemory",
      "command": "npx",
      "args": ["@plures/superlocalmemory-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  ]
}
```

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "superlocalmemory": {
      "command": "npx",
      "args": ["@plures/superlocalmemory-mcp"],
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

This server uses [`@plures/superlocalmemory`](../../plugins/superlocalmemory) under the hood:

- A local SQLite database stores memory rows.
- On `memory_store` / `memory_search`, the server computes an embedding (OpenAI) and performs in-process cosine similarity.
- `memory_index` walks a directory, reads text-like files, and stores them with a source label so they can be retrieved later.

## Privacy

All memory data is stored **locally** on your machine at `SUPERLOCALMEMORY_DB_PATH`.

The only network call is for **embedding generation** when using OpenAI (via `OPENAI_API_KEY`).

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
