import type { Metadata } from 'next';
import './globals.css';

const trustedOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://policy-evidence-ledger.moaydghazzawi.com';

export const metadata: Metadata = {
  title: 'Policy Evidence Ledger',
  description:
    'A local-first workspace for traceable, reproducible policy research.',
  metadataBase: new URL(trustedOrigin),
  alternates: { canonical: '/' },
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'Policy Evidence Ledger',
    description: 'Trace every policy claim back to the record.',
    type: 'website',
    url: '/',
    images: [
      {
        url: '/og.png',
        width: 1731,
        height: 909,
        alt: 'Policy Evidence Ledger',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Policy Evidence Ledger',
    description: 'Trace every policy claim back to the record.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
