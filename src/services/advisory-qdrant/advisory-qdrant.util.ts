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
  /** Season of the advisory entry (Rabi, Kharif, Other); empty when unknown. */
  season: string;
  /** Days after sowing the advice applies from / to; null when absent or not numeric. */
  start_period: number | null;
  end_period: number | null;
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

// ---------------------------------------------------------------------------
// Request parameters (Beckn intent.item.tags -> search_params group)
// ---------------------------------------------------------------------------

export interface AdvisorySearchParams {
  query: string;
  /** Crop in the form stored by docs-pipeline (for example "Wheat"); empty when not sent. */
  crop: string;
  district: string;
  /** Season sent by the caller; only used when ADVISORY_DEFAULT_SEASON is empty. */
  season: string;
  daysAfterSowing: number | null;
  topK: number | null;
}

const CROP_ALIASES: Record<string, string> = {
  wheat: 'Wheat',
  gehun: 'Wheat',
  gehu: 'Wheat',
  'गेहूं': 'Wheat',
  'गेहू': 'Wheat',
  rice: 'Rice',
  paddy: 'Rice',
  dhan: 'Rice',
  'धान': 'Rice',
  sorghum: 'Sorghum',
  jowar: 'Sorghum',
  'ज्वार': 'Sorghum',
  'kodo millet': 'Kodo Millet',
  kodo: 'Kodo Millet',
  'kodo-millet': 'Kodo Millet',
};

/**
 * Map a crop name from the caller to the form docs-pipeline stores (`commodityName`). Qdrant
 * keyword matching is exact and case-sensitive, so "wheat" must become "Wheat". Known aliases
 * (including Hindi names) are mapped; anything else is title-cased.
 */
export function normalizeCrop(raw: unknown): string {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return '';
  const alias = CROP_ALIASES[value.toLowerCase()];
  if (alias) return alias;
  return value
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

/** Longest tag value kept (crop, district, season). */
export const MAX_TAG_LENGTH = 100;

/** Strip control characters (so values are safe to log and filter on), trim, and cap the length. */
export function cleanTagValue(raw: unknown, max = MAX_TAG_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max).trim();
}

function toInt(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(text)) return null;
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the search request: the query comes from item.descriptor.name, everything else from the
 * `search_params` tag group on the item (crop, district, season, days_after_sowing, top_k).
 */
export function parseAdvisoryParams(body: any): AdvisorySearchParams {
  const item = body?.message?.intent?.item;
  const params: AdvisorySearchParams = {
    query: String(item?.descriptor?.name || '').trim(),
    crop: '',
    district: '',
    season: '',
    daysAfterSowing: null,
    topK: null,
  };

  const tags: any[] = Array.isArray(item?.tags) ? item.tags : [];
  for (const tag of tags) {
    const groupCode = String(tag?.descriptor?.code || '').toLowerCase();
    if (groupCode !== 'search_params' && groupCode !== 'search-params') continue;
    const list: any[] = Array.isArray(tag?.list) ? tag.list : [];
    for (const entry of list) {
      const code = String(entry?.descriptor?.code || entry?.name || '').toLowerCase();
      const value = cleanTagValue(entry?.value);
      if (!value) continue;
      switch (code) {
        case 'query':
        case 'search_value':
          if (!params.query) params.query = value;
          break;
        case 'crop':
          params.crop = normalizeCrop(value);
          break;
        case 'district':
          params.district = value;
          break;
        case 'season':
          params.season = value;
          break;
        case 'days_after_sowing':
        case 'days-after-sowing':
          params.daysAfterSowing = toInt(value);
          break;
        case 'top_k':
        case 'topk':
          params.topK = toInt(value);
          break;
      }
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Soft ranking: season and days after sowing
// ---------------------------------------------------------------------------

/** Added to a hit's score when its season is the preferred one. */
export const SEASON_BOOST = 0.1;
/** Added when the farmer's days after sowing falls inside the hit's day range. */
export const DAYS_BOOST = 0.15;

/**
 * Preferred season: ADVISORY_DEFAULT_SEASON when set, else the season the caller sent, else
 * none. Empty means "no preference". Never used as a hard filter.
 */
export function resolvePreferredSeason(requestSeason: string, envSeason = process.env.ADVISORY_DEFAULT_SEASON): string {
  const fromEnv = String(envSeason ?? '').trim();
  if (fromEnv) return fromEnv;
  return String(requestSeason ?? '').trim();
}

export function daysInRange(hit: AdvisoryHit, days: number | null): boolean {
  if (days === null || hit.start_period === null || hit.end_period === null) return false;
  return days >= hit.start_period && days <= hit.end_period;
}

export function hasDayRange(hit: AdvisoryHit): boolean {
  return hit.start_period !== null && hit.end_period !== null;
}

/**
 * Re-rank hits without dropping any: a matching season and a matching day range each add a
 * boost to the score. Ranges in the source data are loose, so these are preferences only.
 * Returns a new array sorted by boosted score (best first).
 */
/** Seasons of an entry as a lowercase list: the data stores several as one text, e.g. "Rabi,Kharif". */
export function seasonList(value: string): string[] {
  return String(value ?? '')
    .split(/[,;/]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function rankHits(
  hits: AdvisoryHit[],
  options: { preferredSeason: string; daysAfterSowing: number | null },
): AdvisoryHit[] {
  const season = options.preferredSeason.trim().toLowerCase();
  const boosted = hits.map((hit) => {
    let adjusted = hit.score;
    if (season && seasonList(hit.season).includes(season)) adjusted += SEASON_BOOST;
    if (daysInRange(hit, options.daysAfterSowing)) adjusted += DAYS_BOOST;
    return { hit, adjusted };
  });
  return boosted.sort((a, b) => b.adjusted - a.adjusted).map((entry) => entry.hit);
}
