// index.js - Status API (ĐÃ SỬA includes, KHÔNG CẦN TỰ SỬA THÊM)

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 15000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// bộ nhớ trong RAM, key = sessionId
const sessions = new Map();

// giả sử bạn đã có hàm decryptWebhook(...) giống vault
async function resolveWebhook(webhookUrlOrVault) {
  // tuỳ bạn: nếu bạn gửi WEBHOOK_URL thật thì chỉ return luôn:
  return webhookUrlOrVault;
}

async function patchMessageDisconnected(webhookUrl, messageId, channelId, embed) {
  // clone embed và sửa field Status
  const newEmbed = JSON.parse(JSON.stringify(embed || {}));

  if (!Array.isArray(newEmbed.fields)) {
    newEmbed.fields = [];
  }

  let found = false;
  for (const f of newEmbed.fields) {
    if (typeof f.name === "string" && f.name.toLowerCase().includes("status")) {
      f.value = "🔴 **Disconnected**";
      found = true;
      break;
    }
  }

  if (!found) {
    newEmbed.fields.push({
      name: "Status",
      value: "🔴 **Disconnected**",
      inline: true
    });
  }

  const payload = {
    embeds: [newEmbed]
  };

  const url = `${webhookUrl}/messages/${messageId}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Status-API"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[Status] PATCH failed", res.status, text);
    throw new Error("PATCH failed");
  }
}

// POST /register
app.post("/register", async (req, res) => {
  try {
    const {
      sessionId,
      webhookUrl,
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed
    } = req.body || {};

    if (!sessionId || !webhookUrl || !messageId || !channelId) {
      return res.status(400).json({ error: "missing fields" });
    }

    const realWebhook = await resolveWebhook(webhookUrl);

    sessions.set(sessionId, {
      sessionId,
      webhookUrl: realWebhook,
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed,
      lastPing: Date.now()
    });

    console.log("[Status] Registered session", sessionId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[Status] /register error", err);
    return res.status(500).json({ error: "internal" });
  }
});

// POST /ping
app.post("/ping", (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(404).json({ error: "session not found" });
    }
    const s = sessions.get(sessionId);
    s.lastPing = Date.now();
    return res.json({ ok: true });
  } catch (err) {
    console.error("[Status] /ping error", err);
    return res.status(500).json({ error: "internal" });
  }
});

// Timer check timeout
setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (now - s.lastPing > HEARTBEAT_TIMEOUT_MS) {
      console.log("[Status] Session timeout:", sessionId);
      try {
        await patchMessageDisconnected(
          s.webhookUrl,
          s.messageId,
          s.channelId,
          s.embed
        );
      } catch (err) {
        console.error("[Status] patch disconnected failed:", err);
      }
      sessions.delete(sessionId);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Status API listening on port", PORT);
});
