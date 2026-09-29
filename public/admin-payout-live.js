(() => {
  document.querySelectorAll('[data-delete-account]').forEach(button => button.addEventListener('click', event => {
    if (!window.confirm(`確定要刪除帳號 ${button.dataset.deleteAccount || ''} 嗎？`)) event.preventDefault();
  }));
  document.querySelectorAll('[data-cancel-payout]').forEach(button => button.addEventListener('click', event => {
    if (!window.confirm('確定要取消這筆指定派彩計畫嗎？')) event.preventDefault();
  }));

  const formatExpiry = value => value
    ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : '請選擇日期與時間';
  const padExpiry = value => String(value).padStart(2, '0');
  document.querySelectorAll('[data-expiry-picker]').forEach(picker => {
    const date = picker.querySelector('input[type="date"]');
    const time = picker.querySelector('input[type="time"]');
    const hidden = picker.querySelector('input[type="hidden"]');
    const preview = picker.querySelector('[data-expiry-preview]');
    if (!(date instanceof HTMLInputElement) || !(time instanceof HTMLInputElement)
      || !(hidden instanceof HTMLInputElement) || !preview) return;
    const sync = () => {
      hidden.value = date.value && time.value ? `${date.value}T${time.value}` : '';
      if (!hidden.value) { preview.textContent = '請選擇到期時間'; return; }
      const remainingMs = new Date(hidden.value).getTime() - Date.now();
      const remaining = remainingMs <= 0 ? '已到期' : `剩餘 ${Math.ceil(remainingMs / 86400000)} 天`;
      preview.textContent = `到期：${formatExpiry(hidden.value)}（${remaining}）`;
    };
    picker.querySelectorAll('[data-expiry-days]').forEach(button => button.addEventListener('click', () => {
      const days = Number(button.dataset.expiryDays);
      if (!Number.isFinite(days)) return;
      const now = new Date();
      const current = hidden.value ? new Date(hidden.value) : now;
      const next = picker.dataset.expiryExtend === 'true' && current > now ? new Date(current) : now;
      next.setDate(next.getDate() + days);
      date.value = `${next.getFullYear()}-${padExpiry(next.getMonth() + 1)}-${padExpiry(next.getDate())}`;
      if (!time.value) time.value = '23:59';
      sync();
    }));
    date.addEventListener('change', sync);
    time.addEventListener('change', sync);
    sync();
  });

  const onlineCount = document.querySelector('#admin-online-count');
  const onlineToggle = document.querySelector('#admin-online-toggle');
  const onlineList = document.querySelector('#online-account-list');
  const onlineItems = document.querySelector('#online-account-items');
  if (onlineToggle && onlineList) onlineToggle.addEventListener('click', () => { onlineList.hidden = !onlineList.hidden; });
  if (onlineCount) {
    const refreshOnline = async () => {
      try {
        const response = await fetch('/admin/Online', { cache: 'no-store' });
        const value = response.ok ? await response.json() : null;
        onlineCount.textContent = Number.isFinite(value?.viewerCount) ? Number(value.viewerCount).toLocaleString() : '—';
        if (onlineItems) {
          const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
          onlineItems.replaceChildren(...(accounts.length
            ? accounts.map(account => { const row = document.createElement('span'); row.dataset.onlineUser = ''; row.textContent = String(account.username || '未知帳號'); return row; })
            : [Object.assign(document.createElement('span'), { className: 'muted', textContent: '目前無人在線' })]));
        }
      } catch { onlineCount.textContent = '—'; }
    };
    refreshOnline();
    window.setInterval(refreshOnline, 5000);
  }

  const navigation = Array.from(document.querySelectorAll('[data-admin-target]'));
  const pages = Array.from(document.querySelectorAll('[data-admin-page]'));
  if (navigation.length && pages.length) {
    const sectionStorageKey = 'jshen-admin-section';
    const show = target => {
      const available = pages.some(page => page.dataset.adminPage === target);
      const selected = available ? target : 'payout';
      pages.forEach(page => { page.hidden = page.dataset.adminPage !== selected; });
      navigation.forEach(link => link.classList.toggle('active', link.dataset.adminTarget === selected));
      try { sessionStorage.setItem(sectionStorageKey, selected); } catch { /* Navigation still works without storage. */ }
      if (location.hash !== `#${selected}`) history.replaceState(null, '', `#${selected}`);
    };
    navigation.forEach(link => link.addEventListener('click', event => { event.preventDefault(); show(link.dataset.adminTarget); }));
    window.addEventListener('hashchange', () => show(location.hash.slice(1)));
    let remembered = '';
    try { remembered = sessionStorage.getItem(sectionStorageKey) || ''; } catch { /* Use the default section. */ }
    show(location.hash.slice(1) || remembered || 'payout');
  }

  const select = document.querySelector('#payout-code');
  const amountInput = document.querySelector('#payout-amount');
  if (!(select instanceof HTMLSelectElement)) return;

  const options = Array.from(select.options).filter(option => option.dataset.payoutIndex !== undefined);
  const defaults = options.map(option => Number(option.dataset.payoutAmount));
  const storageKey = 'jshen-payout-pools-v1';
  let anchor = { amounts: defaults, updatedAt: Date.now() };
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (stored && Array.isArray(stored.amounts) && stored.amounts.length === options.length
      && stored.amounts.every(Number.isFinite) && Number.isFinite(stored.updatedAt)) {
      anchor = stored;
    } else {
      localStorage.setItem(storageKey, JSON.stringify(anchor));
    }
  } catch { /* The dropdown still shows its server snapshot when storage is unavailable. */ }

  const rates = [0.21 / 1.2, 0.12 / 0.9, 0.06 / 0.65, 0.03 / 0.45];
  const onlineSpeed = () => {
    const now = new Date();
    const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const hour = taipei.getHours(), minute = taipei.getMinutes(), second = taipei.getSeconds();
    const range = hour < 6 ? [80, 180] : hour < 12 ? [180, 350] : hour < 18 ? [350, 650] : [650, 1200];
    const progress = ((minute * 60 + second) % 300) / 300;
    return Math.floor(range[0] + (range[1] - range[0]) * progress) / 86;
  };
  let current = defaults;
  const updateAmountInput = force => {
    if (!(amountInput instanceof HTMLInputElement)) return;
    const index = Number(select.selectedOptions[0]?.dataset.payoutIndex ?? 0);
    const value = current[index];
    if (!Number.isFinite(value)) return;
    amountInput.min = String(select.selectedOptions[0]?.dataset.payoutBase || '0.01');
    amountInput.max = String(select.selectedOptions[0]?.dataset.payoutCap || '');
    if (force || !amountInput.value) amountInput.value = value.toFixed(2);
  };
  const update = () => {
    const elapsedSeconds = Math.max(0, (Date.now() - Number(anchor.updatedAt)) / 1000);
    const speed = onlineSpeed();
    current = options.map((option, index) => {
      const base = Number(option.dataset.payoutBase), cap = Number(option.dataset.payoutCap);
      const cycleSize = cap - base;
      const progress = Math.max(0, Number(anchor.amounts[index]) - base) + rates[index] * speed * elapsedSeconds;
      const value = base + (progress % cycleSize);
      option.textContent = `${option.value} · ${option.dataset.payoutName || ''}（目前 ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}）`;
      return value;
    });
    updateAmountInput(false);
  };
  select.addEventListener('change', () => updateAmountInput(true));
  update();
  window.setInterval(update, 500);
})();
