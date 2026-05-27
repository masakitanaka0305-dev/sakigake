// Service Worker: ngrok free tier の警告ページをバイパスする
// 全リクエストに ngrok-skip-browser-warning ヘッダーを追加

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 同一オリジンのリクエストのみ対象
  if (url.origin === self.location.origin) {
    const newHeaders = new Headers(event.request.headers);
    newHeaders.set('ngrok-skip-browser-warning', 'true');
    newHeaders.set('User-Agent', 'SAKIGAKE-App');

    const modifiedRequest = new Request(event.request, {
      headers: newHeaders,
    });

    event.respondWith(fetch(modifiedRequest));
  }
});
