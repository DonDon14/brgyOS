require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";
const PORT = process.env.PORT || 1337;
const SERVICE_FEE_PHP = 15;
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY || "change-me";
const ADMIN_PSID_LIST = (process.env.ADMIN_PSID_LIST || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const userSessions = new Map();
const requests = new Map();
const DATA_DIR = path.join(__dirname, "data");
const PDF_DIR = path.join(__dirname, "generated-pdfs");
const REQUESTS_FILE = path.join(DATA_DIR, "requests.json");
let requestCounter = 1;

ensureStorage();
loadRequestsFromDisk();

app.get("/ping", (_req, res) => {
  res.status(200).send("pong");
});
app.use("/files", express.static(PDF_DIR));
app.use("/admin", express.static(path.join(__dirname, "admin")));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    const entries = body.entry || [];

    for (const entry of entries) {
      const events = entry.messaging || [];

      for (const event of events) {
        const senderId = event?.sender?.id;
        const incomingText = event?.message?.text;
        const quickReplyPayload = event?.message?.quick_reply?.payload;
        const postbackPayload = event?.postback?.payload;
        if (senderId) {
          console.log("SENDER_PSID:", senderId);
        }

        if (!senderId) {
          continue;
        }

        const reply = postbackPayload
          ? await handlePostback(senderId, postbackPayload)
          : await handleIncomingMessage(senderId, incomingText, quickReplyPayload);
        if (reply) {
          await sendMessengerMessage(senderId, reply);
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook processing error:", error?.response?.data || error.message);
    return res.sendStatus(500);
  }
});

async function handleIncomingMessage(senderId, rawText, quickReplyPayload) {
  const text = String(rawText || "").trim();
  const payload = String(quickReplyPayload || "").trim();
  if (!text) return null;

  if (isAdmin(senderId) && payload.startsWith("STAFF_")) {
    return handleAdminQuickReply(payload);
  }

  if (isAdmin(senderId) && isAdminIntent(text)) {
    return handleAdminCommand(senderId, text);
  }

  const session = userSessions.get(senderId) || { step: null, draft: null };

  if (/^start$/i.test(text) || /^request$/i.test(text)) {
    userSessions.set(senderId, {
      step: "awaiting_document",
      draft: { senderId },
    });
    return promptForStep("awaiting_document");
  }

  if (session.step && (payload === "BACK" || /^back$/i.test(text))) {
    const previousStep = getPreviousStep(session.step);
    session.step = previousStep;
    userSessions.set(senderId, session);
    return promptForStep(previousStep, session.draft);
  }

  if (session.step === "awaiting_confirm") {
    if (/^cancel$/i.test(text)) {
      userSessions.delete(senderId);
      return asText("Request cancelled. Reply START anytime to create a new request.");
    }

    if (/^confirm$/i.test(text) || payload === "CONFIRM") {
      const normalizedDraft = await normalizeRequestDraft(session.draft);
      const request = createRequest(normalizedDraft);
      userSessions.delete(senderId);
      logCommissionEvent(request);
      return asText(
        `Your request is submitted.\nReference ID: ${request.id}\n` +
        "Status: PENDING APPROVAL\n" +
        "You will receive an update after barangay staff review."
      );
    }

    return asText("Reply CONFIRM to submit, or CANCEL to stop.");
  }

  if (session.step) {
    applySessionInput(session, text, payload);
    userSessions.set(senderId, session);
    return promptForStep(session.step, session.draft);
  }

  if (/status\s+/i.test(text)) {
    const refId = text.split(/\s+/)[1]?.toUpperCase();
    if (!refId) return asText("Use: STATUS BRGY-2026-0001");
    const request = requests.get(refId);
    if (!request || request.senderId !== senderId) {
      return asText("No request found for that reference.");
    }
    return asText(formatCustomerStatus(request));
  }

  if (isDocumentIntent(text)) {
    userSessions.set(senderId, { step: "awaiting_document", draft: { senderId } });
    return asText("I can help with that. What document do you need?");
  }

  return asText(await generateGeminiReply(text));
}

async function handleAdminCommand(_senderId, commandText) {
  const normalized = normalizeAdminCommand(commandText);
  const parts = normalized.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  let refId = parts[1] ? parts[1].toUpperCase() : null;

  if (command === "/menu") {
    return makeStaffMenu();
  }

  if (command === "/pending") {
    const pending = [...requests.values()].filter((item) => item.status === "PENDING_APPROVAL");
    if (!pending.length) return asText("No pending requests.");
    return makePendingTemplate(pending[0]);
  }

  if (!refId && ["/approve", "/pdf", "/release"].includes(command)) {
    const fallback = findLatestRequestForAction(command);
    if (!fallback) return asText("No matching request found. Try 'show pending' first.");
    refId = fallback.id;
  }

  if (!refId) {
    return asText("Try: show pending, approve, generate pdf, or release.");
  }

  const request = requests.get(refId);
  if (!request) return asText("Reference not found.");

  if (command === "/approve") {
    updateRequestStatus(request, "APPROVED", "Approved by staff");
    await notifyCustomer(request.senderId, `Your request ${request.id} is APPROVED.`);
    return makeApproveResultQuickReply(request);
  }

  if (command === "/pdf") {
    request.pdfUrl = await generateDocumentPdf(request);
    updateRequestStatus(request, "PDF_GENERATED", "PDF generated by staff");
    await notifyCustomer(
      request.senderId,
      `Your document for ${request.id} is ready.\nPDF: ${request.pdfUrl}`
    );
    return makePdfResultQuickReply(request);
  }

  if (command === "/release") {
    updateRequestStatus(request, "RELEASED", "Released by staff");
    await notifyCustomer(request.senderId, `Your request ${request.id} is marked as RELEASED.`);
    return makeReleaseResultQuickReply(request);
  }

  return asText(
    "Unknown staff action.\n" +
    "Try: 'show pending', 'approve', 'generate pdf', or 'release'."
  );
}

async function handlePostback(senderId, payload) {
  if (!isAdmin(senderId)) return null;

  if (payload === "STAFF_MENU") return makeStaffMenu();
  if (payload === "SHOW_PENDING") return handleAdminCommand(senderId, "show pending");
  if (payload === "APPROVE_LATEST") return handleAdminCommand(senderId, "approve");

  const [action, refId] = String(payload).split("|");
  if (!refId) return asText("Invalid action payload.");

  if (action === "APPROVE") return handleAdminCommand(senderId, `approve ${refId}`);
  if (action === "PDF") return handleAdminCommand(senderId, `generate pdf ${refId}`);
  if (action === "RELEASE") return handleAdminCommand(senderId, `release ${refId}`);

  return asText("Unknown action.");
}

function handleAdminQuickReply(payload) {
  if (payload === "STAFF_PENDING") return handleAdminCommand("", "show pending");
  if (payload === "STAFF_APPROVE") return handleAdminCommand("", "approve");
  if (payload === "STAFF_PDF") return handleAdminCommand("", "generate pdf");
  if (payload === "STAFF_RELEASE") return handleAdminCommand("", "release");
  if (payload === "STAFF_MENU") return makeStaffMenuQuickReply();
  return asText("Unknown staff quick action.");
}

function createRequest(draft) {
  const id = `BRGY-${new Date().getFullYear()}-${String(requestCounter).padStart(4, "0")}`;
  requestCounter += 1;

  const request = {
    id,
    senderId: draft.senderId,
    documentType: draft.documentType,
    fullName: draft.fullName,
    purpose: draft.purpose,
    pickupDate: draft.pickupDate,
    serviceFee: SERVICE_FEE_PHP,
    status: "PENDING_APPROVAL",
    pdfUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [
      {
        at: new Date().toISOString(),
        action: "CREATED",
        note: "Request submitted via Messenger",
      },
    ],
  };

  requests.set(id, request);
  persistRequests();
  return request;
}

function updateRequestStatus(request, newStatus, note) {
  request.status = newStatus;
  request.updatedAt = new Date().toISOString();
  if (!Array.isArray(request.history)) request.history = [];
  request.history.push({
    at: new Date().toISOString(),
    action: newStatus,
    note,
  });
  persistRequests();
}

function formatCustomerStatus(request) {
  const pdfLine = request.pdfUrl ? `\nPDF: ${request.pdfUrl}` : "";
  return (
    `Reference: ${request.id}\n` +
    `Document: ${request.documentType}\n` +
    `Status: ${request.status}\n` +
    `Service Fee: PHP ${request.serviceFee}${pdfLine}`
  );
}

function isAdmin(senderId) {
  return ADMIN_PSID_LIST.includes(senderId);
}

function isAdminIntent(text) {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith("/") ||
    normalized === "menu" ||
    normalized === "staff menu" ||
    normalized === "pending" ||
    normalized === "show pending" ||
    normalized === "approve" ||
    normalized.startsWith("approve ") ||
    normalized === "generate pdf" ||
    normalized === "pdf" ||
    normalized.startsWith("generate pdf ") ||
    normalized.startsWith("pdf ") ||
    normalized === "release" ||
    normalized.startsWith("release ") ||
    normalized.startsWith("mark released ")
  );
}

function normalizeAdminCommand(text) {
  const raw = text.trim();
  const normalized = raw.toLowerCase();

  if (normalized === "menu" || normalized === "staff menu") return "/menu";
  if (normalized === "pending" || normalized === "show pending") return "/pending";
  if (normalized === "approve") return "/approve";
  if (normalized.startsWith("approve ")) return `/approve ${raw.split(/\s+/).slice(1).join(" ")}`;
  if (normalized === "generate pdf" || normalized === "pdf") return "/pdf";
  if (normalized.startsWith("generate pdf ")) return `/pdf ${raw.split(/\s+/).slice(2).join(" ")}`;
  if (normalized.startsWith("pdf ")) return `/pdf ${raw.split(/\s+/).slice(1).join(" ")}`;
  if (normalized === "release") return "/release";
  if (normalized.startsWith("release ")) return `/release ${raw.split(/\s+/).slice(1).join(" ")}`;
  if (normalized.startsWith("mark released "))
    return `/release ${raw.split(/\s+/).slice(2).join(" ")}`;

  return raw;
}

function isDocumentIntent(text) {
  return /(clearance|indigency|residency|certificate|permit|document)/i.test(text);
}

function findLatestRequestForAction(command) {
  const items = [...requests.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  if (command === "/approve") return items.find((item) => item.status === "PENDING_APPROVAL") || null;
  if (command === "/pdf") return items.find((item) => item.status === "APPROVED") || null;
  if (command === "/release") return items.find((item) => item.status === "PDF_GENERATED") || null;
  return null;
}

function makeStaffMenu() {
  return makeStaffMenuQuickReply();
}

function makePendingTemplate(request) {
  return asQuickReply(
    `${request.id}\n${request.fullName}\n${request.documentType}\n${request.status}`,
    [
      { title: "Approve", payload: `STAFF_APPROVE` },
      { title: "Generate PDF", payload: "STAFF_PDF" },
      { title: "Release", payload: "STAFF_RELEASE" },
      { title: "Menu", payload: "STAFF_MENU" },
    ]
  );
}

function makeApproveResultQuickReply(request) {
  return asQuickReply(`${request.id} approved. Choose next action.`, [
    { title: "Generate PDF", payload: "STAFF_PDF" },
    { title: "Release", payload: "STAFF_RELEASE" },
    { title: "Menu", payload: "STAFF_MENU" },
  ]);
}

function makePdfResultQuickReply(request) {
  return asQuickReply(`${request.id} PDF generated. Choose next action.`, [
    { title: "Release", payload: "STAFF_RELEASE" },
    { title: "View Pending", payload: "STAFF_PENDING" },
    { title: "Menu", payload: "STAFF_MENU" },
  ]);
}

function makeReleaseResultQuickReply(request) {
  return asQuickReply(`${request.id} marked as released.`, [
    { title: "View Pending", payload: "STAFF_PENDING" },
    { title: "Menu", payload: "STAFF_MENU" },
  ]);
}

function asText(text) {
  return { text };
}

function asQuickReply(text, options) {
  return {
    text,
    quick_replies: options.map((option) => ({
      content_type: "text",
      title: option.title,
      payload: option.payload,
    })),
  };
}

function makeStaffMenuQuickReply() {
  return asQuickReply("Staff Menu", [
    { title: "View Pending", payload: "STAFF_PENDING" },
    { title: "Approve", payload: "STAFF_APPROVE" },
    { title: "Generate PDF", payload: "STAFF_PDF" },
    { title: "Release", payload: "STAFF_RELEASE" },
  ]);
}

function promptForStep(step, draft = {}) {
  if (step === "awaiting_document") {
    return asQuickReply("What document do you need?", [
      { title: "Clearance", payload: "DOC_CLEARANCE" },
      { title: "Indigency", payload: "DOC_INDIGENCY" },
      { title: "Residency", payload: "DOC_RESIDENCY" },
      { title: "Certificate", payload: "DOC_CERTIFICATE" },
    ]);
  }

  if (step === "awaiting_full_name") {
    return asQuickReply("Please provide your full name.", [{ title: "Back", payload: "BACK" }]);
  }

  if (step === "awaiting_address") {
    return asQuickReply("Please provide your complete address.", [{ title: "Back", payload: "BACK" }]);
  }

  if (step === "awaiting_purpose") {
    return asQuickReply("Please provide the purpose of request.", [{ title: "Back", payload: "BACK" }]);
  }

  if (step === "awaiting_pickup_date") {
    return asQuickReply("Preferred pickup date?", [
      { title: "Today", payload: "DATE_TODAY" },
      { title: "Tomorrow", payload: "DATE_TOMORROW" },
      { title: "Back", payload: "BACK" },
    ]);
  }

  if (step === "awaiting_confirm") {
    return asQuickReply(
      "Please confirm your request:\n" +
        `Document: ${draft.documentType}\n` +
        `Full Name: ${draft.fullName}\n` +
        `Address: ${draft.address}\n` +
        `Purpose: ${draft.purpose}\n` +
        `Pickup Date: ${draft.pickupDate}\n` +
        `Service Fee: PHP ${SERVICE_FEE_PHP}`,
      [
        { title: "Confirm", payload: "CONFIRM" },
        { title: "Back", payload: "BACK" },
        { title: "Cancel", payload: "CANCEL" },
      ]
    );
  }

  return asText("Please continue.");
}

function applySessionInput(session, text, payload) {
  if (session.step === "awaiting_document") {
    session.draft.documentType = parseDocumentValue(text, payload);
    session.step = "awaiting_full_name";
    return;
  }

  if (session.step === "awaiting_full_name") {
    session.draft.fullName = text;
    session.step = "awaiting_address";
    return;
  }

  if (session.step === "awaiting_address") {
    session.draft.address = text;
    session.step = "awaiting_purpose";
    return;
  }

  if (session.step === "awaiting_purpose") {
    session.draft.purpose = text;
    session.step = "awaiting_pickup_date";
    return;
  }

  if (session.step === "awaiting_pickup_date") {
    session.draft.pickupDate = parsePickupDate(text, payload);
    session.step = "awaiting_confirm";
  }
}

function parseDocumentValue(text, payload) {
  if (payload === "DOC_CLEARANCE") return "Clearance";
  if (payload === "DOC_INDIGENCY") return "Indigency";
  if (payload === "DOC_RESIDENCY") return "Residency";
  if (payload === "DOC_CERTIFICATE") return "Certificate";
  return text;
}

function parsePickupDate(text, payload) {
  if (payload === "DATE_TODAY") return "Today";
  if (payload === "DATE_TOMORROW") return "Tomorrow";
  return text;
}

async function normalizeRequestDraft(draft) {
  const fallback = {
    ...draft,
    fullName: toTitleCase(draft.fullName || ""),
    address: toTitleCase(draft.address || ""),
    purpose: sentenceCase(draft.purpose || ""),
    pickupDate: normalizePickupDate(draft.pickupDate || ""),
  };

  if (!GEMINI_API_KEY) return fallback;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const prompt =
    "Normalize the JSON fields for a barangay request. Fix name capitalization, address capitalization, and pickupDate format to YYYY-MM-DD when possible. Return JSON only with keys: fullName, address, purpose, pickupDate.";

  try {
    const response = await axios.post(
      endpoint,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: `${prompt}\nInput JSON: ${JSON.stringify(fallback)}` }],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 200 },
      },
      { headers: { "Content-Type": "application/json" }, timeout: 12000 }
    );

    const raw =
      response.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .join("\n")
        .trim() || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      ...draft,
      fullName: parsed.fullName || fallback.fullName,
      address: parsed.address || fallback.address,
      purpose: parsed.purpose || fallback.purpose,
      pickupDate: parsed.pickupDate || fallback.pickupDate,
    };
  } catch (_error) {
    return fallback;
  }
}

function toTitleCase(value) {
  return String(value)
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function sentenceCase(value) {
  const v = String(value).trim();
  if (!v) return v;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function normalizePickupDate(value) {
  const v = String(value).trim();
  if (!v) return v;
  if (/^today$/i.test(v)) return new Date().toISOString().slice(0, 10);
  if (/^tomorrow$/i.test(v)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const date = new Date(v);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return v;
}

function getPreviousStep(step) {
  if (step === "awaiting_confirm") return "awaiting_pickup_date";
  if (step === "awaiting_pickup_date") return "awaiting_purpose";
  if (step === "awaiting_purpose") return "awaiting_address";
  if (step === "awaiting_address") return "awaiting_full_name";
  if (step === "awaiting_full_name") return "awaiting_document";
  return "awaiting_document";
}

async function generateGeminiReply(userText) {
  if (!GEMINI_API_KEY) {
    return "AI service is not configured yet. Please try again later.";
  }

  const systemPrompt =
    "You are BrgyOS assistant for barangay document requests. Help users request Clearance, Indigency, Residency, and other documents. Keep replies short, polite, and actionable. Mention a PHP 15 service fee when a request is being processed.";

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\nUser message: ${userText}` }],
      },
    ],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 300,
    },
  };

  try {
    const response = await axios.post(endpoint, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    const text =
      response.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n")
        .trim() || "";

    return text || "I can help with your barangay request. Please share your full name and requested document type.";
  } catch (error) {
    console.error("Gemini API error:", error?.response?.data || error.message);
    return "I received your message. Please try again in a moment while I reconnect to the assistant service.";
  }
}

async function sendMessengerMessage(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    throw new Error("PAGE_ACCESS_TOKEN is missing.");
  }

  const endpoint = "https://graph.facebook.com/v20.0/me/messages";
  const normalizedMessage = typeof message === "string" ? { text: message } : message;

  await axios.post(
    endpoint,
    {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: normalizedMessage,
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    }
  );
}

function logCommissionEvent(request) {
  const event = {
    timestamp: new Date().toISOString(),
    requestId: request.id,
    senderId: request.senderId,
    fullName: request.fullName,
    documentType: request.documentType,
    feePhp: request.serviceFee,
    status: request.status,
  };

  console.log("COMMISSION_LEDGER_EVENT", JSON.stringify(event));
}

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
}

function loadRequestsFromDisk() {
  if (!fs.existsSync(REQUESTS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf8"));
    const items = Array.isArray(data.requests) ? data.requests : [];
    for (const item of items) {
      requests.set(item.id, item);
    }
    requestCounter = Number(data.requestCounter || items.length + 1);
  } catch (error) {
    console.error("Failed to load requests from disk:", error.message);
  }
}

function persistRequests() {
  const payload = {
    requestCounter,
    requests: [...requests.values()],
  };
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function generateDocumentPdf(request) {
  const fileName = `${request.id}.pdf`;
  const filePath = path.join(PDF_DIR, fileName);
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const writeStream = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    doc.pipe(writeStream);

    doc.fontSize(18).text("Barangay Document Request", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Reference ID: ${request.id}`);
    doc.text(`Document Type: ${request.documentType}`);
    doc.text(`Full Name: ${request.fullName}`);
    doc.text(`Purpose: ${request.purpose}`);
    doc.text(`Preferred Pickup Date: ${request.pickupDate}`);
    doc.text(`Service Fee: PHP ${request.serviceFee}`);
    doc.text(`Status: ${request.status}`);
    doc.moveDown();
    doc.text(`Issued On: ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`);
    doc.moveDown(2);
    doc.text("Prepared by BrgyOS Messenger Workflow");
    doc.text("Authorized Signature: _______________________");
    doc.end();

    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/files/${fileName}`;
  }
  return `PDF generated on server: /files/${fileName}`;
}

async function notifyCustomer(recipientId, text) {
  try {
    await sendMessengerMessage(recipientId, text);
  } catch (error) {
    console.error("Failed to notify customer:", error?.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`BrgyOS backend running on port ${PORT}`);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/requests", requireAdminApiKey, (req, res) => {
  const status = String(req.query.status || "ALL").toUpperCase();
  let items = [...requests.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  if (status !== "ALL") {
    items = items.filter((item) => item.status === status);
  }

  res.json({ data: items });
});

app.post("/api/admin/requests/:id/approve", requireAdminApiKey, async (req, res) => {
  const request = requests.get(String(req.params.id || "").toUpperCase());
  if (!request) return res.status(404).json({ error: "Request not found." });

  updateRequestStatus(request, "APPROVED", "Approved from dashboard");
  await notifyCustomer(request.senderId, `Your request ${request.id} is APPROVED.`);
  return res.json({ ok: true, data: request });
});

app.post("/api/admin/requests/:id/pdf", requireAdminApiKey, async (req, res) => {
  const request = requests.get(String(req.params.id || "").toUpperCase());
  if (!request) return res.status(404).json({ error: "Request not found." });

  request.pdfUrl = await generateDocumentPdf(request);
  updateRequestStatus(request, "PDF_GENERATED", "PDF generated from dashboard");
  await notifyCustomer(request.senderId, `Your document for ${request.id} is ready.\nPDF: ${request.pdfUrl}`);
  return res.json({ ok: true, data: request });
});

app.post("/api/admin/requests/:id/release", requireAdminApiKey, async (req, res) => {
  const request = requests.get(String(req.params.id || "").toUpperCase());
  if (!request) return res.status(404).json({ error: "Request not found." });

  updateRequestStatus(request, "RELEASED", "Released from dashboard");
  await notifyCustomer(request.senderId, `Your request ${request.id} is marked as RELEASED.`);
  return res.json({ ok: true, data: request });
});

function requireAdminApiKey(req, res, next) {
  const headerKey = req.headers["x-admin-key"];
  if (!headerKey || headerKey !== ADMIN_DASHBOARD_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}
