import { buildKccApplicationStatusResponse, buildKccResponse } from "./kcc-response";
import { KccApplicationStatus } from "./kcc.service";

const body = {
  context: { transaction_id: "txn-1", action: "status" },
  message: {
    order: {
      provider: { id: "kcc-agri" },
      items: [{ id: "kcc-status" }],
      fulfillments: [
        {
          customer: {
            person: {
              tags: [
                { descriptor: { code: "request_type" }, value: "application_status" },
                { descriptor: { code: "otp" }, value: "741656" },
              ],
            },
          },
        },
      ],
    },
  },
};

const rejectedDraft: KccApplicationStatus = {
  farmerName: "Karandeep singh chadha",
  applicationNo: "26000170989",
  applicationCurrentStatus: "DRAFT",
  requiredLoanAmount: 100000,
  sanctionedAmount: null,
  updatedAt: "2026-09-24 17:53:48",
  bankName: null,
  branchName: null,
  rejectionReason: "Test Rejected",
  rejectedBy: "Bank User",
  applicationCreatedBy: "Farmer",
  remark: "Your application has been rejected.",
  applicationStatusHistory: [],
  cropHusbandryDetails: [
    {
      cropName: "Brinjal/ Baingan",
      season: "Rabi",
      surveyNumber: "78",
      subDivisionNumber: "456",
      landArea: 1.2,
      cropStateName: "MADHYA PRADESH",
      cropDistrictName: "Vidisha",
      cropVillageName: "Agasod",
    },
  ],
  animalHusbandryDetails: [
    {
      activityName: "Layer Farming",
      unitCount: 12,
      animalStateName: "MADHYA PRADESH",
      animalDistrictName: "Vidisha",
      animalVillageName: "Agasod",
    },
  ],
};

const listValues = (tag: any) =>
  Object.fromEntries(tag.list.map((e: any) => [e.descriptor.code, e.value]));

describe("buildKccResponse", () => {
  it("puts the on_init outcome on items[0].tags[0]", () => {
    const res = buildKccResponse(body, "on_init", {
      code: "otp_sent",
      name: "OTP Sent",
      short_desc: "OTP sent successfully",
    });

    expect(res.context.action).toBe("on_init");
    expect(res.message.order.items[0].tags[0].descriptor.code).toBe("otp_sent");
  });

  it("never echoes the request fulfillment, which carries the OTP", () => {
    const res = buildKccResponse(body, "on_status", {
      code: "kcc_error",
      name: "Error",
      short_desc: "Invalid OTP",
    });

    expect(JSON.stringify(res)).not.toContain("741656");
  });
});

describe("buildKccApplicationStatusResponse", () => {
  it("carries the scalar fields on the outcome tag and omits null ones", () => {
    const res = buildKccApplicationStatusResponse(body, rejectedDraft);
    const tag = res.message.order.tags[0];

    expect(tag.descriptor).toMatchObject({ code: "application_status", short_desc: "DRAFT" });
    const values = listValues(tag);
    expect(values).toMatchObject({
      application_no: "26000170989",
      status: "DRAFT",
      rejected_by: "Bank User",
      rejection_reason: "Test Rejected",
      required_loan_amount: "100000",
      source: "Kisan Rin Portal",
    });
    expect(values).not.toHaveProperty("sanctioned_amount");
    expect(values).not.toHaveProperty("bank_name");
  });

  it("emits one item per history entry, crop and animal activity", () => {
    const res = buildKccApplicationStatusResponse(body, {
      ...rejectedDraft,
      applicationStatusHistory: [
        { createdAt: "2026-08-05 14:51:55", applicationStatus: "SUBMITED" },
      ],
    });
    const codes = res.message.order.items.map(
      (item: any) => item.tags[0].descriptor.code
    );

    expect(codes).toEqual(["status_history", "crop_activity", "animal_activity"]);
    expect(listValues(res.message.order.items[1].tags[0])).toMatchObject({
      crop_name: "Brinjal/ Baingan",
      land_area: "1.2",
      village: "Agasod",
    });
  });

  it("never echoes the OTP", () => {
    const res = buildKccApplicationStatusResponse(body, rejectedDraft);

    expect(JSON.stringify(res)).not.toContain("741656");
  });
});
