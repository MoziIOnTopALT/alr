// index.js - Status API cho SAB (Cách B: PATCH qua protector)

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const HEARTBEAT_TIMEOUT_MS = Number(
  process.env.HEARTBEAT_TIMEOUT_MS || 15000
);
const PROTECTOR_BASE_URL = process.env.PROTECTOR_BASE_URL; // ví dụ: https://webhook-vault-vercel.vercel.app
const STATUS_SHARED_SECRET = process.env.STATUS_SHARED_SECRET || "";

if (!PROTECTOR_BASE_URL) {
  console.warn("[Status] PROTECTOR_BASE_URL not set");
}
if (!STATUS_SHARED_SECRET) {
  console.warn("[Status] STATUS_SHARED_SECRET not set");
}

// lưu session trong RAM
// session: { sessionId, vaultId, messageId, channelId, username, ..., embed, lastPing }
const sessions = new Map();

// ---- tạo HMAC để gọi protector ----
function signBody(body) {
  if (!STATUS_SHARED_SECRET) {
    throw new Error("STATUS_SHARED_SECRET missing");
  }
  const ts = Date.now().toString();
  const payload = `${ts}.${JSON.stringify(body)}`;
  const sig = crypto
    .createHmac("sha256", STATUS_SHARED_SECRET)
    .update(payload)
    .digest("hex");
  return { ts, sig };
}

// ---- gọi protector để PATCH -> Disconnected ----
async function patchMessageDisconnectedViaProtector(
  vaultId,
  messageId,
  embed
) {
  if (!PROTECTOR_BASE_URL) {
    throw new Error("PROTECTOR_BASE_URL missing");
  }

  // clone embed & sửa field Status
  const newEmbed = JSON.parse(JSON.stringify(embed || {}));
  if (!Array.isArray(newEmbed.fields)) {
    newEmbed.fields = [];
  }

  let found = false;
  for (const f of newEmbed.fields) {
    if (typeof f.name === "string" && f.name.toLowerCase().includes("status")) {
      f.value = "🔴 **Disconnected**";
      f.inline = true;
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

  const body = {
    vault_id: vaultId,
    message_id: messageId,
    embeds: [newEmbed],
  };

  const { ts, sig } = signBody(body);

  const url = `${PROTECTOR_BASE_URL}/api/status-patch`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Status-Timestamp": ts,
      "X-Status-Signature": sig,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[Status] PATCH via protector failed", res.status, text);
    throw new Error("PATCH via protector failed");
  }
}

// ========== ROUTES ==========

// POST /register
app.post("/register", (req, res) => {
  try {
    const {
      sessionId,
      vaultId, // ID trong Supabase (wh_....)
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

    sessions.set(sessionId, {
      sessionId,
      vaultId,
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed,
      lastPing: Date.now(),
    });

    console.log("[Status] Registered session", sessionId, "vault:", vaultId);
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
        await patchMessageDisconnectedViaProtector(
          s.vaultId,
          s.messageId,
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
