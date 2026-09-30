import { classifyLocation, haversineKm, nameMatchesRequested } from "./location-match";

const row = (Market: string, District: string, State = "Maharashtra") => ({
  Market,
  District,
  State,
  Commodity: "Onion",
  "Arrival Date": "28-09-2026",
});

describe("nameMatchesRequested", () => {
  it("ignores generic words and trailing spaces", () => {
    expect(nameMatchesRequested("Azadpur mandi", "APMC Azadpur", "Delhi")).toBe(true);
    expect(nameMatchesRequested("Pune", "APMC Pune ", "Pune")).toBe(true);
  });

  it("matches a place given in brackets", () => {
    expect(nameMatchesRequested("Narayangaon", "Junnar(Narayangaon) ", "Pune")).toBe(true);
  });

  it("matches city plus state", () => {
    expect(nameMatchesRequested("Pune, Maharashtra", "Pune(Khadiki) ", "Pune", "Maharashtra")).toBe(true);
  });

  it("needs every requested place word", () => {
    expect(nameMatchesRequested("Manchar, Pune", "Junnar(Narayangaon)", "Pune")).toBe(false);
  });

  it("never matches an empty or generic-only request", () => {
    expect(nameMatchesRequested("", "APMC Pune", "Pune")).toBe(false);
    expect(nameMatchesRequested("APMC", "APMC Pune", "Pune")).toBe(false);
  });
});

describe("classifyLocation", () => {
  it("reports no_data for an empty response", () => {
    expect(classifyLocation([], "Pune")).toEqual({ status: "no_data" });
  });

  it("reports data_found when the returned mandi is the requested place", () => {
    const r = classifyLocation([row("APMC Pune ", "Pune")], "Pune");
    expect(r.status).toBe("data_found");
    expect(r.market).toBe("APMC Pune");
  });

  it("reports nearby_only with the substitute mandi and distance", () => {
    const r = classifyLocation([row("Junnar(Narayangaon) ", "Pune")], "Manchar", 23.456);
    expect(r).toEqual({
      status: "nearby_only",
      market: "Junnar(Narayangaon)",
      district: "Pune",
      state: "Maharashtra",
      distanceKm: 23.5,
    });
  });

  it("treats a mandi within 10 km as the requested place even if names differ", () => {
    expect(classifyLocation([row("Pune(Khadiki)", "Pune")], "Bhosari", 7).status).toBe("data_found");
  });
});

describe("haversineKm", () => {
  it("measures Pune city centre to APMC Pune at about 3 km", () => {
    const km = haversineKm(18.5204, 73.8567, 18.49089838, 73.86850558);
    expect(km).toBeGreaterThan(2.5);
    expect(km).toBeLessThan(4);
  });
});
