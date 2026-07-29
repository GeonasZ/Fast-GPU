const net = require("node:net");

function parseWindowsListeningPids(output, port) {
  const pids = new Set();
  const portPattern = new RegExp(`:${Number(port)}\\s`);
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/LISTENING\s+(\d+)\s*$/);
    if (portPattern.test(line) && match) pids.add(Number(match[1]));
  }
  return [...pids];
}

function canBindPort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function waitForPortAvailable(port, options = {}) {
  const host = options.host || "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 100;
  const canBind = options.canBind || canBindPort;
  const deadline = Date.now() + timeoutMs;
  do {
    if (await canBind(port, host)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

module.exports = { canBindPort, parseWindowsListeningPids, waitForPortAvailable };
