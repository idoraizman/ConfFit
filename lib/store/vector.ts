import { Pinecone } from '@pinecone-database/pinecone'
import { config } from '../config'
import { embed } from '../llm'

/**
 * RAG store for CFP chunks and past accepted-paper abstracts, namespaced per
 * conference so retrieval never bleeds across venues.
 *
 * Pinecone is the primary vector DB. When it is unavailable — or when MOCK_LLM
 * is on, since the stub embeddings have a different dimension than the real
 * index — we fall back to an in-process cosine search over the same records.
 */

export interface VectorRecord {
  id: string
  text: string
  kind: 'cfp' | 'paper'
  source: string
}

export interface Match extends VectorRecord {
  score: number
}

type Stored = VectorRecord & { values: number[] }

const memory = new Map<string, Stored[]>()

function usePinecone(): boolean {
  return config.pinecone.enabled && !config.llm.mock
}

let pc: Pinecone | null = null
function client(): Pinecone {
  return (pc ??= new Pinecone({ apiKey: config.pinecone.apiKey }))
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/** Splits text into overlapping chunks sized for text-embedding-3-small. */
export function chunk(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= size) return clean ? [clean] : []

  const out: string[] = []
  let i = 0
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size)
    if (end < clean.length) {
      // Prefer a paragraph or sentence boundary near the end of the window.
      const window = clean.slice(i, end)
      const br = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
      if (br > size * 0.5) end = i + br + 1
    }
    out.push(clean.slice(i, end).trim())
    if (end >= clean.length) break
    i = end - overlap
  }
  return out.filter(Boolean)
}

export async function upsertChunks(namespace: string, records: VectorRecord[]): Promise<number> {
  if (!records.length) return 0
  const vectors = await embed(records.map((r) => r.text))

  if (usePinecone()) {
    try {
      await client()
        .index(config.pinecone.index)
        .namespace(namespace)
        .upsert(
          records.map((r, i) => ({
            id: r.id,
            values: vectors[i],
            metadata: { text: r.text, kind: r.kind, source: r.source },
          })),
        )
      return records.length
    } catch (e) {
      console.warn('[pinecone] upsert failed, storing in memory:', (e as Error).message)
    }
  }

  const bucket = memory.get(namespace) ?? []
  const byId = new Map(bucket.map((r) => [r.id, r]))
  records.forEach((r, i) => byId.set(r.id, { ...r, values: vectors[i] }))
  memory.set(namespace, [...byId.values()])
  return records.length
}

export async function search(namespace: string, query: string, topK = 4): Promise<Match[]> {
  const [vector] = await embed([query])
  if (!vector) return []

  if (usePinecone()) {
    try {
      const res = await client()
        .index(config.pinecone.index)
        .namespace(namespace)
        .query({ vector, topK, includeMetadata: true })
      return (res.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score ?? 0,
        text: String(m.metadata?.text ?? ''),
        kind: (m.metadata?.kind as VectorRecord['kind']) ?? 'cfp',
        source: String(m.metadata?.source ?? ''),
      }))
    } catch (e) {
      console.warn('[pinecone] query failed, searching memory:', (e as Error).message)
    }
  }

  const bucket = memory.get(namespace) ?? []
  return bucket
    .map((r) => ({ ...r, score: cosine(vector, r.values) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ values, ...rest }) => rest)
}

export async function hasNamespace(namespace: string): Promise<boolean> {
  if ((memory.get(namespace) ?? []).length > 0) return true
  if (!usePinecone()) return false
  try {
    const stats = await client().index(config.pinecone.index).describeIndexStats()
    return Boolean(stats.namespaces?.[namespace]?.recordCount)
  } catch {
    return false
  }
}

export function vectorBackend(): 'pinecone' | 'memory' {
  return usePinecone() ? 'pinecone' : 'memory'
}
