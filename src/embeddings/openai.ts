import type { EmbeddingProvider } from "./transformers.js";

/**
 * OpenAI embedding provider (optional, requires openai package and API key).
 * Uses text-embedding-3-small with 1536 dimensions.
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  public readonly dimension = 1536;
  private client: any;
  private model: string;
  private debug: boolean;

  constructor(apiKey: string, model = "text-embedding-3-small", debug = false) {
    this.model = model;
    this.debug = debug;

    try {
      // Dynamic import to make openai optional
      const openaiModule = require("openai");
      const OpenAI = openaiModule.default || openaiModule;
      this.client = new OpenAI({ apiKey });

      if (this.debug) {
        console.error(`[OpenAIEmbeddings] Initialized with model ${this.model}`);
      }
    } catch (err) {
      throw new Error(
        "OpenAI package not available. Install with: npm install openai"
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
      });

      const embedding = response.data[0].embedding;

      // Validate dimension
      if (embedding.length !== this.dimension) {
        throw new Error(
          `Expected ${this.dimension}-dim embedding but got ${embedding.length}-dim from OpenAI`
        );
      }

      if (this.debug) {
        console.error(
          `[OpenAIEmbeddings] Generated embedding of dimension ${embedding.length} for text of length ${text.length}`
        );
      }

      return embedding;
    } catch (err) {
      throw new Error(`OpenAI embedding failed: ${(err as Error).message}`);
    }
  }
}
