import {
  resolveExternalServiceName,
  resolveRouteName,
  resolveServiceName,
} from "./service-name.resolver";

describe("AgriStack telemetry service naming", () => {
  it.each([
    "agristack-category-a",
    "agristack-category-b",
    "agristack-category-c",
  ])("maps %s to AgriStack", (itemId) => {
    const body = {
      context: { domain: "schemes:vistaar", action: "search" },
      message: {
        intent: {
          provider: { id: "agristack-agri" },
          item: { id: itemId },
        },
      },
    };
    expect(resolveServiceName(body)).toBe("agristack");
    expect(resolveRouteName(body)).toBe("agristack-agri");
  });

  it("maps direct AgriStack gateway URLs to the AgriStack external service", () => {
    expect(resolveExternalServiceName("https://ufsi.agristack.gov.in/gateway/seek")).toBe("agristack");
  });
});
