// index.js - Status API (bản dùng vaultId từ Supabase, PATCH embed Disconnected)

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "CHANGE_THIS_TO_A_LONG_SECRET";

const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 15000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// === Giải mã webhook_enc giống vault ===
function getKey() {
  return crypto.createHash("sha256").update(String(ENCRYPTION_KEY)).digest();
}

function decryptWebhook(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// webhookKey có thể là:
//  - full Discord URL
//  - hoặc id vault "wh_xxx..." trong Supabase
async function resolveWebhook(webhookKey) {
  if (!webhookKey) return null;

  if (
    webhookKey.startsWith("http://") ||
    webhookKey.startsWith("https://")
  ) {
    return webhookKey;
  }

  // Coi như id trong bảng Supabase
  const { data, error } = await supabase
    .from("webhooks")
    .select("webhook_enc")
    .eq("id", webhookKey)
    .maybeSingle();

  if (error || !data) {
    console.error("[Status] resolveWebhook error", error);
    return null;
  }

  try {
    return decryptWebhook(data.webhook_enc);
  } catch (e) {
    console.error("[Status] decryptWebhook error", e);
    return null;
  }
}

async function patchMessageDisconnected(webhookKey, messageId, channelId, embed) {
  const webhookUrl = await resolveWebhook(webhookKey);
  if (!webhookUrl) {
    throw new Error("Cannot resolve webhook from key");
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

  const payload = {
    embeds: [newEmbed],
  };

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
    const text = await res.text();
    console.error("[Status] PATCH failed", res.status, text);
    throw new Error("PATCH failed");
  }
}

// ===== Sessions trong RAM =====
const sessions = new Map();

// POST /register
app.post("/register", async (req, res) => {
  try {
    const {
      sessionId,
      vaultId,
      webhookUrl,    // fallback nếu sau này muốn gửi thẳng webhook
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed,
    } = req.body || {};

    const webhookKey = vaultId || webhookUrl;

    if (!sessionId || !webhookKey || !messageId || !channelId) {
      return res.status(400).json({ error: "missing fields" });
    }

    // Không resolve ngay cũng được, chỉ cần lưu key.
    sessions.set(sessionId, {
      sessionId,
      webhookKey,
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
          s.webhookKey,
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
