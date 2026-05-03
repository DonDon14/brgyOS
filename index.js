require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";
const PORT = process.env.PORT || 1337;

app.get("/ping", (_req, res) => {
  res.status(200).send("pong");
});

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

        if (!senderId || !incomingText) {
          continue;
        }

        const aiReply = await generateGeminiReply(incomingText);
        await sendMessengerText(senderId, aiReply);
        await logCommissionEvent(senderId, incomingText);
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook processing error:", error?.response?.data || error.message);
    return res.sendStatus(500);
  }
});

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

async function logCommissionEvent(senderId, userText) {
  const isLikelyDocumentRequest = /(clearance|indigency|residency|certificate|permit|document)/i.test(
    userText
  );

  if (!isLikelyDocumentRequest) {
    return;
  }

  const event = {
    timestamp: new Date().toISOString(),
    senderId,
    requestText: userText,
    feePhp: 15,
  };

  // Placeholder ledger logging; replace with Google Sheets write in next step.
  console.log("COMMISSION_LEDGER_EVENT", JSON.stringify(event));
}

app.listen(PORT, () => {
  console.log(`BrgyOS backend running on port ${PORT}`);
});
