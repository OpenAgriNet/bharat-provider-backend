/**
 * vistaar-location returns rows for the nearest mandi that has data, widening its
 * radius (5 → 10 → 25 → 50 km) until it finds one. These helpers decide whether the
 * mandi it came back with is the place the farmer asked about, or a nearby substitute.
 */

/** A returned mandi this close to the requested point counts as the farmer's own. */
export const SAME_PLACE_MAX_KM = 10;

// Words that don't identify a place: "APMC Pune", "Azadpur Mandi", "Krishi Upaj Mandi Samiti".
const GENERIC_WORDS = new Set([
  "apmc",
  "mandi",
  "market",
  "samiti",
  "krishi",
  "upaj",
  "yard",
  "sub",
  "main",
]);

export function placeTokens(value: string | undefined | null): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC_WORDS.has(t));
}

/**
 * True when every place word the farmer gave appears in the returned market,
 * district or state name — "Pune" matches "APMC Pune" and "Pune(Khadiki)", "Azadpur mandi"
 * matches "APMC Azadpur", "Narayangaon" matches "Junnar(Narayangaon)",
 * "Pune, Maharashtra" matches a Pune-district row.
 */
export function nameMatchesRequested(
  requested: string,
  market: string | undefined,
  district: string | undefined,
  state?: string | undefined,
): boolean {
  const wanted = placeTokens(requested);
  if (wanted.length === 0) return false;
  const found = new Set([
    ...placeTokens(market),
    ...placeTokens(district),
    ...placeTokens(state),
  ]);
  return wanted.every((t) => found.has(t));
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export type LocationStatus = "data_found" | "nearby_only" | "no_data";

export interface LocationMatchResult {
  status: LocationStatus;
  /** Market/district/state of the mandi the rows came from (unset for no_data). */
  market?: string;
  district?: string;
  state?: string;
  distanceKm?: number;
}

/**
 * Classify a vistaar-location response against the requested place.
 * marketDistanceKm is the distance of the returned mandi from the farmer's
 * point, when its coordinates are known from the market master.
 */
export function classifyLocation(
  rows: any[],
  requestedLocation: string,
  marketDistanceKm?: number,
): LocationMatchResult {
  if (!rows.length) return { status: "no_data" };

  const first = rows[0] ?? {};
  const market = String(first.Market ?? "").trim() || undefined;
  const district = String(first.District ?? "").trim() || undefined;
  const state = String(first.State ?? "").trim() || undefined;
  const distanceKm =
    marketDistanceKm != null ? Math.round(marketDistanceKm * 10) / 10 : undefined;

  const matched = rows.some((r) =>
    nameMatchesRequested(requestedLocation, r?.Market, r?.District, r?.State),
  );
  const close = marketDistanceKm != null && marketDistanceKm <= SAME_PLACE_MAX_KM;

  return {
    status: matched || close ? "data_found" : "nearby_only",
    market,
    district,
    state,
    distanceKm,
  };
}
