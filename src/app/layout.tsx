import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MidnightMiner-Claimer",
  description: "Derive MidnightMiner wallets, claim NIGHT, and consolidate funds",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
