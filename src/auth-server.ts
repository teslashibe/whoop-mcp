// Stateless HTTP auth-server entrypoint for the per-user smore integration.
//
// smore-api (Go) calls this to mint per-user Whoop Cognito tokens without
// reproducing Whoop's auth: every handler delegates to the package's own
// cognito primitives (initiateAuth / respondToMfa / refreshCognitoSession).
// This service stores NOTHING — it takes credentials, returns tokens, done.
// smore persists the tokens (encrypted) and injects them into the user's
// whoop-mcp instance.
//
// Endpoints (bearer-gated by MCP_AUTH_TOKEN, except /health):
//   GET  /health                         -> 200 "ok"
//   POST /bootstrap {email,password}     -> {mfa_required,session} | {tokens}
//   POST /verify    {session,code,email} -> {tokens}
//   POST /refresh   {refresh_token}      -> {tokens}
//
// Run: node dist/auth-server.js  (same image as the MCP server, different cmd)
import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  initiateAuth,
  respondToMfa,
  refreshCognitoSession,
  type CognitoTokens,
} from "./whoop/cognito.js";

const PORT = Number(process.env.PORT ?? process.env.MCP_HTTP_PORT ?? 3000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

if (!AUTH_TOKEN || AUTH_TOKEN.length < 16) {
  throw new Error("MCP_AUTH_TOKEN must be set and at least 16 chars (openssl rand -hex 32).");
}

// The Session we hand back to the caller is opaque, but we need the Cognito
// challenge name on verify. Pack both so the caller can stay oblivious.
function packSession(challengeName: string, session: string): string {
  return Buffer.from(`${challengeName}\n${session}`, "utf8").toString("base64url");
}
function unpackSession(token: string): { challengeName: string; session: string } {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const nl = raw.indexOf("\n");
  if (nl < 0) return { challengeName: "SMS_MFA", session: raw };
  return { challengeName: raw.slice(0, nl), session: raw.slice(nl + 1) };
}

// Wire shape matches the Go client (internal/whoopauth): snake_case, epoch-ms.
function wireTokens(t: CognitoTokens, email: string) {
  return {
    email,
    access_token: t.accessToken,
    refresh_token: t.refreshToken,
    expires_at: t.expiresAt,
  };
}

function bearerOK(req: Request): boolean {
  const h = req.header("authorization") ?? "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (got.length !== AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(AUTH_TOKEN));
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!bearerOK(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/bootstrap", requireAuth, async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  try {
    const r = await initiateAuth(String(email), String(password));
    if (r.tokens) {
      res.json({ tokens: wireTokens(r.tokens, String(email)) });
      return;
    }
    res.json({ mfa_required: true, session: packSession(r.challengeName!, r.session!) });
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  }
});

app.post("/verify", requireAuth, async (req: Request, res: Response) => {
  const { session, code, email } = req.body ?? {};
  if (!session || !code) {
    res.status(400).json({ error: "session and code are required" });
    return;
  }
  try {
    const { challengeName, session: cognitoSession } = unpackSession(String(session));
    const tokens = await respondToMfa(String(email ?? ""), challengeName, cognitoSession, String(code));
    res.json(wireTokens(tokens, String(email ?? "")));
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  }
});

app.post("/refresh", requireAuth, async (req: Request, res: Response) => {
  const refreshToken = req.body?.refresh_token;
  if (!refreshToken) {
    res.status(400).json({ error: "refresh_token is required" });
    return;
  }
  try {
    const tokens = await refreshCognitoSession("", String(refreshToken));
    res.json(wireTokens(tokens, ""));
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  }
});

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.error(`whoop-auth listening on :${PORT}`);
});
