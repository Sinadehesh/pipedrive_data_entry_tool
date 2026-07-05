import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        CRM Intelligence
      </h1>
      <p className="text-slate-600">
        Every sales call — recorded in Claap or Zoom — analyzed for BANT,
        objections, and competitors, then synced to Pipedrive without your
        reps lifting a finger.
      </p>
      <Link
        href="/settings/sync"
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Open dashboard
      </Link>
    </main>
  );
}
