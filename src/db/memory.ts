import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: string; // JSON stringified array
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
 * Local SQLite-based vector memory database.
 * Supports storage, cosine similarity search, and CRUD operations.
 */
export class MemoryDB {
  private db: Database.Database;
  private dimension: number;

  constructor(dbPath: string, dimension: number) {
    this.dimension = dimension;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initTables();
    this.validateDimension();
  }

  private initTables() {
    // Create memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        tags TEXT,
        category TEXT,
        source TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    // Create metadata table for stats
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Initialize capture count if not exists
    const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
    const row = stmt.get("capture_count") as { value: string } | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
        "capture_count",
        "0"
      );
    }
  }

  /**
   * Validate that existing embeddings in the database match the configured dimension.
   * This prevents dimension mismatches when switching between embedding providers.
   */
  private validateDimension() {
    const stmt = this.db.prepare("SELECT embedding FROM memories LIMIT 1");
    const row = stmt.get() as { embedding: string } | undefined;

    if (row) {
      try {
        const existingEmbedding = JSON.parse(row.embedding) as number[];
        if (existingEmbedding.length !== this.dimension) {
          throw new Error(
            `Database dimension mismatch: Database contains ${existingEmbedding.length}-dim embeddings, ` +
            `but configured provider uses ${this.dimension}-dim embeddings. ` +
            `To fix this, either:\n` +
            `  1. Set OPENAI_API_KEY to use OpenAI (1536-dim) if database was created with OpenAI\n` +
            `  2. Use a new database path with SUPERLOCALMEMORY_DB_PATH\n` +
            `  3. Delete the existing database to start fresh with ${this.dimension}-dim embeddings`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Database dimension mismatch")) {
          throw err;
        }
        // Ignore JSON parse errors for corrupted data - will be handled during search
      }
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  /**
   * Store a memory with deduplication
   */
  async store(
    content: string,
    embedding: number[],
    options: StoreOptions = {}
  ): Promise<StoreResult> {
    const {
      tags = [],
      category,
      source = "",
      dedupeThreshold = 0.95,
    } = options;

    // Check for duplicates
    const existing = await this.findSimilar(embedding, dedupeThreshold);

    if (existing) {
      // Update existing entry
      const stmt = this.db.prepare(
        "UPDATE memories SET content = ?, embedding = ?, tags = ?, category = ?, source = ?, created_at = ? WHERE id = ?"
      );
      stmt.run(
        content,
        JSON.stringify(embedding),
        JSON.stringify(tags),
        category || null,
        source,
        Date.now(),
        existing.id
      );

      return {
        entry: {
          ...existing,
          content,
          embedding: JSON.stringify(embedding),
          tags,
          category,
          source,
          created_at: Date.now(),
        },
        isDuplicate: true,
        updatedId: existing.id,
      };
    }

    // Insert new entry
    const id = randomUUID();
    const created_at = Date.now();

    const stmt = this.db.prepare(
      "INSERT INTO memories (id, content, embedding, tags, category, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.run(
      id,
      content,
      JSON.stringify(embedding),
      JSON.stringify(tags),
      category || null,
      source,
      created_at
    );

    return {
      entry: {
        id,
        content,
        embedding: JSON.stringify(embedding),
        tags,
        category,
        source,
        created_at,
      },
      isDuplicate: false,
    };
  }

  /**
   * Find a similar memory above threshold (for deduplication)
   */
  private async findSimilar(
    embedding: number[],
    threshold: number
  ): Promise<MemoryEntry | null> {
    const results = await this.vectorSearch(embedding, 1, threshold);
    return results.length > 0 ? results[0].entry : null;
  }

  /**
   * Vector search using cosine similarity.
   * 
   * Performance note: This implementation loads all embeddings into memory and performs
   * brute-force cosine similarity computation. For large databases (>10,000 memories),
   * this may have performance implications. Future optimizations could include:
   * - Approximate nearest neighbor search (ANN)
   * - Vector indexing (e.g., HNSW, IVF)
   * - Limiting search scope with filters
   */
  async vectorSearch(
    queryEmbedding: number[],
    limit = 5,
    minScore = 0.3
  ): Promise<SearchResult[]> {
    const stmt = this.db.prepare("SELECT * FROM memories");
    const rows = stmt.all() as Array<{
      id: string;
      content: string;
      embedding: string;
      tags: string;
      category: string | null;
      source: string;
      created_at: number;
    }>;

    const results: SearchResult[] = [];

    for (const row of rows) {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding) as number[];
      } catch (err) {
        console.warn(
          `Skipping memory entry with invalid embedding JSON (id=${row.id}):`,
          err
        );
        continue;
      }
      const score = this.cosineSimilarity(queryEmbedding, embedding);

      if (score >= minScore) {
        results.push({
          entry: {
            id: row.id,
            content: row.content,
            embedding: row.embedding,
            tags: JSON.parse(row.tags || "[]") as string[],
            category: row.category || undefined,
            source: row.source,
            created_at: row.created_at,
          },
          score,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Limit results
    return results.slice(0, limit);
  }

  /**
   * Delete a memory by ID
   */
  delete(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  /**
   * Delete memories matching a query above threshold
   */
  async deleteByQuery(
    queryEmbedding: number[],
    threshold = 0.8
  ): Promise<number> {
    const matches = await this.vectorSearch(queryEmbedding, 100, threshold);
    let deleted = 0;

    for (const match of matches) {
      this.delete(match.entry.id);
      deleted++;
    }

    return deleted;
  }

  /**
   * Get user profile (stub - not implemented in core)
   */
  getProfile(): string | null {
    const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
    const row = stmt.get("profile") as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Get all memory content (limited)
   */
  getAllContent(limit = 20): string[] {
    const stmt = this.db.prepare(
      "SELECT content FROM memories ORDER BY created_at DESC LIMIT ?"
    );
    const rows = stmt.all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  /**
   * Get database statistics
   */
  stats(): {
    totalMemories: number;
    captureCount: number;
    dimension: number;
  } {
    const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM memories");
    const countRow = countStmt.get() as { count: number };

    const captureStmt = this.db.prepare(
      "SELECT value FROM metadata WHERE key = ?"
    );
    const captureRow = captureStmt.get("capture_count") as
      | { value: string }
      | undefined;

    return {
      totalMemories: countRow.count,
      captureCount: captureRow ? parseInt(captureRow.value, 10) : 0,
      dimension: this.dimension,
    };
  }

  /**
   * Increment capture count
   */
  incrementCaptureCount(): void {
    const stmt = this.db.prepare(
      "UPDATE metadata SET value = CAST((CAST(value AS INTEGER) + 1) AS TEXT) WHERE key = ?"
    );
    stmt.run("capture_count");
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
