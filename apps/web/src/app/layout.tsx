import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";

// Vendored rather than fetched so the desktop build and an offline browser session
// render identically. Inter is SIL OFL 1.1; see fonts/Inter-LICENSE.txt.
const interVariable = localFont({
  src: "./fonts/Inter-Variable-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-peak-ui",
});

export const metadata: Metadata = {
  title: "PeakCAD",
  description: "PeakCAD by PeakHorologyLLC — build shapes, cut holes, and export models locally",
  applicationName: "PeakCAD",
  authors: [{ name: "PeakHorologyLLC" }],
  creator: "PeakHorologyLLC",
  publisher: "PeakHorologyLLC",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "assets/peakcad/peakcad-logo.png", type: "image/png" },
      { url: "assets/peakcad/peakcad-app-icon.png", type: "image/png" },
    ],
    apple: "assets/peakcad/peakcad-logo.png",
    shortcut: "assets/peakcad/peakcad-logo.png",
  },
};

const themeBootScript = `(function(){try{var t=localStorage.getItem("peakcad:uiTheme")||localStorage.getItem("sketchForge.theme");if(t==="dark"){document.documentElement.dataset.theme="dark";document.documentElement.style.colorScheme="dark";}else{document.documentElement.style.colorScheme="light";}}catch(e){document.documentElement.style.colorScheme="light";}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={interVariable.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Script id="peakcad-theme-boot" strategy="beforeInteractive">
          {themeBootScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
