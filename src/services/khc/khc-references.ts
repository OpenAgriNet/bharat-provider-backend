// KHC reference list -> query parameter of its parent and the id/name fields of its rows.
export const REFERENCES: Record<
  string,
  { parent?: string; id: string; name: string }
> = {
  states: { id: "stateid", name: "statename" },
  districts: { parent: "stateId", id: "districtid", name: "districtname" },
  "sub-districts": {
    parent: "districtId",
    id: "subdistrictid",
    name: "subdistrictname",
  },
  villages: { parent: "subDistrictId", id: "villageid", name: "villagename" },
  schemes: { parent: "stateId", id: "scheme", name: "schemename" },
  categories: { parent: "scheme", id: "problemcategory", name: "categoryname" },
  "sub-categories": {
    parent: "problemCategory",
    id: "problemsubcategory",
    name: "subcategoryname",
  },
};
