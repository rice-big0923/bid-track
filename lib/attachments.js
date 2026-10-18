// The files a bidder attached on a job page and where each is stored on their computer, recorded with the screenshot
// so the bid's reviewer can check the right resume was sent. Only for a bidder who allowed it in the popup.
//
// A page only sees a file's name. Chrome's debugger also knows its location (DOM.getFileInfo), so on Capture the
// background attaches to the tab, takes the files content/file-watch.js remembered in each frame, and asks for each one.

const CONSENT_KEY = "filePathConsent";
const FILE_WATCH = "content/file-watch.js";
const LOOKUP_TIMEOUT_MS = 8000;
const EVENT_SETTLE_MS = 150;
const MAX_FILES = 20;
const OBJECT_GROUP = "bidTrackAttachments";

// { granted, at } once the bidder answered (at: ISO time of the answer); null before.
export async function getFilePathConsent() {
  const { [CONSENT_KEY]: consent } = await chrome.storage.local.get(CONSENT_KEY);
  return typeof consent?.granted === "boolean" ? consent : null;
}

export async function setFilePathConsent(granted) {
  await chrome.storage.local.set({ [CONSENT_KEY]: { granted: !!granted, at: new Date().toISOString() } });
}

// [{ field, name, size, type, lastModified, path, pathError, inField }] for every frame of the tab, oldest pick first.
// Never throws and gives up after LOOKUP_TIMEOUT_MS: a capture must not fail or hang over this. It holds the
// debugger while it runs, so call it before the screenshot, not alongside it.
export async function collectAttachments(tabId) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), LOOKUP_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([lookUp(tabId), timedOut]);
    if (result !== "timeout") return result;
    console.warn("[Bid Track] Looking up attached files timed out");
    await chrome.debugger.detach({ tabId }).catch(() => {}); // free it for the screenshot
    return [];
  } catch (err) {
    console.warn("[Bid Track] Could not look up attached files:", err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function lookUp(tabId) {
  // Tabs opened before the extension loaded have no watcher yet; this one still finds files sitting in fields.
  await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: [FILE_WATCH], world: "MAIN" })
    .catch(() => {});

  const target = { tabId };
  const childSessions = []; // cross-site iframes run as their own targets
  const contexts = []; // the page world of each frame: { sessionId, contextId }
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      childSessions.push(params.sessionId);
    } else if (method === "Runtime.executionContextCreated" && params.context?.auxData?.isDefault) {
      contexts.push({ sessionId: source.sessionId, contextId: params.context.id });
    }
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.attach(target, "1.3");
    await chrome.debugger
      .sendCommand(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .catch((err) => console.warn("[Bid Track] Cross-site frames are not searched:", err.message));
    await sleep(EVENT_SETTLE_MS);
    // Runtime.enable reports the frames' existing contexts as events.
    const sessions = [target, ...childSessions.map((sessionId) => ({ tabId, sessionId }))];
    for (const session of sessions) await chrome.debugger.sendCommand(session, "Runtime.enable").catch(() => {});
    await sleep(EVENT_SETTLE_MS);

    const found = [];
    for (const { sessionId, contextId } of contexts) {
      if (found.length >= MAX_FILES) break;
      const session = sessionId ? { tabId, sessionId } : target;
      found.push(...(await filesInContext(session, contextId).catch(() => [])));
    }
    return found.slice(0, MAX_FILES);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function filesInContext(session, contextId) {
  const send = (method, params) => chrome.debugger.sendCommand(session, method, params);
  try {
    const { result: list } = await send("Runtime.evaluate", {
      expression: 'globalThis[Symbol.for("bidTrack.attachedFiles")]?.() ?? []',
      contextId,
      objectGroup: OBJECT_GROUP
    });
    if (!list?.objectId) return [];
    const { result: meta } = await send("Runtime.callFunctionOn", {
      objectId: list.objectId,
      functionDeclaration: `function () {
        const out = [];
        for (const { file, field, inField } of this) {
          out.push({ field, inField, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });
        }
        return out;
      }`,
      returnByValue: true
    });

    const files = [];
    for (const [index, item] of (meta?.value || []).entries()) {
      const { path, pathError } = await filePath(send, list.objectId, index);
      files.push({
        field: item.field || null,
        name: item.name || "",
        size: Number.isFinite(item.size) ? item.size : null,
        type: item.type || null,
        lastModified: Number.isFinite(item.lastModified) ? new Date(item.lastModified).toISOString() : null,
        path,
        pathError,
        inField: item.inField !== false
      });
    }
    return files;
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
  }
}

async function filePath(send, listObjectId, index) {
  try {
    const { result: file } = await send("Runtime.callFunctionOn", {
      objectId: listObjectId,
      functionDeclaration: "function (i) { return this[i].file; }",
      arguments: [{ value: index }],
      objectGroup: OBJECT_GROUP
    });
    const getInfo = () => send("DOM.getFileInfo", { objectId: file.objectId });
    const { path } = await getInfo().catch(async (err) => {
      if (!/not enabled/i.test(protocolMessage(err))) throw err;
      await send("DOM.enable");
      return getInfo();
    });
    // A file the site built in the browser (not picked from disk) has no location.
    return path ? { path, pathError: null } : { path: null, pathError: "Not a file from this computer" };
  } catch (err) {
    return { path: null, pathError: protocolMessage(err).slice(0, 200) || "Unknown error" };
  }
}

// chrome.debugger rejects with the protocol error as JSON text: {"code":-32000,"message":"Not allowed"}.
function protocolMessage(err) {
  const raw = err?.message || "";
  try {
    return JSON.parse(raw).message || raw;
  } catch {
    return raw;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
