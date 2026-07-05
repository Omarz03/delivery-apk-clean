/* =========================================================================
   service-worker.js
   يخزّن هذا الملف "هيكل التطبيق" (app shell) مؤقتاً داخل المتصفح، بحيث
   يستمر التطبيق بالعمل حتى بدون اتصال بالإنترنت بعد أول زيارة ناجحة.
   ملاحظة: البيانات نفسها (المستفيدون) مخزّنة في IndexedDB وليس هنا —
   هذا الملف يهتم فقط بملفات الواجهة (HTML/CSS/JS).
   ========================================================================= */

const CACHE_NAME = 'delivery-core-v2';

// الملفات الأساسية التي يحتاجها التطبيق للعمل بدون اتصال
const APP_SHELL = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
];

// عند التثبيت: نخزّن هيكل التطبيق مسبقاً
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// عند التفعيل: نحذف أي نسخ تخزين مؤقت قديمة من إصدارات سابقة
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// إستراتيجية الجلب: "الشبكة أولاً، ثم التخزين المؤقت كخطة بديلة"
// هذا يضمن أن المستخدم يحصل دائماً على أحدث نسخة عند توفر اتصال، وعند
// انقطاع الاتصال يعمل التطبيق من النسخة المخزّنة محلياً.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
