const initialProjectContent = `# fable5 project instructions

## Verification
- Before submitting changes, run \`npm test\`.
- Keep snapshots small and reviewable.
- Document changes to public behavior.
`;

const alignedProjectContent = `# fable5 project instructions

## Verification
- Before submitting changes, run \`npm run test:e2e\`.
- Keep snapshots small and reviewable.
- Document changes to public behavior.
`;

const state = {
  projectContent: initialProjectContent,
  savedProjectContent: initialProjectContent,
  conflict: true,
  excluded: null,
  sent: false,
  sentReceipt: null,
  activeView: "effective",
  lastFocus: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  mainStage: $("#main-stage"),
  effectiveView: $("#effective-view"),
  receiptView: $("#receipt-view"),
  navConflictCount: $("#nav-conflict-count"),
  summarySeal: $("#summary-seal"),
  summaryReason: $("#summary-reason"),
  attentionCount: $("#attention-count"),
  projectSourceRow: $("#project-source-row"),
  projectSourceState: $("#project-source-state"),
  projectExcerpt: $("#project-excerpt"),
  projectImpact: $("#project-impact"),
  conflictPanel: $("#conflict-panel"),
  editorBackdrop: $("#editor-backdrop"),
  sourceContent: $("#source-content"),
  saveSource: $("#save-source"),
  editorDirtyState: $("#editor-dirty-state"),
  editorConflict: $(".editor-conflict"),
  editorConflictState: $("#editor-conflict-state"),
  editorProjectCommand: $("#editor-project-command"),
  alignCommand: $("#align-command"),
  toast: $("#toast"),
  receiptStatus: $("#receipt-status"),
  receiptTitle: $("#receipt-title"),
  receiptId: $("#receipt-id"),
  receiptIntro: $("#receipt-intro"),
  exclusionNote: $("#exclusion-note"),
  includedCount: $("#included-count"),
  excludedSummary: $("#excluded-summary"),
  receiptEffectiveTest: $("#receipt-effective-test"),
  runSummaryTitle: $("#run-summary-title"),
  startSession: $("#start-session"),
  projectReceiptCommand: $("#project-receipt-command"),
  sentProof: $("#sent-proof"),
  sentProofCopy: $("#sent-proof-copy"),
  payloadHash: $("#payload-hash"),
};

function isAligned(content) {
  return content.includes("run `npm run test:e2e`");
}

function sourceLabel(source) {
  return {
    workspace: "Charter workspace rule",
    project: ".claude/CLAUDE.md",
    global: "~/.codex/AGENTS.md",
  }[source];
}

function showView(viewName, focusHeading = true) {
  state.activeView = viewName;
  const isEffective = viewName === "effective";
  elements.effectiveView.hidden = !isEffective;
  elements.receiptView.hidden = isEffective;
  elements.effectiveView.classList.toggle("is-visible", isEffective);
  elements.receiptView.classList.toggle("is-visible", !isEffective);

  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  elements.mainStage.scrollTop = 0;
  if (focusHeading) {
    const heading = isEffective ? $("#effective-title") : $("#receipt-title");
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
}

function renderEffectiveState() {
  const resolved = !state.conflict;
  elements.navConflictCount.textContent = resolved ? "✓" : "1";
  elements.navConflictCount.className = `nav-status ${resolved ? "resolved" : "conflict"}`;
  elements.navConflictCount.setAttribute(
    "aria-label",
    resolved ? "No conflicts" : "1 active conflict",
  );

  elements.summarySeal.classList.toggle("warning", !resolved);
  elements.summarySeal.classList.toggle("success", resolved);
  elements.summarySeal.innerHTML = resolved
    ? '<svg viewBox="0 0 20 20"><path d="m4 10 3.5 3.5L16 5"></path></svg>'
    : '<svg viewBox="0 0 20 20"><path d="M10 3 17 16H3zM10 7.5v4M10 14h.01"></path></svg>';
  elements.summaryReason.textContent = resolved
    ? "All active sources now agree."
    : "Charter workspace rule wins the conflict.";
  elements.attentionCount.textContent = resolved ? "No conflicts" : "1 conflict";
  elements.attentionCount.classList.toggle("warning-text", !resolved);

  elements.projectSourceState.textContent = resolved ? "Aligned" : "Conflict";
  elements.projectSourceState.className = `source-state ${resolved ? "resolved" : "conflict"}`;
  elements.projectExcerpt.innerHTML = resolved
    ? "Before submitting changes, run <code>npm run test:e2e</code>. Keep snapshots small and reviewable."
    : "Before submitting changes, run <code>npm test</code>. Keep snapshots small and reviewable.";
  elements.projectImpact.textContent = resolved
    ? "Contributes 3 instructions; test command agrees with 01"
    : "Contributes 3 instructions; test command is overridden by 01";
  elements.projectImpact.style.color = resolved ? "var(--moss)" : "";

  elements.conflictPanel.classList.toggle("is-resolved", resolved);
  elements.conflictPanel.innerHTML = resolved
    ? `<div class="conflict-icon" aria-hidden="true">
         <svg viewBox="0 0 20 20"><path d="m4 10 3.5 3.5L16 5"></path></svg>
       </div>
       <div class="conflict-copy">
         <span class="eyebrow">Sources aligned</span>
         <h2 id="conflict-title">The project now names the effective test command</h2>
         <p>Only <code>.claude/CLAUDE.md</code> changed. The managed workspace rule and global Codex source were untouched.</p>
       </div>
       <button class="button" type="button" data-view="receipt">Review New Session</button>`
    : `<div class="conflict-icon" aria-hidden="true">
         <svg viewBox="0 0 20 20"><path d="M10 3 17 16H3zM10 7.5v4M10 14h.01"></path></svg>
       </div>
       <div class="conflict-copy">
         <span class="eyebrow">Needs attention</span>
         <h2 id="conflict-title">Two active sources name different test commands</h2>
         <p>The run is predictable—precedence 01 uses <code>npm run test:e2e</code>—but the project source still tells future readers to use <code>npm test</code>.</p>
         <div class="comparison-lines" aria-label="Conflicting values">
           <span><b>01</b> npm run test:e2e <em>effective</em></span>
           <span><b>02</b> npm test <em>overridden</em></span>
         </div>
       </div>
       <button class="button warning-button" type="button" id="resolve-conflict">Review project source</button>`;

  const resolveButton = $("#resolve-conflict");
  if (resolveButton) resolveButton.addEventListener("click", openEditor);
  $$("[data-view]", elements.conflictPanel).forEach(bindViewButton);
  renderReceiptProjectText();
}

function renderReceiptProjectText(conflict = state.conflict) {
  elements.projectReceiptCommand.innerHTML = conflict
    ? "Before submitting changes, run <code>npm test</code>."
    : "Before submitting changes, run <code>npm run test:e2e</code>.";
}

function bindViewButton(button) {
  if (button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  button.addEventListener("click", () => showView(button.dataset.view));
}

function openEditor() {
  state.lastFocus = document.activeElement;
  state.projectContent = state.savedProjectContent;
  elements.sourceContent.value = state.projectContent;
  renderEditorState();
  elements.editorBackdrop.hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => elements.sourceContent.focus());
}

function closeEditor({ restore = true } = {}) {
  elements.editorBackdrop.hidden = true;
  document.body.style.overflow = "";
  state.projectContent = state.savedProjectContent;
  if (restore && state.lastFocus instanceof HTMLElement) state.lastFocus.focus();
}

function renderEditorState() {
  const dirty = state.projectContent !== state.savedProjectContent;
  const aligned = isAligned(state.projectContent);
  elements.editorDirtyState.textContent = dirty ? "Unsaved changes" : "No unsaved changes";
  elements.editorDirtyState.style.color = dirty ? "var(--oxide)" : "";
  elements.saveSource.disabled = !dirty || state.projectContent.trim().length === 0;
  elements.editorProjectCommand.textContent = aligned ? "npm run test:e2e" : "npm test";
  elements.editorConflict.classList.toggle("is-aligned", aligned);
  elements.editorConflictState.textContent = aligned ? "Commands aligned" : "Conflict found";
  elements.editorConflictState.className = `source-state ${aligned ? "resolved" : "conflict"}`;
}

function alignProjectCommand() {
  const selectionStart = elements.sourceContent.selectionStart;
  state.projectContent = state.projectContent.includes("`npm test`")
    ? state.projectContent.replace("`npm test`", "`npm run test:e2e`")
    : alignedProjectContent;
  elements.sourceContent.value = state.projectContent;
  renderEditorState();
  elements.sourceContent.focus();
  const newPosition = Math.max(selectionStart, state.projectContent.indexOf("npm run test:e2e"));
  elements.sourceContent.setSelectionRange(newPosition, newPosition + "npm run test:e2e".length);
}

function saveProjectSource() {
  if (elements.saveSource.disabled) return;
  elements.saveSource.disabled = true;
  elements.saveSource.textContent = "Saving…";

  window.setTimeout(() => {
    state.savedProjectContent = state.projectContent;
    state.conflict = !isAligned(state.savedProjectContent);
    elements.saveSource.textContent = "Save project source";
    closeEditor({ restore: false });
    renderEffectiveState();
    renderReceipt();
    showView("effective", false);
    elements.toast.hidden = false;
    $("#undo-save").focus();
  }, 320);
}

function undoSave() {
  state.savedProjectContent = initialProjectContent;
  state.projectContent = initialProjectContent;
  state.conflict = true;
  elements.toast.hidden = true;
  renderEffectiveState();
  renderReceipt();
  $("#edit-project-source").focus();
}

function toggleExclusion(source) {
  if (state.sent) return;
  state.excluded = state.excluded === source ? null : source;
  renderReceipt();
}

function renderReceipt() {
  const sent = state.sent;
  const receiptState =
    sent && state.sentReceipt
      ? state.sentReceipt
      : { excluded: state.excluded, conflict: state.conflict };
  const excluded = receiptState.excluded;
  const includedSources = 3 - (excluded ? 1 : 0);
  const excludedInstructions = excluded === "workspace" ? 2 : excluded === "project" ? 3 : excluded ? 2 : 0;
  const includedInstructions = 7 - excludedInstructions;
  const effectiveTest =
    excluded === "workspace" && receiptState.conflict ? "npm test" : "npm run test:e2e";
  renderReceiptProjectText(receiptState.conflict);

  $$("[data-receipt-source]").forEach((article) => {
    const source = article.dataset.receiptSource;
    const isExcluded = source === excluded;
    article.classList.toggle("is-excluded", isExcluded);
    const button = $("[data-exclude]", article);
    button.setAttribute("aria-pressed", String(isExcluded));
    button.textContent = sent
      ? isExcluded
        ? "Excluded"
        : "Included"
      : isExcluded
        ? "Include again"
        : "Exclude";
    button.disabled = sent;
    button.setAttribute(
      "aria-label",
      sent
        ? `${sourceLabel(source)} was ${isExcluded ? "excluded from" : "included in"} this locked receipt`
        : `${isExcluded ? "Include" : "Exclude"} ${sourceLabel(source)} for this run`,
    );
  });

  elements.includedCount.textContent = `${includedSources} sources · ${includedInstructions} instructions`;
  elements.excludedSummary.textContent = excluded ? `${sourceLabel(excluded)} · this run only` : "None";
  elements.receiptEffectiveTest.textContent = effectiveTest;
  elements.startSession.textContent = sent
    ? "Session started · receipt locked"
    : `Start Session with ${includedSources} source${includedSources === 1 ? "" : "s"}`;
  elements.startSession.disabled = sent;

  elements.receiptStatus.className = `receipt-status ${sent ? "sent" : "draft"}`;
  elements.receiptStatus.innerHTML = `<span class="receipt-status-dot"></span>${
    sent ? "Sent · immutable" : "Draft receipt"
  }`;
  elements.receiptTitle.textContent = sent
    ? "What the agent received"
    : "Review what the agent will receive";
  elements.runSummaryTitle.textContent = sent ? "Receipt locked" : "Ready to start";
  elements.receiptId.textContent = sent ? "mem_01K3F · SS-219" : "DRAFT · fable5";
  elements.receiptIntro.textContent = sent
    ? "This receipt is locked to SS-219. It records the exact sources sent at execution."
    : "This draft reflects the current effective order. You may exclude one source for this run only.";
  elements.exclusionNote.textContent = sent
    ? excluded
      ? `${sourceLabel(excluded)} was excluded from SS-219 only. Its source file remains active for future runs.`
      : "All three configured sources were included. Source files remain independently editable for future runs."
    : "Exclusions do not change any source file. At most one source can be excluded from this run.";

  elements.sentProof.hidden = !sent;
  if (sent) {
    elements.sentProofCopy.textContent = excluded
      ? `The agent received ${includedSources} sources in precedence order. ${sourceLabel(excluded)} was recorded as excluded for this run only.`
      : "The agent received all 3 sources in the precedence order shown above.";
    elements.payloadHash.textContent = excluded ? "sha256:814f…29b7" : "sha256:3db2…8ca1";
  }
}

function startSession() {
  if (state.sent) return;
  state.sentReceipt = {
    excluded: state.excluded,
    conflict: state.conflict,
  };
  state.sent = true;
  elements.toast.hidden = true;
  renderReceipt();
  elements.sentProof.scrollIntoView({ behavior: "smooth", block: "nearest" });
  window.setTimeout(() => elements.sentProof.setAttribute("tabindex", "-1"), 0);
}

function resetDemo() {
  state.projectContent = initialProjectContent;
  state.savedProjectContent = initialProjectContent;
  state.conflict = true;
  state.excluded = null;
  state.sent = false;
  state.sentReceipt = null;
  elements.toast.hidden = true;
  elements.editorBackdrop.hidden = true;
  document.body.style.overflow = "";
  renderEffectiveState();
  renderReceipt();
  showView("effective", false);
  $("#effective-title").setAttribute("tabindex", "-1");
  $("#effective-title").focus();
}

$$("[data-view]").forEach(bindViewButton);
$("#edit-project-source").addEventListener("click", openEditor);
$("#resolve-conflict").addEventListener("click", openEditor);
$("#close-editor").addEventListener("click", () => closeEditor());
$("#cancel-editor").addEventListener("click", () => closeEditor());
elements.sourceContent.addEventListener("input", (event) => {
  state.projectContent = event.target.value;
  renderEditorState();
});
elements.alignCommand.addEventListener("click", alignProjectCommand);
elements.saveSource.addEventListener("click", saveProjectSource);
$("#undo-save").addEventListener("click", undoSave);
$$("[data-exclude]").forEach((button) => {
  button.addEventListener("click", () => toggleExclusion(button.dataset.exclude));
});
elements.startSession.addEventListener("click", startSession);
$("#reset-demo").addEventListener("click", resetDemo);

elements.editorBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.editorBackdrop) closeEditor();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.editorBackdrop.hidden) {
    event.preventDefault();
    closeEditor();
  }

  if (event.key === "Tab" && !elements.editorBackdrop.hidden) {
    const focusable = $$(
      'button:not([disabled]), textarea, summary, [href], [tabindex]:not([tabindex="-1"])',
      elements.editorBackdrop,
    ).filter((element) => !element.hidden && element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

renderEffectiveState();
renderReceipt();
