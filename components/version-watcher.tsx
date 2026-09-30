'use client';

import { useEffect } from 'react';

const VERSION_KEY = 'jshen-loaded-version';

export function VersionWatcher() {
  useEffect(() => {
    let stopped = false;
    let checking = false;

    const checkVersion = async () => {
      if (checking || stopped) return;
      checking = true;
      try {
        const response = await fetch(`/api/version?_=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { version?: string };
        const version = payload.version?.trim();
        if (!version || version === 'local-development') return;

        const loadedVersion = sessionStorage.getItem(VERSION_KEY);
        if (!loadedVersion) {
          sessionStorage.setItem(VERSION_KEY, version);
          return;
        }
        if (loadedVersion !== version) {
          sessionStorage.setItem(VERSION_KEY, version);
          const url = new URL(window.location.href);
          url.searchParams.set('_version', version.slice(0, 12));
          window.location.replace(url.toString());
        }
      } catch {
        // A temporary network failure should not interrupt the current page.
      } finally {
        checking = false;
      }
    };

    void checkVersion();
    const interval = window.setInterval(checkVersion, 5_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkVersion();
    };
    window.addEventListener('focus', checkVersion);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', checkVersion);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
