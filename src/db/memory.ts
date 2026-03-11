import { randomUUID } from "node:crypto";
import PluresDatabase from "@plures/pluresdb";

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[]; // Native array, not JSON string
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

/**
 * PluresDB-based vector memory database with native HNSW vector search.
 * Supports high-performance vector similarity search and distributed P2P sync.
 */
export class MemoryDB {
  private db: any; // Native PluresDB instance
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
    const txnId = this.db.putWithEmbedding(id, entry, embedding);

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
      // Convert native result to our SearchResult format
      const entry = item.data as MemoryEntry;
      
      // Ensure the entry has the expected structure
      if (entry && typeof entry === 'object' && 'id' in entry && 'content' in entry) {
        results.push({
          entry: {
            id: entry.id,
            content: entry.content,
            embedding: entry.embedding || [],
            tags: entry.tags || [],
            category: entry.category,
            source: entry.source || '',
            created_at: entry.created_at || 0
          },
          score: item.score
        });
      }
    }

    return results;
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
      if (item && typeof item === 'object' && 'key' in item && 'value' in item) {
        profile[item.key as string] = item.value as string;
      }
    }
    return profile;
  }

  /**
   * Get recent memory content for context
   */
  async getAllContent(limit: number = 20): Promise<string[]> {
    // Get all memory items and sort by timestamp
    const allItems = this.db.list() || [];
    
    const memories = allItems
      .filter((item: any) => item && item.content && typeof item.content === 'string')
      .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, limit);
    
    return memories.map((item: any) => item.content as string);
  }

  /**
   * Get database statistics including native PluresDB metrics
   */
  async stats(): Promise<Record<string, unknown>> {
    const nativeStats = this.db.stats() || {};
    const allItems = this.db.list() || [];
    
    const memoryCount = allItems.filter((item: any) => 
      item && item.content && typeof item.content === 'string'
    ).length;
    
    const profileCount = this.db.listByType('profile')?.length || 0;
    
    return {
      version: "2.0.0-pluresdb-native",
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
    const current = (existing && typeof existing === 'object' && 'count' in existing) 
      ? (existing.count as number) 
      : 0;
    
    this.db.put(statsId, {
      type: 'stat',
      key: 'captureCount',
      count: current + 1,
      updated_at: Date.now()
    });
  }
}