import type { z } from "zod";

export class WhoopAuthExpiredError extends Error {
  constructor() {
    super(
      "Whoop bearer token expired. Run `whoop-mcp auth` to capture a fresh one.",
    );
    this.name = "WhoopAuthExpiredError";
  }
}

export class WhoopApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
    description?: string,
  ) {
    super(`Whoop API error ${status} on ${path}: ${description ?? body.slice(0, 200)}`);
    this.name = "WhoopApiError";
  }
}

export class WhoopServerError extends Error {
  constructor(public readonly status: number, public readonly path: string) {
    super(
      `Whoop API returned ${status} on ${path}. This is usually transient — try again in 30s.`,
    );
    this.name = "WhoopServerError";
  }
}

export class WhoopProjectionError extends Error {
  constructor(public readonly tool: string, public readonly issue: z.ZodError) {
    super(`Projection for ${tool} failed zod parse: ${issue.message.slice(0, 200)}`);
    this.name = "WhoopProjectionError";
  }
}
