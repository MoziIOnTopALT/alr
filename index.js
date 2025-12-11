// index.js - Status API

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

// ==== ENV ====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 15000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[Status] Missing Supabase env");
}

// Supabase client (server-side, dùng service role key)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ==== Decrypt giống hệt protector ====
function getKey() {
  const base = ENCRYPTION_KEY || "CHANGE_THIS_TO_A_LONG_SECRET";
  return crypto.createHash("sha256").update(String(base)).digest();
}

function decrypt(b64) {
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

function extractVaultId(str) {
  if (!str) return null;
  const m = String(str).match(/wh_[0-9a-f]+/i);
  return m ? m[0] : null;
}

// Nếu nhận vault URL / vault id → lấy real webhook từ Supabase
async function resolveWebhook(webhookUrlOrVault) {
  if (!webhookUrlOrVault) return null;

  // đã là Discord webhook thì trả luôn
  if (/discord(app)?\.com\/api\/webhooks\//.test(webhookUrlOrVault)) {
    return webhookUrlOrVault;
  }

  const vaultId = extractVaultId(webhookUrlOrVault);
  if (!vaultId) {
    // Không phải vault id ⇒ cứ trả lại như cũ
    return webhookUrlOrVault;
  }

  const { data, error } = await supabase
    .from("webhooks")
    .select("webhook_enc")
    .eq("id", vaultId)
    .maybeSingle();

  if (error || !data) {
    console.error("[Status] resolveWebhook supabase error:", error || "no data");
    throw new Error("Cannot resolve webhook from vaultId");
  }

  const realUrl = decrypt(data.webhook_enc);
  return realUrl;
}

// ==== PATCH message -> Disconnected ====
async function patchMessageDisconnected(webhookOrVault, messageId, channelId, embed) {
  const webhookUrl = await resolveWebhook(webhookOrVault);
  if (!webhookUrl) {
    console.error("[Status] patch: cannot resolve webhook url");
    return;
  }

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

  const payload = { embeds: [newEmbed] };
  const url = `${webhookUrl}/messages/${messageId}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Status-API",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[Status] PATCH failed", res.status, text);
    throw new Error("PATCH failed");
  }
}

// ==== Session store (RAM) ====
const sessions = new Map();

// POST /register
app.post("/register", async (req, res) => {
  try {
    const {
      sessionId,
      webhookUrl, // có thể là vault URL
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed,
    } = req.body || {};

    if (!sessionId || !webhookUrl || !messageId || !channelId) {
      return res.status(400).json({ error: "missing fields" });
    }

    // Lưu lại, khi timeout mới resolveWebhook để patch
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
