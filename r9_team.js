/* r9 team polish: behaviour for this aspect only. Folded into script.js at the end. */
(function () {
  "use strict";
  var group = document.getElementById("group");
  if (!group) return;

  // Easter-egg popovers are centred over their glyph; nudge one sideways (--dx) if it would
  // leave the viewport (phones, narrow columns). Measured on show, so no layout work on scroll.
  var PAD = 10;
  function place(egg) {
    var pop = egg.querySelector(".egg-pop");
    if (!pop) return;
    pop.style.setProperty("--dx", "0px");
    var r = pop.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var dx = 0;
    if (r.left < PAD) dx = PAD - r.left;
    else if (r.right > vw - PAD) dx = vw - PAD - r.right;
    if (dx) pop.style.setProperty("--dx", Math.round(dx) + "px");
  }
  group.querySelectorAll(".egg").forEach(function (egg) {
    egg.addEventListener("mouseenter", function () { place(egg); });
    egg.addEventListener("focus", function () { place(egg); });
  });
})();
