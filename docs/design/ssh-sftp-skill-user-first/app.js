const state = {
  dialogOpen: false,
  centerCollapsed: false,
  selection: new Set(["dmg", "notes"]),
  batch: "empty",
  lastFocus: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const theme = new URLSearchParams(window.location.search).get("theme");
const themeNames = {
  heritage: "Warm Archive",
  native: "Mac Utility",
  synthesis: "Warm Precision",
};

if (themeNames[theme]) {
  document.body.dataset.theme = theme;
  document.title = `${themeNames[theme]} · SFTP 文件传输`;
  $("#style-label").textContent = `SSH / SFTP · ${themeNames[theme]}`;
}

const dialog = $("#conflict-dialog");
const remotePane = $("#remote-pane");
const centerEmpty = $("#center-empty");
const batchView = $("#batch-view");
const batchState = $("#batch-state");
const retryButton = $("#retry-button");
const notesTransfer = $("#notes-transfer");
const receipt = $("#receipt");
const toast = $("#toast");

function selectedMeta() {
  const items = [...state.selection];
  const size = items.reduce((total, item) => {
    if (item === "dmg") return total + 98.2;
    if (item === "notes") return total + 0.004;
    if (item === "package") return total + 0.002;
    if (item === "env") return total + 0.001;
    if (item === "readme") return total + 0.009;
    return total;
  }, 0);
  return { count: items.length, size };
}

function formatSize(size) {
  if (size === 0) return "0 B";
  return size >= 1 ? `${size.toFixed(1)} MB` : `${Math.round(size * 1024)} KB`;
}

function updateSelection() {
  const meta = selectedMeta();
  $$(".file-check").forEach((input) => {
    const row = input.closest(".file-row");
    const selected = state.selection.has(input.value);
    input.checked = selected;
    row.classList.toggle("selected", selected);
    row.classList.toggle("draggable", selected);
    row.draggable = selected;
  });
  $("#selection-summary").innerHTML = `<strong>${meta.count} selected</strong> · ${formatSize(meta.size)}`;
  $("#compact-selection").textContent = `${meta.count} selected`;
  $("#upload-count").textContent = `${meta.count} ${meta.count === 1 ? "item" : "items"}`;
  $("#upload-button").disabled = meta.count === 0;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 1800);
}

function updatePolicy() {
  const selected = $('input[name="conflict-policy"]:checked');
  $$(".policy").forEach((policy) => {
    policy.classList.toggle("selected", policy.contains(selected));
  });
  const policy = selected.value;
  const result =
    policy === "keep"
      ? "Result: 2 files · no existing file overwritten"
      : policy === "replace"
        ? "Result: 2 files · existing DMG will be replaced"
        : "Result: 1 file · existing DMG remains unchanged";
  $("#result-preview").textContent = result;
  $("#start-upload").firstChild.textContent =
    policy === "skip" ? "Upload 1 file " : "Upload 2 files ";
}

function openDialog(trigger = $("#upload-button")) {
  if (!state.selection.size) return;
  window.clearTimeout(showToast.timer);
  toast.hidden = true;
  state.lastFocus = trigger;
  state.dialogOpen = true;
  dialog.hidden = false;
  document.body.classList.add("modal-open");
  updatePolicy();
  window.setTimeout(() => $('input[name="conflict-policy"]:checked').focus(), 0);
}

function closeDialog() {
  if (!state.dialogOpen) return;
  state.dialogOpen = false;
  dialog.hidden = true;
  document.body.classList.remove("modal-open");
  state.lastFocus?.focus();
}

function showBatch(kind) {
  state.batch = kind;
  centerEmpty.hidden = true;
  batchView.hidden = false;
  $("#transfer-center").classList.remove("collapsed");
  $("#uploaded-dmg").hidden = kind !== "complete";
  $("#uploaded-notes").hidden = kind !== "complete";

  if (kind === "failure") {
    batchState.className = "batch-state interrupted";
    batchState.innerHTML = "<i></i>Needs attention";
    $("#dmg-percent").textContent = "100%";
    $("#dmg-progress").style.setProperty("--progress", "100%");
    $("#dmg-state").textContent = "Verified";
    $("#notes-percent").textContent = "68%";
    $("#notes-progress").style.setProperty("--progress", "68%");
    $("#notes-state").textContent = "Connection interrupted";
    notesTransfer.classList.add("interrupted");
    retryButton.hidden = false;
    receipt.hidden = true;
  } else if (kind === "complete") {
    batchState.className = "batch-state complete";
    batchState.innerHTML = "<i></i>Complete";
    $("#notes-percent").textContent = "100%";
    $("#notes-progress").style.setProperty("--progress", "100%");
    $("#notes-state").textContent = "Resumed · verified";
    notesTransfer.classList.remove("interrupted");
    retryButton.hidden = true;
    receipt.hidden = false;
  }
  updatePeek();
}

function startUpload() {
  closeDialog();
  showBatch("failure");
  showToast("Upload started · Transfer Center will keep the progress visible");
}

function retryUpload() {
  retryButton.disabled = true;
  retryButton.textContent = "Resuming…";
  $("#notes-state").textContent = "Resuming from 2.8 KB";
  notesTransfer.classList.remove("interrupted");
  $("#notes-progress").style.setProperty("--progress", "84%");
  window.setTimeout(() => {
    retryButton.disabled = false;
    retryButton.innerHTML =
      '<svg aria-hidden="true"><use href="#icon-refresh"></use></svg>Resume from 2.8 KB';
    showBatch("complete");
    showToast("2 of 2 files uploaded and verified");
  }, 650);
}

function updatePeek() {
  const copy =
    state.batch === "complete"
      ? "2 of 2 complete"
      : state.batch === "failure"
        ? "1 interrupted"
        : "No active transfers";
  $("#peek-copy").textContent = copy;
}

function setCenterCollapsed(collapsed) {
  state.centerCollapsed = collapsed;
  $("#transfer-center").classList.toggle("collapsed", collapsed);
  $("#center-peek").hidden = !collapsed;
}

function reset() {
  window.clearTimeout(showToast.timer);
  toast.hidden = true;
  state.selection = new Set(["dmg", "notes"]);
  state.batch = "empty";
  closeDialog();
  remotePane.classList.remove("drag-over");
  centerEmpty.hidden = false;
  batchView.hidden = true;
  receipt.hidden = true;
  $("#uploaded-dmg").hidden = true;
  $("#uploaded-notes").hidden = true;
  retryButton.hidden = false;
  retryButton.disabled = false;
  $("#notes-progress").style.setProperty("--progress", "68%");
  $("#notes-percent").textContent = "68%";
  $("#notes-state").textContent = "Connection interrupted";
  notesTransfer.classList.add("interrupted");
  setCenterCollapsed(false);
  updateSelection();
  setCompactPane("local");
  updateStudy("browse");
}

function setCompactPane(pane) {
  const local = pane === "local";
  $("#local-pane").classList.toggle("compact-active", local);
  $("#remote-pane").classList.toggle("compact-active", !local);
  $("#local-tab").classList.toggle("active", local);
  $("#remote-tab").classList.toggle("active", !local);
  $("#local-tab").setAttribute("aria-selected", String(local));
  $("#remote-tab").setAttribute("aria-selected", String(!local));
}

function updateStudy(step) {
  $$("[data-demo]").forEach((button) => {
    button.classList.toggle("active", button.dataset.demo === step);
  });
}

$$(".file-check").forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) state.selection.add(input.value);
    else state.selection.delete(input.value);
    updateSelection();
  });
});

$$(".file-row[draggable]").forEach((row) => {
  row.addEventListener("dragstart", (event) => {
    if (!state.selection.has(row.dataset.file)) {
      state.selection = new Set([row.dataset.file]);
      updateSelection();
    }
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-charter-sftp", JSON.stringify([...state.selection]));
    event.dataTransfer.setData("text/plain", [...state.selection].join(","));
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    remotePane.classList.remove("drag-over");
  });
  row.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.target.closest("label")) {
      event.preventDefault();
      openDialog(row);
    }
  });
});

remotePane.addEventListener("dragenter", (event) => {
  event.preventDefault();
  remotePane.classList.add("drag-over");
});
remotePane.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  remotePane.classList.add("drag-over");
});
remotePane.addEventListener("dragleave", (event) => {
  if (!remotePane.contains(event.relatedTarget)) remotePane.classList.remove("drag-over");
});
remotePane.addEventListener("drop", (event) => {
  event.preventDefault();
  remotePane.classList.remove("drag-over");
  openDialog(remotePane);
});

$("#upload-button").addEventListener("click", () => openDialog($("#upload-button")));
$("#download-button").addEventListener("click", () =>
  showToast("Select one or more remote files to download"),
);
$("#dialog-close").addEventListener("click", closeDialog);
$("#dialog-cancel").addEventListener("click", closeDialog);
$("#start-upload").addEventListener("click", startUpload);
retryButton.addEventListener("click", retryUpload);
$("#center-collapse").addEventListener("click", () => setCenterCollapsed(true));
$("#center-peek").addEventListener("click", () => setCenterCollapsed(false));
$("#local-tab").addEventListener("click", () => setCompactPane("local"));
$("#remote-tab").addEventListener("click", () => setCompactPane("remote"));
$("#reset-demo").addEventListener("click", reset);

$$('input[name="conflict-policy"]').forEach((radio) => {
  radio.addEventListener("change", updatePolicy);
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.dialogOpen) {
    event.preventDefault();
    closeDialog();
  }
  if (event.key === "Tab" && state.dialogOpen) {
    const focusable = $$(
      "#conflict-dialog button:not([disabled]), #conflict-dialog input:not([disabled])",
    ).filter((element) => element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

$$("[data-demo]").forEach((button) => {
  button.addEventListener("click", () => {
    const step = button.dataset.demo;
    if (step === "browse") reset();
    if (step === "conflict") {
      reset();
      openDialog(button);
      updateStudy("conflict");
    }
    if (step === "failure") {
      closeDialog();
      showBatch("failure");
      updateStudy("failure");
    }
    if (step === "complete") {
      closeDialog();
      showBatch("complete");
      updateStudy("complete");
    }
  });
});

updateSelection();
updatePolicy();
updatePeek();
