# PluresLM v2.0 As-Built Architecture

**Date**: March 10, 2026  
**Status**: ✅ Production Ready  
**SQLite Status**: ❌ **COMPLETELY REMOVED**

## Executive Summary

PluresLM v2.0 represents a **complete architectural rewrite** from a SQLite-based local memory system to a **distributed-first P2P memory mesh** powered by PluresDB and Hyperswarm.

## Core Architecture

### Storage Layer: PluresDB
- **Database Engine**: PluresDB (distributed, P2P mesh)
- **Sync Protocol**: Hyperswarm DHT + Noise encryption  
- **Vector Search**: In-memory cosine similarity computation
- **Schema**: Native PluresDB tables (`memories`, `profile`, `stats`)
- **Replication**: Conflict-free, eventually consistent
- **Dependencies**: `@plures/pluresdb` only

### Transport Layer: Multi-Modal MCP
- **stdio** (default): Process pipes for local OpenClaw integration
- **SSE/HTTP**: Server-Sent Events for remote/distributed deployments
- **Protocol**: Model Context Protocol (MCP) for AI assistant integration
- **SDK**: `@modelcontextprotocol/sdk` with `SSEServerTransport` support

### Memory Model: Vector-First
- **Embeddings**: Transformer.js (local) or OpenAI (remote)
- **Search**: Cosine similarity with configurable thresholds
- **Deduplication**: Automatic duplicate detection via vector similarity
- **Metadata**: Tags, categories, sources, timestamps
- **Indexing**: Project-wide codebase ingestion

## Configuration Model

### Environment Variables
```bash
# Required
PLURES_DB_TOPIC="64-char-hex-string"    # Mesh identity (32 bytes)

# Optional
PLURES_DB_SECRET="encryption-secret"     # Mesh encryption 
MCP_TRANSPORT="stdio|sse|http"          # Transport mode
PORT=3001                               # HTTP port (SSE mode)
HOST="0.0.0.0"                         # HTTP host (SSE mode)
OPENAI_API_KEY="sk-..."                 # Embedding provider
OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
PLURES_LM_DEBUG="true"                  # Debug logging
```

### Deployment Configurations

#### Local Development
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

#### Remote Service (connect-msWork Fleet)
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

## Tool Interface (MCP Protocol)

### Memory Operations
- `pluresLM_store(content, tags?, category?, source?)` - Store memory with embeddings
- `pluresLM_search(query, limit?, minScore?)` - Semantic vector search
- `pluresLM_forget(id? | query?, threshold?)` - Delete by ID or semantic match

### Project Operations  
- `pluresLM_index(directory, maxFiles?, category?, tags?)` - Ingest codebase
- `pluresLM_status()` - Database statistics + P2P sync status
- `pluresLM_profile()` - User profile data

### Resource URIs
- `pluresLM://profile` - User profile JSON
- `pluresLM://recent` - Recent memories markdown
- `pluresLM://stats` - Statistics and sync status

## Deployment Patterns

### Single Device (stdio)
```
OpenClaw Instance ←→ stdio ←→ PluresLM MCP ←→ PluresDB Topic
```

### Remote Service (SSE)
```
Multiple OpenClaw ←→ HTTP/SSE ←→ PluresLM Service ←→ PluresDB Topic
```

### Fleet Deployment (connect-msWork)
```
Load Balancer ←→ N × PluresLM Services ←→ Shared PluresDB Topic
```

### Multi-Region P2P
```
Region A: PluresLM ←→ PluresDB Topic ←→ Hyperswarm DHT
                                     ↕
Region B: PluresLM ←→ PluresDB Topic ←→ Hyperswarm DHT
```

## Breaking Changes from v1.x

### Removed Components
- ❌ `better-sqlite3` dependency  
- ❌ All SQLite file operations
- ❌ File-based storage paths
- ❌ `memory_*` tool names (legacy)

### Added Components  
- ✅ `@plures/pluresdb` dependency
- ✅ P2P mesh synchronization
- ✅ SSE/HTTP transport support
- ✅ `pluresLM_*` tool namespace
- ✅ Distributed conflict resolution

### Changed Components
- 🔄 Configuration: File paths → Topic keys  
- 🔄 Storage: Local files → Distributed mesh
- 🔄 Sync: None → Automatic P2P replication
- 🔄 Scale: Single device → Multi-device/region

## Data Migration Path

### From v1.x (SQLite) to v2.0 (PluresDB)
1. **Export**: Use legacy `pluresLM_export_bundle` on v1.x
2. **Deploy**: Set up v2.0 with PluresDB topic
3. **Import**: Use `pluresLM_import_bundle` on v2.0
4. **Verify**: Check sync status across devices

### Compatibility Matrix
| Version | Storage | Sync | MCP Tools | Migration |
|---------|---------|------|-----------|-----------|
| v1.x    | SQLite  | None | `memory_*` | Export bundle |
| v2.0    | PluresDB | P2P | `pluresLM_*` | Import bundle |

## Security Model

### Encryption
- **At Rest**: PluresDB encryption via `PLURES_DB_SECRET`
- **In Transit**: Noise protocol over Hyperswarm DHT
- **Key Management**: Topic keys are mesh identifiers (32-byte secrets)

### Access Control
- **Mesh Access**: Possession of topic key grants read/write
- **Service Access**: MCP transport determines client authorization  
- **Network**: P2P mesh, no central servers

## Performance Characteristics

### Vector Search
- **Algorithm**: In-memory cosine similarity
- **Complexity**: O(n) linear scan over stored vectors
- **Optimization**: Threshold filtering, configurable limits
- **Scalability**: Limited by available RAM

### P2P Sync
- **Protocol**: Hyperswarm DHT with exponential backoff
- **Latency**: Sub-second for small payloads  
- **Throughput**: Limited by network bandwidth
- **Reliability**: Eventual consistency, conflict-free

## Monitoring & Observability

### Health Checks
```bash
curl http://memory-service:3001/sse  # Service availability
```

### Metrics via `pluresLM_status()`
```json
{
  "version": "2.0.0-pluresdb",
  "backend": "PluresDB", 
  "memoryCount": 1205,
  "dimension": 1536,
  "sync": {
    "topic": "abc123...",
    "connected": true,
    "peerCount": 3
  }
}
```

## Known Limitations

### v2.0 Constraints
- **Vector Search**: Linear scan (no index structures)
- **Memory Capacity**: Bounded by available RAM
- **Network Dependency**: P2P sync requires connectivity
- **Topic Security**: Topic key possession grants full access

### Future Enhancements (v2.1+)
- Vector index structures (FAISS, Annoy)
- Disk-based vector storage for large datasets
- Fine-grained access control within topics
- Multi-topic federation

## Verification Checklist

### ✅ SQLite Removal Verified
- [x] All `better-sqlite3` imports removed
- [x] No SQLite file operations in codebase  
- [x] Package.json dependencies updated
- [x] Configuration schema migrated
- [x] Tool interface updated

### ✅ PluresDB Integration Verified  
- [x] PluresDB tables defined and operational
- [x] P2P sync connectivity confirmed
- [x] Vector search functional
- [x] Multi-device replication tested

### ✅ SSE/HTTP Transport Verified
- [x] SSEServerTransport integration complete
- [x] Multi-transport configuration working
- [x] Remote service deployment tested
- [x] Load balancing compatibility confirmed

---

## Summary

PluresLM v2.0 successfully eliminates all SQLite dependencies and implements a **pure PluresDB distributed architecture** with P2P sync capabilities. The system supports both local (stdio) and remote (SSE/HTTP) deployments, enabling scalable fleet deployments for enterprise use cases like connect-msWork.

**Architecture Status**: ✅ **Production Ready**  
**SQLite References**: ❌ **Zero Remaining**  
**Distributed Capability**: ✅ **Full P2P Mesh**  
**Transport Options**: ✅ **stdio + SSE/HTTP**