require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ENCRYPTION_KEY,
  HEARTBEAT_TIMEOUT_MS
} = process.env;

const app = express();
app.use(express.json());

const TIMEOUT = Number(HEARTBEAT_TIMEOUT_MS || 15000);

// sessionId -> { vaultId, messageId, embed, lastSeen }
const sessions = new Map();

// ===== AES decrypt giống y vault =====
function getKey() {
  const base = ENCRYPTION_KEY || "CHANGE_THIS_TO_A_LONG_SECRET";
  return crypto.createHash("sha256").update(String(base)).digest();
}
function decrypt(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, "base64");
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data= buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// Lấy webhook thật từ Supabase dựa trên vaultId (wh_xxxx)
async function getWebhookUrlFromVaultId(vaultId) {
  const url = `${SUPABASE_URL}/rest/v1/webhooks?id=eq.${encodeURIComponent(vaultId)}&select=webhook_enc`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  const rows = await resp.json().catch(() => []);
  if (!resp.ok || !Array.isArray(rows) || rows.length === 0) {
    throw new Error("vaultId not found in Supabase");
  }
  const webhookEnc = rows[0].webhook_enc;
  const webhookUrl = decrypt(webhookEnc);
  return webhookUrl;
}

// PATCH message để đổi Status -> Disconnected
async function patchMessageDisconnected(vaultId, msgId, embed) {
  const webhookUrl = await getWebhookUrlFromVaultId(vaultId);

  const u = new URL(webhookUrl);
  const parts = u.pathname.split("/").filter(Boolean);
  // /api/webhooks/{id}/{token}
  const webhookId    = parts[parts.length - 2];
  const webhookToken = parts[parts.length - 1];

  // clone embed & sửa field Status
  const newEmbed = JSON.parse(JSON.stringify(embed || {}));
  newEmbed.color = 0xe74c3c; // đỏ

  if (!Array.isArray(newEmbed.fields)) newEmbed.fields = [];

  let found = false;
  for (const f of newEmbed.fields) {
    if (typeof f.name === "string" && f.name:match && f.name:match("Status")) {}
  }

  // JS không có :match như Lua, nên dùng includes
  for (const f of newEmbed.fields) {
    if (typeof f.name === "string" && f.name.toLowerCase().includes("status")) {
      f.value = "🔴 Disconnected";
      f.inline = true;
      found = true;
      break;
    }
  }
  if (!found) {
    newEmbed.fields.push({
      name: "Status",
      value: "🔴 Disconnected",
      inline: true
    });
  }

  const patchUrl = `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}/messages/${msgId}`;

  await axios.patch(
    patchUrl,
    { embeds: [newEmbed] },
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

// ========== API ==========

// Script gọi sau khi gửi main embed
app.post("/register", async (req, res) => {
  try {
    const {
      sessionId,
      vaultId,
      messageId,
      channelId,
      username,
      displayName,
      placeId,
      jobId,
      embed
    } = req.body || {};

    if (!sessionId || !vaultId || !messageId || !embed) {
      return res.status(400).json({ error: "missing fields" });
    }

    sessions.set(sessionId, {
      vaultId,
      messageId,
      embed,
      lastSeen: Date.now()
    });

    console.log("[Status] register", sessionId, vaultId, messageId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[Status] /register error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// Script ping 5s/lần
app.post("/ping", (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: "missing sessionId" });
    }
    const s = sessions.get(sessionId);
    if (s) {
      s.lastSeen = Date.now();
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[Status] /ping error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// Loop check timeout -> EDIT embed
setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, s] of Array.from(sessions.entries())) {
    if (now - s.lastSeen > TIMEOUT) {
      console.log("[Status] timeout", sessionId, "-> disconnected");
      try {
        await patchMessageDisconnected(s.vaultId, s.messageId, s.embed);
      } catch (err) {
        console.error("[Status] patch failed:", err);
      }
      sessions.delete(sessionId);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Status API listening on port", PORT);
});
