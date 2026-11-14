export const DEFAULT_SERVER_URL = "https://engineersbackend-production-5883.up.railway.app";

const LOGGED_OUT_NOTICE =
  "You were logged out — log in again. Bidders: if your manager reset your login, ask them for a new invite code.";
const API_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return normalizeServerUrl(serverUrl);
}

export async function setServerUrl(url) {
  await chrome.storage.local.set({ serverUrl: normalizeServerUrl(url) });
}

function normalizeServerUrl(url) {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_SERVER_URL;
}

// kind: "bidder" (invite / username login) or "owner" (the platform login, signed in for one profile). An owner's
// `bidder` entry carries their name and that profile, so the rest of the extension treats both the same way.
const AUTH_KEYS = ["authToken", "authBidder", "authKind"];

export async function getAuth() {
  const { authToken, authBidder, authKind } = await chrome.storage.local.get(AUTH_KEYS);
  if (!authToken) return null;
  return { token: authToken, bidder: authBidder || null, kind: authKind === "owner" ? "owner" : "bidder" };
}

async function storeAuth(token, bidder, kind = "bidder") {
  await chrome.storage.local.set({ authToken: token, authBidder: bidder, authKind: kind });
  await chrome.storage.local.remove("authNotice");
}

// What the popup shows for an owner: "Pedro · Alpha".
function ownerEntry(owner) {
  return { id: owner.id, name: owner.name, username: `${owner.name} · ${owner.profile?.name || ""}`, profile: owner.profile };
}

// The owner's active profiles, to choose the one this Chrome profile records for (platform name or email + password).
export async function ownerProfiles(username, password) {
  const { profiles } = await request("POST", "/ext/owner/profiles", { username, password });
  return profiles || [];
}

// Signs the owner in for one profile: every capture in this Chrome profile becomes that profile's apply.
export async function ownerLogin(username, password, profileId) {
  const { token, owner } = await request("POST", "/ext/owner/login", { username, password, profileId });
  await storeAuth(token, ownerEntry(owner), "owner");
  return owner;
}

// The bidder routes, or the owner's under /ext/owner.
async function prefix() {
  return (await getAuth())?.kind === "owner" ? "/ext/owner" : "/ext";
}

export async function register(inviteCode, username, password) {
  const { token, bidder } = await request("POST", "/ext/register", { inviteCode, username, password });
  await storeAuth(token, bidder);
  return bidder;
}

export async function login(username, password) {
  const { token, bidder } = await request("POST", "/ext/login", { username, password });
  await storeAuth(token, bidder);
  return bidder;
}

export async function logout() {
  await chrome.storage.local.remove(AUTH_KEYS);
}

// Logs out this login's other browsers; authedRequest stores the fresh token the backend returns for this one.
export async function changePassword(currentPassword, newPassword) {
  const { bidder } = await authedRequest("POST", "/ext/password", { currentPassword, newPassword });
  if (bidder) await chrome.storage.local.set({ authBidder: bidder });
}

export async function me() {
  const owner = (await getAuth())?.kind === "owner";
  const { token: _renewed, ...data } = await authedRequest("GET", owner ? "/ext/owner/me" : "/ext/me");
  const entry = owner ? ownerEntry(data) : data;
  await chrome.storage.local.set({ authBidder: entry });
  return entry;
}

const MAX_JOB_URL_LENGTH = 2000;

// jobUrl/jobTitle let the backend file the screenshot under the right bid. The backend stores a non-http(s) jobUrl
// as null but answers 400 to one over 2000 characters, so one that cannot be accepted is left out: an upload
// must never fail because of the page address. (It keeps the title; the backend truncates that itself.)
export async function getUploadUrl({ job, step, trigger, capturedAt, format, jobUrl, jobTitle, attachments }) {
  const body = { job, step, trigger, capturedAt };
  if (format) body.format = format;
  // Only for a bidder who allowed recording where attached files are stored (see lib/attachments.js).
  if (attachments?.length) body.attachments = attachments;
  if (typeof jobUrl === "string" && /^https?:\/\//i.test(jobUrl) && jobUrl.length <= MAX_JOB_URL_LENGTH) {
    body.jobUrl = jobUrl;
  }
  if (typeof jobTitle === "string" && jobTitle) body.jobTitle = jobTitle;
  return authedRequest("POST", `${await prefix()}/upload-url`, body);
}

// Tells the backend the PUT for `key` (as returned by getUploadUrl) finished.
export async function confirmUpload(key) {
  return authedRequest("POST", `${await prefix()}/uploads/confirm`, { key });
}

// 2026-10-03T11:29:07-03:00 (local time with its UTC offset, as the backend requires).
export function localIsoWithOffset(date) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
  );
}

// Both checks below compare with the token that was sent: a logout, login or renewal that happened while
// the request was in flight wins.
async function authedRequest(method, path, body) {
  const auth = await getAuth();
  if (!auth) throw new ApiError("not logged in", 401);
  let data;
  try {
    data = await request(method, path, body, auth.token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && (await isStoredToken(auth.token))) {
      await chrome.storage.local.remove(AUTH_KEYS);
      await chrome.storage.local.set({ authNotice: LOGGED_OUT_NOTICE });
    }
    throw err;
  }
  // The backend renews a token that is over a week old by adding a fresh one to the response.
  if (typeof data?.token === "string" && data.token && (await isStoredToken(auth.token))) {
    await chrome.storage.local.set({ authToken: data.token });
  }
  return data;
}

async function isStoredToken(token) {
  const { authToken } = await chrome.storage.local.get("authToken");
  return authToken === token;
}

async function request(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${await getServerUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `no answer in ${API_TIMEOUT_MS / 1000} s` : err.message;
    throw new ApiError(`Could not reach the server (${reason})`, 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(errorMessage(data, response.status), response.status);
  return data;
}

// The Engineers backend answers {"error": "<message>"}; a bare FastAPI app answers {"detail": ...}.
function errorMessage(data, status) {
  const message = data?.error ?? data?.detail;
  if (typeof message === "string" && message) return message;
  if (Array.isArray(message) && typeof message[0]?.msg === "string") return message[0].msg;
  return `HTTP ${status}`;
}
