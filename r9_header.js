/* r10_d header behaviour. Folded into script.js at the end. */

/* ===== EMAIL (r10_d) =====
   Click / Enter / Space on the address copies it. A short confirmation shows under the address and is
   announced through the same element (role=status). The address itself is filled in by the inline
   script next to the markup in index.html; this file only copies what is shown.
   To swap the treatment later, replace this block, the EMAIL block in r9_header.css and the
   EMAIL markup in index.html. */
document.addEventListener("DOMContentLoaded", function () {
  var btn = document.querySelector(".email-copy");
  if (!btn) return;
  var textEl = btn.querySelector(".email-text");
  var statusEl = document.getElementById("email-status");
  var timer = null;

  function say(msg, ok) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle("is-error", !ok);
    btn.classList.toggle("is-copied", !!ok);
    clearTimeout(timer);
    timer = setTimeout(function () {
      statusEl.textContent = "";
      btn.classList.remove("is-copied");
    }, 1600);
  }

  // button activation covers click, Enter and Space
  btn.addEventListener("click", function () {
    var addr = textEl.textContent.trim();
    if (addr.indexOf("@") < 0) return;
    if (!navigator.clipboard || !window.isSecureContext) {
      say("Copy unavailable: " + addr, false);
      return;
    }
    navigator.clipboard.writeText(addr).then(
      function () { say("Copied", true); },
      function () { say("Copy failed: " + addr, false); }
    );
  });
});
/* ===== /EMAIL ===== */
