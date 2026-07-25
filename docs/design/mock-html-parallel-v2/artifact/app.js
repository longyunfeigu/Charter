(() => {
  "use strict";

  const state = {
    screen: "completion",
    artifact: "pdf",
    currentVersion: 1,
    viewingVersion: 1,
    selectedRegion: "R-07B",
    originRegion: null,
    note: "",
    noteSaved: false,
    regenerated: false,
    reanchorMode: false,
    reanchored: false,
    preservedOnV1: false,
    linkedRegion: null,
    toastTimer: null,
  };

  const byId = (id) => document.getElementById(id);
  const all = (selector) => [...document.querySelectorAll(selector)];

  const elements = {
    dialog: byId("regenerate-dialog"),
    textarea: byId("feedback-note"),
    saveNoteButton: byId("save-note-button"),
    staleBanner: byId("stale-banner"),
    staleMessage: byId("stale-message"),
    noteComposer: byId("note-composer"),
    threadEmpty: byId("thread-empty"),
    noteThread: byId("note-thread"),
    savedNoteCopy: byId("saved-note-copy"),
    noteCount: byId("note-count"),
    versionTransition: byId("version-transition"),
    staleActions: byId("stale-actions"),
    reanchorGuide: byId("reanchor-guide"),
    reanchorConfirm: byId("reanchor-confirm"),
    confirmReanchorButton: byId("confirm-reanchor-button"),
    newAnchorLabel: byId("new-anchor-label"),
    linkedNote: byId("linked-note"),
    linkedRegionLabel: byId("linked-region-label"),
    toast: byId("toast"),
    toastMessage: byId("toast-message"),
    pdfPage: byId("pdf-page"),
    markdownPreview: byId("markdown-preview"),
    csvPreview: byId("csv-preview"),
    pdfToolbar: byId("pdf-toolbar"),
    pdfInspector: byId("pdf-inspector"),
    supportInspector: byId("support-inspector"),
  };

  function showToast(message) {
    elements.toastMessage.textContent = message;
    elements.toast.hidden = false;
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 3200);
  }

  function setScreen(screen, options = {}) {
    state.screen = screen;
    all(".screen").forEach((section) => {
      section.classList.toggle("active", section.dataset.screen === screen);
    });
    all(".lifecycle-step").forEach((button) => {
      const active = button.dataset.screenTarget === screen;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (screen === "review" && options.artifact) {
      setArtifact(options.artifact);
    }
    if (screen === "history") updateHistory();
    if (options.focus !== false) {
      const heading = document.querySelector(`#screen-${screen} h2`);
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    }
  }

  function artifactMeta(artifact) {
    if (artifact === "md") {
      return {
        name: "decision-summary.md",
        subtitle: "6.2 KB · supporting artifact · artifact_set_01K1A",
      };
    }
    if (artifact === "csv") {
      return {
        name: "evidence.csv",
        subtitle: "184 rows · supporting artifact · artifact_set_01K1A",
      };
    }
    return {
      name: "Q2-review.pdf",
      subtitle: `12 pages · produced by completion.0194`,
    };
  }

  function setArtifact(artifact) {
    state.artifact = artifact;
    const meta = artifactMeta(artifact);
    all(".artifact-index-item").forEach((button) => {
      const selected = button.dataset.artifact === artifact;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    byId("review-filename").textContent = meta.name;
    byId("review-subtitle").textContent = meta.subtitle;
    byId("review-version-chip").textContent =
      artifact === "pdf" ? `v${state.viewingVersion}` : "v1";
    byId("current-version-label").textContent =
      artifact === "pdf" && state.viewingVersion < state.currentVersion
        ? "OLDER VERSION"
        : "CURRENT";
    byId("regenerate-button").hidden = artifact !== "pdf";
    byId("show-origin-button").hidden = artifact !== "pdf";
    elements.pdfPage.hidden = artifact !== "pdf";
    elements.pdfToolbar.hidden = artifact !== "pdf";
    elements.markdownPreview.hidden = artifact !== "md";
    elements.csvPreview.hidden = artifact !== "csv";
    elements.pdfInspector.hidden = artifact !== "pdf";
    elements.supportInspector.hidden = artifact === "pdf";
    if (artifact !== "pdf") {
      byId("support-name").textContent = meta.name;
    }
  }

  function regionLabel(region) {
    return `Page 7 · Region ${region}`;
  }

  function selectRegion(region) {
    state.selectedRegion = region;
    all(".region-target").forEach((button) => {
      const selected = button.dataset.region === region;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    byId("selected-region-title").textContent = regionLabel(region);
    byId("anchor-version").textContent = `v${state.viewingVersion} · 7:${region}`;
    byId("composer-anchor").textContent = `p7 · ${region} · v${state.viewingVersion}`;
    if (state.reanchorMode) {
      elements.newAnchorLabel.textContent = `Page 7 · ${region} · v2`;
      elements.confirmReanchorButton.disabled = false;
    }
    updateHistory();
  }

  function saveNote() {
    const note = elements.textarea.value.trim();
    if (!note) return;
    state.note = note;
    state.noteSaved = true;
    state.originRegion = state.selectedRegion;
    state.preservedOnV1 = false;
    elements.savedNoteCopy.textContent = note;
    byId("origin-region-label").querySelector("span").textContent = `p7 · ${state.originRegion}`;
    elements.threadEmpty.hidden = true;
    elements.noteThread.hidden = false;
    elements.noteComposer.hidden = true;
    elements.noteCount.textContent = state.reanchored ? "2" : "1";
    byId("index-note-dot").hidden = false;
    byId("rail-review-status").textContent = "1 anchored note";
    updateHistory();
    showToast(`Feedback saved to Q2-review.pdf v1 · page 7 · ${state.originRegion}`);
  }

  function openRegeneration() {
    byId("dialog-note-detail").textContent = state.noteSaved
      ? `feedback_018 stays on v1 · page 7 · ${state.originRegion} · You.`
      : "No feedback is attached yet.";
    if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
    else elements.dialog.setAttribute("open", "");
  }

  function closeRegeneration() {
    if (elements.dialog.open && typeof elements.dialog.close === "function") elements.dialog.close();
    else elements.dialog.removeAttribute("open");
  }

  function confirmRegeneration() {
    state.currentVersion = 2;
    state.viewingVersion = 2;
    state.regenerated = true;
    state.reanchorMode = false;
    state.preservedOnV1 = false;
    closeRegeneration();
    byId("index-pdf-version").textContent = "v2 · 12 pages";
    byId("rail-version-label").textContent = "v2 · current";
    byId("rail-version-node").classList.add("current");
    byId("regenerate-button").disabled = true;
    byId("regenerate-button").textContent = "Version 2 created";
    byId("regenerate-button").title = "The v1 to v2 regeneration transition is complete.";
    renderPdfVersion(2);
    if (state.noteSaved) {
      elements.staleBanner.hidden = false;
      elements.versionTransition.hidden = false;
      elements.staleActions.hidden = false;
      byId("rail-review-status").textContent = "1 note needs review";
    } else {
      elements.staleBanner.hidden = false;
    }
    updateVersionBanner();
    updateHistory();
    showToast("Version 2 created. Version 1 remains immutable.");
  }

  function startReanchor() {
    renderPdfVersion(2);
    state.reanchorMode = true;
    elements.staleActions.hidden = true;
    elements.reanchorGuide.hidden = false;
    elements.reanchorConfirm.hidden = false;
    elements.confirmReanchorButton.disabled = true;
    elements.newAnchorLabel.textContent = "Select a region on the page";
    all(".region-target").forEach((button) => {
      button.classList.remove("selected");
      button.setAttribute("aria-pressed", "false");
    });
    byId("paper-scroller").scrollTo({ top: 0, behavior: "smooth" });
    elements.pdfPage
      .querySelector(`.region-target[data-region='${state.originRegion || "R-07B"}']`)
      .focus();
  }

  function cancelReanchor() {
    state.reanchorMode = false;
    elements.reanchorGuide.hidden = true;
    elements.reanchorConfirm.hidden = true;
    elements.staleActions.hidden = false;
    selectRegion(state.originRegion || "R-07B");
    showToast("Re-anchor cancelled. The note remains only on v1.");
  }

  function preserveV1() {
    state.preservedOnV1 = true;
    state.reanchorMode = false;
    elements.staleActions.hidden = true;
    updateVersionBanner();
    byId("rail-review-status").textContent = "1 note retained on v1";
    updateHistory();
    showToast("Feedback intentionally preserved on version 1.");
  }

  function confirmReanchor() {
    if (!state.reanchorMode || !state.selectedRegion) return;
    state.reanchorMode = false;
    state.reanchored = true;
    state.linkedRegion = state.selectedRegion;
    state.preservedOnV1 = false;
    elements.reanchorGuide.hidden = true;
    elements.reanchorConfirm.hidden = true;
    elements.linkedNote.hidden = false;
    elements.linkedRegionLabel.textContent = `p7 · ${state.linkedRegion}`;
    elements.noteCount.textContent = "2";
    elements.staleBanner.hidden = false;
    updateVersionBanner();
    byId("rail-review-status").textContent = "Feedback re-anchored";
    updateHistory();
    showToast(`Linked v2 anchor created at page 7 · ${state.linkedRegion}.`);
  }

  function renderPdfVersion(version) {
    state.viewingVersion = version;
    byId("review-version-chip").textContent = `v${version}`;
    byId("current-version-label").textContent =
      version < state.currentVersion ? "OLDER VERSION" : "CURRENT";
    byId("pdf-watermark").textContent = `VERSION ${version}`;
    byId("chart-change").textContent = version === 2 ? "+39%" : "+37%";
    byId("chart-caption").textContent =
      version === 2
        ? "Teams that shared at least one review artifact retained at 1.9× the baseline rate."
        : "Teams that shared at least one review artifact retained at nearly twice the baseline rate.";
    const region =
      version === 1
        ? state.originRegion || "R-07B"
        : state.linkedRegion || state.originRegion || "R-07B";
    selectRegion(region);
    updateVersionBanner();
  }

  function updateVersionBanner() {
    if (!state.regenerated) {
      elements.staleBanner.hidden = true;
      return;
    }
    elements.staleBanner.hidden = false;
    const versionButton = byId("view-v1-button");
    if (state.viewingVersion === 1) {
      elements.staleMessage.innerHTML = `<strong>Viewing immutable v1.</strong> ${
        state.noteSaved
          ? `feedback_018 originated here at p7 · ${state.originRegion}.`
          : "This version remains available without becoming current."
      }`;
      versionButton.textContent = "Return to current v2";
      return;
    }
    versionButton.textContent = "View immutable v1";
    if (state.reanchored) {
      elements.staleMessage.innerHTML =
        `<strong>Re-anchored on v2.</strong> A linked receipt now points to p7 · ${state.linkedRegion}; the v1 origin is unchanged.`;
    } else if (state.preservedOnV1) {
      elements.staleMessage.innerHTML =
        `<strong>Kept on v1.</strong> feedback_018 remains intentionally bound to p7 · ${state.originRegion}.`;
    } else if (state.noteSaved) {
      elements.staleMessage.innerHTML =
        `<strong>v2 created.</strong> feedback_018 is still anchored to immutable v1 · p7 · ${state.originRegion}.`;
    } else {
      elements.staleMessage.innerHTML =
        "<strong>v2 created.</strong> It is now current; v1 remains available in version history.";
    }
  }

  function updateHistory() {
    const version = state.currentVersion;
    const region = state.linkedRegion || state.selectedRegion || "R-07B";
    byId("history-position").textContent = `v${version} · page 7 · ${region} selected`;
    byId("summary-position").textContent = `Page 7 · ${region}`;
    byId("summary-version").textContent = `Version ${version} · ${
      version === 2 ? "current; v1 retained" : "immutable"
    }`;

    if (state.reanchored) {
      byId("history-status").textContent = "REVIEW LINKED TO V2";
      byId("history-review-state").innerHTML = "<i></i> Re-anchored";
      byId("summary-feedback").textContent = "1 note · linked v1 → v2";
    } else if (state.regenerated && state.noteSaved && !state.preservedOnV1) {
      byId("history-status").textContent = "FEEDBACK NEEDS REVIEW";
      byId("history-review-state").innerHTML = "<i></i> 1 note on v1";
      byId("summary-feedback").textContent = "1 note · awaiting v2 decision";
    } else if (state.preservedOnV1) {
      byId("history-status").textContent = "RETAINED ON V1";
      byId("history-review-state").innerHTML = "<i></i> 1 note · v1 only";
      byId("summary-feedback").textContent = "1 note · intentionally on v1";
    } else if (state.noteSaved) {
      byId("history-status").textContent = "REVIEW IN PROGRESS";
      byId("history-review-state").innerHTML = "<i></i> 1 anchored note";
      byId("summary-feedback").textContent = `1 note · page 7 · ${state.originRegion}`;
    } else {
      byId("history-status").textContent = "READY TO REVIEW";
      byId("history-review-state").innerHTML = "<i></i> No notes yet";
      byId("summary-feedback").textContent = "No notes yet";
    }
  }

  all("[data-screen-target]").forEach((button) => {
    button.addEventListener("click", () => setScreen(button.dataset.screenTarget));
  });

  all("[data-open-artifact]").forEach((button) => {
    button.addEventListener("click", () => {
      setScreen("review", { artifact: button.dataset.openArtifact });
    });
  });

  all(".artifact-index-item").forEach((button) => {
    button.addEventListener("click", () => setArtifact(button.dataset.artifact));
  });

  all(".region-target").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.region === state.selectedRegion));
    button.addEventListener("click", () => selectRegion(button.dataset.region));
  });

  elements.textarea.addEventListener("input", () => {
    elements.saveNoteButton.disabled = elements.textarea.value.trim().length === 0;
  });

  elements.textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (elements.textarea.value.trim()) saveNote();
    }
  });

  elements.noteComposer.addEventListener("submit", (event) => {
    event.preventDefault();
    saveNote();
  });

  byId("regenerate-button").addEventListener("click", openRegeneration);
  byId("cancel-regenerate-button").addEventListener("click", closeRegeneration);
  byId("confirm-regenerate-button").addEventListener("click", confirmRegeneration);
  byId("start-reanchor-button").addEventListener("click", startReanchor);
  byId("cancel-reanchor-button").addEventListener("click", cancelReanchor);
  byId("preserve-v1-button").addEventListener("click", preserveV1);
  byId("confirm-reanchor-button").addEventListener("click", confirmReanchor);
  byId("return-to-pdf-button").addEventListener("click", () => setArtifact("pdf"));
  byId("view-v1-button").addEventListener("click", () => {
    if (state.viewingVersion === 1) {
      renderPdfVersion(2);
      showToast("Returned to current Q2-review.pdf v2.");
    } else {
      renderPdfVersion(1);
      showToast(
        state.noteSaved
          ? `Viewing v1 receipt: feedback_018 · page 7 · ${state.originRegion} · You · immutable`
          : "Viewing immutable Q2-review.pdf v1.",
      );
    }
  });
  byId("show-origin-button").addEventListener("click", () => setScreen("completion"));
  all("[data-open-event='completion']").forEach((button) => {
    button.addEventListener("click", () => setScreen("completion"));
  });
  [byId("resume-review-button"), byId("summary-resume-button")].forEach((button) => {
    button.addEventListener("click", () => {
      renderPdfVersion(state.currentVersion);
      setScreen("review", { artifact: "pdf" });
    });
  });

  all(".history-filter button").forEach((button) => {
    button.addEventListener("click", () => {
      all(".history-filter button").forEach((candidate) => {
        candidate.classList.toggle("selected", candidate === button);
      });
      showToast(
        button.textContent.trim() === "Review packages"
          ? "Showing Sessions with retained review packages."
          : "Showing all retained Sessions.",
      );
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey && ["1", "2", "3"].includes(event.key)) {
      event.preventDefault();
      setScreen({ 1: "completion", 2: "review", 3: "history" }[event.key]);
    }
    if (event.key === "Escape" && state.reanchorMode && !elements.dialog.open) {
      cancelReanchor();
    }
  });

  selectRegion("R-07B");
  setArtifact("pdf");
  updateHistory();
  setScreen("completion", { focus: false });
})();
