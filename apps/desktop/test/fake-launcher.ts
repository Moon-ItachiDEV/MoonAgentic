// Stands in for the server's launcher: says it is ready, then ends as told by FAKE_MODE.
import { spawn } from "node:child_process";

const port = process.argv[process.argv.indexOf("--port") + 1];
const CANNOT =
  "MoonAgentic ne peut pas démarrer : sa base de données est abîmée (database disk image is malformed). Ferme MoonAgentic, puis remplace x par la sauvegarde y.";
if (process.env.FAKE_MODE === "already") {
  console.error("MoonAgentic tourne déjà sur ce dossier de données (/tmp/x).");
  process.exit(3);
}
if (process.env.FAKE_MODE === "cannot") {
  console.error(CANNOT);
  process.exit(4);
}
if (process.env.FAKE_MODE === "cannot-late") {
  // The launcher is gone before its line is read: something else still holds its output and
  // writes the line a moment later, as a pipe read after the exit would bring it.
  spawn(
    process.execPath,
    ["-e", `setTimeout(() => console.error(${JSON.stringify(CANNOT)}), 300)`],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  process.exit(4);
}
if (process.env.FAKE_MODE === "cannot-unended") {
  // The line without its end of line: the stream's end is what completes it.
  process.stderr.write(CANNOT, () => process.exit(4));
  setInterval(() => undefined, 1_000);
} else if (process.env.FAKE_MODE === "port") {
  // What the server says, then what its supervisor says after it.
  console.error("Le port 4999 est déjà pris (EADDRINUSE) : un autre programme l'utilise.");
  console.error("Le serveur s'est arrêté sur une erreur (code 1) : il redémarre dans 1 s.");
  setInterval(() => undefined, 1_000);
} else if (process.env.FAKE_MODE === "split") {
  // The line in two reads, cut in the middle of the « ê » of « prêt ».
  const line = Buffer.from(`MoonAgentic est prêt : http://127.0.0.1:${port}/#token=abc\r\n`);
  const cut = line.indexOf(Buffer.from("ê")) + 1;
  process.stdout.write(line.subarray(0, cut));
  setTimeout(() => process.stdout.write(line.subarray(cut)), 100);
} else console.log(`MoonAgentic est prêt : http://127.0.0.1:${port}/#token=abc`);
if (process.env.FAKE_MODE === "crash") setTimeout(() => process.exit(1), 50);
else if (process.env.FAKE_MODE !== "port") setInterval(() => undefined, 1_000);
// Stops when the app closes its channel, like the real launcher, a moment later.
if (process.env.FAKE_MODE === "lingering") {
  // Closes its channel itself: only the signal ends it, and the app's close comes late.
  process.disconnect?.();
} else if (process.send) process.once("disconnect", () => setTimeout(() => process.exit(0), 100));
process.on("SIGTERM", () => {
  console.log("arrêt");
  // Its output stays open a moment after it is gone, held by something it started.
  if (process.env.FAKE_MODE === "lingering") {
    spawn(process.execPath, ["-e", "setTimeout(() => undefined, 300)"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  process.exit(0);
});
