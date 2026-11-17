// State/UT LGD codes from FFS getStateLgdMaster, verified 2026-11-11 (the API keeps the
// names for the model prompt). These are provider identifiers used to validate input.
export const FFS_STATE_CODES = new Set([
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16",
  "17", "18", "19", "20", "21", "22", "23", "24", "27", "28", "29", "30", "31", "32", "33",
  "34", "35", "36", "37", "38",
]);

// Identifiers, not a language/alias matcher. Advertised only when the state supports them.
export const FFS_COMMON_CROPS: Record<string, string> = {
  "0101900": "wheat",
  "0101000": "maize",
  "0101700": "paddy (rice)",
};
