/* =========================================================================
   session-qr.js — واجهة إنشاء / انضمام الجلسة عبر QR Code
   =========================================================================
   يدير هذا الملف كامل تدفق إنشاء الجلسة:
     المضيف:  إنشاء Offer → عرض QR → انتظار مسح التابع → مسح Answer → اتصال
     التابع:  مسح QR المضيف → إنشاء Answer → عرض QR → اتصال
   بعد اكتمال الاتصال، يتولّى sync-bridge.js ربط P2P بمنطق البيانات.
   ========================================================================= */

/* -----------------------------------------------------------------------
   توليد QR Code (مكتبة qrcode — CDN)
   ----------------------------------------------------------------------- */
async function generateQR(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  // QRCode.js تحتاج حجماً مناسباً للشاشة — نحسبه بناءً على عرض الشاشة
  const size = Math.min(window.innerWidth * 0.72, 280);

  return new Promise((resolve) => {
    new QRCode(container, {
      text: data,
      width: size,
      height: size,
      colorDark: '#1F2E2A',
      colorLight: '#F4F5F1',
      correctLevel: QRCode.CorrectLevel.M,
    });
    // QRCode.js synchronous داخلياً لكن DOM يحتاج frame
    requestAnimationFrame(resolve);
  });
}

/* -----------------------------------------------------------------------
   مسح QR (html5-qrcode — CDN)
   ----------------------------------------------------------------------- */
let activeScanner = null;

async function startQRScan(videoContainerId) {
  return new Promise((resolve, reject) => {
    if (activeScanner) {
      activeScanner.stop().catch(() => {});
      activeScanner = null;
    }

    activeScanner = new Html5Qrcode(videoContainerId);

    const config = {
      fps: 10,
      qrbox: { width: 240, height: 240 },
      aspectRatio: 1.0,
    };

    activeScanner.start(
      { facingMode: 'environment' }, // الكاميرا الخلفية
      config,
      (decodedText) => {
        activeScanner.stop().then(() => {
          activeScanner = null;
          resolve(decodedText);
        });
      },
      () => {} // أخطاء المسح المؤقتة، تُتجاهل
    ).catch((err) => {
      activeScanner = null;
      reject(err);
    });
  });
}

function stopQRScan() {
  if (activeScanner) {
    activeScanner.stop().catch(() => {});
    activeScanner = null;
  }
}

/* -----------------------------------------------------------------------
   واجهة المضيف (Host Flow)
   خطوة ١: إنشاء Offer وعرضها كـ QR
   خطوة ٢: مسح Answer من التابع
   ----------------------------------------------------------------------- */
async function startHostSession() {
  const modal = document.getElementById('sessionModal');
  modal.innerHTML = buildModalShell('إنشاء جلسة تسليم', `
    <div id="hostStep1" class="session-step">
      <p class="step-label">الخطوة ١ من ٢ — اعرض هذا الكود للتابع</p>
      <p class="step-desc">اطلب من الجهاز الآخر فتح التطبيق والضغط على "انضم لجلسة" ثم مسح هذا الكود.</p>
      <div id="hostOfferQR" class="qr-container"><div class="qr-spinner"></div></div>
      <button id="hostScanAnswerBtn" class="btn-primary mt-4 w-full">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
        التابع أظهر كوده — امسحه الآن
      </button>
    </div>

    <div id="hostStep2" class="session-step hidden">
      <p class="step-label">الخطوة ٢ من ٢ — امسح كود التابع</p>
      <div id="hostScanVideo" class="scan-container"></div>
      <button id="hostCancelScanBtn" class="btn-secondary mt-3 w-full">إلغاء</button>
    </div>

    <div id="hostConnected" class="session-step hidden">
      <div class="success-icon">✓</div>
      <p class="step-label text-delivered">تم الاتصال بنجاح!</p>
      <p class="step-desc">الجلسة نشطة. يمكنك الآن إغلاق هذه النافذة والبدء بالتسليم.</p>
      <button id="hostCloseBtn" class="btn-primary mt-4 w-full">ابدأ العمل</button>
    </div>
  `);

  openModal();

  try {
    // إنشاء Offer
    const offerJson = await window.deliveryP2P.createOffer();
    await generateQR('hostOfferQR', offerJson);

    // الخطوة ٢: مسح Answer
    document.getElementById('hostScanAnswerBtn').addEventListener('click', async () => {
      document.getElementById('hostStep1').classList.add('hidden');
      document.getElementById('hostStep2').classList.remove('hidden');

      document.getElementById('hostCancelScanBtn').addEventListener('click', () => {
        stopQRScan();
        document.getElementById('hostStep2').classList.add('hidden');
        document.getElementById('hostStep1').classList.remove('hidden');
      });

      try {
        const answerJson = await startQRScan('hostScanVideo');
        await window.deliveryP2P.receiveAnswer(answerJson);

        // انتظار فتح DataChannel
        await waitForChannel();

        document.getElementById('hostStep2').classList.add('hidden');
        document.getElementById('hostConnected').classList.remove('hidden');
        document.getElementById('hostCloseBtn').addEventListener('click', closeModal);

        window.showToast('تم الاتصال — الجلسة نشطة', 'success');
      } catch (err) {
        window.showToast('تعذّر مسح الكود. حاول مجدداً.', 'error');
        document.getElementById('hostStep2').classList.add('hidden');
        document.getElementById('hostStep1').classList.remove('hidden');
      }
    });

  } catch (err) {
    closeModal();
    window.showToast('تعذّر إنشاء الجلسة. تأكد أن المتصفح يدعم WebRTC.', 'error');
  }
}

/* -----------------------------------------------------------------------
   واجهة التابع (Peer Flow)
   خطوة ١: مسح QR المضيف
   خطوة ٢: عرض Answer كـ QR للمضيف
   ----------------------------------------------------------------------- */
async function startPeerSession() {
  const modal = document.getElementById('sessionModal');
  modal.innerHTML = buildModalShell('الانضمام لجلسة', `
    <div id="peerStep1" class="session-step">
      <p class="step-label">الخطوة ١ من ٢ — امسح كود المضيف</p>
      <p class="step-desc">وجّه الكاميرا نحو الكود الظاهر على شاشة الجهاز الرئيسي.</p>
      <div id="peerScanVideo" class="scan-container"></div>
      <button id="peerCancelBtn" class="btn-secondary mt-3 w-full">إلغاء</button>
    </div>

    <div id="peerStep2" class="session-step hidden">
      <p class="step-label">الخطوة ٢ من ٢ — اعرض هذا الكود للمضيف</p>
      <p class="step-desc">اطلب من المضيف مسح هذا الكود لإكمال الاتصال.</p>
      <div id="peerAnswerQR" class="qr-container"><div class="qr-spinner"></div></div>
      <p class="step-hint">انتظر حتى يمسح المضيف الكود...</p>
    </div>

    <div id="peerConnected" class="session-step hidden">
      <div class="success-icon">✓</div>
      <p class="step-label text-delivered">تم الاتصال بنجاح!</p>
      <p class="step-desc">الجلسة نشطة. يمكنك الآن إغلاق هذه النافذة والبدء بالتسليم.</p>
      <button id="peerCloseBtn" class="btn-primary mt-4 w-full">ابدأ العمل</button>
    </div>
  `);

  openModal();

  document.getElementById('peerCancelBtn').addEventListener('click', () => {
    stopQRScan();
    closeModal();
  });

  try {
    // مسح Offer من المضيف
    const offerJson = await startQRScan('peerScanVideo');

    document.getElementById('peerStep1').classList.add('hidden');
    document.getElementById('peerStep2').classList.remove('hidden');

    // إنشاء Answer وعرضها كـ QR
    const answerJson = await window.deliveryP2P.createAnswer(offerJson);
    await generateQR('peerAnswerQR', answerJson);

    // انتظار فتح DataChannel (المضيف يمسح الـ Answer ويكمل الـ Handshake)
    await waitForChannel();

    document.getElementById('peerStep2').classList.add('hidden');
    document.getElementById('peerConnected').classList.remove('hidden');
    document.getElementById('peerCloseBtn').addEventListener('click', closeModal);

    window.showToast('تم الاتصال — الجلسة نشطة', 'success');

  } catch (err) {
    stopQRScan();
    closeModal();
    const msg = err?.name === 'NotAllowedError'
      ? 'لا يوجد إذن للكاميرا. فعّل الإذن من إعدادات التطبيق ثم أعد المحاولة.'
      : 'تعذّر الانضمام للجلسة. حاول مجدداً.';
    window.showToast(msg, 'error', 4000);
  }
}

/* -----------------------------------------------------------------------
   انتظار فتح DataChannel (مع timeout 30 ثانية)
   ----------------------------------------------------------------------- */
function waitForChannel() {
  return new Promise((resolve, reject) => {
    if (window.deliveryP2P.connected) { resolve(); return; }

    const timeout = setTimeout(() => {
      reject(new Error('انتهت مهلة الاتصال'));
    }, 30000);

    window.deliveryP2P.addEventListener('channel-open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });

    window.deliveryP2P.addEventListener('channel-error', (e) => {
      clearTimeout(timeout);
      reject(e.detail);
    }, { once: true });
  });
}

/* -----------------------------------------------------------------------
   Modal helpers
   ----------------------------------------------------------------------- */
function buildModalShell(title, content) {
  return `
    <div class="session-modal-inner">
      <div class="session-modal-header">
        <h3 class="session-modal-title">${title}</h3>
        <button onclick="closeModal()" class="session-modal-close" aria-label="إغلاق">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="session-modal-body">${content}</div>
    </div>`;
}

function openModal() {
  const overlay = document.getElementById('sessionModalOverlay');
  const modal = document.getElementById('sessionModal');
  overlay.classList.add('open');
  modal.classList.add('open');
}

function closeModal() {
  stopQRScan();
  const overlay = document.getElementById('sessionModalOverlay');
  const modal = document.getElementById('sessionModal');
  overlay.classList.remove('open');
  modal.classList.remove('open');
}

/* -----------------------------------------------------------------------
   فتح إعدادات الهوت سبوت (Hotspot Settings)
   على أندرويد: Intent مباشر لصفحة إعدادات الهوت سبوت
   على iOS: صفحة الإعدادات العامة (iOS لا يسمح بأعمق)
   ----------------------------------------------------------------------- */
async function openHotspotSettings() {
  const isCapacitor = typeof window.Capacitor !== 'undefined';
  const isAndroid = isCapacitor && window.Capacitor.getPlatform() === 'android';
  const isIOS = isCapacitor && window.Capacitor.getPlatform() === 'ios';

  if (isAndroid) {
    try {
      // ACTION_WIRELESS_SETTINGS يفتح إعدادات الاتصال اللاسلكي مباشرة
      await window.Capacitor.Plugins.App.openUrl({
        url: 'android-settings://com.android.settings.TetherSettings',
      });
    } catch {
      // fallback: إعدادات الواي فاي العامة
      await window.Capacitor.Plugins.App.openUrl({
        url: 'android.settings.WIRELESS_SETTINGS',
      });
    }
  } else if (isIOS) {
    await window.Capacitor.Plugins.App.openUrl({ url: 'App-Prefs:INTERNET_TETHERING' });
  } else {
    // PWA على المتصفح — نعرض تعليمات نصية
    window.showToast('افتح إعدادات الجهاز → الاتصال → نقطة اتصال شخصية', 'info', 5000);
  }
}

// نصدّر للـ window حتى تستطيع ملفات أخرى والـ HTML استدعاءها مباشرة
window.startHostSession = startHostSession;
window.startPeerSession = startPeerSession;
window.openHotspotSettings = openHotspotSettings;
window.closeModal = closeModal;
