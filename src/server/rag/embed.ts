import { EMBEDDING_MODEL } from "./models";

/**
 * Embed text with the project's embedding model (bge-m3, 1024-dim). bge-m3 pools
 * internally, so no `pooling` parameter is passed. Returns one vector per input.
 */
export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = await ai.run(EMBEDDING_MODEL, { text: texts });
  return (result as { data: number[][] }).data;
}
