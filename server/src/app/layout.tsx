// Feast Daily server is API-only. Next.js still needs a root layout for its
// built-in error and not-found pages.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
