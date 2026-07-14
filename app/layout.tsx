import type { Metadata } from "next";
import { headers } from "next/headers";
import { Manrope, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);

  return {
    metadataBase: base,
    title: "RIPcheck — Preflight para sublimación",
    description: "Control técnico de archivos PDF y AI para impresión por sublimación.",
    openGraph: {
      title: "RIPcheck — Verifica antes de imprimir",
      description: "Preflight preventivo de PDF y AI para sublimación.",
      images: [{ url: "/og.png", width: 1734, height: 907, alt: "RIPcheck, preflight para sublimación" }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "RIPcheck — Verifica antes de imprimir",
      description: "Preflight preventivo de PDF y AI para sublimación.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className={`${manrope.variable} ${plexMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
