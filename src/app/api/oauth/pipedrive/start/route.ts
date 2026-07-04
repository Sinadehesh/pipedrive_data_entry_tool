import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { authorizeUrl } from "@/lib/pipedrive/oauth";

/**
 * Kicks off the Pipedrive Marketplace OAuth flow. The random `state` is
 * pinned in an httpOnly cookie and echoed back by Pipedrive — the callback
 * accepts the code only when the two match (CSRF protection).
 */
export async function GET() {
  const session = await auth();
  if (!session?.tenantId) {
    return NextResponse.redirect(new URL("/api/auth/signin", appUrl()));
  }

  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("pd_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes to complete the consent screen
    path: "/api/oauth/pipedrive",
  });

  return NextResponse.redirect(authorizeUrl(state));
}

function appUrl(): string {
  return process.env.APP_URL || "http://localhost:3000";
}
