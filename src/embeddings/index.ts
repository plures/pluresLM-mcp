import { TransformersEmbeddings } from "./transformers.js";
import { OpenAIEmbeddings } from "./openai.js";
import type { EmbeddingProvider } from "./transformers.js";

export type { EmbeddingProvider };
export { TransformersEmbeddings, OpenAIEmbeddings };

export interface EmbeddingConfig {
  openaiApiKey?: string;
  openaiModel?: string;
  debug?: boolean;
}

/**
 * Create an embedding provider based on available configuration.
 * Defaults to Transformers.js (zero-config), with OpenAI as optional override.
 */
export async function createEmbeddings(
  config: EmbeddingConfig = {}
): Promise<EmbeddingProvider> {
  const { openaiApiKey, openaiModel, debug = false } = config;

  // If OpenAI key is provided, use OpenAI (fail fast on error)
  if (openaiApiKey) {
    if (debug) {
      console.error("[Embeddings] Using OpenAI provider");
    }
    // When an explicit OpenAI API key is provided, fail fast instead of silently
    // falling back to a different provider with incompatible dimensions.
    // This prevents dimension mismatch errors with existing databases.
    return new OpenAIEmbeddings(openaiApiKey, openaiModel, debug);
  }

  // Default: Transformers.js (zero-config)
  if (debug) {
    console.error("[Embeddings] Using Transformers.js provider (zero-config)");
  }
  return new TransformersEmbeddings(debug);
}
