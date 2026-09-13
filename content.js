(function () {
  "use strict";

  // ---------- state ----------
  let problemsData = null;       // slug -> {title, difficulty, companies}
  let titleIndex = null;         // normalizedTitle -> slug
  let slugIndex = null;          // normalizedSlug -> slug (our dataset's own slug, normalized)
  let currentMatchKey = null;    // last matched slug, to avoid re-render churn
  let collapsed = false;
  let panelEl = null;
  let retryTimer = null;

  // ---------- helpers ----------
  function normalize(str) {
    return (str || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "");
  }

  function buildIndexes() {
    titleIndex = new Map();
    slugIndex = new Map();
    for (const slug in problemsData) {
      const entry = problemsData[slug];
      const nt = normalize(entry.title);
      if (nt && !titleIndex.has(nt)) titleIndex.set(nt, slug);
      const ns = normalize(slug);
      if (ns && !slugIndex.has(ns)) slugIndex.set(ns, slug);
    }
  }

  async function loadData() {
    if (problemsData) return;
    const url = chrome.runtime.getURL("data/problems.json");
    const res = await fetch(url);
    problemsData = await res.json();
    buildIndexes();
  }

  // ---------- detection ----------
  function candidateTitlesFromDom() {
    const candidates = [];

    // document.title, e.g. "Alien Dictionary - NeetCode" or "NeetCode - Alien Dictionary"
    if (document.title) {
      const parts = document.title.split(/[-|•]/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p.toLowerCase() !== "neetcode") candidates.push(p);
      }
    }

    // h1 elements anywhere reasonably near the top of the page
    document.querySelectorAll("h1").forEach((el) => {
      const t = el.textContent && el.textContent.trim();
      if (t && t.length < 100) candidates.push(t);
    });

    // common heading-ish class patterns as a fallback
    document.querySelectorAll('[class*="title" i], [class*="Title"]').forEach((el) => {
      const t = el.textContent && el.textContent.trim();
      if (t && t.length > 0 && t.length < 100) candidates.push(t);
    });

    return candidates;
  }

  function slugFromUrl() {
    const m = location.pathname.match(/\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  function detectProblem() {
    if (!problemsData) return null;

    // 1) try matching visible titles/headings
    const candidates = candidateTitlesFromDom();
    for (const c of candidates) {
      const key = titleIndex.get(normalize(c));
      if (key) return key;
    }

    // 2) try matching the URL slug directly against our dataset's slugs
    const urlSlug = slugFromUrl();
    if (urlSlug) {
      const key = slugIndex.get(normalize(urlSlug));
      if (key) return key;
    }

    return null;
  }

  // ---------- UI ----------
  function ensurePanel() {
    if (panelEl) return panelEl;

    panelEl = document.createElement("div");
    panelEl.id = "nct-panel";
    panelEl.innerHTML = `
      <div id="nct-header">
        <div id="nct-title"><span class="nct-dot nct-dot-off"></span>Company Tags</div>
        <div id="nct-toggle">—</div>
      </div>
      <div id="nct-body">
        <div id="nct-loading">Loading company data…</div>
      </div>
    `;
    document.documentElement.appendChild(panelEl);

    panelEl.querySelector("#nct-header").addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      collapsed = !collapsed;
      applyCollapsed();
      try {
        chrome.storage.local.set({ nctCollapsed: collapsed });
      } catch (e) {}
    });

    try {
      chrome.storage.local.get(["nctCollapsed", "nctPos"], (res) => {
        collapsed = !!res.nctCollapsed;
        applyCollapsed();
        if (res.nctPos && typeof res.nctPos.left === "number") {
          applyPosition(res.nctPos.left, res.nctPos.top);
        }
      });
    } catch (e) {}

    makeDraggable(panelEl);

    return panelEl;
  }

  function applyPosition(left, top) {
    const maxLeft = window.innerWidth - panelEl.offsetWidth - 4;
    const maxTop = window.innerHeight - 44;
    left = Math.min(Math.max(4, left), Math.max(4, maxLeft));
    top = Math.min(Math.max(4, top), Math.max(4, maxTop));
    panelEl.style.left = left + "px";
    panelEl.style.top = top + "px";
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  }

  let suppressNextClick = false;

  function makeDraggable(panel) {
    const header = panel.querySelector("#nct-header");
    header.style.cursor = "grab";

    let dragging = false;
    let moved = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener("mousedown", (e) => {
      dragging = true;
      moved = false;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = startLeft + "px";
      panel.style.top = startTop + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      header.style.cursor = "grabbing";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      applyPosition(startLeft + dx, startTop + dy);
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      header.style.cursor = "grab";
      if (moved) {
        suppressNextClick = true;
        try {
          chrome.storage.local.set({
            nctPos: { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) },
          });
        } catch (e) {}
      }
    });
  }

  function applyCollapsed() {
    if (!panelEl) return;
    panelEl.classList.toggle("nct-collapsed", collapsed);
    panelEl.querySelector("#nct-toggle").textContent = collapsed ? "▸" : "▾";
  }

  function diffClass(diff) {
    const d = (diff || "").toLowerCase();
    if (d.startsWith("e")) return "nct-diff-easy";
    if (d.startsWith("m")) return "nct-diff-medium";
    if (d.startsWith("h")) return "nct-diff-hard";
    return "";
  }

  function renderMatch(slug) {
    const entry = problemsData[slug];
    const body = panelEl.querySelector("#nct-body");
    const dot = panelEl.querySelector(".nct-dot");
    dot.classList.remove("nct-dot-off");

    const chips = entry.companies
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((c) => `<span class="nct-chip">${escapeHtml(c)}</span>`)
      .join("");

    body.innerHTML = `
      <div id="nct-problem-title">${escapeHtml(entry.title)}</div>
      ${entry.difficulty ? `<span id="nct-difficulty" class="${diffClass(entry.difficulty)}">${escapeHtml(cap(entry.difficulty))}</span>` : ""}
      <div id="nct-company-count">Asked by ${entry.companies.length} compan${entry.companies.length === 1 ? "y" : "ies"} (per community tag data)</div>
      <div id="nct-companies">${chips}</div>
      ${footerHtml()}
    `;
  }

  function renderEmpty(reason) {
    const body = panelEl.querySelector("#nct-body");
    const dot = panelEl.querySelector(".nct-dot");
    dot.classList.add("nct-dot-off");
    body.innerHTML = `
      <div id="nct-empty">${escapeHtml(reason)}</div>
      ${searchFallbackHtml()}
      ${footerHtml()}
    `;
    wireSearchFallback();
  }

  function footerHtml() {
    return `<div id="nct-footer">Company tags sourced from a community-maintained LeetCode dataset. Coverage is not exhaustive.</div>`;
  }

  function searchFallbackHtml() {
    return `
      <div id="nct-search-fallback">
        <input id="nct-search-input" type="text" placeholder="Search problem manually…" />
        <div id="nct-search-results"></div>
      </div>
    `;
  }

  function wireSearchFallback() {
    const input = panelEl.querySelector("#nct-search-input");
    const results = panelEl.querySelector("#nct-search-results");
    if (!input) return;
    input.addEventListener("input", () => {
      const q = normalize(input.value);
      results.innerHTML = "";
      if (q.length < 2) return;
      let count = 0;
      for (const [nt, slug] of titleIndex.entries()) {
        if (nt.includes(q)) {
          const entry = problemsData[slug];
          const div = document.createElement("div");
          div.className = "nct-search-result";
          div.textContent = `${entry.title} (${entry.companies.length})`;
          div.addEventListener("click", () => {
            currentMatchKey = slug;
            renderMatch(slug);
          });
          results.appendChild(div);
          count++;
          if (count >= 15) break;
        }
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  // ---------- orchestration ----------
  function isOnProblemPage() {
    return /\/problems\/[^/]+/.test(location.pathname);
  }

  async function tick() {
    if (!isOnProblemPage()) {
      if (panelEl) panelEl.style.display = "none";
      return;
    }
    ensurePanel();
    panelEl.style.display = "";

    await loadData();
    const match = detectProblem();

    if (match) {
      if (match !== currentMatchKey) {
        currentMatchKey = match;
        renderMatch(match);
      }
      return true;
    } else {
      if (currentMatchKey !== null) {
        currentMatchKey = null;
        renderEmpty("Couldn't auto-match this problem to a company-tag entry yet.");
      } else if (panelEl.querySelector("#nct-loading")) {
        renderEmpty("Couldn't auto-match this problem to a company-tag entry.");
      }
      return false;
    }
  }

  function scheduleRetries() {
    clearTimeout(retryTimer);
    let attempts = 0;
    const delays = [200, 500, 1000, 2000, 3500];
    const step = async () => {
      const ok = await tick();
      attempts++;
      if (!ok && attempts < delays.length) {
        retryTimer = setTimeout(step, delays[attempts]);
      }
    };
    retryTimer = setTimeout(step, delays[0]);
  }

  function watchNavigation() {
    let lastPath = location.pathname;
    const check = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        currentMatchKey = null;
        scheduleRetries();
      }
    };

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      check();
    };
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      check();
    };
    window.addEventListener("popstate", check);

    // Fallback: SPA content mutations (covers client routers that don't touch history API in a way we catch)
    const observer = new MutationObserver(() => check());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- init ----------
  loadData().finally(() => {
    scheduleRetries();
    watchNavigation();
  });
})();
