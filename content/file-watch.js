// Runs in the job page's own JavaScript world from the moment the page starts loading (manifest "world": "MAIN").
// It remembers each file the bidder picks or drops on this page, so that on Capture the background can ask Chrome,
// through the debugger, where that file is stored on the bidder's computer: even after the site has uploaded the
// file and cleared its field. Pages, this script included, never see that location. Nothing here reads a file's
// contents or sends anything anywhere; whether the location is recorded at all is the bidder's choice in the popup.
(() => {
  const KEY = Symbol.for("bidTrack.attachedFiles");
  if (globalThis[KEY]) return;

  const MAX_FILES = 20;
  const picked = []; // { file, field }, oldest first
  const known = new WeakSet();

  function remember(files, field) {
    for (const file of files || []) {
      if (!(file instanceof File) || known.has(file)) continue;
      known.add(file);
      picked.push({ file, field });
      if (picked.length > MAX_FILES) picked.shift();
    }
  }

  // "input" is composed, so it also arrives from file fields inside shadow roots; "change" covers the rest.
  function onPick(event) {
    const input = event.composedPath()[0];
    if (input instanceof HTMLInputElement && input.type === "file") remember(input.files, fieldLabel(input));
  }
  window.addEventListener("input", onPick, true);
  window.addEventListener("change", onPick, true);
  window.addEventListener("drop", (event) => remember(event.dataTransfer?.files, dropLabel(event.composedPath()[0])), true);

  // Called by the background through the debugger: every remembered file, plus any sitting in a field without an
  // event (set before this script ran, or by the site's own code). inField is false once the site cleared it.
  function attachedFiles() {
    const inFields = new Set();
    for (const input of fileInputs(document)) {
      remember(input.files, fieldLabel(input));
      for (const file of input.files || []) inFields.add(file);
    }
    return picked.map(({ file, field }) => ({ file, field, inField: inFields.has(file) }));
  }
  Object.defineProperty(globalThis, KEY, { value: attachedFiles });

  function* fileInputs(root) {
    yield* root.querySelectorAll('input[type="file"]');
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) yield* fileInputs(el.shadowRoot);
  }

  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);

  // What the form calls the field ("Resume/CV", "Cover letter"): its ARIA name or label, else the nearest
  // label-like text around it, since upload widgets usually hide the input behind an "Attach" button.
  function fieldLabel(input) {
    const root = input.getRootNode();
    const labelledBy = (input.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => (id && root.getElementById?.(id)?.textContent) || "")
      .join(" ");
    const candidates = [
      input.getAttribute("aria-label"),
      labelledBy,
      input.labels?.[0]?.textContent,
      nearbyText(input),
      input.name,
      input.id
    ];
    return candidates.map(clean).find(Boolean) || null;
  }

  function nearbyText(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const title = node.querySelector('label, legend, h1, h2, h3, h4, h5, h6, [class*="label" i], [class*="title" i]');
      const text = clean(title?.textContent);
      if (text && text.length <= 80) return text;
    }
    return "";
  }

  // A drop zone usually wraps the file field it fills.
  function dropLabel(target) {
    let node = target instanceof Element ? target : null;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const input = node.querySelector('input[type="file"]');
      if (input) return fieldLabel(input);
    }
    return "Dropped on the page";
  }
})();
