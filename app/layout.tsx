import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'J神・圖形來世',
  description: 'J神・圖形來世｜即時牌卡預測系統',
  icons: { icon: '/jshen-logo.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
