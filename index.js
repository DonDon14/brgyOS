require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const admin = require("firebase-admin");

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
const barangays = new Map();
const staffMembers = new Map();
const tokenAlerts = new Map();
const DATA_DIR = path.join(__dirname, "data");
const PDF_DIR = path.join(__dirname, "generated-pdfs");
const REQUESTS_FILE = path.join(DATA_DIR, "requests.json");
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
let requestCounter = 1;

ensureStorage();
const bootstrapPromise = bootstrapData().catch((error) => {
  console.error("Bootstrap error:", error?.message || error);
});

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
    await bootstrapPromise;
    const body = req.body;

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    const entries = body.entry || [];

    for (const entry of entries) {
      const pageId = String(entry?.id || "");
      const barangay = resolveBarangayByPageId(pageId);
      const events = entry.messaging || [];

      for (const event of events) {
        const senderId = event?.sender?.id;
        const incomingText = event?.message?.text;
        const quickReplyPayload = event?.message?.quick_reply?.payload;
        const postbackPayload = event?.postback?.payload;
        const isEcho = event?.message?.is_echo === true;
        if (senderId) {
          console.log("SENDER_PSID:", senderId);
        }

        if (isEcho) {
          continue;
        }

        if (!senderId) {
          continue;
        }

        const reply = postbackPayload
          ? await handlePostback(senderId, postbackPayload, barangay)
          : await handleIncomingMessage(senderId, incomingText, quickReplyPayload, barangay);
        if (reply) {
          try {
            await sendMessengerMessage(senderId, reply, barangay?.pageAccessToken);
          } catch (error) {
            const code = error?.response?.data?.error?.code;
            if (code === 190 && barangay?.id) {
              tokenAlerts.set(barangay.id, {
                status: "expired",
                message: "Facebook Page token expired. Update token in barangay settings.",
                at: new Date().toISOString(),
              });
            }
            throw error;
          }
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook processing error:", error?.response?.data || error.message);
    return res.sendStatus(500);
  }
});

async function handleIncomingMessage(senderId, rawText, quickReplyPayload, barangay) {
  const text = String(rawText || "").trim();
  const payload = String(quickReplyPayload || "").trim();
  if (!text && !payload) return null;
  const detectedLang = detectResponseLanguage(text);

  if (isAdmin(senderId, barangay?.id) && payload.startsWith("STAFF_")) {
    return handleAdminQuickReply(payload, barangay?.id);
  }

  if (isAdmin(senderId, barangay?.id) && isAdminIntent(text)) {
    return handleAdminCommand(senderId, text, barangay?.id);
  }

  const session = userSessions.get(senderId) || { step: null, draft: null, lang: detectedLang };
  session.lang = session.lang || detectedLang;

  // Recover gracefully when a document quick-reply payload arrives without an active session.
  if (!session.step && /^DOC_/.test(payload)) {
    const selectedDoc = parseDocumentValue(text, payload);
    userSessions.set(senderId, {
      step: "awaiting_full_name",
      draft: {
        senderId,
        lang: detectedLang,
        barangayId: barangay?.id || "default",
        documentType: selectedDoc,
      },
      lang: detectedLang,
    });
    return promptForStep("awaiting_full_name", { documentType: selectedDoc }, detectedLang);
  }

  if (/^start$/i.test(text) || /^request$/i.test(text)) {
    userSessions.set(senderId, {
      step: "awaiting_document",
      draft: { senderId, lang: detectedLang, barangayId: barangay?.id || "default" },
      lang: detectedLang,
    });
    return promptForStep("awaiting_document", {}, detectedLang);
  }

  if (session.step && (payload === "BACK" || /^back$/i.test(text))) {
    const previousStep = getPreviousStep(session.step);
    session.step = previousStep;
    userSessions.set(senderId, session);
    return promptForStep(previousStep, session.draft, session.lang);
  }

  if (session.step === "awaiting_confirm") {
    if (/^cancel$/i.test(text) || payload === "CANCEL") {
      userSessions.delete(senderId);
      return asText(localize(session.lang, "cancelled"));
    }

    if (/^confirm$/i.test(text) || payload === "CONFIRM") {
      try {
        const normalizedDraft = await normalizeRequestDraft(session.draft);
        const validationError = validateDraft(normalizedDraft);
        if (validationError) {
          session.draft = normalizedDraft;
          const nextStep = resolveStepFromValidationError(validationError);
          if (nextStep) {
            session.step = nextStep;
            userSessions.set(senderId, session);
            return asText(validationError);
          }
          return asText(validationError);
        }
      const request = await createRequest(normalizedDraft);
        userSessions.delete(senderId);
        logCommissionEvent(request);
        return asText(localize(session.lang, "submitted", request.id));
      } catch (error) {
        console.error("Confirm request error:", error?.message || error);
        return asText("Sorry, naay temporary error sa pag-submit. Palihug try again pinaagi sa CONFIRM.");
      }
    }

    return asText(localize(session.lang, "confirm_or_cancel"));
  }

  if (session.step) {
    applySessionInput(session, text, payload);
    userSessions.set(senderId, session);
    return promptForStep(session.step, session.draft, session.lang);
  }

  const intent = await analyzeMessageIntent(text || payload);

  if (intent === "REQUEST") {
    userSessions.set(senderId, {
      step: "awaiting_document",
      draft: { senderId, lang: detectedLang, barangayId: barangay?.id || "default" },
      lang: detectedLang,
    });
    return asQuickReply(localize(detectedLang, "ask_doc"), [
      { title: "Clearance", payload: "DOC_CLEARANCE" },
      { title: "Indigency", payload: "DOC_INDIGENCY" },
      { title: "Residency", payload: "DOC_RESIDENCY" },
      { title: "Certificate", payload: "DOC_CERTIFICATE" },
    ]);
  }

  if (intent === "FAQ") {
    const helpReply = await generateGeminiReply(
      `User asks for guidance/info, not immediate form submission. Reply helpful and short, and offer to start request if needed. User: ${text}`
    );
    return asText(helpReply);
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

async function analyzeMessageIntent(userText) {
  const fallback = /(clearance|indigency|residency|certificate|document|request|kuha|apply|apply po|pa request)/i
    .test(userText)
    ? "REQUEST"
    : "FAQ";

  if (!GEMINI_API_KEY) return fallback;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const prompt =
    "Classify message intent for barangay Messenger bot. Return one word only: REQUEST or FAQ. REQUEST means user wants to start/continue document transaction. FAQ means user asks information/how-to/prices/requirements.";

  try {
    const response = await axios.post(
      endpoint,
      {
        contents: [{ role: "user", parts: [{ text: `${prompt}\nMessage: ${userText}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 10 },
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    const raw =
      response.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .join(" ")
        .toUpperCase() || "";
    if (raw.includes("REQUEST")) return "REQUEST";
    if (raw.includes("FAQ")) return "FAQ";
    return fallback;
  } catch (_error) {
    return fallback;
  }
}

async function handleAdminCommand(_senderId, commandText, barangayId = "") {
  const normalized = normalizeAdminCommand(commandText);
  const parts = normalized.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  let refId = parts[1] ? parts[1].toUpperCase() : null;

  if (command === "/menu") {
    return makeStaffMenu();
  }

  if (command === "/pending") {
    const pending = [...requests.values()].filter(
      (item) => item.status === "PENDING_APPROVAL" && (!barangayId || item.barangayId === barangayId)
    );
    if (!pending.length) return asText("No pending requests.");
    return makePendingTemplate(pending[0]);
  }

  if (!refId && ["/approve", "/pdf", "/release"].includes(command)) {
    const fallback = findLatestRequestForAction(command, barangayId);
    if (!fallback) return asText("No matching request found. Try 'show pending' first.");
    refId = fallback.id;
  }

  if (!refId) {
    return asText("Try: show pending, approve, generate pdf, or release.");
  }

  const request = requests.get(refId);
  if (!request) return asText("Reference not found.");

  if (command === "/approve") {
    await updateRequestStatus(request, "APPROVED", "Approved by staff");
    await notifyCustomer(request.senderId, `Your request ${request.id} is APPROVED.`, request.barangayId);
    return makeApproveResultQuickReply(request);
  }

  if (command === "/pdf") {
    request.pdfUrl = await generateDocumentPdf(request);
    await updateRequestStatus(request, "PDF_GENERATED", "PDF generated by staff");
    await notifyCustomer(
      request.senderId,
      `Your document for ${request.id} is ready.\nPDF: ${request.pdfUrl}`,
      request.barangayId
    );
    return makePdfResultQuickReply(request);
  }

  if (command === "/release") {
    await updateRequestStatus(request, "RELEASED", "Released by staff");
    await notifyCustomer(
      request.senderId,
      `Your request ${request.id} is marked as RELEASED.`,
      request.barangayId
    );
    return makeReleaseResultQuickReply(request);
  }

  return asText(
    "Unknown staff action.\n" +
    "Try: 'show pending', 'approve', 'generate pdf', or 'release'."
  );
}

async function handlePostback(senderId, payload, barangay) {
  if (!isAdmin(senderId, barangay?.id)) return null;

  if (payload === "STAFF_MENU") return makeStaffMenu();
  if (payload === "SHOW_PENDING") return handleAdminCommand(senderId, "show pending", barangay?.id);
  if (payload === "APPROVE_LATEST") return handleAdminCommand(senderId, "approve", barangay?.id);

  const [action, refId] = String(payload).split("|");
  if (!refId) return asText("Invalid action payload.");

  if (action === "APPROVE") return handleAdminCommand(senderId, `approve ${refId}`, barangay?.id);
  if (action === "PDF") return handleAdminCommand(senderId, `generate pdf ${refId}`, barangay?.id);
  if (action === "RELEASE") return handleAdminCommand(senderId, `release ${refId}`, barangay?.id);

  return asText("Unknown action.");
}

function handleAdminQuickReply(payload, barangayId = "") {
  if (payload === "STAFF_PENDING") return handleAdminCommand("", "show pending", barangayId);
  if (payload === "STAFF_APPROVE") return handleAdminCommand("", "approve", barangayId);
  if (payload === "STAFF_PDF") return handleAdminCommand("", "generate pdf", barangayId);
  if (payload === "STAFF_RELEASE") return handleAdminCommand("", "release", barangayId);
  if (payload === "STAFF_MENU") return makeStaffMenuQuickReply();
  return asText("Unknown staff quick action.");
}

async function createRequest(draft) {
  const id = `BRGY-${new Date().getFullYear()}-${String(requestCounter).padStart(4, "0")}`;
  requestCounter += 1;

  const request = {
    id,
    senderId: draft.senderId,
    barangayId: draft.barangayId || "default",
    documentType: draft.documentType,
    fullName: draft.fullName,
    address: draft.address,
    purpose: draft.purpose,
    pickupDate: draft.pickupDate,
    lang: draft.lang || "en",
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
  await persistRequests();
  return request;
}

async function updateRequestStatus(request, newStatus, note) {
  request.status = newStatus;
  request.updatedAt = new Date().toISOString();
  if (!Array.isArray(request.history)) request.history = [];
  request.history.push({
    at: new Date().toISOString(),
    action: newStatus,
    note,
  });
  await persistRequests();
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

function isAdmin(senderId, barangayId = "") {
  if (ADMIN_PSID_LIST.includes(senderId)) return true;
  for (const staff of staffMembers.values()) {
    if (staff.psid === senderId && staff.active !== false) {
      if (!barangayId) return true;
      return staff.barangayId === barangayId || staff.role === "owner";
    }
  }
  return false;
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

function findLatestRequestForAction(command, barangayId = "") {
  const items = [...requests.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const scoped = barangayId ? items.filter((item) => item.barangayId === barangayId) : items;

  if (command === "/approve") return scoped.find((item) => item.status === "PENDING_APPROVAL") || null;
  if (command === "/pdf") return scoped.find((item) => item.status === "APPROVED") || null;
  if (command === "/release") return scoped.find((item) => item.status === "PDF_GENERATED") || null;
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

function promptForStep(step, draft = {}, lang = "en") {
  if (step === "awaiting_document") {
    return asQuickReply(localize(lang, "ask_doc"), [
      { title: "Clearance", payload: "DOC_CLEARANCE" },
      { title: "Indigency", payload: "DOC_INDIGENCY" },
      { title: "Residency", payload: "DOC_RESIDENCY" },
      { title: "Certificate", payload: "DOC_CERTIFICATE" },
    ]);
  }

  if (step === "awaiting_full_name") {
    return asQuickReply(localize(lang, "ask_name"), [{ title: localize(lang, "back"), payload: "BACK" }]);
  }

  if (step === "awaiting_address") {
    return asQuickReply(localize(lang, "ask_address"), [{ title: localize(lang, "back"), payload: "BACK" }]);
  }

  if (step === "awaiting_purpose") {
    return asQuickReply(localize(lang, "ask_purpose"), [{ title: localize(lang, "back"), payload: "BACK" }]);
  }

  if (step === "awaiting_pickup_date") {
    return asQuickReply(localize(lang, "ask_date"), [
      { title: localize(lang, "today"), payload: "DATE_TODAY" },
      { title: localize(lang, "tomorrow"), payload: "DATE_TOMORROW" },
      { title: localize(lang, "back"), payload: "BACK" },
    ]);
  }

  if (step === "awaiting_confirm") {
    return asQuickReply(
      `${localize(lang, "confirm_header")}\n` +
        `Document: ${draft.documentType}\n` +
        `Full Name: ${toTitleCase(draft.fullName || "")}\n` +
        `Address: ${toTitleCase(draft.address || "")}\n` +
        `Purpose: ${sentenceCase(draft.purpose || "")}\n` +
      `Pickup Date: ${formatPickupDateForDisplay(draft.pickupDate)}\n` +
        `Service Fee: PHP ${SERVICE_FEE_PHP}`,
      [
        { title: localize(lang, "confirm"), payload: "CONFIRM" },
        { title: localize(lang, "back"), payload: "BACK" },
        { title: localize(lang, "cancel"), payload: "CANCEL" },
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
  const now = new Date();
  const toPretty = (dateObj) =>
    dateObj.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

  if (payload === "DATE_TODAY") {
    return toPretty(now);
  }

  if (payload === "DATE_TOMORROW") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toPretty(d);
  }

  const raw = String(text || "").trim();
  if (!raw) return raw;

  const withYear = /\b\d{4}\b/.test(raw) ? raw : `${raw}, ${now.getFullYear()}`;
  const parsed = new Date(withYear);
  if (!Number.isNaN(parsed.getTime())) {
    return toPretty(parsed);
  }
  return toTitleCase(raw);
}

function formatPickupDateForDisplay(value) {
  return String(value || "").trim();
}

function detectResponseLanguage(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(unsa|ngano|palihog|kini|kuha)\b/.test(lower)) return "ceb";
  if (/\b(ano|paano|po|pakisuyo|kumuha)\b/.test(lower)) return "tl";
  if (/\b(how|what|please|request|online)\b/.test(lower)) return "en";
  return "tl";
}

function localize(lang, key, refId = "") {
  const dict = {
    en: {
      ask_doc: "What document do you need?",
      ask_name: "Please provide your full name.",
      ask_address: "Please provide your complete address.",
      ask_purpose: "Please provide the purpose of request.",
      ask_date: "Preferred pickup date?",
      confirm_header: "Please confirm your request:",
      confirm: "Confirm",
      cancel: "Cancel",
      back: "Back",
      today: "Today",
      tomorrow: "Tomorrow",
      cancelled: "Request cancelled. Reply START anytime to create a new request.",
      submitted: `Your request is submitted.\nReference ID: ${refId}\nStatus: PENDING APPROVAL\nYou will receive an update after barangay staff review.`,
      confirm_or_cancel: "Reply CONFIRM to submit, or CANCEL to stop.",
    },
    tl: {
      ask_doc: "Anong dokumento ang kailangan mo?",
      ask_name: "Pakibigay ang buong pangalan mo.",
      ask_address: "Pakibigay ang kumpletong address mo.",
      ask_purpose: "Ano ang layunin ng request?",
      ask_date: "Kailan ang preferred pickup date?",
      confirm_header: "Paki-confirm ang iyong request:",
      confirm: "Confirm",
      cancel: "Cancel",
      back: "Back",
      today: "Today",
      tomorrow: "Tomorrow",
      cancelled: "Nakansela ang request. I-type ang START kung gusto mong magsimula ulit.",
      submitted: `Na-submit na ang request mo.\nReference ID: ${refId}\nStatus: PENDING APPROVAL\nMakakatanggap ka ng update pagkatapos ng staff review.`,
      confirm_or_cancel: "I-reply ang CONFIRM para isumite, o CANCEL para itigil.",
    },
    ceb: {
      ask_doc: "Unsa nga dokumento ang imong kinahanglan?",
      ask_name: "Palihug ihatag ang imong tibuok ngalan.",
      ask_address: "Palihug ihatag ang imong kumpletong address.",
      ask_purpose: "Unsa ang tuyo sa request?",
      ask_date: "Kanus-a ang preferred pickup date?",
      confirm_header: "Palihug i-confirm ang imong request:",
      confirm: "Confirm",
      cancel: "Cancel",
      back: "Back",
      today: "Today",
      tomorrow: "Tomorrow",
      cancelled: "Nakanselar ang request. I-type ang START kung gusto ka magsugod usab.",
      submitted: `Na-submit na ang imong request.\nReference ID: ${refId}\nStatus: PENDING APPROVAL\nMaka-receive ka og update human sa staff review.`,
      confirm_or_cancel: "I-reply ang CONFIRM para isumite, o CANCEL para undang.",
    },
  };
  return (dict[lang] || dict.tl)[key] || key;
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

function validateDraft(draft) {
  if (!draft.documentType) return "Document type is required. Please go back and select a document.";
  if (!draft.fullName || draft.fullName.trim().length < 5) {
    return "Please provide a valid full name (at least 5 characters).";
  }
  if (!draft.address || draft.address.trim().length < 8) {
    return "Please provide a complete address (at least 8 characters).";
  }
  if (!draft.purpose || draft.purpose.trim().length < 3) {
    return "Please provide a valid purpose.";
  }
  if (!draft.pickupDate || draft.pickupDate.trim().length < 4) {
    return "Please provide a valid pickup date.";
  }
  return "";
}

function resolveStepFromValidationError(message) {
  const m = String(message || "").toLowerCase();
  if (m.includes("document")) return "awaiting_document";
  if (m.includes("full name")) return "awaiting_full_name";
  if (m.includes("address")) return "awaiting_address";
  if (m.includes("purpose")) return "awaiting_purpose";
  if (m.includes("pickup date")) return "awaiting_pickup_date";
  return "";
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

async function sendMessengerMessage(recipientId, message, pageAccessToken = "") {
  const token = pageAccessToken || PAGE_ACCESS_TOKEN;
  if (!token) {
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
      params: { access_token: token },
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

function isFirestoreConfigured() {
  return Boolean(FIREBASE_SERVICE_ACCOUNT_JSON || FIREBASE_PROJECT_ID);
}

function getFirestoreDb() {
  if (!isFirestoreConfigured()) return null;
  if (!admin.apps.length) {
    if (FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });
    }
  }
  return admin.firestore();
}

async function bootstrapData() {
  ensureStorage();
  if (isFirestoreConfigured()) {
    await loadFromFirestore();
  } else {
    loadRequestsFromDisk();
  }
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

async function loadFromFirestore() {
  const db = getFirestoreDb();
  if (!db) return;

  requests.clear();
  barangays.clear();
  staffMembers.clear();

  const [rqSnap, brgySnap, staffSnap] = await Promise.all([
    db.collection("requests").get(),
    db.collection("barangays").get(),
    db.collection("staff").get(),
  ]);

  rqSnap.forEach((docRef) => {
    const item = docRef.data();
    if (item?.id) requests.set(item.id, item);
  });
  brgySnap.forEach((docRef) => {
    const b = docRef.data();
    if (b?.id) barangays.set(b.id, b);
  });
  staffSnap.forEach((docRef) => {
    const s = docRef.data();
    if (s?.id) staffMembers.set(s.id, s);
  });

  if (!barangays.size) {
    const defaultBarangay = {
      id: "default",
      name: "Barangay Ane-i",
      municipality: "Claveria",
      province: "Misamis Oriental",
      captainName: "Ernie Sinayon",
      secretaryName: "Arlene Ocero",
      pageId: process.env.DEFAULT_PAGE_ID || "",
      pageAccessToken: PAGE_ACCESS_TOKEN || "",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    barangays.set(defaultBarangay.id, defaultBarangay);
    await db.collection("barangays").doc(defaultBarangay.id).set(defaultBarangay);
  }

  requestCounter = Math.max(
    1,
    ...[...requests.values()]
      .map((r) => Number(String(r.id || "").split("-").pop() || 0))
      .filter((n) => Number.isFinite(n))
  ) + 1;
}

async function persistRequests() {
  const db = getFirestoreDb();
  if (db) {
    const batch = db.batch();
    for (const request of requests.values()) {
      batch.set(db.collection("requests").doc(request.id), request, { merge: true });
    }
    await batch.commit();
    return;
  }
  const payload = {
    requestCounter,
    requests: [...requests.values()],
  };
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function persistBarangays() {
  const db = getFirestoreDb();
  if (!db) return;
  const batch = db.batch();
  for (const barangay of barangays.values()) {
    batch.set(db.collection("barangays").doc(barangay.id), barangay, { merge: true });
  }
  await batch.commit();
}

async function persistStaffMembers() {
  const db = getFirestoreDb();
  if (!db) return;
  const batch = db.batch();
  for (const staff of staffMembers.values()) {
    batch.set(db.collection("staff").doc(staff.id), staff, { merge: true });
  }
  await batch.commit();
}

async function writeAuditLog(action, actorId, request) {
  const db = getFirestoreDb();
  if (!db) return;
  const record = {
    action,
    actorId,
    barangayId: request.barangayId || "",
    requestId: request.id || "",
    at: new Date().toISOString(),
  };
  await db.collection("audit_logs").add(record);
}

function resolveBarangayByPageId(pageId) {
  if (!pageId) return barangays.get("default") || [...barangays.values()][0] || null;
  for (const b of barangays.values()) {
    if (String(b.pageId || "") === String(pageId)) return b;
  }
  return barangays.get("default") || [...barangays.values()][0] || null;
}

async function generateDocumentPdf(request) {
  const fileName = `${request.id}.pdf`;
  const filePath = path.join(PDF_DIR, fileName);
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const writeStream = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    doc.pipe(writeStream);

    const issueDate = new Date().toLocaleDateString("en-PH", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Manila",
    });

    const barangay = barangays.get(request.barangayId || "default") || resolveBarangayByPageId("");
    const barangayName = barangay?.name || "Barangay";
    const municipality = barangay?.municipality || "Municipality";
    const province = barangay?.province || "Province";
    const captainName = (barangay?.captainName || "Barangay Captain").toUpperCase();
    const secretaryName = (barangay?.secretaryName || "Barangay Secretary").toUpperCase();

    doc.fontSize(11).text("Republic of the Philippines", { align: "center" });
    doc.fontSize(11).text(`Province of ${province}`, { align: "center" });
    doc.fontSize(11).text(`Municipality of ${municipality}`, { align: "center" });
    doc.fontSize(12).text(barangayName, { align: "center" });
    doc.moveDown(1.2);

    const template = buildDocumentTemplate(request, issueDate, barangayName, municipality, province);
    doc.font("Helvetica-Bold").fontSize(15).text(template.title, { align: "center" });
    doc.moveDown(1.2);
    doc.font("Helvetica").fontSize(12).text(template.body, {
      align: "justify",
      lineGap: 3,
      indent: 18,
    });

    doc.moveDown(1.2);
    doc.font("Helvetica").fontSize(11).text(`Issued this ${issueDate} at ${barangayName}, ${municipality}, ${province}.`);
    doc.moveDown(2);

    doc.font("Helvetica-Bold").fontSize(11).text(captainName, 70);
    doc.font("Helvetica").fontSize(10).text("Punong Barangay / Barangay Captain", 70);

    doc.font("Helvetica-Bold").fontSize(11).text(secretaryName, 340, doc.y - 26);
    doc.font("Helvetica").fontSize(10).text("Barangay Secretary", 340);

    doc.moveDown(2.2);
    doc.font("Helvetica").fontSize(9).text(`Reference No.: ${request.id}`);
    // Address is already embedded in certificate body; keep footer concise.
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

function buildDocumentTemplate(request, issueDate, barangayName, municipality, province) {
  const fullName = toTitleCase(request.fullName || "");
  const address = toTitleCase(request.address || "");
  const purpose = sentenceCase(request.purpose || "legal purpose");
  const type = String(request.documentType || "").toLowerCase();

  if (type.includes("indigency")) {
    return {
      title: "BARANGAY CERTIFICATE OF INDIGENCY",
      body:
        `TO WHOM IT MAY CONCERN:\n\n` +
        `This is to certify that ${fullName}, of legal age, Filipino, and a bona fide resident of ${address}, ${barangayName}, ${municipality}, ${province}, is known in this barangay as an indigent resident based on records and community verification.\n\n` +
        `This certification is issued upon the request of the above-named person for ${purpose} and for whatever legal purpose it may serve.`,
    };
  }

  if (type.includes("residency") || type.includes("residence")) {
    return {
      title: "BARANGAY CERTIFICATE OF RESIDENCY",
      body:
        `TO WHOM IT MAY CONCERN:\n\n` +
        `This is to certify that ${fullName}, of legal age, Filipino, is a bona fide resident of ${address}, ${barangayName}, ${municipality}, ${province}.\n\n` +
        `This certification is issued upon the request of the above-named person for ${purpose} and for whatever legal purpose it may serve.`,
    };
  }

  if (type.includes("certificate")) {
    return {
      title: "BARANGAY CERTIFICATION",
      body:
        `TO WHOM IT MAY CONCERN:\n\n` +
        `This is to certify that ${fullName}, of legal age, Filipino, is a bona fide resident of ${address}, ${barangayName}, ${municipality}, ${province}.\n\n` +
        `This certification is issued for ${purpose} and for whatever legal purpose it may serve.`,
    };
  }

  return {
    title: "BARANGAY CLEARANCE",
    body:
      `TO WHOM IT MAY CONCERN:\n\n` +
      `This is to certify that ${fullName}, of legal age, Filipino, and a bona fide resident of ${address}, ${barangayName}, ${municipality}, ${province}, is known to be a person of good moral character and has no derogatory record or pending complaint on file in this barangay as of ${issueDate}.\n\n` +
      `This clearance is issued upon request for ${purpose} and for whatever legal purpose it may serve.`,
  };
}

async function notifyCustomer(recipientId, text, barangayId = "") {
  try {
    const barangay = barangayId ? barangays.get(barangayId) : null;
    await sendMessengerMessage(recipientId, text, barangay?.pageAccessToken || "");
  } catch (error) {
    const code = error?.response?.data?.error?.code;
    if (code === 190 && barangayId) {
      tokenAlerts.set(barangayId, {
        status: "expired",
        message: "Facebook Page token expired. Reconnect or update token in barangay settings.",
        at: new Date().toISOString(),
      });
    }
    console.error("Failed to notify customer:", error?.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`BrgyOS backend running on port ${PORT}`);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/requests", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const status = String(req.query.status || "ALL").toUpperCase();
  const barangayId = String(req.query.barangayId || "");
  let items = [...requests.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  if (barangayId) {
    items = items.filter((item) => item.barangayId === barangayId);
  }

  if (status !== "ALL") {
    items = items.filter((item) => item.status === status);
  }

  res.json({ data: items, tokenAlerts: Object.fromEntries(tokenAlerts.entries()) });
});

app.post("/api/admin/requests/:id/approve", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const request = requests.get(String(req.params.id || "").toUpperCase());
  if (!request) return res.status(404).json({ error: "Request not found." });

  await updateRequestStatus(request, "APPROVED", "Approved from dashboard");
  await notifyCustomer(request.senderId, `Your request ${request.id} is APPROVED.`, request.barangayId);
  await writeAuditLog("APPROVE", "dashboard_admin", request);
  return res.json({ ok: true, data: request });
});

app.post("/api/admin/requests/:id/pdf", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const request = requests.get(String(req.params.id || "").toUpperCase());
  if (!request) return res.status(404).json({ error: "Request not found." });

  request.pdfUrl = await generateDocumentPdf(request);
  await updateRequestStatus(request, "PDF_GENERATED", "PDF generated from dashboard");
  await notifyCustomer(request.senderId, `Your document for ${request.id} is ready.\nPDF: ${request.pdfUrl}`, request.barangayId);
  await writeAuditLog("GENERATE_PDF", "dashboard_admin", request);
  return res.json({ ok: true, data: request });
});

app.post("/api/admin/requests/:id/release", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const request = requests.get(String(req.params.id || "").toUpperCase());
  if (!request) return res.status(404).json({ error: "Request not found." });

  await updateRequestStatus(request, "RELEASED", "Released from dashboard");
  await notifyCustomer(request.senderId, `Your request ${request.id} is marked as RELEASED.`, request.barangayId);
  await writeAuditLog("RELEASE", "dashboard_admin", request);
  return res.json({ ok: true, data: request });
});

app.get("/api/admin/export.csv", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const barangayId = String(req.query.barangayId || "");
  const items = [...requests.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const scoped = barangayId ? items.filter((item) => item.barangayId === barangayId) : items;

  const headers = [
    "reference_id",
    "full_name",
    "document_type",
    "address",
    "purpose",
    "pickup_date",
    "service_fee",
    "status",
    "pdf_url",
    "created_at",
    "updated_at",
  ];

  const escapeCsv = (value) => `"${String(value || "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];

  for (const item of scoped) {
    lines.push(
      [
        item.id,
        item.fullName,
        item.documentType,
        item.address,
        item.purpose,
        item.pickupDate,
        item.serviceFee,
        item.status,
        item.pdfUrl || "",
        item.createdAt,
        item.updatedAt,
      ]
        .map(escapeCsv)
        .join(",")
    );
  }

  const csv = lines.join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="brgyos-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(csv);
});

app.get("/api/admin/backup.json", requireAdminApiKey, async (_req, res) => {
  await bootstrapPromise;
  const payload = { requests: [...requests.values()], barangays: [...barangays.values()], staff: [...staffMembers.values()] };
  return res.status(200).json(payload);
});

app.get("/api/owner/barangays", requireAdminApiKey, async (_req, res) => {
  await bootstrapPromise;
  return res.json({ data: [...barangays.values()] });
});

app.post("/api/owner/barangays", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const input = req.body || {};
  const id = String(input.id || "").trim().toLowerCase() || `brgy-${Date.now()}`;
  const record = {
    id,
    name: input.name || id,
    municipality: input.municipality || "",
    province: input.province || "",
    logoUrl: input.logoUrl || "",
    captainName: input.captainName || "",
    secretaryName: input.secretaryName || "",
    pageId: input.pageId || "",
    pageAccessToken: input.pageAccessToken || "",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  barangays.set(id, record);
  await persistBarangays();
  return res.json({ ok: true, data: record });
});

app.patch("/api/owner/barangays/:id", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const id = String(req.params.id || "").toLowerCase();
  const existing = barangays.get(id);
  if (!existing) return res.status(404).json({ error: "Barangay not found." });
  Object.assign(existing, req.body || {}, { updatedAt: new Date().toISOString() });
  barangays.set(id, existing);
  await persistBarangays();
  return res.json({ ok: true, data: existing });
});

app.get("/api/owner/staff", requireAdminApiKey, async (_req, res) => {
  await bootstrapPromise;
  return res.json({ data: [...staffMembers.values()] });
});

app.post("/api/owner/staff", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const input = req.body || {};
  const id = String(input.id || "").trim().toLowerCase() || `staff-${Date.now()}`;
  const record = {
    id,
    name: input.name || id,
    barangayId: input.barangayId || "default",
    role: input.role || "staff",
    psid: input.psid || "",
    active: input.active !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  staffMembers.set(id, record);
  await persistStaffMembers();
  return res.json({ ok: true, data: record });
});

app.patch("/api/owner/staff/:id", requireAdminApiKey, async (req, res) => {
  await bootstrapPromise;
  const id = String(req.params.id || "").toLowerCase();
  const existing = staffMembers.get(id);
  if (!existing) return res.status(404).json({ error: "Staff not found." });
  Object.assign(existing, req.body || {}, { updatedAt: new Date().toISOString() });
  staffMembers.set(id, existing);
  await persistStaffMembers();
  return res.json({ ok: true, data: existing });
});

function requireAdminApiKey(req, res, next) {
  const headerKey = req.headers["x-admin-key"];
  const queryKey = req.query.key;
  const provided = headerKey || queryKey;
  if (!provided || provided !== ADMIN_DASHBOARD_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}
