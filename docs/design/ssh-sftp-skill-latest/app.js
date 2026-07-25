(() => {
  "use strict";

  const FILES = {
    dmg: { name: "charter-1.0.0.dmg", size: 98.2, label: "98.2 MB", conflict: true },
    notes: { name: "release-notes.md", size: 0.0041, label: "4.1 KB", conflict: false },
    package: { name: "package.json", size: 0.0023, label: "2.3 KB", conflict: false },
    env: { name: ".env.production", size: 0.000612, label: "612 B", conflict: false, sensitive: true },
  };

  const initialSelection = ["dmg", "notes"];
  const state = {
    selected: new Set(initialSelection),
    policy: "keep",
    phase: "draft",
    compactPane: "local",
    batchFiles: [],
    timers: [],
    returnFocus: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    dialog: $("#preflight-dialog"),
    manifest: $("#manifest-files"),
    manifestCount: $("#manifest-count"),
    manifestSize: $("#manifest-size"),
    manifestConflicts: $("#manifest-conflicts"),
    localCount: $("#local-count"),
    localSize: $("#local-size"),
    review: $("#review-upload"),
    reviewReason: $("#review-reason"),
    dialogManifest: $("#dialog-manifest"),
    dialogCount: $("#dialog-count"),
    dialogConflict: $("#dialog-conflict"),
    previewCopy: $("#result-preview-copy"),
    previewDetail: $("#result-preview-detail"),
    ledgerEmpty: $("#ledger-empty"),
    ledgerRun: $("#ledger-run"),
    ledgerStatus: $("#ledger-status"),
    dmgTransfer: $("#dmg-transfer"),
    notesTransfer: $("#notes-transfer"),
    dmgProgress: $("#dmg-progress"),
    notesProgress: $("#notes-progress"),
    dmgStatus: $("#dmg-status"),
    notesStatus: $("#notes-status"),
    notesDetail: $("#notes-detail"),
    retry: $("#retry-failed"),
    receipt: $("#completion-receipt"),
    toast: $("#toast"),
    localPane: $("#local-pane"),
    remotePane: $("#remote-pane"),
    localTab: $("#local-tab"),
    remoteTab: $("#remote-tab"),
  };

  let toastTimer;

  function selectedFiles() {
    return [...state.selected].map((id) => ({ id, ...FILES[id] }));
  }

  function totalSize(files = selectedFiles()) {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total >= 1) return `${total.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(total * 1024))} KB`;
  }

  function conflictCount(files = selectedFiles()) {
    return files.filter((file) => file.conflict).length;
  }

  function clearTimers() {
    state.timers.forEach(window.clearTimeout);
    state.timers = [];
  }

  function later(callback, delay) {
    const timer = window.setTimeout(callback, delay);
    state.timers.push(timer);
  }

  function toast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 2400);
  }

  function updateStudy(active) {
    $$("[data-demo]").forEach((button) => {
      button.classList.toggle("study-active", button.dataset.demo === active);
    });
  }

  function manifestMarkup(files) {
    if (!files.length) {
      return `<div class="manifest-file"><strong>No files selected</strong><small>Choose a local file to build a transfer batch.</small></div>`;
    }
    return files
      .map(
        (file) => `<div class="manifest-file">
          <strong>${file.name}</strong>
          <small>${file.label}${file.sensitive ? " · sensitive" : ""}</small>
          ${file.conflict ? "<b>CONFLICT</b>" : ""}
        </div>`,
      )
      .join("");
  }

  function renderSelection() {
    const files = selectedFiles();
    const count = files.length;
    const conflicts = conflictCount(files);
    const size = totalSize(files);

    $$(".file-check").forEach((input) => {
      input.checked = state.selected.has(input.value);
      input.closest(".file-row").classList.toggle("selected", input.checked);
    });
    elements.manifest.innerHTML = manifestMarkup(files);
    elements.manifestCount.textContent = `${count} item${count === 1 ? "" : "s"}`;
    elements.manifestSize.textContent = size;
    elements.manifestConflicts.textContent = conflicts
      ? `${conflicts} needs a decision`
      : "No filename conflicts";
    elements.manifestConflicts.classList.toggle("warning-copy", conflicts > 0);
    elements.localCount.textContent = `${count} selected`;
    elements.localSize.textContent = size;
    elements.review.disabled = count === 0;
    elements.review.querySelector("span").textContent = count ? `Review ${count} item${count === 1 ? "" : "s"}` : "Choose files";
    elements.reviewReason.textContent = count
      ? conflicts
        ? `Review ${conflicts} filename conflict before upload.`
        : "No filename conflict; verify the target before upload."
      : "Select at least one local file.";
  }

  function updatePreflight() {
    const files = selectedFiles();
    const conflicts = conflictCount(files);
    elements.dialogCount.textContent = `${files.length} item${files.length === 1 ? "" : "s"} · ${totalSize(files)}`;
    elements.dialogManifest.innerHTML = files
      .map(
        (file) => `<div class="dialog-file">
          <strong>${file.name}</strong><b>${file.label}</b>
          <small>${file.conflict ? "Matches an existing remote filename" : "New remote filename"}${file.sensitive ? " · sensitive source" : ""}</small>
        </div>`,
      )
      .join("");
    elements.dialogConflict.hidden = conflicts === 0;
    updatePolicyPreview();
  }

  function updatePolicyPreview() {
    const hasDmg = state.selected.has("dmg");
    const policy = state.policy;
    const resultingCount = state.selected.size - (hasDmg && policy === "skip" ? 1 : 0);
    $("#start-upload").disabled = resultingCount === 0;
    if (!hasDmg) {
      elements.previewCopy.textContent = `${state.selected.size} new file${state.selected.size === 1 ? "" : "s"} · no overwrite`;
      elements.previewDetail.textContent = "Every selected filename is new at the remote target.";
      return;
    }
    if (policy === "replace") {
      elements.previewCopy.textContent = "1 atomic replacement · remaining files added";
      elements.previewDetail.textContent =
        "The existing DMG remains active until the new 98.2 MB file is fully written and verified.";
    } else if (policy === "skip") {
      elements.previewCopy.textContent = `${Math.max(state.selected.size - 1, 0)} file uploaded · DMG unchanged`;
      elements.previewDetail.textContent =
        "charter-1.0.0.dmg is excluded from this batch; the remote copy remains untouched.";
    } else {
      elements.previewCopy.textContent = `${state.selected.size} new files · no overwrite`;
      elements.previewDetail.textContent =
        "Existing DMG remains unchanged; new DMG receives “(1)”.";
    }
  }

  function openPreflight() {
    if (!state.selected.size) return;
    state.returnFocus = document.activeElement;
    state.policy = $('input[name="policy"]:checked').value;
    updatePreflight();
    elements.dialog.showModal();
    updateStudy("preflight");
    requestAnimationFrame(() => $(".close-dialog").focus());
  }

  function closePreflight({ restore = true } = {}) {
    if (elements.dialog.open) elements.dialog.close();
    if (restore && state.returnFocus instanceof HTMLElement) state.returnFocus.focus();
  }

  function setLedgerPhase(phase) {
    state.phase = phase;
    elements.ledgerStatus.className = `ledger-status ${phase}`;
    const labels = {
      draft: "Draft",
      running: "Uploading",
      failed: "Interrupted · resumable",
      complete: "Last batch · locked",
    };
    elements.ledgerStatus.innerHTML = `<i></i>${labels[phase]}`;
    elements.ledgerEmpty.hidden = phase !== "draft";
    elements.ledgerRun.hidden = phase === "draft";
    $("#task-state-label").textContent =
      phase === "complete"
        ? "NEXT TRANSFER BATCH · DRAFT"
        : phase === "draft"
          ? "TRANSFER BATCH · DRAFT"
          : "TRANSFER BATCH · TX_01KSSH";
    $("#ledger-title").textContent =
      phase === "complete"
        ? "Last completed batch stays auditable"
        : phase === "draft"
          ? "Batch evidence stays with the route"
          : "Current batch progress and recovery";
  }

  function resetTransferRows() {
    elements.dmgTransfer.className = "transfer-item";
    elements.notesTransfer.className = "transfer-item";
    elements.dmgProgress.style.width = "0%";
    elements.notesProgress.style.width = "0%";
    elements.dmgProgress.parentElement.setAttribute("aria-valuenow", "0");
    elements.notesProgress.parentElement.setAttribute("aria-valuenow", "0");
    elements.dmgStatus.textContent = "Queued";
    elements.notesStatus.textContent = "Queued";
    elements.notesDetail.textContent = "4.1 KB · waits for current write";
    elements.retry.hidden = true;
    elements.receipt.hidden = true;
  }

  function snapshotBatch() {
    state.batchFiles = selectedFiles().filter(
      (file) => !(file.id === "dmg" && state.policy === "skip"),
    );
    $("#dmg-result-name").textContent =
      state.policy === "replace" ? "charter-1.0.0.dmg" : "charter-1.0.0 (1).dmg";
    $("#dmg-detail").textContent =
      state.policy === "replace" ? "98.2 MB · Atomic replacement" : "98.2 MB · Keep both";
    $("#dmg-transfer").hidden = !state.batchFiles.some((file) => file.id === "dmg");
    $("#notes-transfer").hidden = !state.batchFiles.some((file) => file.id === "notes");
  }

  function showFailure() {
    clearTimers();
    if (!state.batchFiles.length) {
      state.selected = new Set(initialSelection);
      state.policy = "keep";
      snapshotBatch();
      renderSelection();
    }
    setLedgerPhase("failed");
    resetTransferRows();
    if (!$("#dmg-transfer").hidden) {
      elements.dmgTransfer.classList.add("done");
      elements.dmgProgress.style.width = "100%";
      elements.dmgProgress.parentElement.setAttribute("aria-valuenow", "100");
      elements.dmgStatus.textContent = "Verified";
    }
    if (!$("#notes-transfer").hidden) {
      elements.notesTransfer.classList.add("failed");
      elements.notesProgress.style.width = "68%";
      elements.notesProgress.parentElement.setAttribute("aria-valuenow", "68");
      elements.notesStatus.textContent = "Connection reset";
      elements.notesDetail.textContent = "2.8 of 4.1 KB retained · retry resumes this file only";
      elements.retry.hidden = false;
    } else {
      completeBatch();
      return;
    }
    updateStudy("failure");
    toast("Connection interrupted after the DMG verified; one file can resume.");
  }

  function startUpload() {
    if (state.selected.size === 0) return;
    clearTimers();
    snapshotBatch();
    if (state.batchFiles.length === 0) return;
    closePreflight({ restore: false });
    resetTransferRows();
    setLedgerPhase("running");
    updateStudy("failure");
    elements.ledgerRun.scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (!$("#dmg-transfer").hidden) {
      elements.dmgStatus.textContent = "Writing";
      later(() => {
        elements.dmgProgress.style.width = "56%";
        elements.dmgProgress.parentElement.setAttribute("aria-valuenow", "56");
        elements.dmgStatus.textContent = "56%";
      }, 260);
      later(() => {
        elements.dmgProgress.style.width = "100%";
        elements.dmgProgress.parentElement.setAttribute("aria-valuenow", "100");
        elements.dmgTransfer.classList.add("done");
        elements.dmgStatus.textContent = "Verified";
        elements.notesStatus.textContent = "Writing";
      }, 620);
      later(() => {
        if ($("#notes-transfer").hidden) completeBatch();
        else showFailure();
      }, 980);
    } else {
      elements.notesStatus.textContent = "Writing";
      elements.notesProgress.style.width = "28%";
      elements.notesProgress.parentElement.setAttribute("aria-valuenow", "28");
      later(showFailure, 500);
    }
  }

  function completeBatch() {
    clearTimers();
    if (!state.batchFiles.length) {
      state.selected = new Set(initialSelection);
      state.policy = "keep";
      snapshotBatch();
      renderSelection();
    }
    setLedgerPhase("complete");
    resetTransferRows();
    if (!$("#dmg-transfer").hidden) {
      elements.dmgTransfer.classList.add("done");
      elements.dmgProgress.style.width = "100%";
      elements.dmgProgress.parentElement.setAttribute("aria-valuenow", "100");
      elements.dmgStatus.textContent = "Verified";
    }
    if (!$("#notes-transfer").hidden) {
      elements.notesTransfer.classList.add("done");
      elements.notesProgress.style.width = "100%";
      elements.notesProgress.parentElement.setAttribute("aria-valuenow", "100");
      elements.notesStatus.textContent = "Verified";
      elements.notesDetail.textContent = "4.1 KB · resumed from 2.8 KB and verified";
    }
    elements.receipt.hidden = false;
    const count = state.batchFiles.length;
    const policyLabel =
      state.policy === "replace"
        ? "Atomic replacement"
        : state.policy === "skip"
          ? "DMG skipped"
          : state.batchFiles.some((file) => file.id === "dmg")
            ? "Keep both"
            : "No conflict";
    $("#receipt-title").textContent =
      `${count} of ${count} file${count === 1 ? "" : "s"} verified on prod-api-01`;
    $("#receipt-detail").textContent =
      `/home/deploy/releases · ${policyLabel} · completed 10:44:18`;
    updateStudy("complete");
    toast("Batch TX_01KSSH completed; the execution receipt is locked.");
  }

  function retryFailed() {
    setLedgerPhase("running");
    elements.notesTransfer.classList.remove("failed");
    elements.notesStatus.textContent = "Resuming";
    elements.notesDetail.textContent = "Resuming from 2.8 KB · completed DMG will not restart";
    elements.retry.hidden = true;
    later(() => {
      elements.notesProgress.style.width = "100%";
      elements.notesProgress.parentElement.setAttribute("aria-valuenow", "100");
      completeBatch();
    }, 520);
  }

  function setCompactPane(pane) {
    state.compactPane = pane;
    const local = pane === "local";
    elements.localPane.classList.toggle("compact-active", local);
    elements.remotePane.classList.toggle("compact-active", !local);
    elements.localTab.classList.toggle("active", local);
    elements.remoteTab.classList.toggle("active", !local);
    elements.localTab.setAttribute("aria-selected", String(local));
    elements.remoteTab.setAttribute("aria-selected", String(!local));
  }

  function reset() {
    clearTimers();
    state.selected = new Set(initialSelection);
    state.policy = "keep";
    state.batchFiles = [];
    $$('input[name="policy"]').forEach((radio) => {
      radio.checked = radio.value === "keep";
    });
    closePreflight({ restore: false });
    setLedgerPhase("draft");
    resetTransferRows();
    $("#dmg-transfer").hidden = false;
    $("#notes-transfer").hidden = false;
    setCompactPane("local");
    renderSelection();
    updateStudy("browse");
    elements.toast.hidden = true;
    $("#review-upload").focus();
  }

  $$(".file-check").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(input.value);
      else state.selected.delete(input.value);
      renderSelection();
    });
  });

  $$('input[name="policy"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.policy = radio.value;
      updatePolicyPreview();
    });
  });

  elements.review.addEventListener("click", openPreflight);
  $("#empty-review").addEventListener("click", openPreflight);
  $("#start-upload").addEventListener("click", startUpload);
  elements.retry.addEventListener("click", retryFailed);
  elements.localTab.addEventListener("click", () => setCompactPane("local"));
  elements.remoteTab.addEventListener("click", () => setCompactPane("remote"));
  $("#reset-demo").addEventListener("click", reset);

  elements.dialog.addEventListener("close", () => {
    if (state.phase === "draft") updateStudy("browse");
    if (elements.dialog.returnValue === "cancel" && state.returnFocus instanceof HTMLElement) {
      state.returnFocus.focus();
    }
  });

  $$("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => {
      const demo = button.dataset.demo;
      if (demo === "browse") reset();
      if (demo === "preflight") openPreflight();
      if (demo === "failure") {
        closePreflight({ restore: false });
        if (!state.batchFiles.length) snapshotBatch();
        showFailure();
      }
      if (demo === "complete") {
        closePreflight({ restore: false });
        if (!state.batchFiles.length) snapshotBatch();
        completeBatch();
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.dialog.open) {
      event.preventDefault();
      closePreflight();
    }
  });

  renderSelection();
  setLedgerPhase("draft");
  setCompactPane("local");
})();
