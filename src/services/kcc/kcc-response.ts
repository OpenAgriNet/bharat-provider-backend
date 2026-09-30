import { KccApplicationStatus } from "./kcc.service";

export type KccAction = "on_init" | "on_status";

export interface KccTag {
  code: string;
  name: string;
  short_desc: string;
  list?: { code: string; name: string; value: string }[];
}

type Entry = { code: string; name: string; value: string };

function toBecknTag(tag: KccTag) {
  return {
    display: true,
    descriptor: {
      name: tag.name,
      code: tag.code,
      short_desc: tag.short_desc,
    },
    ...(tag.list?.length && {
      list: tag.list.map((entry) => ({
        descriptor: { code: entry.code, name: entry.name },
        value: entry.value,
      })),
    }),
  };
}

/**
 * Builds an on_init / on_status envelope in the same shapes as buildAifResponse:
 * on_init carries the outcome on items[0].tags[0], on_status on order.tags[0].
 *
 * The request fulfillment is never echoed back: on status it carries the `otp` tag.
 */
export function buildKccResponse(
  body: any,
  action: KccAction,
  tag: KccTag,
  options: { state?: string; items?: any[] } = {}
) {
  const providerId = body?.message?.order?.provider?.id ?? "kcc-agri";
  const itemId = body?.message?.order?.items?.[0]?.id ?? "kcc-status";
  const context = {
    ...body?.context,
    action,
    timestamp: new Date().toISOString(),
    ttl: "PT10M",
  };

  if (action === "on_init") {
    return {
      context,
      message: {
        order: {
          provider: { id: providerId },
          items: [{ id: itemId, tags: [toBecknTag(tag)] }],
        },
      },
    };
  }

  return {
    context,
    message: {
      order: {
        id: body?.message?.order?.id ?? body?.context?.transaction_id,
        state: options.state ?? "COMPLETED",
        provider: { id: providerId },
        items: options.items ?? [{ id: itemId }],
        tags: [toBecknTag(tag)],
      },
    },
  };
}

/** Drops entries whose value is empty, so absent upstream fields are not shown as "null". */
function present(entries: Entry[]): Entry[] {
  return entries.filter((entry) => entry.value !== "" && entry.value !== "null");
}

const text = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

/**
 * Application status: the scalar fields on the outcome tag, then one item per status
 * history entry, crop and animal activity, each identified by its tag code.
 */
export function buildKccApplicationStatusResponse(
  body: any,
  status: KccApplicationStatus
) {
  const itemId = body?.message?.order?.items?.[0]?.id ?? "kcc-status";

  const history = status.applicationStatusHistory.map((entry, index) => ({
    id: `${itemId}-history-${index + 1}`,
    tags: [
      toBecknTag({
        code: "status_history",
        name: "Status History",
        short_desc: entry.applicationStatus,
        list: present([
          { code: "status", name: "Status", value: entry.applicationStatus },
          { code: "date", name: "Date", value: entry.createdAt },
        ]),
      }),
    ],
  }));

  const crops = status.cropHusbandryDetails.map((crop, index) => ({
    id: `${itemId}-crop-${index + 1}`,
    tags: [
      toBecknTag({
        code: "crop_activity",
        name: "Crop",
        short_desc: crop.cropName,
        list: present([
          { code: "crop_name", name: "Crop", value: crop.cropName },
          { code: "season", name: "Season", value: crop.season },
          { code: "survey_number", name: "Survey Number", value: crop.surveyNumber },
          { code: "sub_division_number", name: "Sub-division Number", value: crop.subDivisionNumber },
          { code: "land_area", name: "Land Area", value: text(crop.landArea) },
          { code: "village", name: "Village", value: crop.cropVillageName },
          { code: "district", name: "District", value: crop.cropDistrictName },
          { code: "state", name: "State", value: crop.cropStateName },
        ]),
      }),
    ],
  }));

  const animals = status.animalHusbandryDetails.map((animal, index) => ({
    id: `${itemId}-animal-${index + 1}`,
    tags: [
      toBecknTag({
        code: "animal_activity",
        name: "Animal Husbandry",
        short_desc: animal.activityName,
        list: present([
          { code: "activity_name", name: "Activity", value: animal.activityName },
          { code: "unit_count", name: "Units", value: text(animal.unitCount) },
          { code: "village", name: "Village", value: animal.animalVillageName },
          { code: "district", name: "District", value: animal.animalDistrictName },
          { code: "state", name: "State", value: animal.animalStateName },
        ]),
      }),
    ],
  }));

  return buildKccResponse(
    body,
    "on_status",
    {
      code: "application_status",
      name: "KCC Application Status",
      short_desc: status.applicationCurrentStatus,
      list: present([
        { code: "farmer_name", name: "Farmer Name", value: status.farmerName },
        { code: "application_no", name: "Application Number", value: status.applicationNo },
        { code: "status", name: "Status", value: status.applicationCurrentStatus },
        { code: "required_loan_amount", name: "Loan Amount Applied", value: text(status.requiredLoanAmount) },
        { code: "sanctioned_amount", name: "Sanctioned Amount", value: text(status.sanctionedAmount) },
        { code: "bank_name", name: "Bank", value: text(status.bankName) },
        { code: "branch_name", name: "Branch", value: text(status.branchName) },
        { code: "rejected_by", name: "Rejected By", value: text(status.rejectedBy) },
        { code: "rejection_reason", name: "Rejection Reason", value: text(status.rejectionReason) },
        { code: "created_by", name: "Application Created By", value: text(status.applicationCreatedBy) },
        { code: "updated_at", name: "Last Updated", value: status.updatedAt },
        { code: "remark", name: "Remark", value: text(status.remark) },
        { code: "source", name: "Source", value: "Kisan Rin Portal" },
      ]),
    },
    { items: [...history, ...crops, ...animals] }
  );
}

/**
 * More than one application on the mobile: list them so the farmer can pick one. The
 * details follow on a second status call carrying application_no, served from the
 * session because the OTP is already spent.
 */
export function buildKccApplicationListResponse(
  body: any,
  applications: KccApplicationStatus[]
) {
  const itemId = body?.message?.order?.items?.[0]?.id ?? "kcc-status";

  const items = applications.map((application, index) => ({
    id: `${itemId}-application-${index + 1}`,
    tags: [
      toBecknTag({
        code: "application_summary",
        name: "KCC Application",
        short_desc: application.applicationNo,
        list: present([
          { code: "application_no", name: "Application Number", value: application.applicationNo },
          { code: "status", name: "Status", value: application.applicationCurrentStatus },
          { code: "required_loan_amount", name: "Loan Amount Applied", value: text(application.requiredLoanAmount) },
          { code: "updated_at", name: "Last Updated", value: application.updatedAt },
        ]),
      }),
    ],
  }));

  return buildKccResponse(
    body,
    "on_status",
    {
      code: "multiple_applications",
      name: "KCC Applications",
      short_desc: `${applications.length} KCC applications found. Select one application number.`,
      list: [
        { code: "application_count", name: "Application Count", value: String(applications.length) },
        { code: "source", name: "Source", value: "Kisan Rin Portal" },
      ],
    },
    { items }
  );
}
