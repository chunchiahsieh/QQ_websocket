'use client';

import { AtSign, ExternalLink, MessageCircle, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

export function ContactLinks() {
  return <div className="flex shrink-0 items-center gap-2" aria-label="聯絡資訊">
    <Dialog>
      <DialogTrigger className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#06a94f] px-4 text-sm font-bold text-white transition hover:bg-[#058e43] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-400">
        <MessageCircle className="h-4 w-4" aria-hidden="true" />LINE 聯絡
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="border border-slate-600 bg-[#111c2d] p-6 text-white shadow-2xl">
        <DialogClose aria-label="關閉聯絡資訊" className="absolute right-3 top-3 rounded-md p-2 text-slate-300 hover:bg-white/10"><X className="h-4 w-4" /></DialogClose>
        <DialogTitle className="text-xl font-bold">LINE 聯絡我們</DialogTitle>
        <DialogDescription className="text-slate-300">掃描 QR Code 加入好友，或點下方按鈕開啟 LINE。</DialogDescription>
        <a href="https://line.me/ti/p/5LfC7875q4" target="_blank" rel="noopener noreferrer" aria-label="開啟 LINE 加好友" className="mx-auto block rounded-xl bg-white p-2">
          <img src="/contact-line.svg" width="256" height="256" alt="LINE 加好友 QR Code，ID：king8989168" className="h-auto w-56 max-w-full" />
        </a>
        <p className="text-center text-sm text-slate-200">LINE ID：<span className="select-all font-semibold text-white">king8989168</span></p>
        <a href="https://line.me/ti/p/5LfC7875q4" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-lg bg-[#06a94f] px-4 py-3 font-bold text-white hover:bg-[#058e43]">開啟 LINE 加好友<ExternalLink className="h-4 w-4" /></a>
      </DialogContent>
    </Dialog>
    <a href="https://www.threads.com/@kevin_09145?igshid=NTc4MTIwNjQ2YQ%3D%3D" target="_blank" rel="noopener noreferrer"
      aria-label="Threads：kevin_09145（另開分頁）" title="Threads @kevin_09145"
      className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm font-semibold text-white transition hover:border-slate-400 hover:bg-slate-800">
      <AtSign className="h-4 w-4" aria-hidden="true" />Threads
    </a>
  </div>;
}
