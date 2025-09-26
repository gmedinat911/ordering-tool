// OneSignal v16 worker integration
try { importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); } catch (e) {}

self.addEventListener('install', (event) => {
  // Activate updated SW immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of uncontrolled clients without reload
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  try {
    if (event.data) {
      const rawText = event.data.text();
      console.log('📩 [SW] Push event received. Raw payload:', rawText);
      if (rawText && rawText.includes('OneSignal')) {
        console.log('➡️ [SW] Routing push to OneSignal SDK handler');
        return; // Allow OneSignalSDK.sw.js to process normally
      }
    }

    // Otherwise, fallback to custom backend notification handling
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}
    console.log('➡️ [SW] Handling push with custom fallback logic. Parsed data:', data);
    const title = data.title || 'Order Update';
    const body = data.body || (data.displayName ? `${data.displayName} is ready!` : 'Your drink is ready!');
    const options = {
      body,
      icon: '/favicon.ico',
      badge: 'https://upload.wikimedia.org/wikipedia/commons/7/72/Cocktail_icon.png'
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    console.error('❌ [SW] Push handling error', e);
  }
});

self.addEventListener('notificationclick', function(event) {
  console.log('🖱️ [SW] Notification clicked:', event.notification);
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          console.log('➡️ [SW] Focusing existing client window');
          return client.focus();
        }
      }
      // Open the deployed menu path on your domain
      if (clients.openWindow) {
        console.log('➡️ [SW] Opening new window to /bdaymenu-bar.html');
        return clients.openWindow('/bdaymenu-bar.html');
      }
    })
  );
});
