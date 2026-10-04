import type { Metadata, Viewport } from 'next';
import './globals.css';
import { VersionWatcher } from '@/components/version-watcher';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: 'J神・圖形來世',
  description: 'J神・圖形來世｜即時牌卡預測系統',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'J神・圖形來世', statusBarStyle: 'black-translucent' },
  icons: { icon: '/jshen-logo.svg', apple: '/apple-touch-icon.png' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body><VersionWatcher />{children}</body></html>;
}
