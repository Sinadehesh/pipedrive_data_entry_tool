import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { env } from "@/lib/env";
import { googleEnv } from "@/lib/google/auth";

/**
 * Kicks off the Google Workspace DATA-ACCESS grant — deliberately separate
 * from sign-in (§9.3): read-only mail+calendar scopes live on this flow
 * only. access_type=offline + prompt=consent guarantees a refresh token
 * even on re-connects.
 */
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export async function GET() {
  const session = await auth();
  if (!session?.tenantId) {
    return NextResponse.redirect(new URL("/api/auth/signin", appUrl()));
  }

  const { clientId } = googleEnv();
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/oauth/google",
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  return NextResponse.redirect(url);
}

function appUrl(): string {
  return env().APP_URL || "http://localhost:3000";
}

function redirectUri(): string {
  return `${appUrl().replace(/\/$/, "")}/api/oauth/google`;
}
