// index.js - Status API: lấy webhook thật từ Supabase + patch Disconnected

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 15000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ENCRYPTION_KEY) {
  console.error("[Status] Missing Supabase / ENCRYPTION_KEY env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ==== AES-256-GCM decrypt giống Vault ====
function getKey() {
  const base = ENCRYPTION_KEY || "CHANGE_THIS_TO_A_LONG_SECRET";
  return crypto.createHash("sha256").update(String(base)).digest(); // 32 bytes
}

function decryptWebhook(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// vaultId ("wh_xxx") hoặc raw webhook
async function resolveWebhook(vaultOrUrl) {
  if (!vaultOrUrl) return null;
  const s = String(vaultOrUrl);

  // Nếu bạn gửi thẳng webhook thật → dùng luôn
  if (s.startsWith("http://") || s.startsWith("https://")) {
    return s;
  }

  // Còn lại coi như là vaultId ("wh_xxx") → lấy từ Supabase rồi decrypt
  try {
    const { data, error } = await supabase
      .from("webhooks")
      .select("webhook_enc")
      .eq("id", s)
      .maybeSingle();

    if (error) {
      console.error("[Status] Supabase error:", error);
      return null;
    }
    if (!data || !data.webhook_enc) {
      console.error("[Status] Supabase: no record for", s);
      return null;
    }

    const webhookUrl = decryptWebhook(data.webhook_enc);
    return webhookUrl;
  } catch (e) {
    console.error("[Status] resolveWebhook failed:", e);
    return null;
  }
}

// ==== Lưu session trong RAM ====
const sessions = new Map();

// PATCH embed → Disconnected
async function patchMessageDisconnected(webhookUrl, messageId, channelId, embed) {
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
      inline: true,
    });
  }

  const url = `${webhookUrl}/messages/${messageId}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Status-API",
    },
    body: JSON.stringify({ embeds: [newEmbed] }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("[Status] PATCH failed", res.status, txt);
    throw new Error("PATCH failed");
  }
}

// POST /register
app.post("/register", async (req, res) => {
  try {
    const {
      sessionId,
      vaultId,       // <-- từ script
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed,
    } = req.body || {};

    if (!sessionId || !vaultId || !messageId || !channelId) {
      return res.status(400).json({ error: "missing fields" });
    }

    const webhookUrl = await resolveWebhook(vaultId);
    if (!webhookUrl) {
      return res.status(404).json({ error: "cannot resolve webhook" });
    }

    sessions.set(sessionId, {
      sessionId,
      webhookUrl,
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed,
      lastPing: Date.now(),
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
