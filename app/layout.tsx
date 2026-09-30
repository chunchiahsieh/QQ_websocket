import type { Metadata } from 'next';
import './globals.css';
import { VersionWatcher } from '@/components/version-watcher';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'J神・圖形來世',
  description: 'J神・圖形來世｜即時牌卡預測系統',
  icons: { icon: '/jshen-logo.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body><VersionWatcher />{children}</body></html>;
}
