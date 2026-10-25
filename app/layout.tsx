import type { Metadata } from "next";
import "./globals.css";
import { Pwa } from "./pwa";

export const metadata: Metadata = {
  title: "買い物",
  description: "買い物リスト・在庫・購入履歴",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "買い物", statusBarStyle: "black-translucent" },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased"><Pwa />{children}</body>
    </html>
  );
}
