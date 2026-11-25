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
      var target = event.target;
      // A script or style sheet of the app that did not arrive.
      if (
        target &&
        target !== window &&
        (target.tagName === "SCRIPT" || target.tagName === "LINK")
      ) {
        var file = target.src || target.href || "";
        failures.push(file);
        if (!reloadOnce()) show("Fichier non chargé : " + file.replace(location.origin, ""));
        return;
      }
      if (document.getElementById("boot")) {
        show(event.message || (event.error && event.error.message) || "Erreur inconnue");
      }
    },
    true,
  );

  window.addEventListener("unhandledrejection", function (event) {
    if (!document.getElementById("boot")) return;
    var reason = event.reason;
    show((reason && reason.message) || String(reason));
  });

  window.__moonagenticBoot = { failures: failures };
})();
