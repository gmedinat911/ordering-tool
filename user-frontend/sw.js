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
    // If OneSignal SDK is present, let it handle its own pushes
    if (event.data) {
      const rawText = event.data.text();
      if (rawText && rawText.includes('OneSignal')) {
        // Allow OneSignalSDK.sw.js to process normally
        return;
      }
    }

    // Otherwise, fallback to custom backend notification handling
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}
    const title = data.title || 'Order Update';
    const body = data.body || (data.displayName ? `${data.displayName} is ready!` : 'Your drink is ready!');
    const options = {
      body,
      icon: '/favicon.ico'
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    console.error('Push handling error', e);
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      // Open the deployed menu path on your domain
      if (clients.openWindow) return clients.openWindow('/bdaymenu-bar.html');
    })
  );
});
