# PluresLM MCP Service

**Distributed vector memory service for AI assistants powered by PluresDB.**

PluresLM MCP provides persistent vector memory with P2P synchronization across devices. Built on [PluresDB](https://github.com/plures/pluresdb) for distributed data and [Model Context Protocol](https://modelcontextprotocol.io/) for AI tool integration.

## Features

- 🧠 **Persistent vector memory** - Semantic search across conversation history
- 🌐 **P2P synchronization** - Share memories across devices via Hyperswarm
- 🔧 **MCP protocol** - Standard interface for AI assistant integration  
- 🚀 **Multiple transports** - stdio, SSE/HTTP for different deployment needs
- 📦 **Zero-knowledge** - No central servers, encrypted P2P mesh
- 🛠️ **Project indexing** - Ingest codebases for context-aware assistance

## Quick Start

### Local Development (stdio)

```bash
npm install
npm run build

# Set PluresDB topic (generate with: openssl rand -hex 32)
export PLURES_DB_TOPIC="your-64-char-hex-topic-key"

# Start stdio MCP server
npm start
```

### Remote Service (HTTP/SSE)

```bash
# Configure for HTTP transport
export MCP_TRANSPORT=sse
export PORT=3001
export HOST=0.0.0.0
export PLURES_DB_TOPIC="your-topic-key"

# Start HTTP service
npm start
# → Serving on http://0.0.0.0:3001/sse
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLURES_DB_TOPIC` | ✅ | 64-char hex string (32 bytes) for PluresDB mesh |
| `PLURES_DB_SECRET` | ❌ | Optional encryption secret for mesh |
| `MCP_TRANSPORT` | ❌ | `stdio` (default) or `sse` for HTTP |
| `PORT` | ❌ | HTTP port when using SSE transport (default: 3001) |
| `HOST` | ❌ | HTTP host (default: 0.0.0.0) |
| `OPENAI_API_KEY` | ❌ | OpenAI key for embeddings (falls back to local Transformers.js) |
| `OPENAI_EMBEDDING_MODEL` | ❌ | OpenAI model name (default: text-embedding-3-small) |
| `PLURES_LM_DEBUG` | ❌ | Enable debug logging (true/false) |

### OpenClaw Integration

#### Local (stdio):
```json
{
  "mcpServers": {
    "pluresLM": {
      "command": "node", 
      "args": ["path/to/pluresLM-mcp/dist/index.js"],
      "env": {
        "PLURES_DB_TOPIC": "your-topic-key"
      }
    }
  }
}
```

#### Remote (SSE):
```json
{
  "mcpServers": {
    "pluresLM": {
      "transport": {
        "type": "sse",
        "url": "http://memory-service:3001/sse" 
      }
    }
  }
}
```

## Architecture

### PluresDB Backend

PluresLM v2.0+ uses **pure PluresDB** for storage and synchronization:

- **No SQLite dependencies** - Distributed-first design
- **Hyperswarm P2P mesh** - Direct device-to-device sync
- **Embedded vector search** - Cosine similarity in-memory
- **Conflict-free replication** - CRDTs for distributed consistency

### Transport Options

1. **stdio** (default) - Process pipes for local OpenClaw integration
2. **sse** - Server-Sent Events over HTTP for remote/clustered deployments

### Memory Sync

All devices sharing the same `PLURES_DB_TOPIC` automatically sync memories:

```bash
# Device 1
export PLURES_DB_TOPIC="abc123..." 
npm start  # Stores memories locally

# Device 2  
export PLURES_DB_TOPIC="abc123..."  # Same topic
npm start  # Automatically receives Device 1's memories
```

## Tools

PluresLM MCP exposes these tools for AI assistants:

- `pluresLM_store(content, tags?, category?, source?)` - Store new memory
- `pluresLM_search(query, limit?, minScore?)` - Semantic search  
- `pluresLM_forget(id? | query?, threshold?)` - Delete memories
- `pluresLM_index(directory, maxFiles?, category?, tags?)` - Index codebase
- `pluresLM_status()` - Database stats + sync status
- `pluresLM_profile()` - User profile data

## Deployment

### Connect-msWork Fleet

For enterprise deployments across multiple OpenClaw instances:

```bash
# Memory service (dedicated server)
docker run -p 3001:3001 -e MCP_TRANSPORT=sse plures/pluresLM-mcp

# Worker instances (point to service)
export MCP_TRANSPORT=sse
export PLURES_LM_SERVICE_URL=http://memory-service:3001/sse
```

### High Availability

```bash
# Multiple services with shared PluresDB topic
docker-compose up -d  # Load balancer → N service instances
```

## Migration from v1.x

PluresLM v2.0 is a **breaking change** from SQLite-based v1.x:

### What Changed
- ❌ **Removed**: All SQLite/better-sqlite3 dependencies
- ✅ **Added**: PluresDB distributed storage  
- ✅ **Added**: P2P mesh synchronization
- ✅ **Added**: SSE/HTTP transport option
- 🔄 **Changed**: Tool names (`memory_*` → `pluresLM_*`)
- 🔄 **Changed**: Configuration (file paths → topic keys)

### Migration Path
1. Export v1.x data: `pluresLM_export_bundle`
2. Deploy v2.0 with PluresDB topic
3. Import data: `pluresLM_import_bundle` 

*Note: Direct file migration not supported due to schema differences.*

## License

AGPL-3.0 - See [LICENSE](LICENSE)

## Links

- [PluresDB](https://github.com/plures/pluresdb) - Distributed database engine
- [Model Context Protocol](https://modelcontextprotocol.io/) - AI tool standard  
- [OpenClaw](https://openclaw.ai/) - AI assistant platform