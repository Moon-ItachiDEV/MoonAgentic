// Runs before the app, as a plain script any browser reads. Without it, a page whose code
// or styles fail to load stays white with no word: an iPhone app on the home screen, which
// may keep a page from an older build, then asks for files the server no longer has.
// A file that fails is fetched again once; then the screen in #root says what failed.
(function () {
  var KEY = "moonagentic.boot.reloaded";
  var failures = [];

  function show(message) {
    var box = document.getElementById("boot");
    if (!box) return; // the app is already shown: it reports its own errors
    box.className = "boot failed";
    var why = document.getElementById("boot-why");
    if (why && message) why.textContent = message;
  }

  function reloadOnce() {
    try {
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60000) return false;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (e) {
      return false; // no storage: no way to know it was tried, so it is not
    }
    location.reload();
    return true;
  }

  window.addEventListener(
    "error",
    function (event) {
      // Once the app is shown, it handles its own failures: a lazy part that fails to load
      // must not reload the page under the user's feet.
      if (!document.getElementById("boot")) return;
      var target = event.target;
      // A script or style sheet of the app that did not arrive. An icon or the manifest
      // that fails is no reason to reload.
      var rel = target && target.tagName === "LINK" ? String(target.rel) : "";
      if (
        target &&
        target !== window &&
        (target.tagName === "SCRIPT" || rel === "stylesheet" || rel === "modulepreload")
      ) {
        var file = target.src || target.href || "";
        failures.push(file);
        if (!reloadOnce()) show("Fichier non chargé : " + file.replace(location.origin, ""));
        return;
      }
      show(event.message || (event.error && event.error.message) || "Erreur inconnue");
    },
    true,
  );

  window.addEventListener("unhandledrejection", function (event) {
    if (!document.getElementById("boot")) return;
    var reason = event.reason;
    show((reason && reason.message) || String(reason));
  });

  // « Recharger » keeps the address as it is, a pairing code or an open thread included;
  // its plain link to / is only for a browser where this script did not run.
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("#boot-reload") : null;
    if (!link) return;
    event.preventDefault();
    location.reload();
  });

  window.__moonagenticBoot = { failures: failures };
})();
