// Stands in for the server's launcher: says it is ready, then ends as told by FAKE_MODE.
const port = process.argv[process.argv.indexOf("--port") + 1];
console.log(`MoonAgentic est prêt : http://127.0.0.1:${port}/#token=abc`);
if (process.env.FAKE_MODE === "crash") setTimeout(() => process.exit(1), 50);
else setInterval(() => undefined, 1_000);
// Stops when the app closes its channel, like the real launcher, a moment later.
if (process.send) process.once("disconnect", () => setTimeout(() => process.exit(0), 100));
process.on("SIGTERM", () => {
  console.log("arrêt");
  process.exit(0);
});
