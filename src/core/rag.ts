import type { KbDoc } from "./playbook";
import { contentWords } from "./guardrail";

export interface Chunk {
  /** id citable: `<doc>#<sección>` */
  id: string;
  docTitle: string;
  heading: string;
  text: string;
}

export interface Retrieved extends Chunk {
  score: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function chunkKb(docs: KbDoc[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of docs) {
    const parts = doc.text.split(/^## /m).slice(1);
    for (const part of parts) {
      const [heading = "", ...body] = part.split("\n");
      chunks.push({ id: `${doc.id}#${slug(heading)}`, docTitle: doc.title, heading: heading.trim(), text: body.join(" ").trim() });
    }
  }
  return chunks;
}

/**
 * BM25 léxico con stemming liviano en español. Elegido sobre embeddings para que
 * corra igual en Workers, en CI y sin GPU; la interfaz permite cambiarlo por
 * Vectorize/pgvector cuando la KB de un cliente lo justifique (ver ADR 0004).
 */
export class KbIndex {
  private readonly docs: { chunk: Chunk; tf: Map<string, number>; len: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(chunks: Chunk[]) {
    this.docs = chunks.map((chunk) => {
      const words = contentWords(`${chunk.docTitle} ${chunk.heading} ${chunk.heading} ${chunk.text}`);
      const tf = new Map<string, number>();
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { chunk, tf, len: words.length };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, topK = 3, k1 = 1.4, b = 0.75): Retrieved[] {
    const q = [...new Set(contentWords(query))];
    const n = this.docs.length;
    return this.docs
      .map(({ chunk, tf, len }) => {
        let score = 0;
        for (const w of q) {
          const f = tf.get(w);
          if (!f) continue;
          const df = this.df.get(w) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / this.avgLen));
        }
        return { ...chunk, score: Number(score.toFixed(3)) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, topK);
  }
}
