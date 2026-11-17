import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { buildAifResponse as buildResponse } from "../aif/aif-response";
import { FfsSessionStore } from "./ffs-session.store";
import { FfsConfig, FfsHttp, FfsTransportError, FfsWorkflow } from "./ffs.workflow";

type Tags = { descriptor?: { code?: string }; value?: unknown }[];

const OPERATIONS = ["send_otp", "verify_otp", "entitlement", "find_shops", "create_booking", "context"];
const JSON_ARGS = ["crop_selections", "order", "resolution"];
const BOOLEAN_ARGS = ["resend", "selected_plots_only", "confirmed"];

const defaultHttp: FfsHttp = async ({ method, url, headers, params, data, timeoutMs }) => {
  try {
    const response = await axios.request({
      method: method as any,
      url,
      headers,
      params,
      data,
      timeout: timeoutMs,
      responseType: "text",
      transformResponse: (body) => body,
      validateStatus: () => true,
      maxRedirects: 0,
    });
    return { status: response.status, text: typeof response.data === "string" ? response.data : "" };
  } catch (error) {
    throw new FfsTransportError(error?.code ?? error?.message ?? "FFS request failed");
  }
};

/**
 * Fertilizer Facilitation (FFS) booking for the chat API, behind Beckn provider
 * `ffs-agri`. One /init per workflow step: tag `request_type` names the step and each
 * argument is its own tag (lists as JSON text). The outcome comes back as one
 * `ffs_result` tag holding the JSON result and diagnostics. context.tags carries
 * session_id/question_id.
 */
@Injectable()
export class FfsService {
  private readonly logger = new Logger(FfsService.name);
  /** Replaced in tests. */
  http: FfsHttp = defaultHttp;

  constructor(
    private readonly config: ConfigService,
    private readonly store: FfsSessionStore
  ) {}

  private settings(): FfsConfig {
    const env = (name: string) => this.config.get<string>(name) || process.env[name] || "";
    return {
      baseUrl: env("FFS_BASE_URL"),
      esaKey: env("FFS_ESA_KEY"),
      esaIv: env("FFS_ESA_IV"),
      appVersion: env("FFS_APP_VERSION"),
      timeoutMs: Number(env("FFS_TIMEOUT")) || 20000,
    };
  }

  /** The Beckn `context.tags` map, or the legacy list form. */
  private contextTags(body: any): Record<string, string> {
    const tags = body?.context?.tags;
    if (Array.isArray(tags)) {
      const out: Record<string, string> = {};
      for (const tag of tags) for (const entry of tag?.list ?? []) out[entry?.descriptor?.code] = entry?.value;
      return out;
    }
    return tags && typeof tags === "object" ? tags : {};
  }

  private error(body: any, code: string, message: string) {
    return buildResponse(body, "on_init", { code, name: "FFS error", short_desc: message });
  }

  async handle(body: any) {
    const tags: Tags = body?.message?.order?.fulfillments?.[0]?.customer?.person?.tags ?? [];
    const values: Record<string, unknown> = {};
    for (const tag of tags) if (tag?.descriptor?.code) values[tag.descriptor.code] = tag.value;

    const operation = String(values.request_type ?? "");
    if (!OPERATIONS.includes(operation)) return this.error(body, "invalid_request", "Unknown FFS request_type.");
    // Every argument is its own tag, like the other providers; lists travel as JSON text.
    const args: Record<string, unknown> = {};
    try {
      for (const [code, value] of Object.entries(values)) {
        if (code === "request_type") continue;
        if (JSON_ARGS.includes(code)) args[code] = JSON.parse(String(value));
        else if (BOOLEAN_ARGS.includes(code)) args[code] = value === "true";
        else args[code] = value;
      }
    } catch {
      return this.error(body, "invalid_request", "FFS list arguments must be valid JSON.");
    }
    const { session_id: sessionId = "", question_id: questionId = "" } = this.contextTags(body);
    if (!sessionId) return this.error(body, "invalid_request", "A conversation session ID is required.");

    const started = Date.now();
    const { result, diagnostics } = await this.store.serialise(sessionId, async () => {
      const workflow = new FfsWorkflow(sessionId, questionId, this.store, this.settings(), this.http, (message) =>
        this.logger.log(`[session:${sessionId}] ${message}`)
      );
      const result = await workflow.run(operation, args);
      return { result, diagnostics: { ...workflow.diagnostics, lock_wait_ms: Date.now() - started } };
    });
    this.logger.log(`[ffs] ${operation} status=${result?.status ?? "context"} api_calls=${diagnostics.api_calls}`);
    return buildResponse(body, "on_init", {
      code: "ffs_result",
      name: "FFS result",
      short_desc: "FFS workflow outcome.",
      list: [
        { code: "result", name: "result", value: JSON.stringify(result) },
        { code: "diagnostics", name: "diagnostics", value: JSON.stringify(diagnostics) },
      ],
    });
  }
}
