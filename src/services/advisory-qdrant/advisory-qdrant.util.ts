/** One advisory chunk read back from Qdrant (payload written by docs-pipeline). */
export interface AdvisoryHit {
  score: number;
  /** Full stored chunk text (header + fields), what the farmer-facing answer is built from. */
  text: string;
  doc_id: string;
  chunk_id: string;
  /** Advisory entry id inside a webhook record; absent for PDF advisory chunks. */
  pop_id?: number | string | null;
  section: string;
  title: string;
  crop: string;
  institute: string;
  creator: string;
}

/**
 * Keep only the best-scoring chunk per advisory entry (doc_id + pop_id), sorted by score
 * descending. Hits without a pop_id (PDF chunks) are kept, one per chunk_id.
 */
export function dedupeByPop(hits: AdvisoryHit[]): AdvisoryHit[] {
  const best = new Map<string, AdvisoryHit>();
  for (const hit of hits) {
    const hasPop = hit.pop_id !== undefined && hit.pop_id !== null && hit.pop_id !== '';
    const key = hasPop ? `pop:${hit.doc_id}:${hit.pop_id}` : `chunk:${hit.chunk_id}`;
    const current = best.get(key);
    if (!current || hit.score > current.score) {
      best.set(key, hit);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** "Institute, creator" for the Source line; either part is omitted when empty. */
export function formatSource(institute: string, creator: string): string {
  return [institute, creator]
    .map((part) => String(part || '').trim())
    .filter((part) => part.length > 0)
    .join(', ');
}
