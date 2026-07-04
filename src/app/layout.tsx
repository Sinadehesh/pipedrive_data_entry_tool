import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "CRM Intelligence",
  description: "Automatic Pipedrive data entry from calls, email, and calendar.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
