// Entry point for cPanel / Phusion Passenger, which loads the startup file with
// require(). The app itself is an ES module, so load it with a dynamic import.
import('./src/server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
