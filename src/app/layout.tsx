import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MidnightMiner Claimer",
  description: "Check and consolidate NIGHT tokens from MidnightMiner wallets",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
