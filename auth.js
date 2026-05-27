// SAKIGAKE — 共通認証チェック + ヘッダー動的化
(function() {
  'use strict';

  var STORAGE_KEY = 'sakigake_user';

  // ログインページでは何もしない
  if (window.location.pathname === '/login.html') return;

  // localStorage チェック
  var raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    window.location.href = '/login.html';
    return;
  }

  var user;
  try {
    user = JSON.parse(raw);
    if (!user || !user.recordId) throw new Error('invalid');
  } catch(e) {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = '/login.html';
    return;
  }

  // イニシャル生成
  function getInitials(name) {
    if (!name) return '??';
    var parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + '.' + parts[1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }

  // ヘッダー書き換え + ログアウトボタン追加
  document.addEventListener('DOMContentLoaded', function() {
    var initials = getInitials(user.name);

    // イニシャルバッジ (w-9 h-9 rounded-[10px] bg-mint ... mono)
    var badges = document.querySelectorAll('header .bg-mint.mono');
    badges.forEach(function(el) {
      // サイズ確認（ナビのドットではなくアバターバッジ）
      if (el.classList.contains('w-9') || el.style.width) {
        el.textContent = initials;
      }
    });

    // ユーザー名テキスト
    var nameEls = document.querySelectorAll('header .font-bold.text-\\[13px\\]');
    nameEls.forEach(function(el) {
      if (el.closest('nav')) return; // ナビ内は除外
      el.textContent = user.name;
    });

    // アカウントリンクをドロップダウンメニューに置き換え
    var accountLink = document.querySelector('header a[href="account.html"]');
    if (accountLink) {
      var wrapper = accountLink.parentElement;
      wrapper.style.position = 'relative';

      // リンクをボタンに置換（ページ遷移を防ぐ）
      var toggle = document.createElement('button');
      toggle.className = 'flex items-center gap-2.5 hover:opacity-90 transition cursor-pointer';
      toggle.title = 'メニュー';
      toggle.innerHTML =
        '<div class="w-9 h-9 rounded-[10px] bg-mint flex items-center justify-center mono text-xs font-bold">' + initials + '</div>' +
        '<div class="hidden sm:block"><div class="font-bold text-[13px] leading-tight">' + user.name + '</div></div>' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="text-inkmute ml-0.5"><path stroke-linecap="round" d="M6 9l6 6 6-6"/></svg>';
      accountLink.replaceWith(toggle);

      // ドロップダウン
      var dropdown = document.createElement('div');
      dropdown.className = 'absolute right-0 top-full mt-2 bg-paper border border-black/10 rounded-xl shadow-lg py-2 min-w-[180px] z-50';
      dropdown.style.display = 'none';
      dropdown.innerHTML =
        '<div class="px-4 py-2 border-b border-black/5 mb-1">' +
          '<div class="font-bold text-[13px]">' + user.name + '</div>' +
          '<div class="mono text-[10px] text-inkmute tracking-wider">' + (user.salesId || '') + '</div>' +
        '</div>' +
        '<button id="sakigake-logout" class="w-full text-left px-4 py-2.5 text-[13px] font-bold text-danger hover:bg-red-50 transition rounded-b-xl">ログアウト</button>';
      wrapper.appendChild(dropdown);

      var open = false;
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        open = !open;
        dropdown.style.display = open ? 'block' : 'none';
      });
      document.addEventListener('click', function() {
        open = false;
        dropdown.style.display = 'none';
      });
      dropdown.querySelector('#sakigake-logout').addEventListener('click', function() {
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = '/login.html';
      });
    }
  });

  // グローバルにユーザー情報を公開（他スクリプトから参照可能）
  window.SAKIGAKE_USER = user;

})();
