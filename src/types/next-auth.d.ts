import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    /** The user's active workspace — the tenant filter for every query. */
    tenantId: string;
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
