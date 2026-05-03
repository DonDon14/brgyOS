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
        if (senderId) {
          console.log("SENDER_PSID:", senderId);
        }

        if (!senderId || !incomingText) {
          continue;
        }

        const reply = await handleIncomingMessage(senderId, incomingText);
        if (reply) {
          await sendMessengerText(senderId, reply);
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook processing error:", error?.response?.data || error.message);
    return res.sendStatus(500);
  }
});

async function handleIncomingMessage(senderId, rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  if (isAdmin(senderId) && isAdminIntent(text)) {
    return handleAdminCommand(senderId, text);
  }

  const session = userSessions.get(senderId) || { step: null, draft: null };

  if (/^start$/i.test(text) || /^request$/i.test(text)) {
    userSessions.set(senderId, {
      step: "awaiting_document",
      draft: { senderId },
    });
    return "What document do you need? (Clearance, Indigency, Residency, or Certificate)";
  }

  if (session.step === "awaiting_document") {
    session.draft.documentType = text;
    session.step = "awaiting_full_name";
    userSessions.set(senderId, session);
    return "Please provide your full name.";
  }

  if (session.step === "awaiting_full_name") {
    session.draft.fullName = text;
    session.step = "awaiting_purpose";
    userSessions.set(senderId, session);
    return "Please provide the purpose of request.";
  }

  if (session.step === "awaiting_purpose") {
    session.draft.purpose = text;
    session.step = "awaiting_pickup_date";
    userSessions.set(senderId, session);
    return "Preferred pickup date? (example: May 10, 2026)";
  }

  if (session.step === "awaiting_pickup_date") {
    session.draft.pickupDate = text;
    session.step = "awaiting_confirm";
    userSessions.set(senderId, session);
    return (
      "Please confirm your request:\n" +
      `Document: ${session.draft.documentType}\n` +
      `Full Name: ${session.draft.fullName}\n` +
      `Purpose: ${session.draft.purpose}\n` +
      `Pickup Date: ${session.draft.pickupDate}\n` +
      `Service Fee: PHP ${SERVICE_FEE_PHP}\n\n` +
      "Reply CONFIRM to submit or CANCEL to stop."
    );
  }

  if (session.step === "awaiting_confirm") {
    if (/^cancel$/i.test(text)) {
      userSessions.delete(senderId);
      return "Request cancelled. Reply START anytime to create a new request.";
    }

    if (/^confirm$/i.test(text)) {
      const request = createRequest(session.draft);
      userSessions.delete(senderId);
      logCommissionEvent(request);
      return (
        `Your request is submitted.\nReference ID: ${request.id}\n` +
        "Status: PENDING APPROVAL\n" +
        "You will receive an update after barangay staff review."
      );
    }

    return "Reply CONFIRM to submit, or CANCEL to stop.";
  }

  if (/status\s+/i.test(text)) {
    const refId = text.split(/\s+/)[1]?.toUpperCase();
    if (!refId) return "Use: STATUS BRGY-2026-0001";
    const request = requests.get(refId);
    if (!request || request.senderId !== senderId) {
      return "No request found for that reference.";
    }
    return formatCustomerStatus(request);
  }

  if (isDocumentIntent(text)) {
    userSessions.set(senderId, { step: "awaiting_document", draft: { senderId } });
    return "I can help with that. What document do you need?";
  }

  return generateGeminiReply(text);
}

async function handleAdminCommand(_senderId, commandText) {
  const normalized = normalizeAdminCommand(commandText);
  const parts = normalized.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  let refId = parts[1] ? parts[1].toUpperCase() : null;

  if (command === "/menu") {
    return (
      "Staff Menu:\n" +
      "show pending\n" +
      "approve\n" +
      "generate pdf\n" +
      "release\n\n" +
      "You can also include a reference ID if needed."
    );
  }

  if (command === "/pending") {
    const pending = [...requests.values()].filter((item) => item.status === "PENDING_APPROVAL");
    if (!pending.length) return "No pending requests.";
    return pending
      .slice(0, 10)
      .map((item) => `${item.id} | ${item.fullName} | ${item.documentType} | ${item.status}`)
      .join("\n");
  }

  if (!refId && ["/approve", "/pdf", "/release"].includes(command)) {
    const fallback = findLatestRequestForAction(command);
    if (!fallback) return "No matching request found. Try 'show pending' first.";
    refId = fallback.id;
  }

  if (!refId) {
    return "Try: show pending, approve, generate pdf, or release.";
  }

  const request = requests.get(refId);
  if (!request) return "Reference not found.";

  if (command === "/approve") {
    request.status = "APPROVED";
    request.updatedAt = new Date().toISOString();
    persistRequests();
    await notifyCustomer(request.senderId, `Your request ${request.id} is APPROVED.`);
    return `${request.id} approved. Next: /pdf ${request.id}`;
  }

  if (command === "/pdf") {
    request.status = "PDF_GENERATED";
    request.pdfUrl = await generateDocumentPdf(request);
    request.updatedAt = new Date().toISOString();
    persistRequests();
    await notifyCustomer(
      request.senderId,
      `Your document for ${request.id} is ready.\nPDF: ${request.pdfUrl}`
    );
    return `${request.id} PDF generated: ${request.pdfUrl}`;
  }

  if (command === "/release") {
    request.status = "RELEASED";
    request.updatedAt = new Date().toISOString();
    persistRequests();
    await notifyCustomer(request.senderId, `Your request ${request.id} is marked as RELEASED.`);
    return `${request.id} marked as released.`;
  }

  return (
    "Unknown staff action.\n" +
    "Try: 'show pending', 'approve', 'generate pdf', or 'release'."
  );
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
  };

  requests.set(id, request);
  persistRequests();
  return request;
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

async function sendMessengerText(recipientId, messageText) {
  if (!PAGE_ACCESS_TOKEN) {
    throw new Error("PAGE_ACCESS_TOKEN is missing.");
  }

  const endpoint = "https://graph.facebook.com/v20.0/me/messages";

  await axios.post(
    endpoint,
    {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text: messageText },
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
    await sendMessengerText(recipientId, text);
  } catch (error) {
    console.error("Failed to notify customer:", error?.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`BrgyOS backend running on port ${PORT}`);
});
