import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MidnightMiner-Claimer",
  description: "Derive MidnightMiner wallets, claim NIGHT, and consolidate funds",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions inject attributes into body before hydration (e.g. cz-shortcut-listen). */}
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
