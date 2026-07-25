(() => {
  const cases = {
    screenshot: {
      label: "Screenshot Quick Card",
      verdict:
        "The old Quick Card is credible, but the product question spans capture → Session scope → later recovery. The new set adds only those two causal boundaries.",
      score: "93",
      oldTitle: "Historical · local capture interaction",
      oldSrc: "../screenshot-quickcard-mock.html",
      newTitle: "Recommended · 3-surface intent loop",
      newSrc: "./screenshot-flow.html",
    },
    memory: {
      label: "Effective Memory",
      verdict:
        "The old provider-first inventory is useful for maintenance, but weak for the user's real question: what affects this project and this run? Preserve sources; correct the default mental model.",
      score: "94",
      oldTitle: "Historical · provider-first IA v3",
      oldSrc: "../memory-ia-v3.html",
      newTitle: "Recommended · effective → source → receipt",
      newSrc: "./memory-system.html",
    },
    artifact: {
      label: "Artifact Lifecycle",
      verdict:
        "The old artifact workspace is already strong. Do not redesign it for novelty; add the missing completion, immutable-version feedback, and History return contract.",
      score: "95",
      oldTitle: "Historical · artifact platform final mock",
      oldSrc: "../session-artifact-platform-final-mock.html",
      newTitle: "Recommended · completion → review → return",
      newSrc: "./artifact-lifecycle.html",
    },
  };

  const tabs = [...document.querySelectorAll("[data-case]")];
  const verdict = document.querySelector("#case-verdict");
  const score = document.querySelector("#case-score");
  const oldTitle = document.querySelector("#old-title");
  const newTitle = document.querySelector("#new-title");
  const oldFrame = document.querySelector("#old-frame");
  const newFrame = document.querySelector("#new-frame");
  const oldLink = document.querySelector("#old-link");
  const newLink = document.querySelector("#new-link");

  function selectCase(name) {
    const value = cases[name];
    if (!value) return;
    tabs.forEach((tab) => {
      const active = tab.dataset.case === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    verdict.textContent = value.verdict;
    score.textContent = value.score;
    oldTitle.textContent = value.oldTitle;
    newTitle.textContent = value.newTitle;
    oldFrame.src = value.oldSrc;
    newFrame.src = value.newSrc;
    oldLink.href = value.oldSrc;
    newLink.href = value.newSrc;
    document.title = `Mock boundary validation · ${value.label}`;
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => selectCase(tab.dataset.case)));
  selectCase("screenshot");
})();
