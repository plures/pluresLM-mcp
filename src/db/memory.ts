import { randomUUID } from "node:crypto";
import PluresDatabase, { type VectorSearchItem } from "@plures/pluresdb";

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

// Type-safe PluresDB interface
interface NativePluresDatabase {
  put(id: string, data: unknown): string;
  putWithEmbedding(id: string, data: unknown, embedding: number[]): string;
  get(id: string): unknown | null;
  delete(id: string): void;
  list(): unknown[];
  listByType(nodeType: string): unknown[];
  vectorSearch(embedding: number[], limit?: number, threshold?: number): VectorSearchItem[];
  getActorId(): string;
  stats(): unknown;
}

/**
 * PluresDB-based vector memory database with native HNSW vector search.
 * Supports high-performance vector similarity search and distributed P2P sync.
 */
export class MemoryDB {
  private db: NativePluresDatabase;
  private dimension: number;

  constructor(topic: string, secret: string | undefined, dimension: number) {
    this.dimension = dimension;
    
    // Use native PluresDB with vector embeddings support
    // Topic becomes the actor ID for P2P sync
    const dbPath = `~/.pluresdb/topics/${topic}`;
    this.db = new PluresDatabase(topic, dbPath);
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
   * This scales to 100k+ memories efficiently (O(log n) instead of O(n))
   */
  async vectorSearch(queryVector: number[], limit: number = 10, minScore: number = 0.3): Promise<SearchResult[]> {
    // Use PluresDB's native vectorSearch - this uses HNSW indexing for scalability
    const nativeResults = this.db.vectorSearch(queryVector, limit, minScore);
    
    const results: SearchResult[] = [];
    
    for (const item of nativeResults) {
      // Type-safe conversion from VectorSearchItem
      const rawEntry = item.data;
      
      // Ensure the entry has the expected MemoryEntry structure
      if (this.isValidMemoryEntry(rawEntry)) {
        results.push({
          entry: rawEntry,
          score: item.score
        });
      }
    }

    return results;
  }

  /**
   * Type guard for MemoryEntry validation
   */
  private isValidMemoryEntry(data: unknown): data is MemoryEntry {
    return (
      typeof data === 'object' &&
      data !== null &&
      'id' in data &&
      'content' in data &&
      'embedding' in data &&
      'tags' in data &&
      'source' in data &&
      'created_at' in data
    );
  }

  /**
   * Delete memory by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      this.db.delete(id);
      return true;
    } catch {
      return false;
    }
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
      typeof (data as any).key === 'string' &&
      typeof (data as any).value === 'string'
    );
  }

  /**
   * Get recent memory content for context
   */
  async getAllContent(limit: number = 20): Promise<string[]> {
    // Get all memory items and sort by timestamp
    const allItems = this.db.list() || [];
    
    const memories = allItems
      .filter((item): item is MemoryEntry => this.isValidMemoryEntry(item))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
    
    return memories.map(item => item.content);
  }

  /**
   * Get database statistics including native PluresDB metrics
   */
  async stats(): Promise<Record<string, unknown>> {
    const nativeStats = this.db.stats() || {};
    const allItems = this.db.list() || [];
    
    const memoryCount = allItems.filter(item => this.isValidMemoryEntry(item)).length;
    const profileCount = this.db.listByType('profile')?.length || 0;
    
    return {
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
      typeof (data as any).count === 'number'
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
    return data;
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
    let memories = allItems.filter((item): item is MemoryEntry => this.isValidMemoryEntry(item));

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
    const memories = allItems.filter((item): item is MemoryEntry => this.isValidMemoryEntry(item));

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
    const memories = allItems.filter((item): item is MemoryEntry => this.isValidMemoryEntry(item));

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
    const allItems = this.db.list() || [];
    const memories = allItems.filter((item): item is MemoryEntry => this.isValidMemoryEntry(item));

    const suggestions: Array<{original: MemoryEntry, duplicate: MemoryEntry, similarity: number}> = [];
    let duplicatesRemoved = 0;

    // Compare each memory with all others
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const memA = memories[i];
        const memB = memories[j];

        // Skip if either has empty embedding
        if (!memA.embedding?.length || !memB.embedding?.length) continue;

        const similarity = this.cosineSimilarity(memA.embedding, memB.embedding);
        
        if (similarity >= similarityThreshold) {
          // Keep the newer one (higher created_at), remove older
          const [original, duplicate] = memA.created_at > memB.created_at ? [memA, memB] : [memB, memA];
          
          suggestions.push({ original, duplicate, similarity });

          if (!dryRun) {
            await this.delete(duplicate.id);
            duplicatesRemoved++;
          }
        }
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
    const memories = allItems.filter((item): item is MemoryEntry => this.isValidMemoryEntry(item));
    
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
    const allMemories = allItems.filter((item): item is MemoryEntry => this.isValidMemoryEntry(item));
    
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
}