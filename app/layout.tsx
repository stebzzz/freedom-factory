import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Sidebar } from "@/components/sidebar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Freedom Factory",
  description: "Production YouTube Faceless - Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-screen">
        <ThemeProvider>
          <div className="bg-mesh" />
          <div className="noise-overlay" />
          <Sidebar />
          <main
            className="relative z-10 min-h-screen transition-all duration-300"
            style={{ marginLeft: "var(--sidebar-width)" }}
          >
            <div className="px-10 py-10 max-w-[1320px]">
              {children}
            </div>
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
