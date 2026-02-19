import { pipeline, env } from "@huggingface/transformers";
import os from "node:os";
import path from "node:path";

// Configure cache directory (customizable via environment variable)
const cacheDir = 
  process.env.SUPERLOCALMEMORY_CACHE_DIR ||
  path.join(os.homedir(), ".cache", "superlocalmemory", "transformers");
env.cacheDir = cacheDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

// Type for the feature-extraction pipeline used in this class.
// Using a simpler interface to avoid overly complex union types.
interface EmbeddingPipeline {
  (text: string, options: { pooling: string; normalize: boolean }): Promise<{ data: ArrayLike<number> }>;
}

/**
 * Transformers.js embedding provider using bge-small-en-v1.5 (384 dimensions).
 * This runs entirely in-process with no external API calls (after initial model download).
 */
export class TransformersEmbeddings implements EmbeddingProvider {
  public readonly dimension = 384;
  private pipeline: EmbeddingPipeline | null = null;
  private readonly model = "Xenova/bge-small-en-v1.5";
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  private async ensurePipeline() {
    if (!this.pipeline) {
      if (this.debug) {
        console.error(`[TransformersEmbeddings] Loading model ${this.model}...`);
        console.error(`[TransformersEmbeddings] Cache directory: ${cacheDir}`);
        console.error(`[TransformersEmbeddings] Note: First run will download the model (~100MB), subsequent runs use cache`);
      }
      
      try {
        this.pipeline = (await pipeline("feature-extraction", this.model)) as any as EmbeddingPipeline;
        if (this.debug) {
          console.error(`[TransformersEmbeddings] Model loaded successfully`);
        }
      } catch (err) {
        const error = err as Error;
        throw new Error(
          `Failed to load embedding model: ${error.message}. ` +
          `This may be due to network restrictions or missing model files. ` +
          `Try running with network access first to download the model, or set OPENAI_API_KEY as fallback.`
        );
      }
    }
    return this.pipeline;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.ensurePipeline();
    
    // Generate embeddings
    const output = await pipe(text, { pooling: "mean", normalize: true });
    
    // Convert to regular array
    const embedding = Array.from(output.data) as number[];
    
    if (this.debug) {
      console.error(
        `[TransformersEmbeddings] Generated embedding of dimension ${embedding.length} for text of length ${text.length}`
      );
    }

    if (embedding.length !== this.dimension) {
      throw new Error(
        `Expected ${this.dimension}-dim embedding but got ${embedding.length}-dim`
      );
    }
    return embedding;
  }
}
