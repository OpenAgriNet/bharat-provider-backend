/**
 * PM Kisan OTP — send / verify CLI tool
 *
 * Mirrors AppService.sendOTP / verifyOTP (src/app.service.ts): calls the PM-KISAN
 * ChatbotOTP and ChatbotOTPVerified endpoints with the same AES-128-CBC payload.
 *
 * Uses the built-in base URL / token below; override with PM_KISAN_BASE_OTP_URL and
 * PM_KISSAN_TOKEN in the shell environment.
 *
 * Usage:
 *   node test-pmkisan-otp.js send   <mobile|reg_no>
 *   node test-pmkisan-otp.js verify <mobile|reg_no> <otp>
 *   node test-pmkisan-otp.js flow   <mobile|reg_no>      # send, then prompt for OTP and verify
 *   node test-pmkisan-otp.js <mobile|reg_no>             # same as flow
 */

const crypto = require("crypto");
const readline = require("readline");

// ── config ─────────────────────────────────────────────────────────────────
const BASE_URL = (
  process.env.PM_KISAN_BASE_OTP_URL ||
  "https://exlink.pmkisan.gov.in/services/chatbotservice.asmx"
).replace(/\/+$/, "");
const TOKEN = process.env.PM_KISSAN_TOKEN || "FHGBHFYBT268Gpf37hmJ6RY";

// ── crypto (same as src/utils/encryption.ts) ───────────────────────────────
function getUniqueKey() {
  return crypto.randomBytes(16).toString("hex");
}

function keyBytes(key) {
  const buf = Buffer.alloc(16);
  Buffer.from(key, "utf-8").copy(buf, 0, 0, 16);
  return buf;
}

function encrypt(text, key) {
  const k = keyBytes(key);
  const cipher = crypto.createCipheriv("aes-128-cbc", k, k);
  return cipher.update(text, "utf8", "base64") + cipher.final("base64");
}

function decrypt(text, key) {
  const k = keyBytes(key);
  const decipher = crypto.createDecipheriv("aes-128-cbc", k, k);
  const out = Buffer.concat([decipher.update(Buffer.from(text, "base64")), decipher.final()]);
  return out.toString("utf-8").trim();
}

// ── helpers ────────────────────────────────────────────────────────────────
function detectType(value) {
  return /^[6-9]\d{9}$/.test(value) ? "Mobile" : "Ben_id";
}

async function callPmKisan(endpoint, payload) {
  const key = getUniqueKey();
  const body = { EncryptedRequest: `${encrypt(JSON.stringify(payload), key)}@${key}` };
  const url = `${BASE_URL}/${endpoint}`;

  console.log(`\n→ POST ${url}`);
  console.log("  payload:", JSON.stringify({ ...payload, Token: "***" }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  console.log(`← HTTP ${res.status}`);
  if (!res.ok) {
    console.log("  body:", raw);
    return null;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.log("  non-JSON body:", raw);
    return null;
  }

  const output = json?.d?.output || "";
  const [cipherText, responseKey] = output.split("@");
  if (!cipherText) {
    console.log("  unexpected body:", raw);
    return null;
  }

  const plain = decrypt(cipherText, responseKey || key);
  console.log("  decrypted:", plain);
  try {
    return JSON.parse(plain);
  } catch {
    return { raw: plain };
  }
}

async function sendOtp(value) {
  const result = await callPmKisan("ChatbotOTP", {
    Types: detectType(value),
    Values: value,
    Token: TOKEN,
  });
  const ok = !!result && result.Rsponce !== "False";
  console.log(`\nsendOTP status: ${ok ? "OK" : "NOT_OK"}`);
  return ok;
}

async function verifyOtp(value, otp) {
  const result = await callPmKisan("ChatbotOTPVerified", {
    Types: detectType(value),
    Values: String(value),
    OTP: String(otp),
    Token: String(TOKEN),
  });
  const ok = !!result && result.Rsponce === "True";
  console.log(`\nverifyOTP status: ${ok ? "OK" : "NOT_OK"}`);
  return ok;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function main() {
  let [, , command, value, otp] = process.argv;
  // `node test-pmkisan-otp.js <mobile|reg_no>` is shorthand for `flow`
  if (command && !value && !["send", "verify", "flow"].includes(command)) {
    [command, value] = ["flow", command];
  }

  if (!command || !value || (command === "verify" && !otp)) {
    console.log(`
Usage:
  node test-pmkisan-otp.js send   <mobile|reg_no>
  node test-pmkisan-otp.js verify <mobile|reg_no> <otp>
  node test-pmkisan-otp.js flow   <mobile|reg_no>
  node test-pmkisan-otp.js <mobile|reg_no>             (same as flow)
  `);
    process.exit(1);
  }
  if (!BASE_URL || !TOKEN) {
    console.error("Error: PM_KISAN_BASE_OTP_URL and PM_KISSAN_TOKEN must be set (.env or environment)");
    process.exit(1);
  }
  console.log(`Type detected: ${detectType(value)}`);

  let ok;
  if (command === "send") {
    ok = await sendOtp(value);
  } else if (command === "verify") {
    ok = await verifyOtp(value, otp);
  } else if (command === "flow") {
    ok = await sendOtp(value);
    if (ok) ok = await verifyOtp(value, await prompt("\nEnter OTP received: "));
  } else {
    console.error(`Unknown command "${command}". Use send, verify or flow.`);
    process.exit(1);
  }
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error("Request failed:", err.cause?.code || err.name, err.message);
  process.exit(1);
});
