import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import axios from "axios";
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from "crypto";
import * as fs from "fs";
import { AgristackService } from "./agristack.service";

jest.mock("axios");
jest.mock("fs", () => ({ ...jest.requireActual("fs"), readFileSync: jest.fn() }));

const mockedAxios = axios as jest.Mocked<typeof axios>;
interface SeekPayload {
  signature: string;
  header: { message_id: string };
  message: {
    transaction_id: string;
    consent?: unknown;
    seek_request: { query_param: Record<string, string> };
  };
}
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const entries = [{
  farmerData: { frCentralId: "F1", farmerNameEng: "Test Farmer" },
  landData: [{ plotVillageName: "Test Village" }],
  cropSurveyData: [{ cropName: "Rice" }],
  landOwnershipData: [{ ownerNoAsPerRor: "1" }],
}];

function encryptedResponse(value: unknown = entries, plaintext = JSON.stringify(value)) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    header: { status: "succeed", completed_count: 1, is_msg_encrypted: true },
    message: {
      encrypted_data: data.toString("base64"),
      encrypted_key: publicEncrypt({
        key: keys.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
      }, key).toString("base64"),
      iv: iv.toString("base64"),
      auth_tag: cipher.getAuthTag().toString("base64"),
      encryption_alg: "AES-256-GCM+RSA-OAEP-SHA256",
    },
  };
}

function request(category = "a", state = "22") {
  return {
    context: { action: "search" },
    message: { intent: { item: {
      id: `agristack-category-${category}`,
      tags: Object.entries({ farmerId: "F1", stateLgdCode: state, season: "Rabi", year: "2026-2027" })
        .map(([code, value]) => ({ descriptor: { code }, value })),
    } } },
  };
}

describe("AgristackService synchronous gateway", () => {
  let service: AgristackService;

  beforeEach(() => {
    jest.resetAllMocks();
    for (const method of ["log", "warn", "error"] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
    }
    jest.mocked(fs.readFileSync).mockReturnValue(keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    service = new AgristackService(new ConfigService({ AGRISTACK_SENDER_ID: "sender" }));
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: "test-token", expires_in: 300 } });
  });

  afterEach(() => jest.restoreAllMocks());

  it("resolves without a database provider", async () => {
    const module = await Test.createTestingModule({
      providers: [AgristackService, { provide: ConfigService, useValue: new ConfigService() }],
    }).compile();
    try {
      expect(module.get(AgristackService)).toBeInstanceOf(AgristackService);
    } finally {
      await module.close();
    }
  });

  it.each(["a", "b", "c"])("sends state and exact query fields, then decrypts category %s", async (category) => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse() });
    const result = await service.search(request(category));
    const [url, data, config] = mockedAxios.post.mock.calls[1];
    const payload = data as SeekPayload;
    expect(url).toBe("https://ufsi.agristack.gov.in/gateway/seek");
    expect(config.headers["X-State-LGD-Code"]).toBe("22");
    expect(payload.signature).toBe("");
    expect(payload.message.consent).toBeUndefined();
    expect(payload.message.seek_request.query_param).toEqual({
      frCentralId: "F1", ...(category === "a" ? {} : { season: "Rabi", year: "2026-2027" }),
    });
    const item = result.message.catalog.providers[0].items[0];
    expect(item.id).toBe("F1");
    expect(item.tags.map((tag: { descriptor: { code: string } }) => tag.descriptor.code))
      .toEqual(["farmer-data", "land-data", "crop-survey-data", "land-ownership-data"]);
  });

  it.each(["", "abc", "22\r\nbad", "0", "123"])("rejects invalid state %j before HTTP", async (state) => {
    const result = await service.search(request("a", state));
    expect(result.message.catalog.providers[0].items[0].id).toBe("error");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it.each(["auth_tag", "encrypted_key", "iv", "encrypted_data", "encryption_alg"])(
    "rejects invalid %s instead of returning an empty successful catalog", async (field) => {
      const response = encryptedResponse();
      response.message[field] = field === "encryption_alg" ? "unknown" : "AAAA";
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: response });
      const result = await service.search(request());
      expect(result.message.catalog.providers[0].items[0].id).toBe("error");
    },
  );

  it("rejects a mismatched private key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    jest.mocked(fs.readFileSync).mockReturnValue(other.privateKey.export({ type: "pkcs8", format: "pem" }));
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse() });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("rejects RSA keys below the documented minimum", async () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    jest.mocked(fs.readFileSync).mockReturnValue(weak.privateKey.export({ type: "pkcs8", format: "pem" }));
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse() });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("preserves alternate farmer names and IDs without optional sections", async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse([
      { farmerData: { centralId: "F2", frNameEn: "Alternate Name" }, landData: [] },
    ]) });
    const item = (await service.search(request())).message.catalog.providers[0].items[0];
    expect(item.id).toBe("F2");
    expect(item.descriptor.name).toBe("Alternate Name");
    expect(item.tags).toHaveLength(2);
  });

  it("reports a missing private key", async () => {
    jest.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("missing file"); });
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse() });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("rejects unexpected decrypted shapes", async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse({ unexpected: true }) });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it.each([null, [null], [{}], [{ farmerData: [], landData: [] }]])(
    "rejects malformed farmer records %j", async (value) => {
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse(value) });
      expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
    },
  );

  it("rejects unauthenticated ciphertext even when field lengths are correct", async () => {
    const response = encryptedResponse();
    const tag = Buffer.from(response.message.auth_tag, "base64");
    tag[0] ^= 1;
    response.message.auth_tag = tag.toString("base64");
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: response });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it.each(["", "$bad", "a"])("rejects malformed base64 %j", async (value) => {
    const response = encryptedResponse();
    response.message.encrypted_data = value;
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: response });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("rejects authenticated non-JSON plaintext", async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: encryptedResponse(null, "not json") });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("returns an empty catalog for an explicit no-farmer result", async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: {
      header: { status: "succeed", completed_count: 0, is_msg_encrypted: false },
    } });
    expect((await service.search(request())).message.catalog.providers[0].items).toEqual([]);
  });

  it("rejects plaintext farmer responses", async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: {
      header: { status: "succeed", completed_count: 1, is_msg_encrypted: false },
      message: { seek_response: entries },
    } });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it.each(["a", "b", "c"])("reports missing input for category %s without HTTP", async (category) => {
    const body = request(category);
    body.message.intent.item.tags = [];
    expect((await service.search(body)).message.catalog.providers[0].items[0].id).toBe("error");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it.each(["b", "c"])("reports gateway failure for category %s", async (category) => {
    mockedAxios.post.mockRejectedValueOnce(new Error("Network unavailable"));
    expect((await service.search(request(category))).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("reuses a valid access token", async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: encryptedResponse() });
    await service.search(request());
    await service.search(request());
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync).toHaveBeenCalledWith("private_key.pem");
  });

  it("rejects gateway failure status", async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: {
      ...encryptedResponse(), header: { status: "failed" },
    } });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("error");
  });

  it("retries a 401 with a fresh token and fresh request IDs", async () => {
    mockedAxios.post
      .mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { response: { status: 401 } }))
      .mockResolvedValueOnce({ data: { access_token: "refreshed" } })
      .mockResolvedValueOnce({ status: 200, data: encryptedResponse() });
    expect((await service.search(request())).message.catalog.providers[0].items[0].id).toBe("F1");
    const first = mockedAxios.post.mock.calls[1][1] as SeekPayload;
    const second = mockedAxios.post.mock.calls[3][1] as SeekPayload;
    expect(first.message.transaction_id).not.toBe(second.message.transaction_id);
    expect(first.header.message_id).not.toBe(second.header.message_id);
    expect(mockedAxios.post.mock.calls[3][2].headers["X-State-LGD-Code"]).toBe("22");
  });
});
