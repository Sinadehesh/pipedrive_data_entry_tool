import type { ReactNode } from "react";

export const metadata = {
  title: "CRM Intelligence",
  description: "Automatic Pipedrive data entry from calls, email, and calendar.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
