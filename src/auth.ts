import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  accounts,
  memberships,
  sessions,
  tenants,
  users,
  verificationTokens,
} from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * App authentication (who is this user?) — deliberately separate from the
 * DATA-ACCESS grants in `connections` (ARCHITECTURE.md §9.3): signing in
 * asks only for identity, never for mailbox or CRM scopes.
 *
 * Tenant routing: the JWT carries `tenantId`, resolved (and on first
 * sign-in, created) from `memberships`. Every server component, server
 * action, and API route derives its tenant from this session value —
 * server-side state, never client input.
 */
export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // JWT sessions: no DB read per request on serverless. To add magic links,
  // append an Email provider (e.g. Resend) here — the adapter tables it
  // needs already exist.
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [
    Google({
      clientId: env().GOOGLE_CLIENT_ID,
      clientSecret: env().GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      // Cast once: JWT claim typing varies across next-auth v5 betas.
      const claims = token as typeof token & {
        userId?: string;
        tenantId?: string;
      };
      // First sign-in on this JWT: `user` is present. Resolve or bootstrap
      // the tenant once and pin it in the token.
      if (user?.id) claims.userId = user.id;
      if (!claims.tenantId && claims.userId) {
        claims.tenantId = await resolveOrBootstrapTenant(
          claims.userId,
          claims.email ?? null,
        );
      }
      // Tenant switch via unstable_update() — e.g. after accepting an
      // invite. The requested tenant is honored ONLY if a membership row
      // exists for this user; the client can never talk itself into a
      // foreign tenant.
      if (
        trigger === "update" &&
        claims.userId &&
        typeof (session as { tenantId?: unknown } | null)?.tenantId === "string"
      ) {
        const requested = (session as { tenantId: string }).tenantId;
        const [member] = await db
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, claims.userId),
              eq(memberships.tenantId, requested),
            ),
          )
          .limit(1);
        if (member) claims.tenantId = requested;
      }
      return claims;
    },
    session({ session, token }) {
      const claims = token as typeof token & {
        userId: string;
        tenantId: string;
      };
      session.user.id = claims.userId;
      session.tenantId = claims.tenantId;
      return session;
    },
  },
});

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
]);

/**
 * Route the user to their tenant; first sign-in creates their workspace.
 * The signup email's corporate domain seeds `internalDomains` (feeding the
 * internal-thread filter and identity resolution from day one).
 *
 * Joining an EXISTING workspace goes through an invite flow (membership row
 * created by an owner) — deliberately not by matching email domains, which
 * would let anyone with a stray corp address read that company's CRM data.
 */
async function resolveOrBootstrapTenant(
  userId: string,
  email: string | null,
): Promise<string> {
  const [existing] = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (existing) return existing.tenantId;

  const domain = email?.split("@")[1]?.toLowerCase();
  const isCorporate = !!domain && !FREE_MAIL_DOMAINS.has(domain);

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: isCorporate ? domain.split(".")[0] : (email ?? "workspace"),
      internalDomains: isCorporate ? [domain] : [],
    })
    .returning({ id: tenants.id });

  await db
    .insert(memberships)
    .values({ userId, tenantId: tenant.id, role: "owner" })
    .onConflictDoNothing();

  return tenant.id;
}
