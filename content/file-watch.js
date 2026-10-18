// Runs in the job page's own JavaScript world from the moment the page starts loading (manifest "world": "MAIN").
// It remembers each file the bidder picks or drops on this page, so that on Capture the background can ask Chrome,
// through the debugger, where that file is stored on the bidder's computer: even after the site has uploaded the
// file and cleared its field. Pages, this script included, never see that location. Nothing here reads a file's
// contents or sends anything anywhere; whether the location is recorded at all is the bidder's choice in the popup.
(() => {
  const KEY = Symbol.for("bidTrack.attachedFiles");
  if (globalThis[KEY]) return;

  const MAX_FILES = 20;
  const picked = []; // oldest first
  const known = new WeakSet();

  function remember(files) {
    for (const file of files || []) {
      if (!(file instanceof File) || known.has(file)) continue;
      known.add(file);
      picked.push(file);
      if (picked.length > MAX_FILES) picked.shift();
    }
  }

  // "input" is composed, so it also arrives from file fields inside shadow roots; "change" covers the rest.
  function onPick(event) {
    const input = event.composedPath()[0];
    if (input instanceof HTMLInputElement && input.type === "file") remember(input.files);
  }
  window.addEventListener("input", onPick, true);
  window.addEventListener("change", onPick, true);
  window.addEventListener("drop", (event) => remember(event.dataTransfer?.files), true);

  // Called by the background through the debugger: every remembered file, plus any sitting in a field without an
  // event (set before this script ran, or by the site's own code).
  function attachedFiles() {
    for (const input of fileInputs(document)) remember(input.files);
    return picked.slice();
  }
  Object.defineProperty(globalThis, KEY, { value: attachedFiles });

  function* fileInputs(root) {
    yield* root.querySelectorAll('input[type="file"]');
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) yield* fileInputs(el.shadowRoot);
  }
})();
