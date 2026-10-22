import { KhcMasterService, PlaceMatch, looseKey } from "./khc-master.service";
import { REFERENCES } from "./khc-references";

type Values = Record<string, unknown>;

export interface LookupDeps {
  /** Whole reference list (cache first, KHC API second). */
  listAll(kind: string, parentId?: number): Promise<Values[]>;
  master?: KhcMasterService;
}

export class LookupError extends Error {}

const MAX_MATCHES = 10;
// Search deeper than we return, so `total` can say whether the list was cut.
const SEARCH_LIMIT = 51;
const VILLAGE_FILL_LIMIT = 40; // sub-district village lists fetched for one lookup
const VILLAGE_FILL_PARALLEL = 5;

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = row;
  }
  return previous[b.length];
}

/** Rows whose name equals, contains, or (allowing a typo) resembles the query. */
export function matchRows(rows: Values[], kind: string, query: string): Values[] {
  const key = looseKey(query);
  if (!key) return [];
  const nameOf = (row: Values) => looseKey(String(row[REFERENCES[kind].name]));
  const exact = rows.filter((row) => nameOf(row) === key);
  if (exact.length) return exact;
  const contains = rows.filter((row) => nameOf(row).includes(key));
  if (contains.length) return contains;
  const allowed = key.length <= 4 ? 0 : key.length <= 8 ? 1 : 2;
  return allowed
    ? rows.filter((row) => distance(nameOf(row), key) <= allowed)
    : [];
}

const idOf = (kind: string, row: Values) => Number(row[REFERENCES[kind].id]);
const nameOf = (kind: string, row: Values) => String(row[REFERENCES[kind].name]);
const ref = (kind: string, row: Values) => ({ id: idOf(kind, row), name: nameOf(kind, row) });


const STOPWORDS = new Set(
  "a an and are as at be been by for from has have i in is it me my not of on or so that the this to under was were with am no yet about".split(" ")
);
// Crude stem so "refused"/"refuses"/"refusing" compare equal.
const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, "");
const tokens = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
      .map(stem)
  );
const overlap = (concern: Set<string>, name: string) => {
  const own = tokens(name);
  if (!own.size) return 0;
  let hit = 0;
  for (const word of own) if (concern.has(word)) hit += 1;
  return hit / own.size;
};

interface CategoryNode {
  id: number;
  name: string;
  subCategories: { id: number; name: string }[];
}

/**
 * Best category + sub-category for a complaint by word overlap with their names, or null when no
 * single pair clearly wins. English only (the tool passes an English summary); the caller falls
 * back to showing the list.
 */
export function suggestCategory(
  concern: string,
  categories: CategoryNode[]
): { category: { id: number; name: string }; subCategory: { id: number; name: string } } | null {
  const words = tokens(concern);
  if (!words.size) return null;
  const scored: { score: number; category: CategoryNode; sub: { id: number; name: string } }[] = [];
  for (const category of categories) {
    const categoryScore = overlap(words, category.name);
    for (const sub of category.subCategories) {
      scored.push({ score: 2 * overlap(words, sub.name) + categoryScore, category, sub });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  // At least a full sub-category match, or a strong partial plus its category, and a clear lead.
  if (!best || best.score < 1.2 || (second && best.score - second.score < 0.4)) return null;
  return {
    category: { id: best.category.id, name: best.category.name },
    subCategory: best.sub,
  };
}

export class KhcLookup {
  constructor(private readonly deps: LookupDeps) {}

  /** The one state a name or id refers to, or the candidates when it is ambiguous. */
  private async resolveState(
    stateId?: number,
    stateName?: string
  ): Promise<{ state?: Values; candidates?: Values[] }> {
    const states = await this.deps.listAll("states");
    if (stateId) {
      const state = states.find((row) => idOf("states", row) === stateId);
      if (!state) throw new LookupError("That KHC state ID was not found.");
      return { state };
    }
    if (!stateName) return {};
    const found = matchRows(states, "states", stateName);
    if (found.length === 1) return { state: found[0] };
    if (!found.length) {
      return { candidates: states };
    }
    return { candidates: found };
  }

  /**
   * Where is this place? Searches the state's districts and sub-districts and the cached
   * villages, and returns each match with its whole chain (state, district, block, village).
   */
  async findLocation(input: {
    name: string;
    stateId?: number;
    stateName?: string;
    districtId?: number;
    districtName?: string;
  }): Promise<Values> {
    const master = this.deps.master;
    const resolved = await this.resolveState(input.stateId, input.stateName);
    if (resolved.candidates) {
      return {
        needs: "state",
        matches: resolved.candidates.map((row) => ({ level: "state", ...ref("states", row) })),
        total: resolved.candidates.length,
      };
    }
    const state = resolved.state;
    const stateRef = state ? ref("states", state) : null;
    const matches: PlaceMatch[] = [];
    let district: Values | undefined;
    let districtRef: { id: number; name: string } | null = null;

    if (state) {
      const districts = await this.deps.listAll("districts", stateRef!.id);
      if (input.districtId) {
        district = districts.find((row) => idOf("districts", row) === input.districtId);
      } else if (input.districtName) {
        const found = matchRows(districts, "districts", input.districtName);
        if (found.length === 1) district = found[0];
      }
      if (district) districtRef = ref("districts", district);
      // The place may itself be a district.
      for (const row of matchRows(districts, "districts", input.name)) {
        matches.push({
          level: "district",
          ...ref("districts", row),
          state: stateRef,
          district: ref("districts", row),
          subDistrict: null,
        });
      }
      if (districtRef) {
        const subDistricts = await this.deps.listAll("sub-districts", districtRef.id);
        for (const row of matchRows(subDistricts, "sub-districts", input.name)) {
          matches.push({
            level: "sub-district",
            ...ref("sub-districts", row),
            state: stateRef,
            district: districtRef,
            subDistrict: ref("sub-districts", row),
          });
        }
        await this.fillVillages(subDistricts);
      }
    }

    if (master?.isReady()) {
      const scope = { stateId: stateRef?.id, districtId: districtRef?.id };
      matches.push(...(await master.search("village", input.name, scope, SEARCH_LIMIT)));
      if (!districtRef) {
        matches.push(...(await master.search("sub-district", input.name, scope, SEARCH_LIMIT)));
      }
    }

    // An exact name beats partial ones ("Abupur" should not also list "Abupur Kalan").
    const key = looseKey(input.name);
    const exact = matches.filter((match) => looseKey(match.name) === key);
    const best = exact.length ? exact : matches;
    const result: Values = {
      matches: best.slice(0, MAX_MATCHES),
      // Real count (capped at SEARCH_LIMIT): more than matches.length means the list was cut.
      total: best.length,
    };
    if (stateRef) result.state = stateRef;
    if (districtRef) result.district = districtRef;
    if (!matches.length) {
      if (stateRef && master?.isReady()) {
        const coverage = await master.villageCoverage(stateRef.id);
        result.villageCoverage = coverage;
      }
      result.needs = state ? (districtRef ? "geocode" : "district") : "state";
    }
    return result;
  }

  /** Make sure a district's villages are cached (bounded, a few lists at a time). */
  private async fillVillages(subDistricts: Values[]): Promise<void> {
    const master = this.deps.master;
    if (!master?.isReady()) return;
    const missing: number[] = [];
    for (const row of subDistricts) {
      const id = idOf("sub-districts", row);
      if (!(await master.isFresh("villages", id))) missing.push(id);
    }
    const batch = missing.slice(0, VILLAGE_FILL_LIMIT);
    for (let index = 0; index < batch.length; index += VILLAGE_FILL_PARALLEL) {
      await Promise.all(
        batch
          .slice(index, index + VILLAGE_FILL_PARALLEL)
          .map((id) => this.deps.listAll("villages", id).catch(() => []))
      );
    }
  }

  /**
   * A state's grievance options in one call: its schemes, or, once a scheme is named,
   * that scheme's categories with their sub-categories.
   */
  async grievanceTree(input: {
    stateId?: number;
    stateName?: string;
    scheme?: string;
    concern?: string;
  }): Promise<Values> {
    const resolved = await this.resolveState(input.stateId, input.stateName);
    if (!resolved.state) {
      if (!resolved.candidates) {
        throw new LookupError("A state name or state ID is required.");
      }
      return {
        needs: "state",
        matches: resolved.candidates.map((row) => ref("states", row)),
        total: resolved.candidates.length,
      };
    }
    const state = ref("states", resolved.state);
    const schemes = await this.deps.listAll("schemes", state.id);
    const scheme = (row: Values) => ({ ...ref("schemes", row), division: row.division ?? null });
    const found = input.scheme ? matchRows(schemes, "schemes", input.scheme) : [];
    if (found.length !== 1) {
      return {
        state,
        schemes: (found.length ? found : schemes).map(scheme),
        needs: "scheme",
        // none: the named scheme is not offered by KHC in this state; several: pick one.
        match: !input.scheme ? "unnamed" : found.length ? "several" : "none",
      };
    }
    const chosen = scheme(found[0]);
    const categories = await this.deps.listAll("categories", chosen.id);
    const tree = await Promise.all(
      categories.map(async (category) => ({
        ...ref("categories", category),
        subCategories: (
          await this.deps.listAll("sub-categories", idOf("categories", category))
        ).map((row) => ref("sub-categories", row)),
      }))
    );
    const result: Values = { state, scheme: chosen, categories: tree };
    const suggested = input.concern ? suggestCategory(input.concern, tree) : null;
    if (suggested) result.suggested = suggested;
    return result;
  }
}
