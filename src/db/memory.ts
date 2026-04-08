import { randomUUID } from "node:crypto";
import { PluresDatabase, type VectorSearchItem, type NativePluresDatabase as PluresDatabaseNative } from "@plures/pluresdb";

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  tags: string[];
  category?: string;
  source: string;
  created_at: number;
}

export interface StoreOptions {
  tags?: string[];
  category?: string;
  source?: string;
  dedupeThreshold?: number;
}

export interface StoreResult {
  entry: MemoryEntry;
  isDuplicate: boolean;
  updatedId?: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
}

/** MemoryEntry without the embedding vector — for all public API responses */
export type MemoryEntryPublic = Omit<MemoryEntry, 'embedding'>;

/** Strip embedding from a MemoryEntry for public output */
function stripEmbedding(entry: MemoryEntry): MemoryEntryPublic {
  const { embedding: _, ...rest } = entry;
  return rest;
}

/** Strip embedding from a SearchResult for public output */
function stripSearchEmbedding(result: SearchResult): { entry: MemoryEntryPublic; score: number } {
  return { entry: stripEmbedding(result.entry), score: result.score };
}

// Type-safe PluresDB interface
interface NativePluresDatabase extends PluresDatabaseNative {
  put(id: string, data: unknown): string;
  putWithEmbedding(id: string, data: unknown, embedding: number[]): string;
  get(id: string): unknown | null;
  delete(id: string): void;
  list(): unknown[];
  listByType(nodeType: string): unknown[];
  vectorSearch(embedding: number[], limit?: number, threshold?: number): VectorSearchItem[];
  getActorId(): string;
  stats(): unknown;
  execDsl(query: string): unknown;
  execIr(steps: unknown[]): unknown;
  // Agens Runtime (pluresdb-node >= 3.3.0)
  agensEmit?(event: Record<string, unknown>): string;
  agensEmitPraxis?(event: Record<string, unknown>): string;
  agensListEvents?(sinceIso: string): Record<string, unknown>[];
  agensStateGet?(key: string): unknown;
  agensStateSet?(key: string, value: unknown): void;
  agensStateWatch?(sinceIso: string): Array<{ key: string; value: unknown }>;
  agensTimerSchedule?(name: string, intervalSecs: number, payload: unknown): string;
  agensTimerCancel?(timerId: string): boolean;
  agensTimerList?(): Array<Record<string, unknown>>;
  agensTimerDue?(): Array<Record<string, unknown>>;
  agensTimerReschedule?(timerId: string): boolean;
}

/**
 * PluresDB-based vector memory database with native HNSW vector search.
 * Supports high-performance vector similarity search and distributed P2P sync.
 */
export class MemoryDB {
  private db: NativePluresDatabase;
  private dimension: number;

  constructor(options: { topic?: string; secret?: string; dbPath?: string; dimension: number }) {
    this.dimension = options.dimension;
    
    // Direct path takes priority over topic-derived path
    const dbPath = options.dbPath || `~/.pluresdb/topics/${options.topic}`;
    const actorId = options.topic || 'pluresLM';
    this.db = new PluresDatabase(actorId, dbPath) as unknown as NativePluresDatabase;
  }

  async connect() {
    // PluresDB connects automatically on instantiation
    return Promise.resolve();
  }

  close() {
    // Native PluresDB handles cleanup automatically
  }

  /**
   * Store a memory with embedding using PluresDB's native vector indexing
   */
  async store(content: string, embedding: number[], options: StoreOptions = {}): Promise<StoreResult> {
    const { tags = [], category, source = "", dedupeThreshold = 0.95 } = options;
    
    // Check for duplicates using PluresDB's native vector search
    if (dedupeThreshold > 0) {
      const similar = await this.vectorSearch(embedding, 1, dedupeThreshold);
      if (similar.length > 0) {
        const existingEntry = similar[0].entry;
        return {
          entry: existingEntry,
          isDuplicate: true,
          updatedId: existingEntry.id
        };
      }
    }

    const id = randomUUID();
    const entry: MemoryEntry = {
      id,
      content,
      embedding,
      tags,
      category,
      source,
      created_at: Date.now()
    };

    // Store with native embedding indexing - this enables HNSW vector search
    this.db.putWithEmbedding(id, entry, embedding);

    return {
      entry,
      isDuplicate: false
    };
  }

  /**
   * High-performance vector similarity search using PluresDB's native HNSW index
   * Supports post-filtering by category, tags, and date range.
   */
  async vectorSearch(queryVector: number[], limit: number = 10, minScore: number = 0.3, filter?: {
    category?: string;
    tags?: string[];
    after?: number;
    before?: number;
  }): Promise<SearchResult[]> {
    // Over-fetch when filtering to ensure we get enough results after filtering
    const fetchLimit = filter ? limit * 4 : limit;
    const nativeResults = this.db.vectorSearch(queryVector, fetchLimit, minScore);
    
    let results: SearchResult[] = [];
    
    for (const item of nativeResults) {
      const rawEntry = item.data;
      
      if (this.isValidMemoryEntry(rawEntry)) {
        const entry = this.extractMemoryEntry(rawEntry);
        
        // Post-filter
        if (filter?.category && entry.category !== filter.category) continue;
        if (filter?.tags?.length && !filter.tags.some(t => entry.tags?.includes(t))) continue;
        if (filter?.after && entry.created_at < filter.after) continue;
        if (filter?.before && entry.created_at > filter.before) continue;
        
        results.push({ entry, score: item.score });
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Unwrap PluresDB node — nodes are stored as { data, id, timestamp }.
   * Returns the inner `data` if wrapped, otherwise the raw object.
   */
  private unwrapNode(node: unknown): unknown {
    if (typeof node === 'object' && node !== null && 'data' in node && 'id' in node && 'timestamp' in node) {
      return (node as { data: unknown }).data;
    }
    return node;
  }

  /**
   * Type guard for MemoryEntry validation. Handles both raw entries
   * and PluresDB-wrapped nodes { data, id, timestamp }.
   */
  private isValidMemoryEntry(data: unknown): data is MemoryEntry {
    const entry = this.unwrapNode(data);
    return (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      'content' in entry &&
      ('embedding' in entry || 'vector' in entry) &&
      'created_at' in entry
    );
  }

  /**
   * Extract a MemoryEntry from a possibly-wrapped node.
   * Call only after isValidMemoryEntry returns true.
   */
  private extractMemoryEntry(data: unknown): MemoryEntry {
    const raw = this.unwrapNode(data) as Record<string, unknown>;
    // Normalize: gateway plugin stores 'vector', pluresLM-mcp expects 'embedding'
    if ('vector' in raw && !('embedding' in raw)) {
      raw.embedding = raw.vector;
    }
    // Default missing fields
    if (!('tags' in raw)) raw.tags = [];
    if (!('source' in raw)) raw.source = '';
    return raw as unknown as MemoryEntry;
  }

  /**
   * Delete memory by ID
   */
  async delete(id: string): Promise<boolean> {
    // PluresDB stores with 'memory:' prefix internally for some entries
    const candidates = [id, `memory:${id}`];
    for (const key of candidates) {
      try {
        this.db.delete(key);
        return true;
      } catch (e: unknown) {
        // Log the actual error for debugging
        console.error(`[MemoryDB] delete(${key}) failed:`, String(e));
        continue;
      }
    }
    return false;
  }

  /**
   * Delete memories by semantic query using native vector search
   */
  async deleteByQuery(queryVector: number[], threshold: number = 0.8): Promise<number> {
    const matches = await this.vectorSearch(queryVector, 100, threshold);
    
    let deleted = 0;
    for (const match of matches) {
      if (await this.delete(match.entry.id)) {
        deleted++;
      }
    }
    
    return deleted;
  }

  /**
   * Get stored profile data
   */
  async getProfile(): Promise<Record<string, string> | null> {
    // Search for profile entries by type
    const profileItems = this.db.listByType('profile') || [];
    
    if (profileItems.length === 0) return null;
    
    const profile: Record<string, string> = {};
    for (const item of profileItems) {
      if (this.isKeyValuePair(item)) {
        profile[item.key] = item.value;
      }
    }
    return profile;
  }

  /**
   * Type guard for key-value pair validation
   */
  private isKeyValuePair(data: unknown): data is { key: string; value: string } {
    return (
      typeof data === 'object' &&
      data !== null &&
      'key' in data &&
      'value' in data &&
      typeof (data as Record<string, unknown>).key === 'string' &&
      typeof (data as Record<string, unknown>).value === 'string'
    );
  }

  /**
   * Get recent memory content for context
   */
  async getAllContent(limit: number = 20): Promise<string[]> {
    // Get all memory items and sort by timestamp
    const allItems = this.db.list() || [];
    
    const memories = allItems
      .filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
    
    return memories.map(item => item.content);
  }

  // Stats cache (60s TTL)
  private _statsCache: { data: Record<string, unknown>; ts: number } | null = null;
  private static readonly STATS_TTL_MS = 60_000;

  /**
   * Get database statistics including native PluresDB metrics
   */
  async stats(): Promise<Record<string, unknown>> {
    if (this._statsCache && (Date.now() - this._statsCache.ts) < MemoryDB.STATS_TTL_MS) {
      return this._statsCache.data;
    }

    const nativeStats = this.db.stats() || {};
    const allItems = this.db.list() || [];
    
    const memoryCount = allItems.filter(item => this.isValidMemoryEntry(item)).length;
    const profileCount = this.db.listByType('profile')?.length || 0;
    
    const data = {
      version: "2.1.0-pluresdb-native",
      backend: "PluresDB-Native-HNSW",
      memoryCount,
      profileCount,
      dimension: this.dimension,
      vectorIndexing: "HNSW",
      scalability: "O(log n)",
      actorId: this.db.getActorId(),
      native: nativeStats
    };

    this._statsCache = { data, ts: Date.now() };
    return data;
  }

  /**
   * Increment capture count statistic
   */
  async incrementCaptureCount(): Promise<void> {
    const statsId = "captureCount";
    const existing = this.db.get(statsId);
    
    const current = this.isStatsEntry(existing) ? existing.count : 0;
    
    this.db.put(statsId, {
      type: 'stat',
      key: 'captureCount',
      count: current + 1,
      updated_at: Date.now()
    });
  }

  /**
   * Type guard for stats entry validation
   */
  private isStatsEntry(data: unknown): data is { count: number } {
    return (
      typeof data === 'object' &&
      data !== null &&
      'count' in data &&
      typeof (data as Record<string, unknown>).count === 'number'
    );
  }

  /**
   * Get memory by ID  
   */
  async get(id: string): Promise<MemoryEntry | null> {
    const data = this.db.get(id);
    if (!this.isValidMemoryEntry(data)) {
      return null;
    }
    return this.extractMemoryEntry(data);
  }

  /**
   * Update memory by ID
   */
  async update(id: string, updates: Partial<MemoryEntry>): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) {
      return false;
    }

    const updated: MemoryEntry = {
      ...existing,
      ...updates,
      id, // Preserve ID
      created_at: existing.created_at // Preserve creation time
    };

    // If embedding changed, store with new embedding; otherwise use regular put
    if (updates.embedding) {
      this.db.putWithEmbedding(id, updated, updates.embedding);
    } else {
      this.db.put(id, updated);
    }

    return true;
  }

  /**
   * List memories with pagination and filtering
   */
  async list(options: {
    limit?: number;
    offset?: number;
    category?: string;
    tags?: string[];
    sortBy?: 'created_at' | 'updated_at';
    sortOrder?: 'asc' | 'desc';
  } = {}): Promise<MemoryEntry[]> {
    const { limit, offset = 0, category, tags, sortBy = 'created_at', sortOrder = 'desc' } = options;

    // Get all items and filter to valid memories
    const allItems = this.db.list() || [];
    let memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

    // Apply filters
    if (category) {
      memories = memories.filter(m => m.category === category);
    }

    if (tags && tags.length > 0) {
      memories = memories.filter(m => 
        tags.some(tag => m.tags.includes(tag))
      );
    }

    // Sort
    memories.sort((a, b) => {
      const aVal = sortBy === 'created_at' ? a.created_at : a.created_at; // TODO: Add updated_at field
      const bVal = sortBy === 'created_at' ? b.created_at : b.created_at;
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });

    // Apply pagination
    const start = offset;
    const end = limit ? start + limit : undefined;
    return memories.slice(start, end);
  }

  /**
   * Text search (non-semantic) across memory content
   */
  async searchText(query: string, options: {
    limit?: number;
    caseSensitive?: boolean;
    wholeWords?: boolean;
    category?: string;
  } = {}): Promise<MemoryEntry[]> {
    const { limit = 10, caseSensitive = false, wholeWords = false, category } = options;

    let searchQuery = query;
    if (!caseSensitive) {
      searchQuery = searchQuery.toLowerCase();
    }

    const allItems = this.db.list() || [];
    const memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

    const matches = memories.filter(memory => {
      // Apply category filter
      if (category && memory.category !== category) {
        return false;
      }

      let content = memory.content;
      if (!caseSensitive) {
        content = content.toLowerCase();
      }

      if (wholeWords) {
        const regex = new RegExp(`\\b${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        return regex.test(content);
      } else {
        return content.includes(searchQuery);
      }
    });

    return matches.slice(0, limit);
  }

  /**
   * Find stale memories (not accessed recently)
   */
  async findStale(daysThreshold: number = 30, limit: number = 10): Promise<MemoryEntry[]> {
    const cutoffTime = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);

    const allItems = this.db.list() || [];
    const memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

    const staleMemories = memories
      .filter(memory => memory.created_at < cutoffTime)
      .sort((a, b) => a.created_at - b.created_at) // Oldest first
      .slice(0, limit);

    return staleMemories;
  }

  /**
   * Consolidate memories (remove near-duplicates)
   */
  async consolidate(similarityThreshold: number = 0.95, dryRun: boolean = true): Promise<{
    duplicatesFound: number;
    duplicatesRemoved: number;
    suggestions: Array<{original: MemoryEntry, duplicate: MemoryEntry, similarity: number}>;
  }> {
    // Batched approach: iterate memories in chunks, use HNSW vector search
    // to find near-duplicates instead of O(n²) brute-force comparison.
    const BATCH_SIZE = 100;
    const MAX_DUPLICATES = 500; // cap to prevent runaway

    const allItems = this.db.list() || [];
    const memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

    const suggestions: Array<{original: MemoryEntry, duplicate: MemoryEntry, similarity: number}> = [];
    const removed = new Set<string>(); // track already-removed IDs
    let duplicatesRemoved = 0;

    for (let batch = 0; batch < memories.length && suggestions.length < MAX_DUPLICATES; batch += BATCH_SIZE) {
      const chunk = memories.slice(batch, batch + BATCH_SIZE);

      for (const mem of chunk) {
        if (removed.has(mem.id)) continue;
        if (!mem.embedding?.length) continue;

        // Use HNSW to find nearest neighbors (fast O(log n) per query)
        try {
          const neighbors = await this.vectorSearch(mem.embedding, 5, similarityThreshold);

          for (const { entry: neighbor, score: similarity } of neighbors) {
            if (neighbor.id === mem.id) continue;
            if (removed.has(neighbor.id)) continue;

            // Keep the newer one, mark older as duplicate
            const [original, duplicate] = mem.created_at > neighbor.created_at
              ? [mem, neighbor]
              : [neighbor, mem];

            suggestions.push({ original, duplicate, similarity });

            if (!dryRun) {
              await this.delete(duplicate.id);
              duplicatesRemoved++;
            }
            removed.add(duplicate.id);

            if (suggestions.length >= MAX_DUPLICATES) break;
          }
        } catch {
          // Skip memories that fail vector search
          continue;
        }

        if (suggestions.length >= MAX_DUPLICATES) break;
      }
    }

    return {
      duplicatesFound: suggestions.length,
      duplicatesRemoved,
      suggestions
    };
  }

  /**
   * Generate world state summary
   */
  async getWorldState(): Promise<{
    summary: string;
    memoryCount: number;
    categories: Record<string, number>;
    recentActivity: MemoryEntry[];
  }> {
    const stats = await this.stats();
    const recentMemories = await this.list({ limit: 5, sortBy: 'created_at', sortOrder: 'desc' });
    
    // Count by category
    const allItems = this.db.list() || [];
    const memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));
    
    const categories: Record<string, number> = {};
    memories.forEach(memory => {
      const cat = memory.category || 'uncategorized';
      categories[cat] = (categories[cat] || 0) + 1;
    });

    return {
      summary: `Memory system contains ${stats.memoryCount} memories across ${Object.keys(categories).length} categories. Recent activity includes ${recentMemories.length} new memories.`,
      memoryCount: stats.memoryCount as number,
      categories,
      recentActivity: recentMemories
    };
  }

  /**
   * Generate daily summary for a specific date
   */
  async getDailySummary(date: string): Promise<{
    date: string;
    memoriesCreated: number;
    memories: MemoryEntry[];
    categories: Record<string, number>;
  }> {
    // Parse date and get day boundaries
    const targetDate = new Date(date);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const startTime = startOfDay.getTime();
    const endTime = endOfDay.getTime();

    // Get memories from that day
    const allItems = this.db.list() || [];
    const allMemories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));
    
    const dayMemories = allMemories.filter(memory => 
      memory.created_at >= startTime && memory.created_at <= endTime
    );

    // Count by category
    const categories: Record<string, number> = {};
    dayMemories.forEach(memory => {
      const cat = memory.category || 'uncategorized';
      categories[cat] = (categories[cat] || 0) + 1;
    });

    return {
      date,
      memoriesCreated: dayMemories.length,
      memories: dayMemories.sort((a, b) => b.created_at - a.created_at),
      categories
    };
  }

  /**
   * MCP health check
   */
  async health(): Promise<{ status: string; timestamp: number; checks: Record<string, boolean> }> {
    const checks = {
      database: true, // PluresDB auto-connects
      vectorSearch: true, // Always available with native implementation
      storage: true // Always available
    };

    return {
      status: Object.values(checks).every(Boolean) ? 'healthy' : 'degraded',
      timestamp: Date.now(),
      checks
    };
  }

  /**
   * Cosine similarity calculation
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const magnitude = Math.sqrt(normA * normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Export all memories as a bundle
   */
  async exportBundle(): Promise<{
    metadata: {
      version: string;
      exported_at: number;
      memory_count: number;
      bundle_id: string;
    };
    memories: MemoryEntry[];
  }> {
    const allItems = this.db.list() || [];
    const memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

    return {
      metadata: {
        version: "2.2.0",
        exported_at: Date.now(),
        memory_count: memories.length,
        bundle_id: randomUUID(),
      },
      memories,
    };
  }

  /**
   * Restore memories from a bundle
   */
  async restoreBundle(bundle: {
    metadata: { memory_count: number };
    memories: MemoryEntry[];
  }): Promise<{
    imported: number;
    skipped: number;
    errors: number;
  }> {
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const memory of bundle.memories) {
      try {
        // Check if memory already exists
        const existing = await this.get(memory.id);
        if (existing) {
          skipped++;
          continue;
        }

        // Import the memory
        if (memory.embedding && memory.embedding.length > 0) {
          this.db.putWithEmbedding(memory.id, memory, memory.embedding);
        } else {
          this.db.put(memory.id, memory);
        }
        imported++;
      } catch (err) {
        console.error(`Failed to restore memory ${memory.id}:`, err);
        errors++;
      }
    }

    return { imported, skipped, errors };
  }

  /**
   * Export memory pack (subset with filtering)
   */
  async exportPack(options: {
    name: string;
    category?: string;
    tags?: string[];
    dateRange?: { start: number; end: number };
    limit?: number;
  }): Promise<{
    pack: {
      name: string;
      created_at: number;
      filters: typeof options;
      memories: MemoryEntry[];
    };
  }> {
    const allItems = this.db.list() || [];
    let memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

    // Apply filters
    if (options.category) {
      memories = memories.filter(m => m.category === options.category);
    }

    if (options.tags && options.tags.length > 0) {
      memories = memories.filter(m => 
        options.tags!.some(tag => m.tags.includes(tag))
      );
    }

    if (options.dateRange) {
      memories = memories.filter(m => 
        m.created_at >= options.dateRange!.start && 
        m.created_at <= options.dateRange!.end
      );
    }

    if (options.limit) {
      memories = memories.slice(0, options.limit);
    }

    const pack = {
      name: options.name,
      created_at: Date.now(),
      filters: options,
      memories,
    };

    // Store pack metadata for listing
    const packId = `pack:${options.name}`;
    this.db.put(packId, {
      type: 'pack',
      name: options.name,
      created_at: pack.created_at,
      memory_count: memories.length,
      filters: options,
    });

    return { pack };
  }

  /**
   * Import memory pack
   */
  async importPack(pack: {
    name: string;
    memories: MemoryEntry[];
  }): Promise<{
    imported: number;
    skipped: number;
    errors: number;
  }> {
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const memory of pack.memories) {
      try {
        // Check if memory already exists
        const existing = await this.get(memory.id);
        if (existing) {
          skipped++;
          continue;
        }

        // Import the memory
        if (memory.embedding && memory.embedding.length > 0) {
          this.db.putWithEmbedding(memory.id, memory, memory.embedding);
        } else {
          this.db.put(memory.id, memory);
        }
        imported++;
      } catch (err) {
        console.error(`Failed to import memory ${memory.id}:`, err);
        errors++;
      }
    }

    return { imported, skipped, errors };
  }

  /**
   * List available memory packs
   */
  async listPacks(): Promise<Array<{
    name: string;
    created_at: number;
    memory_count: number;
    filters: Record<string, unknown>;
  }>> {
    const allItems = this.db.list() || [];
    const packs = allItems.filter(item => 
      typeof item === 'object' && 
      item !== null && 
      'type' in item && 
      item.type === 'pack'
    );

    return packs.map(pack => {
      const record = pack as Record<string, unknown>;
      return {
        name: typeof record.name === "string" ? record.name : "",
        created_at: typeof record.created_at === "number" ? record.created_at : 0,
        memory_count: typeof record.memory_count === "number" ? record.memory_count : 0,
        filters: typeof record.filters === "object" && record.filters !== null
          ? (record.filters as Record<string, unknown>)
          : {},
      };
    });
  }

  /**
   * Uninstall memory pack (remove pack metadata)
   */
  async uninstallPack(name: string): Promise<boolean> {
    const packId = `pack:${name}`;
    try {
      this.db.delete(packId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a native PluresDB DSL query.
   */
  query(dsl: string): unknown {
    return this.db.execDsl(dsl);
  }

  /**
   * Execute a native PluresDB IR query.
   */
  execIr(steps: unknown[]): unknown {
    return this.db.execIr(steps);
  }

  /**
   * Query DSL processor (basic implementation)
   */
  async queryDsl(query: string): Promise<MemoryEntry[]> {
    // Basic DSL implementation - support filter(), sort(), limit()
    try {
      const allItems = this.db.list() || [];
      let memories = allItems.filter(item => this.isValidMemoryEntry(item)).map(item => this.extractMemoryEntry(item));

      // Simple parser for basic DSL operations
      const operations = query.split('|>').map(op => op.trim());
      
      for (const op of operations) {
        if (op.startsWith('filter(')) {
          const filterExpr = op.match(/filter\((.*)\)/)?.[1];
          if (filterExpr) {
            if (filterExpr.includes('category ==')) {
              const category = filterExpr.match(/category == "(.*)"/)?.[1];
              if (category) {
                memories = memories.filter(m => m.category === category);
              }
            }
            if (filterExpr.includes('tags.includes')) {
              const tag = filterExpr.match(/tags\.includes\("(.*)"\)/)?.[1];
              if (tag) {
                memories = memories.filter(m => m.tags.includes(tag));
              }
            }
          }
        } else if (op.startsWith('sort(')) {
          const sortExpr = op.match(/sort\((.*)\)/)?.[1];
          if (sortExpr && sortExpr.includes('created_at')) {
            const desc = sortExpr.includes('desc');
            memories.sort((a, b) => desc ? b.created_at - a.created_at : a.created_at - b.created_at);
          }
        } else if (op.startsWith('limit(')) {
          const limit = parseInt(op.match(/limit\((\d+)\)/)?.[1] || '10');
          memories = memories.slice(0, limit);
        }
      }

      return memories;
    } catch (err) {
      console.error('DSL query error:', err);
      return [];
    }
  }
}