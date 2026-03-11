import { randomUUID } from "node:crypto";
import { PluresDB } from "@plures/pluresdb";

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
 * PluresDB-based vector memory database.
 * Supports storage, cosine similarity search, and distributed sync.
 */
export class MemoryDB {
  private db: PluresDB;
  private dimension: number;

  constructor(topic: string, secret: string | undefined, dimension: number) {
    this.dimension = dimension;
    this.db = new PluresDB({
      topic,
      secret,
      // Use built-in tables for memories
      tables: {
        memories: {
          id: 'string',
          content: 'string', 
          embedding: 'json',
          tags: 'json',
          category: 'string?',
          source: 'string',
          created_at: 'number',
        },
        profile: {
          key: 'string',
          value: 'string',
          updated_at: 'number',
        },
        stats: {
          key: 'string',
          value: 'number',
          updated_at: 'number',
        }
      }
    });
  }

  async connect() {
    await this.db.connect();
  }

  close() {
    this.db.disconnect();
  }

  /**
   * Store a memory with embedding and metadata
   */
  async store(content: string, embedding: number[], options: StoreOptions = {}): Promise<StoreResult> {
    const { tags = [], category, source = "", dedupeThreshold = 0.95 } = options;
    
    // Check for duplicates using cosine similarity
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

    // Store in PluresDB
    await this.db.insert('memories', entry);

    return {
      entry,
      isDuplicate: false
    };
  }

  /**
   * Vector similarity search using cosine distance
   */
  async vectorSearch(queryVector: number[], limit: number = 10, minScore: number = 0.3): Promise<SearchResult[]> {
    // Get all memories and compute cosine similarity
    const allMemories = await this.db.select('memories', {});
    
    const results: SearchResult[] = [];
    
    for (const row of allMemories) {
      const entry: MemoryEntry = {
        id: row.id as string,
        content: row.content as string,
        embedding: row.embedding as number[],
        tags: (row.tags as string[]) || [],
        category: row.category as string | undefined,
        source: row.source as string,
        created_at: row.created_at as number
      };

      const score = this.cosineSimilarity(queryVector, entry.embedding);
      if (score >= minScore) {
        results.push({ entry, score });
      }
    }

    // Sort by score descending and limit
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Delete memory by ID
   */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.db.delete('memories', { id });
    return deleted > 0;
  }

  /**
   * Delete memories by semantic query
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
    const rows = await this.db.select('profile', {});
    if (rows.length === 0) return null;
    
    const profile: Record<string, string> = {};
    for (const row of rows) {
      profile[row.key as string] = row.value as string;
    }
    return profile;
  }

  /**
   * Get recent memory content for context
   */
  async getAllContent(limit: number = 20): Promise<string[]> {
    const rows = await this.db.select('memories', {}, {
      orderBy: [['created_at', 'desc']],
      limit
    });
    
    return rows.map(row => row.content as string);
  }

  /**
   * Get database statistics
   */
  async stats(): Promise<Record<string, unknown>> {
    const memoryCount = await this.db.count('memories');
    const profileCount = await this.db.count('profile');
    
    return {
      version: "2.0.0-pluresdb",
      backend: "PluresDB",
      memoryCount,
      profileCount,
      dimension: this.dimension,
      sync: {
        topic: this.db.getTopic(),
        connected: this.db.isConnected(),
        peerCount: this.db.getPeerCount()
      }
    };
  }

  /**
   * Increment capture count statistic
   */
  async incrementCaptureCount(): Promise<void> {
    const existing = await this.db.select('stats', { key: 'captureCount' });
    const current = existing.length > 0 ? (existing[0].value as number) : 0;
    
    await this.db.upsert('stats', {
      key: 'captureCount',
      value: current + 1,
      updated_at: Date.now()
    });
  }

  /**
   * Compute cosine similarity between two vectors
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