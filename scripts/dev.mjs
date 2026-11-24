/**
 * Starts the development server behind a tunnel this script looks after.
 *
 *   npm run dev                  # the app, with a tunnel that is kept alive
 *   npm run dev -- --reset       # anything after -- goes to `shopify app dev`
 *   npm run dev:tunnel-check     # only checks that a tunnel can be opened
 *   npm run dev:plain            # `shopify app dev` on its own, as before
 *
 * Why not just `shopify app dev`? It opens a Cloudflare quick tunnel itself,
 * and that goes wrong in two ways that both end with the storefront chat
 * saying "something went wrong" while the dev server looks healthy:
 *
 *  - Asking Cloudflare for a tunnel can take longer than cloudflared waits.
 *    The CLI then tries again, but a 40 second timer from the failed attempt
 *    is left running, and when it fires it stops the tunnel that did connect
 *    (seen with @shopify/cli 5.0.2). The address stays registered with
 *    Shopify and nothing answers on it.
 *  - A quick tunnel that dies later (the laptop slept, the network changed)
 *    is never opened again.
 *
 * So the tunnel is opened here, retried until it is connected, and handed to
 * the CLI with --tunnel-url. It is then watched: when it stops answering,
 * a new one is opened and `shopify app dev` is started again on it, which
 * also gives Shopify the new address.
 *
 * Quick tunnels are for development only. A deployed app has a fixed address
 * and needs none of this.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

const ROOT = process.cwd();
const CLOUDFLARED =
  process.env.SHOPIFY_CLI_CLOUDFLARED_PATH ??
  join(
    ROOT,
    "node_modules/@shopify/cli/bin",
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
const SHOPIFY = join(ROOT, "node_modules/.bin", process.platform === "win32" ? "shopify.cmd" : "shopify");

/** How long one attempt may take to get an address and connect. */
const CONNECT_TIMEOUT_MS = 60_000;
/** How often the tunnel is checked once the app is running. */
const CHECK_EVERY_MS = 30_000;
/** This many failed checks in a row and the tunnel is replaced. */
const CHECKS_BEFORE_RESTART = 3;
/** cloudflared reconnects by itself; this long without a connection and it is replaced. */
const DISCONNECTED_LIMIT_MS = 90_000;

const say = (text) => console.log(`\n[tunnel] ${text}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * One attempt at a quick tunnel to `port`. Resolves with the public address
 * once cloudflared has both been given one and connected, or with null when
 * the attempt failed (it is stopped first).
 */
function openTunnel(port) {
  return new Promise((resolve) => {
    const child = spawn(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let url = null;
    let registered = false;
    let settled = false;
    let reason = "";
    // Kept up to date for as long as cloudflared runs: is it connected, and since when.
    const link = { connected: false, since: Date.now() };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result) child.kill("SIGTERM");
      resolve(result ? { url, child, link } : { url: null, child: null, reason });
    };
    const timer = setTimeout(() => {
      reason = "it did not connect in time";
      finish(false);
    }, CONNECT_TIMEOUT_MS);

    const read = (chunk) => {
      const text = chunk.toString();
      url ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
      if (/Registered tunnel connection/.test(text)) {
        registered = true;
        link.connected = true;
        link.since = Date.now();
      } else if (/Connection terminated|Unregistered tunnel connection|no more connections active/.test(text)) {
        if (link.connected) link.since = Date.now();
        link.connected = false;
      }
      const failed = /failed to request quick Tunnel|failed to unmarshal quick Tunnel|ERR Couldn't start tunnel/.exec(text);
      if (failed) reason = "Cloudflare did not hand out an address";
      if (url && registered) finish(true);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (error) => {
      reason = `cloudflared could not be started (${error.code ?? error.message})`;
      finish(false);
    });
    child.once("exit", () => {
      reason ||= "cloudflared stopped";
      finish(false);
    });
  });
}

/** Keeps trying until a tunnel is connected. Null when asked to stop meanwhile. */
async function connectedTunnel(port, isStopping) {
  for (let attempt = 1; !isStopping(); attempt += 1) {
    const tunnel = await openTunnel(port);
    if (tunnel.url) return tunnel;
    say(`No tunnel yet: ${tunnel.reason}. Trying again (attempt ${attempt + 1})…`);
    await wait(Math.min(15_000, 2_000 * attempt));
  }
  return null;
}

/**
 * What the tunnel's address answers with. "down" is Cloudflare saying no
 * tunnel is connected there; an error reaching Cloudflare at all is
 * "unknown" (this machine may simply be offline for a moment).
 */
async function tunnelState(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return response.status === 530 ? "down" : "up";
  } catch {
    return "unknown";
  }
}

function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill(signal);
    // The CLI can take a moment to shut its servers; do not wait for ever.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 8_000).unref();
  });
}

/** Opens a tunnel to a throwaway server and checks a request comes through it. */
async function checkTunnel() {
  const token = `shopi-assist-${Date.now()}`;
  const server = createServer((_request, response) => response.end(token));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  say("Opening a test tunnel…");
  const tunnel = await connectedTunnel(port, () => false);
  say(`Connected: ${tunnel.url}. Sending a request through it…`);
  // A new address takes a moment to be known everywhere, so keep trying for a minute.
  let reached = false;
  let last = "";
  for (let attempt = 0; attempt < 20 && !reached; attempt += 1) {
    try {
      const response = await fetch(tunnel.url, { signal: AbortSignal.timeout(10_000) });
      reached = (await response.text()) === token;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error?.cause?.code ?? error?.name ?? "error";
    }
    if (!reached) await wait(3_000);
  }
  await stop(tunnel.child);
  server.close();
  if (reached) say("The tunnel works: a request came through it.");
  else if (last === "ENOTFOUND") {
    // The tunnel connected; only this machine's DNS has not learnt the new
    // address yet. Shopify looks it up for itself.
    say("The tunnel connected. This machine could not look its new address up yet, so the request through it was not tried.");
  } else say(`A tunnel opened, but no request came through it (${last}).`);
  process.exit(reached ? 0 : last === "ENOTFOUND" ? 2 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--tunnel-check")) return checkTunnel();
  if (!existsSync(CLOUDFLARED)) {
    say("cloudflared is not installed with the Shopify CLI here. Starting `shopify app dev` on its own.");
    args.push("--plain");
  }
  // Someone who brings their own networking gets the CLI as it is.
  const own = args.some((arg) => /^--(tunnel-url|use-localhost|plain)\b/.test(arg));
  if (own) {
    const plain = spawn(SHOPIFY, ["app", "dev", ...args.filter((arg) => arg !== "--plain")], { stdio: "inherit" });
    plain.once("exit", (code) => process.exit(code ?? 0));
    return undefined;
  }

  let stopping = false;
  let tunnel = null;
  let app = null;
  const shutDown = async () => {
    if (stopping) return;
    stopping = true;
    await stop(app, "SIGINT");
    await stop(tunnel?.child);
    process.exit(0);
  };
  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);
  process.on("SIGHUP", shutDown);
  // Whatever way this ends, the tunnel does not outlive it.
  process.on("exit", () => tunnel?.child?.kill());

  while (!stopping) {
    const port = await freePort();
    say("Opening a tunnel…");
    tunnel = await connectedTunnel(port, () => stopping);
    if (!tunnel) break;
    say(`Connected: ${tunnel.url}`);

    let tunnelGone = false;
    tunnel.child.once("exit", () => {
      tunnelGone = true;
    });
    app = spawn(SHOPIFY, ["app", "dev", "--tunnel-url", `${tunnel.url}:${port}`, ...args], {
      stdio: "inherit",
    });
    let appExit = null;
    app.once("exit", (code) => {
      appExit = code ?? 0;
    });

    // Watch both until the app is closed or the tunnel has to be replaced.
    let failures = 0;
    let lastCheck = Date.now();
    const disconnected = () =>
      !tunnel.link.connected && Date.now() - tunnel.link.since > DISCONNECTED_LIMIT_MS;
    while (
      !stopping &&
      appExit === null &&
      !tunnelGone &&
      !disconnected() &&
      failures < CHECKS_BEFORE_RESTART
    ) {
      await wait(1_000);
      if (Date.now() - lastCheck < CHECK_EVERY_MS) continue;
      lastCheck = Date.now();
      const state = await tunnelState(tunnel.url);
      failures = state === "down" ? failures + 1 : state === "up" ? 0 : failures;
    }
    if (stopping) break;
    if (appExit !== null) {
      // Closed from inside (q, Ctrl+C) or it failed: nothing to keep alive.
      await stop(tunnel.child);
      process.exit(appExit);
    }

    say("The tunnel stopped answering. Opening a new one and starting the dev server again…");
    await stop(app, "SIGINT");
    await stop(tunnel.child);
  }
  return undefined;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
