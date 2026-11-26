// Stands in for the server's launcher: says it is ready, then ends as told by FAKE_MODE.
const port = process.argv[process.argv.indexOf("--port") + 1];
if (process.env.FAKE_MODE === "already") {
  console.error("MoonAgentic tourne déjà sur ce dossier de données (/tmp/x).");
  process.exit(3);
}
if (process.env.FAKE_MODE === "cannot") {
  console.error(
    "MoonAgentic ne peut pas démarrer : sa base de données est abîmée (database disk image is malformed). Ferme MoonAgentic, puis remplace x par la sauvegarde y.",
  );
  process.exit(4);
}
if (process.env.FAKE_MODE === "port") {
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
if (process.send) process.once("disconnect", () => setTimeout(() => process.exit(0), 100));
process.on("SIGTERM", () => {
  console.log("arrêt");
  process.exit(0);
});
