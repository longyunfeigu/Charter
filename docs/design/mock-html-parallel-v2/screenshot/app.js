(() => {
  const state = {
    view: "capture",
    session: "SS-184",
    cardVisible: true,
    annotated: false,
    attached: false,
    saved: false,
    sent: false,
    everSent: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  let toastTimer;

  function toast(message) {
    const node = $("#toast");
    clearTimeout(toastTimer);
    node.textContent = message;
    node.classList.add("show");
    toastTimer = window.setTimeout(() => node.classList.remove("show"), 2500);
  }

  function setView(view) {
    state.view = view;
    $$("[data-surface]").forEach((node) => node.classList.toggle("active", node.dataset.surface === view));
    $$("[data-view]").forEach((node) => {
      const active = node.dataset.view === view;
      node.classList.toggle("active", active);
      if (node.classList.contains("study-tab")) node.setAttribute("aria-pressed", String(active));
    });
    render();
  }

  function render() {
    const hasSession = Boolean(state.session);
    $("#session-state").classList.toggle("none", !hasSession);
    $("#session-state").lastChild.textContent = hasSession ? " SS-184 active" : " No active Session";
    $("#rail-destination").textContent = hasSession ? "Fix failing Electron test" : "No Session selected";
    $("#rail-session-id").textContent = hasSession ? "SS-184 · fable5" : "Capture retained locally";

    $("#capture-card").hidden = !state.cardVisible;
    $("#capture-card").classList.toggle("annotated", state.annotated);
    $("#pending-tray").hidden = state.cardVisible;

    $("#destination").classList.toggle("missing", !hasSession);
    $("#destination-name").textContent = hasSession ? "Fix failing Electron test" : "Choose a Session before attach";
    $("#destination-id").textContent = hasSession ? "SS-184 · fable5" : "asset remains local";
    $("#destination-status").textContent = hasSession ? "ready" : "required";
    $("#attach span").textContent = hasSession ? "Add to active Session" : "Choose Session";

    $("#select-session").classList.toggle("unselected", !hasSession);
    $("#select-session").classList.toggle("selected", hasSession);
    $("#destination-help").textContent = hasSession
      ? "The capture will become context for this Session only."
      : "Select this Session to attach the retained capture. Sending remains disabled until then.";
    $("#scope-pill").textContent = hasSession ? "SS-184 · Session only" : "No destination";

    $("#attachment").hidden = !state.attached;
    $("#attachment-meta").textContent =
      `asset_01K0X · ${state.annotated ? "1 annotation" : "no annotation"} · ${hasSession ? "SS-184" : "local"}`;
    $("#remove-attachment").disabled = state.sent;
    $("#send").disabled = !hasSession || !state.attached || state.sent;
    $("#send").textContent = state.sent ? "Sent · locked" : "Send with image";
    $("#send-reason").textContent = state.sent
      ? "Sent to SS-184 · receipt locked"
      : !hasSession
        ? "Choose a Session before sending"
        : !state.attached
          ? "Add or reuse the image before sending"
          : "Ready · image is attached to SS-184";
    $("#sent-proof").hidden = !state.sent;
    $("#asset-empty").hidden = state.saved;
    $("#asset-layout").hidden = !state.saved;
    $("#reuse").hidden = !state.saved;
    $("#assets-eyebrow").textContent = state.everSent
      ? "SESSION ASSETS · SS-184"
      : "RECOVERY LIBRARY";
    $("#assets-title").textContent = state.saved
      ? "One object, still recoverable"
      : "Capture not saved yet";
    $("#asset-scope").textContent = state.everSent
      ? "Session SS-184"
      : "Local recovery library";
    $("#asset-annotation").classList.toggle("visible", state.annotated);
    $("#asset-annotation-copy").textContent = state.annotated
      ? "1 region · separate layer"
      : "No annotation";
    $("#asset-usage").textContent = state.everSent
      ? state.sent
        ? "Sent to SS-184 · reusable"
        : "Sent to SS-184 · reused in a new draft"
      : "Local recovery copy · not yet sent";

    const stages = { capture: true, attached: state.attached || state.sent, saved: state.saved };
    $$("[data-trace]").forEach((node) => {
      node.classList.toggle("done", stages[node.dataset.trace] && node.dataset.trace !== state.view);
      node.classList.toggle(
        "current",
        (node.dataset.trace === "capture" && state.view === "capture") ||
          (node.dataset.trace === "attached" && state.view === "session") ||
          (node.dataset.trace === "saved" && state.view === "assets"),
      );
    });
  }

  function attachCapture() {
    if (!state.session) {
      state.attached = false;
      setView("session");
      toast("Choose a Session; the image is still local and cannot be sent yet");
      return;
    }
    state.attached = true;
    setView("session");
    toast("Attached to SS-184; review before send");
  }

  $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

  $("#toggle-session").addEventListener("click", () => {
    state.session = state.session ? null : "SS-184";
    if (!state.session) state.attached = false;
    render();
    toast(state.session ? "SS-184 restored" : "Edge state: no Session is active");
  });

  $("#attach").addEventListener("click", attachCapture);
  $("#annotate").addEventListener("click", () => {
    state.annotated = !state.annotated;
    render();
    toast(state.annotated ? "Failure region added as a separate layer" : "Annotation removed");
  });
  $("#save").addEventListener("click", () => {
    state.saved = true;
    setView("assets");
    toast("Saved once with capture provenance");
  });
  $("#save-from-assets").addEventListener("click", () => {
    state.saved = true;
    render();
    toast("Saved locally; provenance is now available for recovery");
    $("#reuse").focus();
  });
  $("#dismiss").addEventListener("click", () => {
    state.cardVisible = false;
    render();
    toast("Quick Card dismissed; capture retained in the pending tray");
  });
  $("#pending-tray").addEventListener("click", () => {
    state.cardVisible = true;
    render();
    toast("Quick Card restored");
  });
  $("#select-session").addEventListener("click", () => {
    state.session = "SS-184";
    state.attached = true;
    render();
    toast("SS-184 selected and capture attached");
  });
  $("#remove-attachment").addEventListener("click", () => {
    state.attached = false;
    render();
    toast("Image removed from this draft; saved object is unchanged");
  });
  $("#send").addEventListener("click", () => {
    if (!state.session || !state.attached) return;
    state.sent = true;
    state.everSent = true;
    state.saved = true;
    render();
    toast("Sent with SS-184 scope; immutable usage recorded");
  });
  $("#reuse").addEventListener("click", () => {
    state.attached = Boolean(state.session);
    state.sent = false;
    setView("session");
    toast(
      state.session
        ? "Reused asset_01K0X without duplicating the image"
        : "Choose a Session; the saved asset remains recoverable",
    );
  });
  $("#reset").addEventListener("click", () => window.location.reload());

  document.addEventListener("keydown", (event) => {
    const interactiveTarget = event.target.closest(
      "button, a, textarea, input, select, [contenteditable='true']",
    );
    if (
      interactiveTarget ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      state.view !== "capture" ||
      !state.cardVisible
    )
      return;
    if (event.key.toLowerCase() === "a") {
      event.preventDefault();
      $("#annotate").click();
    }
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      $("#save").click();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      attachCapture();
    }
  });

  render();
})();
