import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vizzia Slack Health Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
