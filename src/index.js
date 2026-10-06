/* NexTap production deployment sync — dashboard session/profile hardening */
import { CARD_DESIGNS } from "./card-designs.js";
import { buildContactCard, contactFilename } from "./contact-card.js";
import { QUICK_BLOCKS, contentUsage, contentLimitViolation, normalizePlan } from "../public/content-limits.js";
const CARD_DESIGN_BY_ID = new Map(CARD_DESIGNS.map(design => [design.id, design]));
const MAX_ROW_BYTES = 1800000;
const MAX_IMAGE_URL_BYTES = 1700000;
const MAX_REQUEST_BYTES = 2000000;
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function assertRowBudget(record) {
  const encoder = new TextEncoder();
  const size = Object.values(record).reduce((sum, value) => sum + encoder.encode(String(value ?? "")).length, 0);
  if (size > MAX_ROW_BYTES) throw new RequestError("Profile or order is too large. Please use smaller images or less content.", 413);
}

function validateImageUrl(value) {
  const image = String(value || "").trim();
  if (!image) return image;
  if (image.startsWith("data:")) {
    if (image.length > MAX_IMAGE_URL_BYTES) throw new RequestError("Image is too large. Please upload a smaller image.", 413);
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) throw new RequestError("Please use a valid JPG, PNG or WebP image.");
    let bytes;
    try { bytes = atob(match[2]); } catch { throw new RequestError("Invalid image data."); }
    const png = bytes.startsWith("\x89PNG\r\n\x1a\n");
    const jpeg = bytes.startsWith("\xff\xd8\xff");
    const webp = bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    if (!(match[1] === "png" ? png : match[1] === "jpeg" ? jpeg : webp)) throw new RequestError("Image content does not match its file type.");
  } else {
    let parsed;
    try { parsed = new URL(image); } catch { throw new RequestError("Image URL must use https or http."); }
    if (!["https:", "http:"].includes(parsed.protocol)) throw new RequestError("Image URL must use https or http.");
  }
  return image;
}

async function readJsonRequest(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("Invalid request.");
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) { await reader.cancel(); throw new RequestError("Request is too large. Please use smaller images or less content.", 413); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(text); } catch { throw new RequestError("Invalid JSON request."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new RequestError("Request must be a JSON object.");
  return data;
}

async function imageFileDataUrl(file) {
  if (!(file instanceof File)) throw new RequestError("No photo selected.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new RequestError("Please use JPG, PNG or WebP.");
  if (file.size > 1200 * 1024) throw new RequestError("Optimized photo must be 1.2 MB or smaller.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return validateImageUrl("data:" + file.type + ";base64," + btoa(binary));
}

async function readFormRequest(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("No photo selected.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new RequestError("Upload is too large. Please use a smaller image.", 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    return await new Request(request.url, { method: request.method, headers: request.headers, body: new Blob(chunks) }).formData();
  } catch { throw new RequestError("Invalid photo upload."); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

// Advance display timestamps without using them as the content-write lock.
function nextProfileTimestamp(row) {
  const previous = Date.parse(row?.updated_at || "");
  return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

function changedProfileResponse() {
  return json({ code: "PROFILE_CHANGED", error: "This profile was updated elsewhere. Your edits have not been saved. Reload the latest profile before trying again." }, 409);
}

// Older dashboard clients may omit the revision. Updated editors send the
// version they opened, so a stale tab cannot overwrite a newer saved profile.
function expectedProfileRevision(request, body) {
  const header = request.headers.get("X-Expected-Revision");
  const supplied = body && Object.prototype.hasOwnProperty.call(body, "expected_revision");
  let fromHeader;
  if (header !== null) {
    if (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header))) throw new RequestError("Invalid expected profile revision.");
    fromHeader = Number(header);
  }
  if (supplied && (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0)) throw new RequestError("Invalid expected profile revision.");
  if (supplied && header !== null && body.expected_revision !== fromHeader) throw new RequestError("Conflicting expected profile revisions.");
  return supplied ? body.expected_revision : fromHeader;
}

function matchesProfileRevision(request, row, body) {
  const expected = expectedProfileRevision(request, body);
  return expected === undefined || expected === Number(row?.content_revision ?? 0);
}

async function limitLoginAttempts(request, env, namespace, identifier) {
  const secret = env.CLIENT_AUTH_SECRET || env.ADMIN_PASSWORD;
  if (!secret) return;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  const expiry = (bucket + 1) * windowMs;
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE expires_at <= ?").bind(now).run();
  const keys = [];
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) keys.push({ value: "ip:" + ip, limit: 40 });
  keys.push({ value: "account:" + identifier, limit: 10 });
  for (const entry of keys) {
    const key = namespace + ":" + bucket + ":" + await hmacSign(entry.value, secret);
    const result = await env.DB.prepare("INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts")
      .bind(key, expiry).first();
    if (Number(result?.attempts || 0) > entry.limit) {
      const error = new RequestError("Too many sign-in attempts. Please try again later.", 429);
      error.retryAfter = Math.max(1, Math.ceil((expiry - now) / 1000));
      throw error;
    }
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeBusinessHours(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;
    const normalized = parsed.map((item, index) => {
      const toMinutes = v => {
        if (v === null || v === undefined || v === "") return null;
        if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
        const parts = String(v).trim().split(":");
        if (parts.length !== 2) return null;
        const h = Number(parts[0]), m = Number(parts[1]);
        return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59
          ? h * 60 + m
          : null;
      };
      const normalizedDay = {
        ...(item && typeof item === "object" ? item : {}),
        day: item?.day != null && Number.isInteger(Number(item.day)) && Number(item.day) >= 0 && Number(item.day) <= 6 ? Number(item.day) : index,
        enabled: item?.enabled !== false,
        open: toMinutes(item?.open),
        close: toMinutes(item?.close)
      };
      if (Array.isArray(item?.periods)) {
        normalizedDay.periods = item.periods.map(period => ({
          ...period,
          open: toMinutes(period?.open),
          close: toMinutes(period?.close)
        }));
      }
      return normalizedDay;
    });
    return JSON.stringify(normalized);
  } catch {
    return raw;
  }
}

function rowToClient(row, origin) {
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    job_title: row.job_title || "",
    company: row.company || "",
    about: row.about || "",

    phone: row.phone || "",
    email: row.email || "",
    messenger: row.messenger || "",
    whatsapp: row.whatsapp || "",
    viber: row.viber || "",

    instagram: row.instagram || "",
    facebook: row.facebook || "",
    linkedin: row.linkedin || "",
    tiktok: row.tiktok || "",
    youtube: row.youtube || "",
    x: row.x || "",
    telegram: row.telegram || "",
    threads: row.threads || "",
    github: row.github || "",
    behance: row.behance || "",
    dribbble: row.dribbble || "",
    twitch: row.twitch || "",
    steam: row.steam || "",
    website: row.website || "",

    accent_color: row.accent_color || "#2162c6",

    // Card Type
    card_type: row.card_type || "basic",
    content_plan: contentUsage(row),
    content_revision: Number(row.content_revision || 0),

    // Profile Type (Premium / Elite)
    profile_type: row.profile_type || "",

    active: Boolean(row.active),
    view_count: Number(row.view_count || 0),
    last_viewed_at: row.last_viewed_at || "",

    photo_url: row.photo_key || "",
    photo: row.photo_key || "",

    // Featured
    featured_enabled: Boolean(row.featured_enabled),
    featured_title: row.featured_title || "",
    featured_description: row.featured_description || "",
    featured_image: row.featured_image || "",
    featured_button_text: row.featured_button_text || "",
    featured_button_link: row.featured_button_link || "",

    // Quick Info
    location: row.location || "",
    business_hours: row.business_hours || "",
    services: row.services || "",
    portfolio: row.portfolio || "",
    booking: row.booking || "",
    reviews: row.reviews || "",
    payments: row.payments || "",

    // New Quick Info
    education: row.education || "",
    skills: row.skills || "",
    resume: row.resume || "",
    achievements: row.achievements || "",
    certifications: row.certifications || "",
    pricing: row.pricing || "",
    products: row.products || "",
    promotions: row.promotions || "",
    team: row.team || "",
    multiple_locations: row.multiple_locations || "",
    business_inquiry: row.business_inquiry || "",
    business_location_name: row.business_location_name || "",
    business_location_link: row.business_location_link || "",
    business_locations: row.business_locations || "[]",
    profile_modules: row.profile_modules || "{}",
    profile_module_visibility: row.profile_module_visibility || "{}",

    // Quick Info Order
    quick_info_order:
      row.quick_info_order ||
      '["business_location","business_hours","services","portfolio","booking","reviews","payments","education","skills","resume","achievements","certifications","pricing","products","promotions","team","multiple_locations","business_inquiry"]',

    quick_info_enabled: row.quick_info_enabled !== 0,

    show_business_location: row.show_business_location !== 0,
    show_location: row.show_location !== 0,
    show_business_hours: row.show_business_hours !== 0,
    show_services: row.show_services !== 0,
    show_portfolio: row.show_portfolio !== 0,
    show_booking: row.show_booking !== 0,
    show_reviews: row.show_reviews !== 0,
    show_payments: row.show_payments !== 0,

    // New Quick Info visibility
    show_education: row.show_education !== 0,
    show_skills: row.show_skills !== 0,
    show_resume: row.show_resume !== 0,
    show_achievements: row.show_achievements !== 0,
    show_certifications: row.show_certifications !== 0,
    show_pricing: row.show_pricing !== 0,
    show_products: row.show_products !== 0,
    show_promotions: row.show_promotions !== 0,
    show_team: row.show_team !== 0,
    show_multiple_locations: row.show_multiple_locations !== 0,
    show_business_inquiry: row.show_business_inquiry !== 0
  };
}

function rowToPublicClient(row) {
  if (!row) return null;
  const client = rowToClient(row, "");
  delete client.view_count;
  delete client.last_viewed_at;
  delete client.content_revision;
  const quickFields = ["location", "business_hours", "services", "portfolio", "booking", "reviews", "payments", "education", "skills", "resume", "achievements", "certifications", "pricing", "products", "promotions", "team", "multiple_locations", "business_inquiry"];
  for (const field of quickFields) {
    if (!client.quick_info_enabled || !client["show_" + field] || (QUICK_BLOCKS.includes(field) && !client.content_plan.keys.includes(field))) delete client[field];
  }
  if (!client.content_plan.keys.includes("business_location")) {
    delete client.business_location_name;
    delete client.business_location_link;
    delete client.business_locations;
  }
  if (!client.content_plan.keys.includes("featured")) {
    for (const field of ["featured_title", "featured_description", "featured_image", "featured_button_text", "featured_button_link"]) delete client[field];
  }
  let modules = {}, visibility = {};
  try { modules = JSON.parse(client.profile_modules); } catch {}
  try { visibility = JSON.parse(client.profile_module_visibility); } catch {}
  const published = {};
  if (client.quick_info_enabled && modules && typeof modules === "object" && !Array.isArray(modules)) {
    for (const key of ["media", "games", "streaming", "discord", "tournament_history", "gallery", "interests", "custom_links", "collaborations"]) {
      if (client.content_plan.keys.includes(key) && visibility?.[key] !== false && Object.prototype.hasOwnProperty.call(modules, key)) published[key] = modules[key];
    }
  }
  client.profile_modules = JSON.stringify(published);
  return client;
}

async function getClientByKey(env, key, origin) {
  const row = await env.DB.prepare(
    "SELECT * FROM clients WHERE (id = ? OR slug = ?) AND active = 1 LIMIT 1"
  )
    .bind(key, key)
    .first();

  return rowToPublicClient(row);
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    new RegExp(
      "(^|;\\s*)" +
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "=([^;]*)"
    )
  );

  try { return match ? decodeURIComponent(match[2]) : null; } catch { return null; }
}

function base64UrlEncode(bytes) {
  let binary = "";

  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    c => c.charCodeAt(0)
  );
}

async function hmacSign(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text)
  );

  return base64UrlEncode(
    new Uint8Array(signature)
  );
}

async function createAdminSession(env) {
  const expires =
    Date.now() +
    7 * 24 * 60 * 60 * 1000;

  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        role: "admin",
        exp: expires
      })
    )
  );

  const signature = await hmacSign(
    payload,
    env.ADMIN_PASSWORD
  );

  return payload + "." + signature;
}

async function verifyAdminSession(request, env) {
  const token = getCookie(
    request,
    "nextap_admin"
  );

  if (!token || !env.ADMIN_PASSWORD) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [payload, signature] = parts;

  try {
    const expected = await hmacSign(
      payload,
      env.ADMIN_PASSWORD
    );

    if (signature.length !== expected.length) {
      return false;
    }

    let diff = 0;

    for (
      let i = 0;
      i < signature.length;
      i++
    ) {
      diff |=
        signature.charCodeAt(i) ^
        expected.charCodeAt(i);
    }

    if (diff !== 0) {
      return false;
    }

    const data = JSON.parse(
      new TextDecoder().decode(
        base64UrlDecode(payload)
      )
    );

    return (
      data.role === "admin" &&
      data.exp > Date.now()
    );
  } catch {
    return false;
  }
}

async function hashClientPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    key,
    256
  );
  return {
    salt: base64UrlEncode(salt),
    hash: base64UrlEncode(new Uint8Array(bits))
  };
}

async function verifyClientPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const salt = base64UrlDecode(storedSalt);
    const result = await hashClientPassword(password, salt);
    if (result.hash.length !== storedHash.length) return false;
    let diff = 0;
    for (let i = 0; i < storedHash.length; i++) {
      diff |= storedHash.charCodeAt(i) ^ result.hash.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

async function clientCredentialFingerprint(env, row) {
  return hmacSign(JSON.stringify([row.id, row.login_password_hash || "", row.login_password_salt || ""]), env.CLIENT_AUTH_SECRET || env.ADMIN_PASSWORD);
}

async function createClientSession(env, clientId, credentials) {
  const secret = env.CLIENT_AUTH_SECRET || env.ADMIN_PASSWORD;
  if (!secret) throw new Error("CLIENT_AUTH_SECRET is not configured");
  const row = credentials || await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(String(clientId)).first();
  if (!row) throw new Error("Client not found");
  const credential = await clientCredentialFingerprint(env, row);
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({ role: "client", clientId, exp: expires, credential })
    )
  );
  const signature = await hmacSign(payload, secret);
  return payload + "." + signature;
}

async function verifyClientSession(request, env) {
  const token = getCookie(request, "nextap_client");
  const secret = env.CLIENT_AUTH_SECRET || env.ADMIN_PASSWORD;
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  try {
    const expected = await hmacSign(payload, secret);
    if (signature.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) {
      diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff !== 0) return null;
    const data = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload))
    );
    if (data.role !== "client" || data.exp <= Date.now() || !data.clientId) return null;
    const row = await env.DB.prepare(
      "SELECT * FROM clients WHERE id = ? AND active = 1 LIMIT 1"
    ).bind(String(data.clientId)).first();
    // Old tokens require one sign-in after this upgrade. A password reset
    // invalidates all tokens bound to the previous stored credentials.
    if (!row || !data.credential || data.credential !== await clientCredentialFingerprint(env, row)) return null;
    return row;
  } catch {
    return null;
  }
}

async function handleClientAuth(request, env, url) {
  if (url.pathname === "/api/client-auth/me" && request.method === "GET") {
    const row = await verifyClientSession(request, env);
    return json({
      authenticated: Boolean(row),
      client: row ? rowToClient(row, url.origin) : null
    });
  }

  if (url.pathname === "/api/client-auth/login" && request.method === "POST") {
    const body = await readJsonRequest(request);

    const identifier = String(body.identifier || body.email || "").trim();
    const email = identifier.toLowerCase();
    const password = String(body.password || "");
    if (!identifier || !password) return json({ error: "Email/phone and password are required." }, 400);
    if (identifier.length > 254 || password.length > 256) throw new RequestError("Sign-in details are too long.");

    // Match phone numbers even when the profile uses a different common format
    // (e.g. 0917 123 4567, 0917-123-4567, +63 917 123 4567, or +639171234567).
    const phoneDigits = identifier.replace(/\D/g, "");
    const phoneLocal = phoneDigits.startsWith("63") && phoneDigits.length === 12
      ? "0" + phoneDigits.slice(2)
      : phoneDigits;
    const phoneIntl = phoneDigits.startsWith("0")
      ? "+63" + phoneDigits.slice(1)
      : (phoneDigits.startsWith("63") ? "+" + phoneDigits : "+" + phoneDigits);
    const phoneSql = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')";
    await limitLoginAttempts(request, env, "client", email.includes("@") ? email : phoneLocal);

    const row = await env.DB.prepare(
      "SELECT * FROM clients WHERE (lower(email) = ? OR " +
      phoneSql + " = ? OR " + phoneSql + " = ? OR " + phoneSql + " = ?) " +
      "AND active = 1 ORDER BY updated_at DESC LIMIT 1"
    ).bind(email, phoneDigits, phoneLocal, phoneIntl).first();

    const valid = row
      ? await verifyClientPassword(password, row.login_password_hash, row.login_password_salt)
      : false;

    if (!valid) return json({ error: "Invalid email or password." }, 401);

    const token = await createClientSession(env, row.id, row);
    return new Response(JSON.stringify({ ok: true, client: rowToClient(row, url.origin) }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "Set-Cookie": `nextap_client=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
      }
    });
  }

  if (url.pathname === "/api/client-auth/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Set-Cookie": "nextap_client=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      }
    });
  }

  return null;
}

async function handleClientApi(request, env, url) {
  const row = await verifyClientSession(request, env);
  if (!row) return json({ error: "Unauthorized" }, 401);

  const p = url.pathname;

  if (p === "/api/client/photo" && request.method === "PUT") {
    if (!matchesProfileRevision(request, row)) return changedProfileResponse();
    const form = await readFormRequest(request);
    const file = form.get("photo");
    const dataUrl = await imageFileDataUrl(file);
    assertRowBudget({ ...row, photo_key: dataUrl });
    const write = await env.DB.prepare("UPDATE clients SET photo_key = ?, updated_at = ?, content_revision = content_revision + 1 WHERE id = ? AND content_revision = ?")
      .bind(dataUrl, nextProfileTimestamp(row), row.id, row.content_revision).run();
    if (Number(write.meta?.changes) !== 1) return changedProfileResponse();
    const saved = await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(row.id).first();
    return json(saved ? rowToClient(saved, url.origin) : null);
  }

  if (p === "/api/client/featured-photo" && request.method === "PUT") {
    if (!matchesProfileRevision(request, row)) return changedProfileResponse();
    const form = await readFormRequest(request);
    const file = form.get("photo");
    const dataUrl = await imageFileDataUrl(file);
    assertRowBudget({ ...row, featured_image: dataUrl });
    const violation = contentLimitViolation({ ...row, featured_image: dataUrl }, row);
    if (violation) return json(violation, 400);

    const write = await env.DB.prepare("UPDATE clients SET featured_image = ?, updated_at = ?, content_revision = content_revision + 1 WHERE id = ? AND content_revision = ?")
      .bind(dataUrl, nextProfileTimestamp(row), row.id, row.content_revision).run();
    if (Number(write.meta?.changes) !== 1) return changedProfileResponse();

    const saved = await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(row.id).first();
    return json(saved ? rowToClient(saved, url.origin) : null);
  }

  if (p === "/api/client/featured-photo" && request.method === "DELETE") {
    if (!matchesProfileRevision(request, row)) return changedProfileResponse();
    const write = await env.DB.prepare("UPDATE clients SET featured_image = '', updated_at = ?, content_revision = content_revision + 1 WHERE id = ? AND content_revision = ?")
      .bind(nextProfileTimestamp(row), row.id, row.content_revision).run();
    if (Number(write.meta?.changes) !== 1) return changedProfileResponse();

    const saved = await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(row.id).first();
    return json(saved ? rowToClient(saved, url.origin) : null);
  }

  if (p === "/api/client/photo" && request.method === "DELETE") {
    if (!matchesProfileRevision(request, row)) return changedProfileResponse();
    const write = await env.DB.prepare("UPDATE clients SET photo_key = '', updated_at = ?, content_revision = content_revision + 1 WHERE id = ? AND content_revision = ?")
      .bind(nextProfileTimestamp(row), row.id, row.content_revision).run();
    if (Number(write.meta?.changes) !== 1) return changedProfileResponse();
    const saved = await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(row.id).first();
    return json(saved ? rowToClient(saved, url.origin) : null);
  }

  if (p === "/api/client/profile" && request.method === "PUT") {
    const body = await readJsonRequest(request);
    if (!matchesProfileRevision(request, row, body)) return changedProfileResponse();

    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const name = hasOwn("name") ? String(body.name ?? "").trim() : String(row.name || "").trim();
    const email = hasOwn("email") ? String(body.email ?? "").trim().toLowerCase() : String(row.email || "").trim().toLowerCase();
    // Existing phone-login accounts may legitimately have no email. An
    // unrelated content save must not require changing their login identity.
    if (!name || (!email && String(row.email || "").trim())) return json({ error: "Name and email are required." }, 400);

    if (hasOwn("email") && email) {
      const duplicateEmail = await env.DB.prepare("SELECT id FROM clients WHERE lower(email) = ? AND id != ? LIMIT 1").bind(email, row.id).first();
      if (duplicateEmail) return json({ error: "That email is already assigned to another client. Please use a different email." }, 409);
    }

    const fields = [
      "job_title","company","about","phone","whatsapp","viber","messenger","website","accent_color",
      "instagram","facebook","linkedin","tiktok","youtube","x","telegram","threads",
      "github","behance","dribbble","twitch","steam","location","business_hours","services","portfolio",
      "booking","reviews","payments","education","skills","resume","achievements",
      "certifications","pricing","products","promotions","team","multiple_locations",
      "business_inquiry","business_location_name","business_location_link","business_locations","profile_modules","profile_module_visibility","featured_title","featured_description","featured_image",
      "featured_button_text","featured_button_link"
    ];
    const values = [];
    const sets = [];
    const expectedFields = {};
    if (hasOwn("name")) { sets.push("name = ?"); values.push(name); }
    for (const field of fields) {
      if (hasOwn(field)) {
        sets.push(field + " = ?");
        const value = field === "business_hours" ? normalizeBusinessHours(body[field]) : String(body[field] ?? "").trim();
        if (field === "featured_image") validateImageUrl(value);
        expectedFields[field] = value;
        values.push(value);
      }
    }
    if (hasOwn("featured_enabled")) { sets.push("featured_enabled = ?"); values.push(body.featured_enabled ? 1 : 0); }
    if (hasOwn("quick_info_enabled")) {
      sets.push("quick_info_enabled = ?");
      values.push(body.quick_info_enabled === false ? 0 : 1);
    }
    if (hasOwn("quick_info_order")) {
      const allowedQuickInfo = [
        "business_location","business_hours","services","portfolio","booking","reviews","payments",
        "education","skills","resume","achievements","certifications","pricing","products",
        "promotions","team","business_inquiry"
      ];
      const requestedOrder = Array.isArray(body.quick_info_order) ? body.quick_info_order : [];
      const normalizedOrder = [...new Set(requestedOrder.filter(key => allowedQuickInfo.includes(key)))];
      sets.push("quick_info_order = ?");
      values.push(JSON.stringify(normalizedOrder));
    }
    const visibility = ["business_location","location","business_hours","services","portfolio","booking","reviews","payments","education","skills","resume","achievements","certifications","pricing","products","promotions","team","multiple_locations","business_inquiry"];
    for (const key of visibility) {
      const visibilityKey = "show_" + key;
      if (hasOwn(visibilityKey)) {
        sets.push(visibilityKey + " = ?");
        values.push(body[visibilityKey] === false ? 0 : 1);
      }
    }
    if (hasOwn("email")) { sets.push("email = ?"); values.push(email); }
    if (!sets.length) return json({ error: "No profile changes supplied." }, 400);
    const candidate = { ...row, ...expectedFields, name, email };
    if (hasOwn("featured_enabled")) candidate.featured_enabled = body.featured_enabled ? 1 : 0;
    if (hasOwn("quick_info_enabled")) candidate.quick_info_enabled = body.quick_info_enabled === false ? 0 : 1;
    for (const key of visibility) {
      if (hasOwn("show_" + key)) candidate["show_" + key] = body["show_" + key] === false ? 0 : 1;
    }
    assertRowBudget(candidate);
    const violation = contentLimitViolation(candidate, row);
    if (violation) return json(violation, 400);
    sets.push("updated_at = ?"); values.push(nextProfileTimestamp(row));
    sets.push("content_revision = content_revision + 1");
    values.push(row.id, row.content_revision);

    const writeResult = await env.DB.prepare("UPDATE clients SET " + sets.join(", ") + " WHERE id = ? AND content_revision = ?").bind(...values).run();
    if (!writeResult.success) {
      return json({ error: "Profile save failed at the database layer." }, 500);
    }
    if (Number(writeResult.meta?.changes) !== 1) return changedProfileResponse();

    const saved = await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(row.id).first();
    if (!saved) return json({ error: "Profile was updated but could not be reloaded from the database." }, 500);

    // Verify every field requested by the dashboard against the fresh D1 row.
    // This prevents the UI from reporting success when a write did not persist.
    const verifyFields = [...fields, "name", "email"];
    for (const field of verifyFields) {
      if (!hasOwn(field)) continue;
      const expected = field === "name" ? name : field === "email" ? email : expectedFields[field];
      const actual = String(saved[field] ?? "").trim();
      if (actual !== expected) {
        return json({
          error: "Profile save verification failed.",
          field,
          expected,
          actual
        }, 500);
      }
    }

    if (hasOwn("featured_enabled") && Number(saved.featured_enabled || 0) !== (body.featured_enabled ? 1 : 0)) {
      return json({ error: "Profile save verification failed.", field: "featured_enabled" }, 500);
    }

    for (const key of visibility) {
      const visibilityKey = "show_" + key;
      if (!hasOwn(visibilityKey)) continue;
      const expected = body[visibilityKey] === false ? 0 : 1;
      if (Number(saved[visibilityKey] ?? 0) !== expected) {
        return json({ error: "Profile save verification failed.", field: visibilityKey }, 500);
      }
    }

    return json(rowToClient(saved, url.origin));
  }

  if (p === "/api/client/password" && request.method === "PUT") {
    const body = await readJsonRequest(request);
    if (!matchesProfileRevision(request, row, body)) return changedProfileResponse();
    const currentPassword = String(body.current_password || "");
    const newPassword = String(body.new_password || "");
    if (!currentPassword || !newPassword) return json({ error: "Current and new password are required." }, 400);
    if (newPassword.length < 8) return json({ error: "New password must be at least 8 characters." }, 400);
    if (currentPassword.length > 256 || newPassword.length > 256) throw new RequestError("Password must be 256 characters or shorter.");
    await limitLoginAttempts(request, env, "password", row.id);
    const valid = await verifyClientPassword(currentPassword, row.login_password_hash, row.login_password_salt);
    if (!valid) return json({ error: "Current password is incorrect." }, 401);
    const credentials = await hashClientPassword(newPassword);
    const write = await env.DB.prepare("UPDATE clients SET login_password_hash = ?, login_password_salt = ?, updated_at = ?, content_revision = content_revision + 1 WHERE id = ? AND content_revision = ?")
      .bind(credentials.hash, credentials.salt, nextProfileTimestamp(row), row.id, row.content_revision).run();
    if (Number(write.meta?.changes) !== 1) return changedProfileResponse();
    const saved = await env.DB.prepare("SELECT * FROM clients WHERE id = ? LIMIT 1").bind(row.id).first();
    if (!saved || saved.login_password_hash !== credentials.hash) return changedProfileResponse();
    const token = await createClientSession(env, row.id, { ...row, login_password_hash: credentials.hash, login_password_salt: credentials.salt });
    const response = json({ ok: true, client: rowToClient(saved, url.origin) });
    response.headers.set("Set-Cookie", `nextap_client=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
    return response;
  }

  return json({ error: "Client API route not found" }, 404);
}

async function handleAuth(request, env, url) {
  if (
    url.pathname === "/api/auth/me" &&
    request.method === "GET"
  ) {
    return json({
      authenticated:
        await verifyAdminSession(
          request,
          env
        )
    });
  }

  if (
    url.pathname === "/api/auth/login" &&
    request.method === "POST"
  ) {
    const body = await readJsonRequest(request);
    await limitLoginAttempts(request, env, "admin", "admin");

    if (!env.ADMIN_PASSWORD) {
      return new Response(
        JSON.stringify({
          error:
            "ADMIN_PASSWORD is not configured"
        }),
        {
          status: 500,
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    if (
      body.password !==
      env.ADMIN_PASSWORD
    ) {
      return new Response(
        JSON.stringify({
          error: "Invalid password"
        }),
        {
          status: 401,
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    const token =
      await createAdminSession(env);

    return new Response(
      JSON.stringify({
        ok: true
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
          "Set-Cookie":
            `nextap_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
        }
      }
    );
  }

  if (
    url.pathname === "/api/auth/logout" &&
    request.method === "POST"
  ) {
    return new Response(
      JSON.stringify({
        ok: true
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
          "Set-Cookie":
            "nextap_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        }
      }
    );
  }

  return null;
}


function makeOrderId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return "NT-" + stamp + "-" + random;
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new RequestError("Please supply between 1 and 50 order items.");
  const prices = {
    "Basic Card": 199,
    "Premium Card": 299,
    "Elite Card": 499
  };
  return items.map(item => {
    const plan = String(item?.plan || "").trim();
    if (!Object.prototype.hasOwnProperty.call(prices, plan)) throw new RequestError("Unknown card plan.");
    const quantity = item?.quantity ?? 1;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new RequestError("Each item quantity must be a whole number between 1 and 99.");
    if (item?.custom_design !== undefined && typeof item.custom_design !== "boolean") throw new RequestError("Custom design must be true or false.");
    const custom = item?.custom_design === true;
    const designId = item?.design_id;
    if (designId !== undefined && typeof designId !== "string") throw new RequestError("Please select a valid card design.");
    if (custom && designId) throw new RequestError("Choose a ready-made design or a custom design for each card.");
    const design = designId ? CARD_DESIGN_BY_ID.get(designId) : null;
    if (designId && !design) throw new RequestError("This card design is unavailable. Please select another design.");
    const image = custom ? validateImageUrl(item?.custom_design_image) : "";
    return {
      plan,
      quantity,
      unit_price: prices[plan],
      custom_design: custom,
      custom_design_fee: custom ? 49 : 0,
      custom_design_image: image,
      ...(design ? {
        design_id: design.id,
        design_name: design.label,
        design_version: design.version,
        design_front: design.front,
        design_back: design.back
      } : {}),
      card_name: String(item?.card_name || "").trim().slice(0, 120)
    };
  });
}

function shippingForRegion(value) {
  const match = typeof value === "string" && /^(\d{2})0{7,8}$/.exec(value);
  const groups = {
    "01": "Luzon", "02": "Luzon", "03": "Luzon", "04": "Luzon",
    "05": "Luzon", "13": "Luzon", "14": "Luzon", "17": "Luzon",
    "06": "Visayas", "07": "Visayas", "08": "Visayas", "18": "Visayas",
    "09": "Mindanao", "10": "Mindanao", "11": "Mindanao", "12": "Mindanao",
    "15": "Mindanao", "16": "Mindanao", "19": "Mindanao"
  };
  const zone = match && groups[match[1]];
  if (!zone) throw new RequestError("Please select a valid delivery region.");
  return { delivery_region_code: match[1] + "00000000", shipping_zone: zone, shipping_fee: zone === "Luzon" ? 70 : 99 };
}

function formatOrderMessage(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = [
    "🔔 New NexTap Order",
    "",
    "Order: " + order.id,
    "Customer: " + order.customer_name,
    "Email: " + (order.customer_email || "—"),
    "Phone: " + (order.customer_phone || "—"),
    "Contact: " + (order.contact_preference || "—"),
    "Card Name: " + (order.card_name || "—"),
    "Title / Role: " + (order.title_role || "—"),
    "",
    "Items:"
  ];
  for (const item of items) {
    lines.push(
      "• " + item.plan +
      " × " + item.quantity +
      (item.design_id ? " · Design " + item.design_id : "") +
      (item.custom_design ? " + Custom Design" : "") +
      " — ₱" + ((item.unit_price + item.custom_design_fee) * item.quantity).toFixed(2)
    );
  }
  lines.push(
    "",
    "Subtotal: ₱" + Number(order.subtotal || 0).toFixed(2),
    "Shipping" + (order.shipping_zone ? " (" + order.shipping_zone + ")" : "") + ": ₱" + Number(order.shipping_fee || 0).toFixed(2),
    "Total: ₱" + Number(order.total || 0).toFixed(2),
    "Address: " + (order.delivery_address || "—"),
    "Notes: " + (order.delivery_notes || "—")
  );
  return lines.join("\n");
}

async function sendOrderEmail(env, order) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL || !env.RESEND_FROM_EMAIL) {
    return { sent: false, reason: "Email notification environment variables are not configured." };
  }

  const subject = "New NexTap Order " + order.id;
  const textBody = formatOrderMessage(order);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [env.ADMIN_EMAIL],
      subject,
      text: textBody
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Email notification failed: " + detail.slice(0, 300));
  }

  return { sent: true };
}

async function sendOrderWhatsApp(env, order) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.ADMIN_WHATSAPP_TO) {
    return { sent: false, reason: "WhatsApp notification environment variables are not configured." };
  }

  const response = await fetch(
    "https://graph.facebook.com/v23.0/" +
    encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID) +
    "/messages",
    {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Authorization": "Bearer " + env.WHATSAPP_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: String(env.ADMIN_WHATSAPP_TO).replace(/\D/g, ""),
        type: "text",
        text: { body: formatOrderMessage(order) }
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error("WhatsApp notification failed: " + detail.slice(0, 300));
  }

  return { sent: true };
}

async function notifyNewOrder(env, order) {
  const results = await Promise.allSettled([
    sendOrderEmail(env, order),
    sendOrderWhatsApp(env, order)
  ]);
  const email = results[0].status === "fulfilled" ? results[0].value : { sent: false, reason: results[0].reason?.message || "Email failed" };
  const whatsapp = results[1].status === "fulfilled" ? results[1].value : { sent: false, reason: results[1].reason?.message || "WhatsApp failed" };
  const sent = Boolean(email.sent || whatsapp.sent);
  return { sent, email, whatsapp };
}

async function handleApi(
  request,
  env,
  url
) {
  const p = url.pathname;

  // PROTECT ADMIN API
  const isPublicApi =
    p.startsWith("/api/address/") ||
    p === "/api/auth/login" ||
    p === "/api/auth/logout" ||
    p === "/api/auth/me" ||
    (
      p === "/api/orders" &&
      request.method === "POST"
    ) ||
    (
      p.startsWith("/api/clients/") &&
      request.method === "GET"
    ) ||
    (
      p.startsWith("/api/clients/") &&
      request.method === "POST" &&
      p.endsWith("/view")
    );

  if (
    p.startsWith("/api/") &&
    !isPublicApi
  ) {
    const authenticated =
      await verifyAdminSession(
        request,
        env
      );

    if (!authenticated) {
      return json(
        {
          error: "Unauthorized"
        },
        401
      );
    }
  }

  // PUBLIC PHILIPPINE ADDRESS DATA PROXY (PSGC Cloud)
  // Use PSGC codes instead of display-name paths so punctuation/formatting
  // differences in region names cannot break the cascading selectors.
  const PSGC_BASE = "https://psgc.cloud/api/v2";

  async function psgcJson(path, signal) {
    const response = await fetch(PSGC_BASE + path, {
      headers: { "accept": "application/json" },
      signal
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { response, data };
  }

  function psgcList(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.items)) return data.items;
    return [];
  }

  async function manilaBarangays() {
    // PSGC exposes Manila's barangays under its 14 districts, while retaining
    // the parent city in the regional city list with an empty barangay list.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const cities = await psgcJson(
        "/regions/1300000000/cities-municipalities", controller.signal
      );
      if (!cities.response.ok) {
        return json({ error: "Unable to load Manila districts." }, cities.response.status);
      }
      const expectedCodes = Array.from({ length: 14 }, (_, index) =>
        "13806" + String(index + 1).padStart(2, "0") + "000"
      );
      const districts = new Set(psgcList(cities.data)
        .filter(item => String(item.type || "").toLowerCase() === "submun")
        .map(item => String(item.code || "")));
      if (!expectedCodes.every(code => districts.has(code))) {
        return json({ error: "Unable to load all Manila districts." }, 502);
      }

      const lists = new Array(expectedCodes.length);
      let next = 0;
      let failure = null;
      async function loadDistricts() {
        while (!failure && next < expectedCodes.length) {
          const index = next++;
          try {
            const result = await psgcJson(
              "/cities-municipalities/" + expectedCodes[index] + "/barangays",
              controller.signal
            );
            if (!result.response.ok) {
              failure ||= { status: result.response.status };
              controller.abort();
              return;
            }
            const items = psgcList(result.data);
            if (!items.length || items.some(item => !item?.code || !item?.name)) {
              failure ||= { status: 502 };
              controller.abort();
              return;
            }
            lists[index] = items;
          } catch {
            failure ||= { status: controller.signal.aborted ? 504 : 502 };
            controller.abort();
          }
        }
      }
      await Promise.all(Array.from({ length: 4 }, loadDistricts));
      if (failure) return json({ error: "Unable to load all Manila barangays." }, failure.status);
      const unique = new Map();
      for (const item of lists.flat()) {
        if (!unique.has(String(item.code))) unique.set(String(item.code), item);
      }
      return json([...unique.values()]);
    } catch {
      return json({ error: "Unable to load all Manila barangays." }, controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(deadline);
    }
  }

  if (p === "/api/address/regions" && request.method === "GET") {
    const { response, data } = await psgcJson("/regions");
    return json(psgcList(data), response.status);
  }

  if (p === "/api/address/provinces" && request.method === "GET") {
    const region = String(url.searchParams.get("region") || "").trim();
    if (!region) return json({ error: "Region code is required." }, 400);

    const provincesResult = await psgcJson(
      "/regions/" + encodeURIComponent(region) + "/provinces"
    );
    if (!provincesResult.response.ok) {
      return json({ error: "Unable to load provinces." }, provincesResult.response.status);
    }

    const provinces = psgcList(provincesResult.data)
      .map(x => ({
        code: String(x.code || ""),
        name: String(x.name || "")
      }))
      .filter(x => x.code && x.name);

    // Include highly urbanized cities as selectable "province-level" entries.
    // They do not belong to a province, so they use an huc: code prefix.
    const citiesResult = await psgcJson(
      "/regions/" + encodeURIComponent(region) + "/cities-municipalities"
    );
    const hucs = psgcList(citiesResult.data)
      .filter(x => {
        const type = String(x.type || "").toLowerCase();
        const parentProvince = x.province ?? x.province_code ?? "";
        return (type === "city" || type === "highly_urbanized_city") && !parentProvince;
      })
      .map(x => ({
        code: "huc:" + String(x.code || ""),
        name: String(x.name || "")
      }))
      .filter(x => x.code !== "huc:" && x.name);

    return json([...provinces, ...hucs]);
  }

  if (p === "/api/address/cities" && request.method === "GET") {
    const region = String(url.searchParams.get("region") || "").trim();
    const province = String(url.searchParams.get("province") || "").trim();
    if (!region) return json({ error: "Region code is required." }, 400);

    if (province.startsWith("huc:")) {
      const code = province.slice(4);
      const result = await psgcJson(
        "/cities-municipalities/" + encodeURIComponent(code)
      );
      if (!result.response.ok) {
        return json({ error: "Unable to load city / municipality." }, result.response.status);
      }
      const item = result.data?.data || result.data;
      return json(item?.code ? [item] : []);
    }

    if (!province) {
      const result = await psgcJson("/regions/" + encodeURIComponent(region) + "/cities-municipalities");
      return json(psgcList(result.data), result.response.status);
    }

    const result = await psgcJson(
      "/regions/" + encodeURIComponent(region) +
      "/provinces/" + encodeURIComponent(province) +
      "/cities-municipalities"
    );
    return json(psgcList(result.data), result.response.status);
  }

  if (p === "/api/address/barangays" && request.method === "GET") {
    const region = String(url.searchParams.get("region") || "").trim();
    const province = String(url.searchParams.get("province") || "").trim();
    const city = String(url.searchParams.get("city") || "").trim();
    if (!region || !city) return json({ error: "Region and city are required." }, 400);

    if (province.startsWith("huc:") || !province) {
      const result = await psgcJson(
        "/cities-municipalities/" + encodeURIComponent(city) +
        "/barangays"
      );
      if (result.response.ok && !psgcList(result.data).length &&
          region === "1300000000" && city === "1380600000") {
        return manilaBarangays();
      }
      return json(psgcList(result.data), result.response.status);
    }

    const result = await psgcJson(
      "/regions/" + encodeURIComponent(region) +
      "/provinces/" + encodeURIComponent(province) +
      "/cities-municipalities/" + encodeURIComponent(city) +
      "/barangays"
    );
    return json(psgcList(result.data), result.response.status);
  }

  // CREATE ORDER FROM PUBLIC CHECKOUT
  if (p === "/api/orders" && request.method === "POST") {
    const d = await readJsonRequest(request);

    const customerName = String(d.customer_name || "").trim();
    const customerEmail = String(d.customer_email || "").trim().toLowerCase();
    const customerPhone = String(d.customer_phone || "").trim();
    const address = String(d.delivery_address || "").trim();
    const cardName = String(d.card_name || "").trim();
    const titleRole = String(d.title_role || "").trim();
    const items = normalizeOrderItems(d.items);

    if (!customerName || !customerEmail || !customerPhone || !address || !cardName || !titleRole || !items.length) {
      return json({
        error: "Name, email, phone, card name, title / role, delivery address, and at least one item are required."
      }, 400);
    }

    const shipping = shippingForRegion(d.delivery_region_code);
    if (d.region !== undefined && shippingForRegion(d.region).delivery_region_code !== shipping.delivery_region_code) {
      throw new RequestError("The delivery region does not match the selected address. Please review your address.");
    }
    if (d.city !== undefined && (typeof d.city !== "string" || !/^\d{9,10}$/.test(d.city) || d.city.slice(0, 2) !== shipping.delivery_region_code.slice(0, 2))) {
      throw new RequestError("The delivery city does not match the selected region. Please review your address.");
    }
    const subtotal = items.reduce((sum, item) =>
      sum + ((item.unit_price + item.custom_design_fee) * item.quantity), 0
    );
    const total = subtotal + shipping.shipping_fee;

    const order = {
      id: makeOrderId(),
      customer_name: customerName.slice(0, 160),
      customer_email: customerEmail.slice(0, 254),
      customer_phone: customerPhone.slice(0, 60),
      messenger: String(d.messenger || "").trim().slice(0, 254),
      whatsapp: String(d.whatsapp || "").trim().slice(0, 60),
      viber: String(d.viber || "").trim().slice(0, 60),
      delivery_address: address.slice(0, 1000),
      delivery_notes: String(d.delivery_notes || "").trim().slice(0, 1000),
      card_name: cardName.slice(0, 160),
      title_role: titleRole.slice(0, 160),
      design_request: String(d.design_request || "").trim().slice(0, 2000),
      contact_preference: String(d.contact_preference || "").trim().slice(0, 40),
      items,
      subtotal,
      ...shipping,
      total,
      status: "new",
      notification_status: "pending",
      created_at: new Date().toISOString()
    };
    assertRowBudget({ ...order, items: JSON.stringify(items) });

    await env.DB.prepare(`
      INSERT INTO orders (
        id, customer_name, customer_email, customer_phone,
        messenger, whatsapp, viber, delivery_address, delivery_notes,
        card_name, title_role, design_request, contact_preference, items_json,
        subtotal, shipping_fee, shipping_zone, delivery_region_code, total, status, notification_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      order.id,
      order.customer_name,
      order.customer_email,
      order.customer_phone,
      order.messenger,
      order.whatsapp,
      order.viber,
      order.delivery_address,
      order.delivery_notes,
      order.card_name,
      order.title_role,
      order.design_request,
      order.contact_preference,
      JSON.stringify(order.items),
      order.subtotal,
      order.shipping_fee,
      order.shipping_zone,
      order.delivery_region_code,
      order.total,
      order.status,
      order.notification_status,
      order.created_at,
      order.created_at
    ).run();

    const notification = await notifyNewOrder(env, order);
    const notificationStatus = notification.sent ? "sent" : "pending";
    await env.DB.prepare(
      "UPDATE orders SET notification_status = ?, updated_at = ? WHERE id = ?"
    ).bind(notificationStatus, new Date().toISOString(), order.id).run();

    return json({
      ok: true,
      order_id: order.id,
      subtotal: order.subtotal,
      shipping_fee: order.shipping_fee,
      shipping_zone: order.shipping_zone,
      delivery_region_code: order.delivery_region_code,
      total: order.total,
      notification_status: notificationStatus
    }, 201);
  }

  // ADMIN: GET ORDERS
  if (p === "/api/orders" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500"
    ).all();

    return json(results.map(row => ({
      id: row.id,
      customer_name: row.customer_name,
      customer_email: row.customer_email,
      customer_phone: row.customer_phone,
      messenger: row.messenger,
      whatsapp: row.whatsapp,
      viber: row.viber,
      delivery_address: row.delivery_address,
      delivery_notes: row.delivery_notes,
      card_name: row.card_name,
      title_role: row.title_role,
      design_request: row.design_request,
      contact_preference: row.contact_preference,
      items: JSON.parse(row.items_json || "[]"),
      subtotal: Number(row.subtotal || 0),
      shipping_fee: Number(row.shipping_fee || 0),
      shipping_zone: row.shipping_zone || "",
      delivery_region_code: row.delivery_region_code || "",
      total: Number(row.total || 0),
      status: row.status,
      notification_status: row.notification_status,
      created_at: row.created_at,
      updated_at: row.updated_at
    })));
  }

  // ADMIN: UPDATE ORDER STATUS
  if (p.startsWith("/api/orders/") && request.method === "PATCH") {
    const id = decodeURIComponent(p.split("/").pop());
    const d = await readJsonRequest(request);
    const allowed = ["new", "confirmed", "processing", "ready", "completed", "cancelled"];
    const status = String(d.status || "").toLowerCase();
    if (!allowed.includes(status)) return json({ error: "Invalid order status." }, 400);

    const existing = await env.DB.prepare("SELECT id FROM orders WHERE id = ? LIMIT 1").bind(id).first();
    if (!existing) return json({ error: "Order not found." }, 404);

    await env.DB.prepare(
      "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?"
    ).bind(status, new Date().toISOString(), id).run();

    return json({ ok: true, status });
  }

  // GET ALL CLIENTS
  if (
    p === "/api/clients" &&
    request.method === "GET"
  ) {
    const { results } =
      await env.DB
        .prepare(
          "SELECT * FROM clients ORDER BY created_at DESC"
        )
        .all();

    return json(
      results.map(
        r =>
          rowToClient(
            r,
            url.origin
          )
      )
    );
  }

  // Contact import uses the same active public profile as the profile page.
  const contactMatch = /^\/api\/clients\/([^/]+)\/contact\.vcf$/.exec(p);
  if (contactMatch && request.method === "GET") {
    const client = await getClientByKey(env, decodeURIComponent(contactMatch[1]), url.origin);
    if (!client) return json({ error: "Client profile not found" }, 404);
    const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
    return new Response(buildContactCard(client), {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": disposition + '; filename="' + contactFilename(client) + '"',
        "Cache-Control": "no-store",
        "CDN-Cache-Control": "no-store"
      }
    });
  }

  // GET ONE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "GET"
  ) {
    const key =
      decodeURIComponent(
        p.split("/").pop()
      );

    const client =
      await getClientByKey(
        env,
        key,
        url.origin
      );

    return client
      ? json(client)
      : json(
          {
            error:
              "Client profile not found"
          },
          404
        );
  }

  // CREATE / UPDATE CLIENT
  if (
    p === "/api/clients" &&
    (
      request.method === "POST" ||
      request.method === "PUT"
    )
  ) {
    const d =
      await readJsonRequest(request);

    const name =
      String(
        d.name || ""
      ).trim();

    if (!name) {
      return json(
        {
          error:
            "Name is required."
        },
        400
      );
    }

    const id =
      String(
        d.id ||
        slugify(name)
      );

    const slug =
      slugify(
        d.slug ||
        name
      );
    const email = String(d.email || "").trim().toLowerCase();

    if (!id || !slug) {
      return json(
        {
          error:
            "A valid name/slug is required."
        },
        400
      );
    }

    const existing =
      await env.DB
        .prepare(
          "SELECT * FROM clients WHERE id = ? LIMIT 1"
        )
        .bind(id)
        .first();
    if (request.method === "PUT" && !existing) return json({ error: "Client not found. Reload the client list before editing." }, 404);
    if (request.method === "PUT" && !matchesProfileRevision(request, existing, d)) return changedProfileResponse();
    const duplicateSlug = await env.DB
      .prepare("SELECT id FROM clients WHERE slug = ? AND id != ? LIMIT 1")
      .bind(slug, id)
      .first();

    if (duplicateSlug) {
      return json(
        {
          error:
            "That profile slug is already in use. Please choose a different name."
        },
        409
      );
    }

    if (email) {
      const duplicateEmail = await env.DB
        .prepare(
          "SELECT id FROM clients WHERE lower(email) = ? AND id != ? LIMIT 1"
        )
        .bind(email, id)
        .first();

      if (duplicateEmail) {
        return json(
          {
            error:
              "That email is already assigned to another client. Please use a different email."
          },
          409
        );
      }
    }
    if (request.method === "POST" && (await env.DB.prepare("SELECT id FROM clients WHERE id = ? LIMIT 1").bind(id).first())) return json({ error: "A client with this profile ID already exists. Open the existing client and use Edit instead." }, 409);



    const photoKey =
      String(
        d.photo_key ||
        existing?.photo_key ||
        ""
      );

    let loginPasswordHash = String(existing?.login_password_hash || "");
    let loginPasswordSalt = String(existing?.login_password_salt || "");

    if (String(d.client_login_password || "").trim()) {
      if (String(d.client_login_password).length < 8 || String(d.client_login_password).length > 256) throw new RequestError("Client password must be between 8 and 256 characters.");
      const credentials = await hashClientPassword(String(d.client_login_password));
      loginPasswordHash = credentials.hash;
      loginPasswordSalt = credentials.salt;
    }

    const now = nextProfileTimestamp(existing);
    validateImageUrl(photoKey);
    validateImageUrl(d.featured_image);
    assertRowBudget({ ...d, photo_key: photoKey, featured_image: String(d.featured_image || ""),
      profile_modules: typeof d.profile_modules === "string" ? d.profile_modules : JSON.stringify(d.profile_modules || {}),
      profile_module_visibility: typeof d.profile_module_visibility === "string" ? d.profile_module_visibility : JSON.stringify(d.profile_module_visibility || {}),
      quick_info_order: JSON.stringify(Array.isArray(d.quick_info_order) ? d.quick_info_order : [])
    });

    // Match the normalization used by the INSERT below, rather than trusting
    // submitted counts, an owner-supplied plan, or arbitrary JSON properties.
    const storedPlan = normalizePlan(d.card_type) === "elite" ? "gold" : normalizePlan(d.card_type);
    const candidate = { card_type: storedPlan,
      featured_enabled: d.featured_enabled ? 1 : 0,
      quick_info_enabled: d.quick_info_enabled === false ? 0 : 1,
      business_locations: String(d.business_locations || "[]"),
      business_location_name: String(d.business_location_name || ""),
      business_location_link: String(d.business_location_link || ""),
      profile_modules: typeof d.profile_modules === "string" ? d.profile_modules : JSON.stringify(d.profile_modules || {}),
      profile_module_visibility: typeof d.profile_module_visibility === "string" ? d.profile_module_visibility : JSON.stringify(d.profile_module_visibility || {})
    };
    for (const key of QUICK_BLOCKS) {
      candidate["show_" + key] = d["show_" + key] === false ? 0 : 1;
      if (key !== "business_location") candidate[key] = key === "business_hours" ? normalizeBusinessHours(d[key]) : String(d[key] || "");
    }
    for (const key of ["featured_title", "featured_description", "featured_image", "featured_button_text", "featured_button_link"]) candidate[key] = String(d[key] || "");
    const violation = contentLimitViolation(candidate, existing);
    if (violation) return json(violation, 400);
    const profileType = ["corporate_professional", "businessman", "student", "e_sport", "content_creator", "personal"].includes(String(d.profile_type || "")) ? String(d.profile_type) : "";

    const clientWrite = await env.DB.prepare(`
      INSERT INTO clients
      (
        id,
        slug,
        name,
        job_title,
        company,
        about,
        phone,
        email,
        login_password_hash,
        login_password_salt,
        instagram,
        facebook,
        linkedin,
        tiktok,
        youtube,
        x,
        telegram,
        threads,
        github,
        behance,
        dribbble,
        twitch,
        steam,
        messenger,
        whatsapp,
        viber,
        website,
        accent_color,

        card_type,

        photo_key,
        active,
        view_count,
        last_viewed_at,
        created_at,
        updated_at,

        featured_enabled,
        featured_title,
        featured_description,
        featured_image,
        featured_button_text,
        featured_button_link,

        location,
        business_location_name,
        business_location_link,
        business_locations,
        business_hours,
        services,
        portfolio,
        booking,
        reviews,
        payments,

        education,
        skills,
        resume,
        achievements,
        certifications,
        pricing,
        products,
        promotions,
        team,
        multiple_locations,
        business_inquiry,
        profile_modules,
        profile_module_visibility,
        quick_info_order,

        quick_info_enabled,

        show_location,
        show_business_location,
        show_business_hours,
        show_services,
        show_portfolio,
        show_booking,
        show_reviews,
        show_payments,

        show_education,
        show_skills,
        show_resume,
        show_achievements,
        show_certifications,
        show_pricing,
        show_products,
        show_promotions,
        show_team,
        show_multiple_locations,
        show_business_inquiry,
        profile_type
      )
    SELECT
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?
    WHERE ? = 1 OR EXISTS (SELECT 1 FROM clients WHERE id = ? AND content_revision = ?)
      ON CONFLICT(id) DO UPDATE SET

        slug=excluded.slug,
        name=excluded.name,
        job_title=excluded.job_title,
        company=excluded.company,
        about=excluded.about,

        phone=excluded.phone,
        email=excluded.email,
        login_password_hash=CASE WHEN excluded.login_password_hash != '' THEN excluded.login_password_hash ELSE clients.login_password_hash END,
        login_password_salt=CASE WHEN excluded.login_password_hash != '' THEN excluded.login_password_salt ELSE clients.login_password_salt END,
        instagram=excluded.instagram,
        facebook=excluded.facebook,
        linkedin=excluded.linkedin,
        tiktok=excluded.tiktok,
        youtube=excluded.youtube,
        x=excluded.x,
        telegram=excluded.telegram,
        threads=excluded.threads,
        github=excluded.github,
        behance=excluded.behance,
        dribbble=excluded.dribbble,
        twitch=excluded.twitch,
        steam=excluded.steam,
        messenger=excluded.messenger,
        whatsapp=excluded.whatsapp,
        viber=excluded.viber,
        website=excluded.website,

        accent_color=excluded.accent_color,
        card_type=excluded.card_type,
        photo_key=excluded.photo_key,
        active=excluded.active,

        featured_enabled=excluded.featured_enabled,
        featured_title=excluded.featured_title,
        featured_description=excluded.featured_description,
        featured_image=excluded.featured_image,
        featured_button_text=excluded.featured_button_text,
        featured_button_link=excluded.featured_button_link,

        location=excluded.location,
        business_location_name=excluded.business_location_name,
        business_location_link=excluded.business_location_link,
        business_locations=excluded.business_locations,
        business_hours=excluded.business_hours,
        services=excluded.services,
        portfolio=excluded.portfolio,
        booking=excluded.booking,
        reviews=excluded.reviews,
        payments=excluded.payments,

        education=excluded.education,
        skills=excluded.skills,
        resume=excluded.resume,
        achievements=excluded.achievements,
        certifications=excluded.certifications,
        pricing=excluded.pricing,
        products=excluded.products,
        promotions=excluded.promotions,
        team=excluded.team,
        multiple_locations=excluded.multiple_locations,
        business_inquiry=excluded.business_inquiry,
        profile_modules=excluded.profile_modules,
        profile_module_visibility=excluded.profile_module_visibility,
        quick_info_order=excluded.quick_info_order,
        profile_type=excluded.profile_type,

        quick_info_enabled=excluded.quick_info_enabled,

        show_location=excluded.show_location,
        show_business_location=excluded.show_business_location,
        show_business_hours=excluded.show_business_hours,
        show_services=excluded.show_services,
        show_portfolio=excluded.show_portfolio,
        show_booking=excluded.show_booking,
        show_reviews=excluded.show_reviews,
        show_payments=excluded.show_payments,

        show_education=excluded.show_education,
        show_skills=excluded.show_skills,
        show_resume=excluded.show_resume,
        show_achievements=excluded.show_achievements,
        show_certifications=excluded.show_certifications,
        show_pricing=excluded.show_pricing,
        show_products=excluded.show_products,
        show_promotions=excluded.show_promotions,
        show_team=excluded.show_team,
        show_multiple_locations=excluded.show_multiple_locations,
        show_business_inquiry=excluded.show_business_inquiry,

        updated_at=excluded.updated_at,
        content_revision=clients.content_revision + 1
      WHERE clients.content_revision = ?
    `).bind(

      id,
      slug,
      name,

      String(d.job_title || ""),
      String(d.company || ""),
      String(d.about || ""),

      String(d.phone || ""),
      email,
      loginPasswordHash,
      loginPasswordSalt,

      String(d.instagram || ""),
      String(d.facebook || ""),
      String(d.linkedin || ""),
      String(d.tiktok || ""),
      String(d.youtube || ""),
      String(d.x || ""),
      String(d.telegram || ""),
      String(d.threads || ""),
      String(d.github || ""),
      String(d.behance || ""),
      String(d.dribbble || ""),
      String(d.twitch || ""),
      String(d.steam || ""),

      String(d.messenger || ""),
      String(d.whatsapp || ""),
      String(d.viber || ""),
      String(d.website || ""),

      String(
        d.accent_color ||
        "#2162c6"
      ),

      // Card Type
      storedPlan,

      photoKey,

      d.active === false
        ? 0
        : 1,

      Number(
        existing?.view_count ||
        d.view_count ||
        0
      ),

      String(
        existing?.last_viewed_at ||
        ""
      ),

      String(
        existing?.created_at ||
        now
      ),

      now,

      // Featured
      d.featured_enabled
        ? 1
        : 0,

      String(
        d.featured_title ||
        ""
      ),

      String(
        d.featured_description ||
        ""
      ),

      String(
        d.featured_image ||
        ""
      ),

      String(
        d.featured_button_text ||
        ""
      ),

      String(
        d.featured_button_link ||
        ""
      ),

      // Quick Info
      String(
        d.location ||
        ""
      ),

      String(
        d.business_location_name ||
        ""
      ),

      String(
        d.business_location_link ||
        ""
      ),

      String(
        d.business_locations ||
        "[]"
      ),

      normalizeBusinessHours(d.business_hours),

      String(
        d.services ||
        ""
      ),

      String(
        d.portfolio ||
        ""
      ),

      String(
        d.booking ||
        ""
      ),

      String(
        d.reviews ||
        ""
      ),

      String(
        d.payments ||
        ""
      ),

      // New Quick Info
      String(
        d.education ||
        ""
      ),

      String(
        d.skills ||
        ""
      ),

      String(
        d.resume ||
        ""
      ),

      String(
        d.achievements ||
        ""
      ),

      String(
        d.certifications ||
        ""
      ),

      String(
        d.pricing ||
        ""
      ),

      String(
        d.products ||
        ""
      ),

      String(
        d.promotions ||
        ""
      ),

      String(
        d.team ||
        ""
      ),

      String(
        d.multiple_locations ||
        ""
      ),

      String(
        d.business_inquiry ||
        ""
      ),

      typeof d.profile_modules === "string"
        ? d.profile_modules
        : JSON.stringify(d.profile_modules || {}),

      typeof d.profile_module_visibility === "string"
        ? d.profile_module_visibility
        : JSON.stringify(d.profile_module_visibility || {}),

      JSON.stringify(
        Array.isArray(d.quick_info_order)
          ? d.quick_info_order
          : []
      ),

      d.quick_info_enabled === false
        ? 0
        : 1,

      d.show_location === false
        ? 0
        : 1,

      d.show_business_location === false
        ? 0
        : 1,

      d.show_business_hours === false
        ? 0
        : 1,

      d.show_services === false
        ? 0
        : 1,

      d.show_portfolio === false
        ? 0
        : 1,

      d.show_booking === false
        ? 0
        : 1,

      d.show_reviews === false
        ? 0
        : 1,

      d.show_payments === false
        ? 0
        : 1,

      // New Quick Info visibility
      d.show_education === false
        ? 0
        : 1,

      d.show_skills === false
        ? 0
        : 1,

      d.show_resume === false
        ? 0
        : 1,

      d.show_achievements === false
        ? 0
        : 1,

      d.show_certifications === false
        ? 0
        : 1,

      d.show_pricing === false
        ? 0
        : 1,

      d.show_products === false
        ? 0
        : 1,

      d.show_promotions === false
        ? 0
        : 1,

      d.show_team === false
        ? 0
        : 1,

      d.show_multiple_locations === false
        ? 0
        : 1,

      d.show_business_inquiry === false
        ? 0
        : 1,
      profileType,
      request.method === "POST" ? 1 : 0,
      id,
      existing?.content_revision ?? -1,
      existing?.content_revision ?? -1

    ).run();
    if (Number(clientWrite.meta?.changes) !== 1) return changedProfileResponse();

const savedRow =
  await env.DB
    .prepare(
      "SELECT * FROM clients WHERE id = ? LIMIT 1"
    )
    .bind(id)
    .first();

return json(
  savedRow
    ? rowToClient(savedRow, url.origin)
    : null
  );
}

  // ACTIVATE / DEACTIVATE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "POST" &&
    p.endsWith("/status")
  ) {
    const id =
      decodeURIComponent(
        p.split("/")[3]
      );

    const d =
      await readJsonRequest(request);

    const active =
      d.active
        ? 1
        : 0;

    const existing =
      await env.DB
        .prepare(
          "SELECT id FROM clients WHERE id = ? OR slug = ? LIMIT 1"
        )
        .bind(id, id)
        .first();

    if (!existing) {
      return json(
        {
          error:
            "Client not found"
        },
        404
      );
    }

    await env.DB
      .prepare(
        "UPDATE clients SET active = ?, updated_at = ?, content_revision = content_revision + 1 WHERE id = ?"
      )
      .bind(
        active,
        new Date().toISOString(),
        existing.id
      )
      .run();

    return json({
      ok: true,
      active:
        Boolean(active)
    });
  }

  // PROFILE VIEW COUNTER
  if (
    p.startsWith("/api/clients/") &&
    request.method === "POST" &&
    p.endsWith("/view")
  ) {
    const id =
      decodeURIComponent(
        p.split("/")[3]
      );

    const existing =
      await env.DB
        .prepare(
          "SELECT id FROM clients WHERE id = ? OR slug = ? LIMIT 1"
        )
        .bind(id, id)
        .first();

    if (!existing) {
      return json(
        {
          error:
            "Profile not found"
        },
        404
      );
    }

    const now =
      new Date().toISOString();

    const result =
      await env.DB
        .prepare(
          "UPDATE clients SET view_count = COALESCE(view_count,0) + 1, last_viewed_at = ? WHERE id = ?"
        )
        .bind(
          now,
          existing.id
        )
        .run();

    const updated =
      await env.DB
        .prepare(
          "SELECT view_count FROM clients WHERE id = ?"
        )
        .bind(
          existing.id
        )
        .first();

    return json({
      ok:
        Boolean(
          result.success
        ),
      views:
        Number(
          updated?.view_count ||
          0
        )
    });
  }

  // DELETE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "DELETE"
  ) {
    const id =
      decodeURIComponent(
        p.split("/").pop()
      );

    const existing =
      await env.DB
        .prepare(
          "SELECT id, photo_key FROM clients WHERE id = ? OR slug = ? LIMIT 1"
        )
        .bind(id, id)
        .first();

    if (!existing) {
      return json(
        {
          error:
            "Client not found"
        },
        404
      );
    }

    await env.DB
      .prepare(
        "DELETE FROM clients WHERE id = ?"
      )
      .bind(
        existing.id
      )
      .run();

    return json({
      ok: true
    });
  }

  // PHOTO UPLOAD
  if (
    p === "/api/upload" &&
    request.method === "POST"
  ) {
    const form =
      await readFormRequest(request);

    const file =
      form.get("photo");

    const dataUrl = await imageFileDataUrl(file);

    return json({
      key: dataUrl,
      url: dataUrl
    });
  }

  return json(
    {
      error:
        "API route not found"
    },
    404
  );
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) throw new RequestError("Please submit this request from the NexTap website.", 403);
        const length = Number(request.headers.get("Content-Length") || 0);
        if (length > MAX_REQUEST_BYTES) throw new RequestError("Request is too large. Please use smaller images or less content.", 413);
      }
      const clientAuthResponse =
        await handleClientAuth(
          request,
          env,
          url
        );

      if (clientAuthResponse) {
        return withSecurityHeaders(clientAuthResponse);
      }

      const authResponse =
        await handleAuth(
          request,
          env,
          url
        );

      if (authResponse) {
        return withSecurityHeaders(authResponse);
      }

      if (
        url.pathname.startsWith("/api/client/")
      ) {
        return withSecurityHeaders(await handleClientApi(
          request,
          env,
          url
        ));
      }

      if (
        url.pathname.startsWith(
          "/api/"
        )
      ) {
        return withSecurityHeaders(await handleApi(
          request,
          env,
          url
        ));
      }

      if (
        url.pathname === "/client-login" ||
        url.pathname === "/client-login/"
      ) {
        return withSecurityHeaders(await env.ASSETS.fetch(
          new Request(
            new URL(
              "/client-login.html",
              request.url
            ),
            request
          )
        ));
      }

      if (
        url.pathname === "/client-dashboard" ||
        url.pathname === "/client-dashboard/" ||
        url.pathname === "/client-dashboard.html"
      ) {
        // Bust any browser/edge copy of the legacy dashboard URL. The query
        // parameter becomes part of the browser cache key while preserving
        // the familiar /client-dashboard pathname.
        const dashboardVersion = "767b822a10432723";
        if (url.pathname !== "/client-dashboard.html" && url.searchParams.get("nxv") !== dashboardVersion) {
          const location = new URL(request.url);
          location.searchParams.set("nxv", dashboardVersion);
          const headers = new Headers({
            "Location": location.toString(),
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "CDN-Cache-Control": "no-store"
          });
          return withSecurityHeaders(new Response(null,{status:302,headers}));
        }
        const assetUrl = new URL("/client-dashboard.html", request.url);
        assetUrl.searchParams.set("nxv", dashboardVersion);
        const dashboardResponse = await env.ASSETS.fetch(
          new Request(assetUrl, request)
        );
        const headers = new Headers(dashboardResponse.headers);
        headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        headers.set("CDN-Cache-Control", "no-store");
        headers.set("X-NexTap-Dashboard-Version", "client-content-current-c3a665fc");
        headers.set("X-NexTap-Dashboard-Source", "public/client-dashboard.html");
        return withSecurityHeaders(new Response(dashboardResponse.body, {
          status: dashboardResponse.status,
          statusText: dashboardResponse.statusText,
          headers
        }));
      }

      if (url.pathname === "/__nextap-version") {
        return withSecurityHeaders(new Response(
          JSON.stringify({
            dashboard: "client-content-current",
            commit: typeof BUILD_COMMIT === "string" ? BUILD_COMMIT : "development"
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
              "CDN-Cache-Control": "no-store"
            }
          }
        ));
      }

      if (
        url.pathname === "/order" ||
        url.pathname === "/order/" ||
        url.pathname === "/order.html"
      ) {
        return withSecurityHeaders(await env.ASSETS.fetch(
          new Request(new URL("/order.html", request.url), request)
        ));
      }

      if (
        url.pathname === "/admin/orders" ||
        url.pathname === "/admin/orders/" ||
        url.pathname === "/admin/orders.html"
      ) {
        const ordersResponse = await env.ASSETS.fetch(
          new Request(new URL("/admin/orders.html", request.url), request)
        );
        return withSecurityHeaders(ordersResponse);
      }

      if (
        url.pathname === "/admin" ||
        url.pathname === "/admin/" ||
        url.pathname === "/admin/index.html"
      ) {
        const adminResponse = await env.ASSETS.fetch(
          new Request(
            new URL(
              "/admin/index.html",
              request.url
            ),
            request
          )
        );
        const headers = new Headers(adminResponse.headers);
        headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        headers.set("CDN-Cache-Control", "no-store");
        headers.set("X-NexTap-Admin-Version", "auth-bootstrap-v2");
        return withSecurityHeaders(new Response(adminResponse.body, {
          status: adminResponse.status,
          statusText: adminResponse.statusText,
          headers
        }));
      }

      if (
        url.pathname.startsWith(
          "/profile/"
        )
      ) {
        const slug =
          decodeURIComponent(
            url.pathname.slice(
              "/profile/".length
            )
          ).replace(
            /^\/+|\/+$/g,
            ""
          );

        if (!slug) {
          return withSecurityHeaders(Response.redirect(
            new URL(
              "/profile",
              request.url
            ),
            302
          ));
        }

        const target =
          new URL(
            "/profile.html",
            request.url
          );

        target.searchParams.set(
          "slug",
          slug
        );

        return withSecurityHeaders(await env.ASSETS.fetch(
          new Request(
            target.toString(),
            request
          )
        ));
      }

      if (
        url.pathname ===
        "/profile"
      ) {
        return withSecurityHeaders(await env.ASSETS.fetch(
          new Request(
            new URL(
              "/profile.html",
              request.url
            ),
            request
          )
        ));
      }

      if (url.pathname === "/") {
        return withSecurityHeaders(await env.ASSETS.fetch(
          new Request(new URL("/index.html", request.url), request)
        ));
      }

      return withSecurityHeaders(await env.ASSETS.fetch(
        request
      ));

    } catch (err) {
      if (err instanceof RequestError) {
        const response = json({ error: err.message }, err.status);
        if (err.status === 429) response.headers.set("Retry-After", String(err.retryAfter || 900));
        return withSecurityHeaders(response);
      }
      console.error("NexTap request failed", { path: url.pathname, error: err?.message || "Unknown error" });
      return withSecurityHeaders(json(
        {
          error:
            "Server error. Please try again or contact NexTap."
        },
        500
      ));
    }
  }
};
