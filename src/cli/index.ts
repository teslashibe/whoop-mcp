#!/usr/bin/env node
// whoop-mcp CLI — the single entry point for everything (build/dev/test/auth/
// deploy/inspect); package.json has no `scripts`. Runs from anywhere on the
// system (after `npm link` or global install).
//
// Architecture:
//   - Single-file CLI dispatcher.
//   - `ROOT` is the package root, resolved from `import.meta.url` so the CLI
//     always operates on its install dir regardless of cwd.
//   - Commands that wrap dev tooling spawn the local node_modules/.bin binaries
//     (tsx, vitest, tsc) so a `npm link`-ed install picks up the right versions.
//   - Commands that wrap Fly assume `fly` is on the system PATH.
//   - Banner uses 24-bit truecolor ANSI escapes (RGB); honors NO_COLOR and
//     skips colors if stdout is not a TTY.

import { spawn, type SpawnOptions } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { runCloudSetup, runLocalSetup } from "./setup.js";
import { runScript } from "./ui.js";

// ── locate package root ──────────────────────────────────────────────────
// This file lives at one of:
//   <root>/dist/cli/index.js    (compiled, normal install)
//   <root>/src/cli/index.ts     (dev, via tsx)
// Both are 2 dirs deep from the package root.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PKG_PATH = resolve(ROOT, "package.json");
const PKG = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
  name: string;
  version: string;
};
const VERSION = PKG.version;

// ── color helpers ────────────────────────────────────────────────────────
// Whoop branding is mono (black/white). Banner uses a light-gray block text
// and a slightly dimmer gray for the pulse waveform. Truecolor (24-bit) —
// supported by every modern terminal (Terminal.app, iTerm2, Warp, kitty,
// alacritty, VS Code integrated terminal). Red/green retained for status
// semantics (✓ / ✗).
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  brand: "\x1b[38;2;225;225;225m",     // light gray — block text + accents
  brandDim: "\x1b[38;2;150;150;150m",  // medium gray — pulse waveform
  gray: "\x1b[38;2;120;120;120m",
  white: "\x1b[97m",
  green: "\x1b[92m",
  red: "\x1b[91m",
};
function wrap(code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}
const c = {
  brand: (s: string) => wrap(ANSI.brand, s),
  brandDim: (s: string) => wrap(ANSI.brandDim, s),
  gray: (s: string) => wrap(ANSI.gray, s),
  white: (s: string) => wrap(ANSI.white, s),
  green: (s: string) => wrap(ANSI.green, s),
  red: (s: string) => wrap(ANSI.red, s),
  bold: (s: string) => wrap(ANSI.bold, s),
  dim: (s: string) => wrap(ANSI.dim, s),
};

// ── banner ───────────────────────────────────────────────────────────────
// The banner prints on EVERY command, at the very top — but to STDERR, so it
// shows in the terminal without ever touching stdout. That keeps the MCP
// protocol stream clean on `start`/`dev`, the parseable output clean on
// `version`/`config`, and every command safe to pipe. Color is decided from
// stderr's TTY (not stdout's) since that's where it's written.
function printBanner(): void {
  const color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
  const w = (code: string, s: string): string => (color ? `${code}${s}${ANSI.reset}` : s);
  const lines = [
    "",
    w(ANSI.brand, "   ██╗    ██╗██╗  ██╗ ██████╗  ██████╗ ██████╗     ███╗   ███╗ ██████╗██████╗ "),
    w(ANSI.brand, "   ██║    ██║██║  ██║██╔═══██╗██╔═══██╗██╔══██╗    ████╗ ████║██╔════╝██╔══██╗"),
    w(ANSI.brand, "   ██║ █╗ ██║███████║██║   ██║██║   ██║██████╔╝    ██╔████╔██║██║     ██████╔╝"),
    w(ANSI.brand, "   ██║███╗██║██╔══██║██║   ██║██║   ██║██╔═══╝     ██║╚██╔╝██║██║     ██╔═══╝ "),
    w(ANSI.brand, "   ╚███╔███╔╝██║  ██║╚██████╔╝╚██████╔╝██║         ██║ ╚═╝ ██║╚██████╗██║     "),
    w(ANSI.brand, "    ╚══╝╚══╝ ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝         ╚═╝     ╚═╝ ╚═════╝╚═╝     "),
    "",
    w(ANSI.brandDim, "   ▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁"),
    "",
    `   ${w(ANSI.bold, "v" + VERSION)}  ${w(ANSI.gray, "·")}  ${w(ANSI.white, "48 tools")}  ${w(ANSI.gray, "·")}  ${w(ANSI.white, "47 microservices")}  ${w(ANSI.gray, "·")}  ${w(ANSI.white, "311 endpoints")}`,
    "",
  ];
  for (const line of lines) console.error(line);
}

// ── command registry ─────────────────────────────────────────────────────
interface Cmd {
  group: "Get started" | "Local" | "Setup" | "Deployed" | "Inspect" | "Help";
  desc: string;
  usage?: string;
  run: (args: string[]) => Promise<number>;
}

const GROUP_ORDER: Cmd["group"][] = ["Get started", "Setup", "Deployed", "Local", "Inspect", "Help"];

const commands: Record<string, Cmd> = {
  // ── Get started (headline) ─────────────────────────────────────────────
  cloud: {
    group: "Get started",
    desc: "★ Recommended. Guided deploy to a host (Fly/Railway/Cloud Run/custom) + connect to Claude web/mobile via OAuth, in one command.",
    run: async () => runCloudSetup(ROOT),
  },
  local: {
    group: "Get started",
    desc: "Guided setup to run the MCP on this machine (stdio) and wire it into Claude Desktop / Claude Code.",
    run: async () => runLocalSetup(ROOT),
  },

  // ── Local ────────────────────────────────────────────────────────────
  start: {
    group: "Local",
    desc: "Start the MCP server (stdio by default; --http for HTTP mode)",
    usage: "whoop-mcp start [--http]",
    run: async (args) => {
      const isHttp = args.includes("--http");
      const serverJs = resolve(ROOT, "dist", "server.js");
      if (!existsSync(serverJs)) {
        console.error(c.red("dist/server.js not found.") + " Run " + c.bold("whoop-mcp build") + " first.");
        return 1;
      }
      const env = { ...process.env, MCP_TRANSPORT: isHttp ? "http" : "stdio" };
      return run(process.execPath, [serverJs], { env });
    },
  },
  dev: {
    group: "Local",
    desc: "Run the server in dev mode (tsx source if available, else built dist)",
    run: async () => runScript(ROOT, "server", [], { preferSource: true }),
  },
  "dev:http": {
    group: "Local",
    desc: "Run the server in dev mode, HTTP transport",
    run: async () => {
      const env = { ...process.env, MCP_TRANSPORT: "http" };
      return runScript(ROOT, "server", [], { preferSource: true, env });
    },
  },
  build: {
    group: "Local",
    desc: "Compile TypeScript to dist/",
    run: async () => run(npmBin("tsc"), []),
  },
  test: {
    group: "Local",
    desc: "Run the test suite (vitest)",
    usage: "whoop-mcp test [test-filter]",
    run: async (args) => run(npmBin("vitest"), ["run", ...args]),
  },
  typecheck: {
    group: "Local",
    desc: "Run `tsc --noEmit`",
    run: async () => run(npmBin("tsc"), ["--noEmit"]),
  },

  // ── Setup ────────────────────────────────────────────────────────────
  auth: {
    group: "Setup",
    desc: "Log into Whoop + save tokens. Auto-detects first-time vs re-auth and local vs deployed — pushes new tokens to your deployment (Fly/Railway/Cloud Run/custom) when there is one. Run it for setup or when the ~30-day token expires",
    usage: "whoop-mcp auth [--app <fly-app>]",
    run: async (args) => runScript(ROOT, "scripts/cognito_bootstrap", args),
  },

  // ── Deployed ─────────────────────────────────────────────────────────
  deploy: {
    group: "Deployed",
    desc: "Re-deploy the current code to your existing deployment (Fly/Railway/Cloud Run)",
    usage: "whoop-mcp deploy [-- <extra args>]",
    run: async (args) => {
      const d = detectDeploy();
      if (!d) { console.error(c.red("No deployment found. Run `whoop-mcp cloud` to set one up.")); return 1; }
      switch (d.platform) {
        case "fly":
          return run("fly", ["deploy", ...(d.app ? ["-a", d.app] : []), ...args]);
        case "railway":
          if (d.app) await run("railway", ["link", "--project", d.app]);
          return run("railway", ["up", ...args]);
        case "cloudrun": {
          const region = d.region ?? "us-west1";
          return run("gcloud", ["run", "deploy", d.app!, "--source", ".", "--region", region, "--min-instances", "1",
            ...(d.project ? ["--project", d.project] : []), "--quiet", ...args]);
        }
        case "custom":
          console.log(c.gray("Custom host — rebuild + restart your container yourself (see `whoop-mcp cloud` → Custom)."));
          return 0;
        default:
          console.log(c.gray(`'${d.platform}' has no remote to deploy to.`));
          return 0;
      }
    },
  },
  logs: {
    group: "Deployed",
    desc: "Tail logs from your deployment (Fly/Railway/Cloud Run)",
    usage: "whoop-mcp logs [-- <extra args>]",
    run: async (args) => {
      const d = detectDeploy();
      if (!d) { console.error(c.red("No deployment found. Run `whoop-mcp cloud` first.")); return 1; }
      switch (d.platform) {
        case "fly":
          return run("fly", ["logs", ...(d.app ? ["-a", d.app] : []), ...args]);
        case "railway":
          if (d.app) await run("railway", ["link", "--project", d.app]);
          return run("railway", ["logs", ...args]);
        case "cloudrun": {
          const region = d.region ?? "us-west1";
          return run("gcloud", ["run", "services", "logs", "read", d.app!, "--region", region,
            ...(d.project ? ["--project", d.project] : []), ...args]);
        }
        default:
          console.log(c.gray(`Logs for a ${d.platform} deployment live on your own host — check its dashboard.`));
          return 0;
      }
    },
  },
  status: {
    group: "Deployed",
    desc: "Show your deployment's status + ping /health",
    run: async () => {
      const d = detectDeploy();
      if (!d) { console.error(c.red("No deployment found. Run `whoop-mcp cloud` first.")); return 1; }
      console.log(`  ${c.gray("platform")}  ${c.bold(d.platform)}${d.app ? `  ${c.gray("·")}  ${d.app}` : ""}`);
      if (d.url) console.log(`  ${c.gray("url     ")}  ${d.url}`);
      console.log("");
      switch (d.platform) {
        case "fly":
          if (d.app) { console.log(c.gray(`→ fly status -a ${d.app}`)); await run("fly", ["status", "-a", d.app]); }
          break;
        case "railway":
          if (d.app) await run("railway", ["link", "--project", d.app]);
          console.log(c.gray("→ railway status")); await run("railway", ["status"]);
          break;
        case "cloudrun": {
          const region = d.region ?? "us-west1";
          console.log(c.gray(`→ gcloud run services describe ${d.app}`));
          await run("gcloud", ["run", "services", "describe", d.app!, "--region", region,
            ...(d.project ? ["--project", d.project] : []),
            "--format=value(status.url,status.latestReadyRevisionName)"]);
          break;
        }
      }
      if (!d.url) { console.log(c.gray("(no URL recorded — nothing to ping)")); return 0; }
      console.log("");
      console.log(c.gray(`→ GET ${cleanUrl(d.url)}/health`));
      return ping(`${cleanUrl(d.url)}/health`);
    },
  },
  ping: {
    group: "Deployed",
    desc: "GET /health on your deployed server",
    run: async () => {
      const d = detectDeploy();
      if (!d?.url) { console.error(c.red("No deployment URL found. Run `whoop-mcp cloud` first (or set $FLY_APP).")); return 1; }
      return ping(`${cleanUrl(d.url)}/health`);
    },
  },

  // ── Inspect ──────────────────────────────────────────────────────────
  info: {
    group: "Inspect",
    desc: "Show install path, version, env state, and your deployment",
    run: async () => {
      const d = detectDeploy();
      const envExists = existsSync(resolve(ROOT, ".env"));
      const built = existsSync(resolve(ROOT, "dist", "server.js"));
      console.log(`${c.bold("whoop-mcp")}  ${c.gray("v" + VERSION)}`);
      console.log("");
      const row = (label: string, value: string) =>
        console.log(`  ${c.gray(label.padEnd(15))} ${value}`);
      row("install root", ROOT);
      row("node", process.version);
      row("built (dist/)", built ? c.green("yes") : c.red("no — run `whoop-mcp build`"));
      row(".env", envExists ? c.green("present") : c.red("missing"));
      if (d) {
        row("deployment", c.green(d.platform) + (d.app ? c.gray(` · ${d.app}`) : ""));
        if (d.region) row("region", d.region);
        if (d.url) {
          row("deployed url", cleanUrl(d.url));
          row("health probe", `${cleanUrl(d.url)}/health`);
          row("mcp endpoint", `${cleanUrl(d.url)}/mcp`);
        }
      } else {
        row("deployment", c.gray("(none — run `whoop-mcp cloud`)"));
      }
      return 0;
    },
  },
  tools: {
    group: "Inspect",
    desc: "List the MCP tools the server exposes (48 total)",
    run: async () => {
      const reads = [
        "whoop_today", "whoop_day", "whoop_profile", "whoop_calendar", "whoop_recovery",
        "whoop_sleep", "whoop_strain", "whoop_trend", "whoop_compare", "whoop_stress",
        "whoop_sleep_need", "whoop_live_hr", "whoop_live_state", "whoop_live_stress",
        "whoop_workouts", "whoop_workout", "whoop_sports_catalog", "whoop_lift_prs",
        "whoop_lift_exercise", "whoop_lift_progression", "whoop_lift_history",
        "whoop_lift_library", "whoop_lift_catalog", "whoop_journal", "whoop_journal_catalog",
        "whoop_behavior_impact", "whoop_cycle", "whoop_performance_assessment",
        "whoop_smart_alarm", "whoop_leaderboard", "whoop_communities", "whoop_hr_zones",
      ];
      const writes = [
        "whoop_activity_create", "whoop_activity_delete", "whoop_lift_log",
        "whoop_lift_template_save", "whoop_lift_custom_exercise", "whoop_journal_log",
        "whoop_journal_autopop", "whoop_cycle_log", "whoop_symptom_log",
        "whoop_smart_alarm_set", "whoop_hr_zones_set", "whoop_profile_update",
        "whoop_hidden_metric", "whoop_coach_ask",
      ];
      const raw = ["whoop_raw", "whoop_endpoints"];

      console.log(`${c.bold("Reads")} ${c.gray("(" + reads.length + ")")}`);
      for (const t of reads) console.log(`  ${c.green("●")} ${t}`);
      console.log("");
      console.log(`${c.bold("Writes")} ${c.gray("(" + writes.length + " — preview-first; confirm=false default)")}`);
      for (const t of writes) console.log(`  ${c.brand("●")} ${t}`);
      console.log("");
      console.log(`${c.bold("Escape hatches")} ${c.gray("(" + raw.length + ")")}`);
      for (const t of raw) console.log(`  ${c.gray("●")} ${t}`);
      console.log("");
      console.log(c.gray(`total: ${reads.length + writes.length + raw.length}`));
      return 0;
    },
  },
  config: {
    group: "Inspect",
    desc: "Print a Claude Desktop config snippet",
    usage: "whoop-mcp config <stdio|http>",
    run: async (args) => {
      const mode = args[0];
      if (mode !== "stdio" && mode !== "http") {
        console.log(c.bold("Pick a mode:"));
        console.log("  " + c.brand("whoop-mcp config stdio") + c.gray("   # local install"));
        console.log("  " + c.brand("whoop-mcp config http") + c.gray("    # remote deployment (uses mcp-remote bridge)"));
        return 1;
      }
      const home = process.env.HOME ?? "~";
      const cfgPath = resolve(home, "Library/Application Support/Claude/claude_desktop_config.json");
      console.log(c.gray(`Edit:  ${cfgPath}`));
      console.log("");
      if (mode === "stdio") {
        console.log(JSON.stringify({
          mcpServers: {
            whoop: {
              command: process.execPath,
              args: [resolve(ROOT, "dist", "server.js")],
            },
          },
        }, null, 2));
      } else {
        // Claude Desktop doesn't natively support remote MCP — bridge via npx mcp-remote.
        const d = detectDeploy();
        const url = d?.url ? `${cleanUrl(d.url)}/mcp` : "https://YOUR-SERVER/mcp";
        console.log(JSON.stringify({
          mcpServers: {
            whoop: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                url,
                "--header",
                "Authorization:Bearer YOUR_MCP_AUTH_TOKEN",
              ],
            },
          },
        }, null, 2));
        console.log("");
        console.log(c.gray("Bridge: https://www.npmjs.com/package/mcp-remote"));
        console.log(c.gray("Claude Desktop only supports stdio — `mcp-remote` proxies your HTTP server through it."));
      }
      return 0;
    },
  },

  // ── Help ─────────────────────────────────────────────────────────────
  version: {
    group: "Help",
    desc: "Print the version string",
    run: async () => {
      console.log(VERSION);
      return 0;
    },
  },
  help: {
    group: "Help",
    desc: "Show this help",
    run: async () => {
      printHelp();
      return 0;
    },
  },
};

// Aliases — helpful shortcuts.
const aliases: Record<string, string> = {
  "-h": "help",
  "--help": "help",
  "-v": "version",
  "--version": "version",
};

// ── helpers ──────────────────────────────────────────────────────────────
function npmBin(name: string): string {
  const path = resolve(ROOT, "node_modules", ".bin", name);
  if (!existsSync(path)) {
    console.error(c.red(`Missing dev dependency: ${name}`));
    console.error(c.gray(`Expected at: ${path}`));
    console.error(c.gray(`Run `) + c.bold(`cd ${ROOT} && npm install`) + c.gray(` first.`));
    process.exit(1);
  }
  return path;
}

function detectFlyApp(): string | null {
  if (process.env.FLY_APP) return process.env.FLY_APP;
  const tomlPath = resolve(ROOT, "fly.toml");
  if (existsSync(tomlPath)) {
    const m = readFileSync(tomlPath, "utf8").match(/^app\s*=\s*['"]([^'"]+)['"]/m);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Where the server is deployed — from the `.whoop-mcp-deploy.json` record written
// by `whoop-mcp cloud`/`local`, falling back to legacy Fly detection
// (fly.toml / $FLY_APP) for deploys made before the record existed.
interface DeployInfo { platform: string; app?: string; url?: string; region?: string; project?: string; }
function detectDeploy(): DeployInfo | null {
  const recPath = resolve(ROOT, ".whoop-mcp-deploy.json");
  if (existsSync(recPath)) {
    try {
      const r = JSON.parse(readFileSync(recPath, "utf8")) as DeployInfo;
      if (r && typeof r.platform === "string") return r;
    } catch { /* fall through to legacy detection */ }
  }
  const app = detectFlyApp();
  if (app) return { platform: "fly", app, url: `https://${app}.fly.dev` };
  return null;
}
const cleanUrl = (u: string): string => u.replace(/\/+$/, "");

function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(c.red(`\nKilled by signal ${signal}`));
        res(128);
        return;
      }
      res(code ?? 1);
    });
    child.on("error", (err) => {
      console.error(c.red("Failed to spawn:"), err.message);
      res(1);
    });
  });
}

function ping(url: string, timeoutMs = 10_000): Promise<number> {
  return new Promise((res) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { "user-agent": `whoop-mcp/${VERSION}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          const label = ok ? c.green(`✓ ${status}`) : c.red(`✗ ${status}`);
          const preview = body.length > 120 ? body.slice(0, 117) + "..." : body;
          console.log(`${label}  ${url}  ${c.gray("→ " + preview.replace(/\s+/g, " ").trim())}`);
          res(ok ? 0 : 1);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      console.error(c.red(`✗ timeout after ${timeoutMs}ms:`), url);
      res(1);
    });
    req.on("error", (err) => {
      console.error(c.red("✗ network error:"), err.message);
      res(1);
    });
    req.end();
  });
}

function printHelp(): void {
  console.log(`${c.bold("Usage:")} whoop-mcp ${c.gray("<command>")} ${c.gray("[args]")}`);
  console.log("");
  const byGroup: Record<string, [string, Cmd][]> = {};
  for (const [name, cmd] of Object.entries(commands)) {
    byGroup[cmd.group] ??= [];
    byGroup[cmd.group]!.push([name, cmd]);
  }
  for (const group of GROUP_ORDER) {
    const list = byGroup[group];
    if (!list || list.length === 0) continue;
    console.log(c.bold(group));
    const longest = Math.max(...list.map(([n]) => n.length));
    for (const [name, cmd] of list) {
      const padded = name.padEnd(longest + 2);
      console.log(`  ${c.brand(padded)}${c.white(cmd.desc)}`);
      if (cmd.usage) {
        console.log(`  ${" ".repeat(longest + 2)}${c.gray(cmd.usage)}`);
      }
    }
    console.log("");
  }
  console.log(c.gray("Global flags:"));
  console.log(c.gray("  --help, -h     Show this help"));
  console.log(c.gray("  --version, -v  Show version"));
  console.log(c.gray("  NO_COLOR=1     Disable ANSI colors"));
  console.log("");
  console.log(c.gray("First-time global install (from a clone of this repo):"));
  console.log(c.gray("  cd ") + c.bold(ROOT));
  console.log(c.gray("  npm install && npx tsc && npm link"));
  console.log("");
  console.log(c.gray("Repo: ") + c.white(PKG.name) + c.gray(" · ") + ROOT);
  console.log("");
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Ctrl-C kills the CLI from anywhere — during a spinner, a subprocess, or
  // between prompts — and restores the cursor a spinner/menu may have hidden.
  // (Ctrl-C inside a text prompt is also caught in ui.ts's ask(), where readline
  // intercepts SIGINT before it would reach the process.)
  process.on("SIGINT", () => { process.stderr.write("\x1b[?25h"); process.exit(130); });

  // Banner on EVERY invocation, at the very top. It goes to stderr (see
  // printBanner), so even `start` (MCP stdio), `dev`, and `version` show it
  // without corrupting their stdout.
  printBanner();

  if (argv.length === 0) {
    printHelp();
    return 0;
  }

  let name = argv[0]!;
  if (name in aliases) name = aliases[name]!;

  const cmd = commands[name];
  if (!cmd) {
    console.error(`${c.red("Unknown command:")} ${name}`);
    console.error("");
    console.error(`Run ${c.bold("whoop-mcp help")} to see all commands.`);
    return 1;
  }

  return cmd.run(argv.slice(1));
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(c.red("Fatal:"), err instanceof Error ? err.stack : err);
  process.exit(1);
});
