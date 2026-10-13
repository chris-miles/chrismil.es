/* r9 papers polish: behaviour for this aspect only. Folded into script.js at the end.

   Interface for other sections (the filter itself lives in script.js, "r8: papers filter"):

   1. Markup: any <a class="theme-link" data-theme="THEME"> anywhere on the page. A click is caught
      by one capture-phase listener on document (so the link can be re-rendered or moved), which
      filters Papers to THEME, clears type/search, scrolls to #publications and sets the hash.
   2. Script: window.showPapersByTheme(THEME[, { scroll: false }]) does the same; pass "" to clear.

   THEME is one of: spatial-genomics, cytoskeleton, sciml (the values in each .pub's data-themes).
   Rows are #pub-list .pub[data-themes] and stay in the DOM when hidden, so counting them is safe.

   This file has no behaviour of its own at the moment; the link icons, key and Scholar link are
   static markup (gen.js pubs + index.html) styled in r9_papers.css. */
