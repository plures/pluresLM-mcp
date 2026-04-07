# PluresLM Memory System Hardening Plan

## Date: 2026-04-07
## Status: PLANNING — measure twice, cut once

---

## Audit Findings

### What's Broken or Fragile

| # | Issue | Impact | Root Cause |
|---|-------|--------|------------|
| 1 | **No version tracking** | Can't tell what code is running | No version in startup log, no build hash |
| 2 | **Graceful shutdown takes 90s+** | Restarts stall, can't iterate | No TimeoutStopSec, 11GB embedding model in memory |
| 3 | **No memory limit** | OOM at 13GB, kernel kills | No MemoryMax in systemd unit |
| 4 | **vectorSearch ignores category/tag filters** | Search returns irrelevant results | Native HNSW doesn't filter, post-filter not implemented |
| 5 | **searchText only searches content** | Tags, categories invisible to text search | Filter only checks `memory.content.includes(query)` |
| 6 | **Every query loads ALL entries** | list(), searchText(), stats(), consolidate() all do `this.db.list()` | No index-side filtering |
| 7 | **Procedure update creates duplicates** | Fixed in code but older entries still in DB | update() was store() without delete — fixed tonight |
| 8 | **No live logging/observability** | Guessing at runtime state | Praxis engine exists but no structured log output |
| 9 | **Embedding model loads in 120s** | Long restart window | Transformers.js FP32 on CPU, no caching |
| 10 | **Plugin MCP session not resilient** | Tools fail after daemon restart until next search | Session reset only on specific error codes |

### What's Missing

| # | Capability | Why It Matters |
|---|-----------|----------------|
| 1 | **Filtered vector search** | "Find similar memories BUT only in error-fix category" — basic requirement |
| 2 | **Tag-based search** | "Find all memories tagged copilot" — impossible today |
| 3 | **Date range queries** | "What did I learn this week?" — can't do it |
| 4 | **Combined queries** | Vector + category + date + tag in one call — need SQL-like flexibility |
| 5 | **Search result quality** | Embeddings return 384-dim arrays in output — massive token waste |
| 6 | **Health endpoint with version** | `GET /health` should report version, uptime, memory, procedure count |

---

## The Plan

### Phase 1: Operational Hardening (do first — foundation)

**Goal: Never guess at runtime state again.**

#### 1a. Systemd Unit Hardening
```ini
[Service]
MemoryMax=4G              # Kill before 13GB OOM
TimeoutStopSec=10         # Force-kill after 10s, not 90
WatchdogSec=300           # Restart if health check fails for 5min
Environment=NODE_OPTIONS="--max-old-space-size=3072"  # Cap V8 heap
```

#### 1b. Version & Build Tracking
- Generate `dist/BUILD_INFO.json` at compile time: `{ version, gitSha, buildTime }`
- Startup log: `[pluresLM-mcp] v2.12.0 (abc123) starting — DB: /path, embeddings: bge-small-en-v1.5`
- Health endpoint: return version, uptime, memory usage, procedure count, embedding model

#### 1c. Structured Logging
- Log every tool call: `[tool] pluresLM_search query="copilot" limit=5 → 5 results (42ms)`
- Log procedure fires: `[proc] praxis-evidence-capture fired (after_store) → 3 related found (35ms)`
- Log errors with context: `[error] pluresLM_consolidate failed: OOM at 4GB limit (3596 memories)`

#### 1d. Plugin Session Resilience
- Auto-reset MCP session on ANY error, not just specific codes
- Retry with fresh session before returning error to agent

### Phase 2: Search Capabilities (core value)

**Goal: Search as powerful as the data we store.**

#### 2a. Filtered Vector Search
Add post-filter to `vectorSearch()`:
```typescript
async vectorSearch(query: number[], limit: number, minScore: number, 
  filter?: { category?: string; tags?: string[]; after?: number; before?: number }
): Promise<SearchResult[]> {
  // Over-fetch from HNSW (limit * 3), then filter, return limit
  const raw = this.db.vectorSearch(query, limit * 3, minScore);
  let results = raw.filter(r => this.isValidMemoryEntry(r.data))
    .map(r => ({ entry: this.extractMemoryEntry(r.data), score: r.score }));
  
  if (filter?.category) results = results.filter(r => r.entry.category === filter.category);
  if (filter?.tags?.length) results = results.filter(r => 
    filter.tags!.some(t => r.entry.tags?.includes(t)));
  if (filter?.after) results = results.filter(r => r.entry.created_at >= filter.after!);
  if (filter?.before) results = results.filter(r => r.entry.created_at <= filter.before!);
  
  return results.slice(0, limit);
}
```

#### 2b. Tag & Category Search
Add dedicated search by tag/category without needing vector:
```typescript
async searchByTag(tags: string[], opts?: { limit?: number; category?: string }): Promise<MemoryEntry[]>
async searchByCategory(category: string, opts?: { limit?: number; sortBy?: string }): Promise<MemoryEntry[]>
```

#### 2c. Date Range Queries
```typescript
async searchByDateRange(after: number, before: number, opts?: { category?: string; limit?: number }): Promise<MemoryEntry[]>
```

#### 2d. Unified Search Tool
Expose a single `pluresLM_search` that accepts all filter types:
```json
{
  "query": "copilot assignment",     // semantic (optional)
  "category": "error-fix",           // exact match (optional) 
  "tags": ["copilot", "github"],     // any-match (optional)
  "after": "2026-04-01",             // date range (optional)
  "before": "2026-04-07",
  "limit": 10
}
```

#### 2e. Strip Embeddings from Output
Never return 384-dim float arrays in tool results. Content, category, tags, score, date — that's it.

### Phase 3: Procedure Engine Hardening

**Goal: Procedures are reliable automation, not fragile scripts.**

#### 3a. Procedure Dedup on Load
`loadFromDb` should deduplicate by name (keep highest version only) and clean up stale entries.

#### 3b. Variable Resolution Tests
Add unit tests for `_resolveVar`:
- `$input.query` → nested access
- `$results` → bare name (no $ in vars)
- `$input.nested.deep.path` → multi-level
- `$nonexistent` → returns raw string

#### 3c. Procedure Execution Logging
Every step logged: `[proc:task-lifecycle] step 1/5: search (constraints) → 5 results (42ms)`

### Phase 4: Performance (stop loading everything)

**Goal: O(log n) for all operations, not O(n).**

#### 4a. Index-Side Category/Tag Filtering
Use PluresDB IR `filter` op to reduce dataset before processing:
```typescript
// Instead of: this.db.list() → filter in JS
// Use: this.db.execIr([{ op: "filter", predicate: { field: "category", cmp: "==", value: "error-fix" } }])
```

#### 4b. Stats Cache
Cache `stats()` result for 60s — no need to scan all entries every call.

#### 4c. Embedding Model Optimization
Investigate: can we use ONNX quantized model (INT8) instead of FP32? Would cut memory from ~10GB to ~2GB.

---

## Execution Order

1. **Phase 1** (1a–1d) — operational hardening. No feature changes, just stop guessing.
2. **Phase 2a** — filtered vector search. Biggest bang for the buck.
3. **Phase 2e** — strip embeddings from output. Easy win.
4. **Phase 2d** — unified search tool. Wire it end-to-end.
5. **Phase 3a** — procedure dedup cleanup.
6. **Phase 3c** — procedure logging.
7. **Phase 4** — performance (only if Phase 2 reveals bottlenecks).

## Files to Change

| File | Changes |
|------|---------|
| `pluresLM-mcp.service` | MemoryMax, TimeoutStopSec, WatchdogSec, NODE_OPTIONS |
| `src/server.ts` | Version logging, structured tool logging, enriched health endpoint |
| `src/db/memory.ts` | Filtered vectorSearch, tag search, date range, strip embeddings |
| `src/procedures.ts` | Dedup on load, execution logging, variable resolution hardening |
| `superlocalmemory/src/http-service-client.ts` | Session auto-reset on any error |
| `superlocalmemory/src/index.ts` | Pass filter params through to daemon |
| `package.json` | Build script for BUILD_INFO.json |

## Success Criteria

- [ ] `systemctl --user status pluresLM-mcp` shows version, memory capped at 4GB
- [ ] `pluresLM_search` with `category="error-fix"` returns only error-fixes
- [ ] `pluresLM_search` with `tags=["copilot"]` returns only copilot-tagged memories  
- [ ] Search results never contain embedding arrays
- [ ] Procedure create → update → delete → restart → verify 0 zombies
- [ ] Every tool call logged with timing
- [ ] Daemon stops in <10s
- [ ] Daemon starts and is healthy in <30s (if cached) or <150s (cold)
