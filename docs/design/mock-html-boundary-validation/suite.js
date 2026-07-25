(() => {
  const body = document.body;
  const suite = body.dataset.suite;
  const surfaces = [...document.querySelectorAll("[data-surface]")];
  const surfaceButtons = [...document.querySelectorAll("[data-surface-target]")];
  const readout = document.querySelector("[data-study-readout]");
  const toast = document.querySelector("#toast");
  let toastTimer;

  const surfaceCopy = {
    screenshot: {
      capture: "Entry · Capture is a transient object, not yet Session context",
      composer: "Execution · Same image inherits an explicit Session scope",
      assets: "Recovery · Same image remains reusable with provenance",
    },
    memory: {
      effective: "Before the run · Show what actually applies here",
      file: "Change · Edit the source with scope and precedence visible",
      receipt: "At execution · Confirm the exact memory set sent to this run",
    },
    artifact: {
      complete: "Handoff · Completion exposes a versioned artifact set",
      workspace: "Review · Feedback anchors to artifact, version and region",
      history: "Return · The same review state survives after the Session ends",
    },
  };

  function showSurface(name) {
    surfaces.forEach((surface) => {
      surface.classList.toggle("active", surface.dataset.surface === name);
    });
    surfaceButtons.forEach((button) => {
      const active = button.dataset.surfaceTarget === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (readout) readout.textContent = surfaceCopy[suite]?.[name] ?? name;
  }

  function showToast(message) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function on(selector, eventName, callback) {
    document.querySelector(selector)?.addEventListener(eventName, callback);
  }

  function onAll(selector, eventName, callback) {
    document.querySelectorAll(selector).forEach((element) => element.addEventListener(eventName, callback));
  }

  surfaceButtons.forEach((button) => {
    button.addEventListener("click", () => showSurface(button.dataset.surfaceTarget));
  });
  on("[data-reset]", "click", () => window.location.reload());

  if (suite === "screenshot") {
    const card = document.querySelector("#quick-card");
    const pendingBanner = document.querySelector("#pending-banner");
    const contextShelf = document.querySelector("#context-shelf");
    const sessionRow = document.querySelector("#active-session-row");
    const primaryLabel = document.querySelector("#feed-shot-label");

    on("#annotate-shot", "click", () => {
      card?.classList.toggle("annotated");
      showToast(card?.classList.contains("annotated") ? "Annotation kept with this capture" : "Annotation removed");
    });
    on("#feed-shot", "click", () => {
      if (body.classList.contains("no-session")) {
        pendingBanner?.classList.add("show");
        contextShelf?.removeAttribute("hidden");
        showSurface("composer");
        showToast("Capture is queued until a Session is selected");
        return;
      }
      contextShelf?.removeAttribute("hidden");
      showSurface("composer");
      showToast("Attached to Session · Fix failing Electron test");
    });
    on("#save-shot", "click", () => {
      showSurface("assets");
      showToast("Saved once; provenance and annotation were preserved");
    });
    on("#close-shot", "click", () => {
      card?.setAttribute("hidden", "");
      showToast("Quick Card dismissed; original clipboard remains unchanged");
    });
    on("#edge-no-session", "click", () => {
      const noSession = body.classList.toggle("no-session");
      sessionRow?.classList.toggle("active", !noSession);
      if (primaryLabel) primaryLabel.textContent = noSession ? "Keep for next Session" : "Add to active Session";
      showToast(noSession ? "Edge state: there is no active Session" : "Active Session restored");
    });
    on("#choose-session", "click", () => {
      body.classList.remove("no-session");
      sessionRow?.classList.add("active");
      pendingBanner?.classList.remove("show");
      if (primaryLabel) primaryLabel.textContent = "Add to active Session";
      showToast("Queued capture attached to the selected Session");
    });
    on("#send-shot", "click", () => {
      document.querySelector("#sent-shot-proof")?.removeAttribute("hidden");
      contextShelf?.setAttribute("hidden", "");
      pendingBanner?.classList.remove("show");
      showToast("Message sent with image and Session scope");
    });
    on("#reuse-shot", "click", () => {
      contextShelf?.removeAttribute("hidden");
      showSurface("composer");
      showToast("Reused from Asset Library without creating a duplicate");
    });
  }

  if (suite === "memory") {
    const conflict = document.querySelector("#memory-conflict");
    const effectiveMode = document.querySelector('[data-memory-mode="effective"]');
    const libraryMode = document.querySelector('[data-memory-mode="library"]');
    const effectiveTab = document.querySelector("#effective-tab");
    const libraryTab = document.querySelector("#library-tab");
    const source = document.querySelector("#optional-source");

    function setMemoryMode(mode) {
      const effective = mode === "effective";
      effectiveMode?.toggleAttribute("hidden", !effective);
      libraryMode?.toggleAttribute("hidden", effective);
      effectiveTab?.classList.toggle("active", effective);
      libraryTab?.classList.toggle("active", !effective);
      showToast(effective ? "Viewing resolved memory for this project" : "Viewing provider-led source inventory");
    }

    on("#effective-tab", "click", () => setMemoryMode("effective"));
    on("#library-tab", "click", () => setMemoryMode("library"));
    on("#toggle-conflict", "click", () => {
      conflict?.classList.add("show");
      showToast("Edge state: two active sources disagree");
    });
    on("#resolve-conflict", "click", () => {
      conflict?.classList.remove("show");
      showToast("Conflict resolved for this project; source files were not silently overwritten");
    });
    onAll('[data-memory-action="open-file"]', "click", () => showSurface("file"));
    on("#close-memory-file", "click", () => showSurface("effective"));
    on("#save-memory", "click", () => {
      showSurface("effective");
      showToast("Saved to project memory · effective set recalculated");
    });
    on("#promote-memory", "click", () => {
      showToast("Created a Charter rule candidate for review; nothing was promoted silently");
    });
    onAll('[data-memory-action="start-run"]', "click", () => showSurface("receipt"));
    on("#exclude-source", "click", () => {
      source?.classList.toggle("excluded");
      const excluded = source?.classList.contains("excluded");
      document.querySelector("#source-count").textContent = excluded ? "2 of 3 sources" : "3 sources";
      showToast(excluded ? "Project memory excluded for this run only" : "Project memory restored");
    });
    on("#send-memory-run", "click", () => {
      document.querySelector("#memory-run-proof")?.removeAttribute("hidden");
      showToast("Run started with an inspectable memory receipt");
    });
  }

  if (suite === "artifact") {
    const staleBanner = document.querySelector("#stale-banner");
    const anchorVersion = document.querySelector("#anchor-version");

    on("#review-artifacts", "click", () => showSurface("workspace"));
    on("#accept-session", "click", () => {
      document.querySelector("#history-status").textContent = "Accepted · 3 artifacts";
      document.querySelector("#history-status")?.classList.remove("amber");
      document.querySelector("#history-status")?.classList.add("green");
      showSurface("history");
      showToast("Session accepted; artifact set remains available in History");
    });
    onAll('[data-artifact-action="regenerate"]', "click", () => {
      staleBanner?.classList.add("show");
      if (anchorVersion) anchorVersion.textContent = "Anchor on v1 · current artifact v2";
      showToast("Edge state: artifact regenerated after feedback was authored");
    });
    on("#reanchor-feedback", "click", () => {
      staleBanner?.classList.remove("show");
      if (anchorVersion) anchorVersion.textContent = "Anchored to v2 · page 4 · chart region";
      showToast("Feedback re-anchored to v2; the v1 audit trail was preserved");
    });
    on("#attach-feedback", "click", () => {
      document.querySelector("#feedback-state").textContent = "1 anchored note · v1";
      showSurface("complete");
      showToast("Feedback attached to the Session with artifact version and region");
    });
    on("#history-open-artifacts", "click", () => showSurface("workspace"));
    on("#history-replay", "click", () => {
      showToast("Replay opened at the event that produced Q2-review.pdf v1");
    });
  }

  showSurface(surfaces.find((surface) => surface.classList.contains("active"))?.dataset.surface ?? surfaces[0]?.dataset.surface);
})();
