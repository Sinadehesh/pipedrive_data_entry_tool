import { env } from "@/lib/env";

/**
 * Pipedrive Marketplace OAuth (authorization-code flow).
 * https://oauth.pipedrive.com is the token host for every tenant; the
 * granted company is identified by `api_domain` in the token response.
 */
const AUTHORIZE_URL = "https://oauth.pipedrive.com/oauth/authorize";
const TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";

export function pipedriveOAuthEnv() {
  const e = env();
  for (const k of ["PIPEDRIVE_CLIENT_ID", "PIPEDRIVE_CLIENT_SECRET", "APP_URL"] as const) {
    if (!e[k]) throw new Error(`${k} is required for Pipedrive OAuth`);
  }
  return {
    clientId: e.PIPEDRIVE_CLIENT_ID,
    clientSecret: e.PIPEDRIVE_CLIENT_SECRET,
    redirectUri: `${e.APP_URL.replace(/\/$/, "")}/api/oauth/pipedrive`,
  };
}

export function authorizeUrl(state: string): string {
  const { clientId, redirectUri } = pipedriveOAuthEnv();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type PipedriveTokens = {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when accessToken expires. */
  expiresAt: string;
  /** Company subdomain, e.g. "acme" for acme.pipedrive.com. */
  domain: string;
};

export async function exchangeCode(code: string): Promise<PipedriveTokens> {
  const { redirectUri } = pipedriveOAuthEnv();
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}

export async function refreshTokens(
  refreshToken: string,
): Promise<PipedriveTokens> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function tokenRequest(
  params: Record<string, string>,
): Promise<PipedriveTokens> {
  const { clientId, clientSecret } = pipedriveOAuthEnv();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(
      `Pipedrive token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number; // seconds
    api_domain: string; // e.g. "https://acme.pipedrive.com"
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    domain: new URL(body.api_domain).hostname.split(".")[0],
  };
}
