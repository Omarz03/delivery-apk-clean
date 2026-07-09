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
   QR متحرك (Animated QR) — لتبسيط الرمز بصرياً
   -------------------------------------------------------------------------
   بدل رمز واحد كثيف يحمل كل بيانات WebRTC دفعة واحدة، نقسّم النص إلى قطع
   صغيرة ونعرضها كسلسلة رموز بسيطة تتبدّل تلقائياً وبشكل دائري (تتكرر من
   جديد بعد آخر قطعة). كل قطعة معها رقمها الترتيبي، فترتيب استقبالها غير
   مهم، وأي قطعة تفوت الكاميرا رح ترجع تظهر بالدورة التالية تلقائياً —
   بلا أي تدخل من المستخدم ولا حاجة لإعادة أي شيء يدوياً.
   ----------------------------------------------------------------------- */

/**
 * عرض نص طويل كسلسلة رموز QR بسيطة تتبدّل تلقائياً.
 * @param {string} containerId
 * @param {string} payloadStr النص الكامل (بعد الضغط) المطلوب نقله
 * @param {{ chunkSize?: number, intervalMs?: number }} [options]
 * @returns {{ stop: () => void, totalChunks: number }}
 */
function startAnimatedQR(containerId, payloadStr, options = {}) {
  const chunkSize = options.chunkSize || 180;
  const intervalMs = options.intervalMs || 800;
  const transferId = Math.random().toString(36).slice(2, 8);
  const totalChunks = Math.max(1, Math.ceil(payloadStr.length / chunkSize));

  const frames = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunkData = payloadStr.slice(i * chunkSize, (i + 1) * chunkSize);
    frames.push(JSON.stringify({ id: transferId, i, n: totalChunks, d: chunkData }));
  }

  let currentFrame = 0;
  let stopped = false;

  function renderFrame() {
    if (stopped) return;
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const size = Math.min(window.innerWidth * 0.72, 280);
    new QRCode(container, {
      text: frames[currentFrame],
      width: size,
      height: size,
      colorDark: '#1F2E2A',
      colorLight: '#F4F5F1',
      // مستوى تصحيح أخف (L) لأن الرمز بيتكرر تلقائياً — لا حاجة لتصحيح
      // أخطاء مرتفع، وهذا يخفّف الكثافة البصرية للرمز بشكل ملموس.
      correctLevel: QRCode.CorrectLevel.L,
    });

    // مؤشر بصري صغير لعدد القطعة الحالية (يساعد أثناء الاختبار الميداني)
    const badge = document.createElement('div');
    badge.textContent = `${currentFrame + 1} / ${totalChunks}`;
    badge.style.cssText = 'margin-top:8px;font-size:12px;opacity:0.6;text-align:center;';
    container.appendChild(badge);

    currentFrame = (currentFrame + 1) % totalChunks;
  }

  renderFrame();
  const timer = setInterval(renderFrame, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    totalChunks,
  };
}

/**
 * مسح مستمر لسلسلة رموز QR متحركة وتجميعها حتى اكتمال كل القطع.
 * على عكس startQRScan (يتوقف عند أول رمز)، هذه الدالة تستمر بالمسح وتُعيد
 * تجميع القطع الواردة (بأي ترتيب) حتى تكتمل كل قطع نفس عملية النقل.
 * @param {string} videoContainerId
 * @param {{ onProgress?: (received: number, total: number) => void }} [options]
 * @returns {Promise<string>} النص الكامل المُعاد تجميعه
 */
function startAnimatedQRScan(videoContainerId, options = {}) {
  const { onProgress } = options;

  return new Promise((resolve, reject) => {
    if (activeScanner) {
      activeScanner.stop().catch(() => {});
      activeScanner = null;
    }

    activeScanner = new Html5Qrcode(videoContainerId);
    const config = { fps: 10, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0 };
    const buffers = new Map(); // transferId → مصفوفة القطع

    activeScanner.start(
      { facingMode: 'environment' },
      config,
      (decodedText) => {
        let parsed;
        try {
          parsed = JSON.parse(decodedText);
        } catch {
          return; // إطار غير صالح أو منتصف انتقال — نتجاهله ونستمر بالمسح
        }
        if (typeof parsed.i !== 'number' || typeof parsed.n !== 'number' || !parsed.id) return;

        if (!buffers.has(parsed.id)) {
          buffers.set(parsed.id, new Array(parsed.n).fill(null));
        }
        const buffer = buffers.get(parsed.id);
        buffer[parsed.i] = parsed.d;

        const receivedCount = buffer.filter((c) => c !== null).length;
        onProgress?.(receivedCount, parsed.n);

        if (receivedCount === parsed.n) {
          const fullText = buffer.join('');
          activeScanner.stop()
            .then(() => { activeScanner = null; resolve(fullText); })
            .catch(() => { activeScanner = null; resolve(fullText); });
        }
      },
      () => {} // أخطاء المسح المؤقتة بين الإطارات — تُتجاهل
    ).catch((err) => {
      activeScanner = null;
      reject(err);
    });
  });
}

/* -----------------------------------------------------------------------
   واجهة المضيف (Host Flow)
   خطوة ١: إنشاء Offer وعرضها كـ QR
   خطوة ٢: مسح Answer من التابع
   ----------------------------------------------------------------------- */
async function startHostSession(isReconnect = false) {
  const modal = document.getElementById('sessionModal');
  const title = isReconnect ? 'إعادة الاتصال' : 'إنشاء جلسة تسليم';
  const step1Desc = isReconnect
    ? 'الاتصال السابق انقطع لكن بياناتك محفوظة بالكامل. اطلب من الجهاز الآخر مسح هذا الكود لاستئناف الجلسة.'
    : 'اطلب من الجهاز الآخر فتح التطبيق والضغط على "انضم لجلسة" ثم مسح هذا الكود.';

  modal.innerHTML = buildModalShell(title, `
    <div id="hostStep1" class="session-step">
      <p class="step-label">الخطوة ١ من ٢ — اعرض هذا الكود للتابع</p>
      <p class="step-desc">${step1Desc}</p>
      <div id="hostOfferQR" class="qr-container"><div class="qr-spinner"></div></div>
      <button id="hostScanAnswerBtn" class="btn-primary mt-4 w-full">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
        التابع أظهر كوده — امسحه الآن
      </button>
    </div>

    <div id="hostStep2" class="session-step hidden">
      <p class="step-label">الخطوة ٢ من ٢ — امسح كود التابع</p>
      <div id="hostScanVideo" class="scan-container"></div>
      <p id="hostScanProgress" class="step-hint">وجّه الكاميرا نحو الكود المتحرك على شاشة التابع...</p>
      <button id="hostCancelScanBtn" class="btn-secondary mt-3 w-full">إلغاء</button>
    </div>

    <div id="hostConnected" class="session-step hidden">
      <div class="success-icon">✓</div>
      <p class="step-label text-delivered">${isReconnect ? 'تم استئناف الاتصال بنجاح!' : 'تم الاتصال بنجاح!'}</p>
      <p class="step-desc">الجلسة نشطة. يمكنك الآن إغلاق هذه النافذة والبدء بالتسليم.</p>
      <button id="hostCloseBtn" class="btn-primary mt-4 w-full">ابدأ العمل</button>
    </div>
  `);

  openModal();

  let offerQRController = null;

  try {
    // إنشاء Offer
    const offerJson = await window.deliveryP2P.createOffer();
    offerQRController = startAnimatedQR('hostOfferQR', offerJson);

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
        const answerJson = await startAnimatedQRScan('hostScanVideo', {
          onProgress: (received, total) => {
            const hint = document.getElementById('hostScanProgress');
            if (hint) hint.textContent = `تم استقبال ${received} من ${total} — استمر بتوجيه الكاميرا`;
          },
        });

        const hint = document.getElementById('hostScanProgress');
        if (hint) hint.textContent = 'تم استلام الكود ✓ — جارٍ إكمال الاتصال...';

        await window.deliveryP2P.receiveAnswer(answerJson);

        // انتظار فتح DataChannel
        await waitForChannel();
        offerQRController?.stop();

        document.getElementById('hostStep2').classList.add('hidden');
        document.getElementById('hostConnected').classList.remove('hidden');
        document.getElementById('hostCloseBtn').addEventListener('click', closeModal);

        window.showToast('تم الاتصال — الجلسة نشطة', 'success');
      } catch (err) {
        window.showToast(connectionErrorMessage(err), 'error', 6000);
        document.getElementById('hostStep2').classList.add('hidden');
        document.getElementById('hostStep1').classList.remove('hidden');
      }
    });

  } catch (err) {
    offerQRController?.stop();
    closeModal();
    window.showToast('تعذّر إنشاء الجلسة. تأكد أن المتصفح يدعم WebRTC.', 'error');
  }
}

/* -----------------------------------------------------------------------
   واجهة التابع (Peer Flow)
   خطوة ١: مسح QR المضيف
   خطوة ٢: عرض Answer كـ QR للمضيف
   ----------------------------------------------------------------------- */
async function startPeerSession(isReconnect = false) {
  const modal = document.getElementById('sessionModal');
  const title = isReconnect ? 'إعادة الاتصال' : 'الانضمام لجلسة';
  const step1Desc = isReconnect
    ? 'الاتصال السابق انقطع لكن بياناتك محفوظة بالكامل. وجّه الكاميرا نحو الكود المتحرك على شاشة الجهاز الرئيسي لاستئناف الجلسة.'
    : 'وجّه الكاميرا نحو الكود المتحرك الظاهر على شاشة الجهاز الرئيسي.';

  modal.innerHTML = buildModalShell(title, `
    <div id="peerStep1" class="session-step">
      <p class="step-label">الخطوة ١ من ٢ — امسح كود المضيف</p>
      <p class="step-desc">${step1Desc}</p>
      <div id="peerScanVideo" class="scan-container"></div>
      <p id="peerScanProgress" class="step-hint">استمر بتوجيه الكاميرا نحو الكود...</p>
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
      <p class="step-label text-delivered">${isReconnect ? 'تم استئناف الاتصال بنجاح!' : 'تم الاتصال بنجاح!'}</p>
      <p class="step-desc">الجلسة نشطة. يمكنك الآن إغلاق هذه النافذة والبدء بالتسليم.</p>
      <button id="peerCloseBtn" class="btn-primary mt-4 w-full">ابدأ العمل</button>
    </div>
  `);

  openModal();

  document.getElementById('peerCancelBtn').addEventListener('click', () => {
    stopQRScan();
    closeModal();
  });

  let answerQRController = null;

  try {
    // مسح Offer من المضيف
    const offerJson = await startAnimatedQRScan('peerScanVideo', {
      onProgress: (received, total) => {
        const hint = document.getElementById('peerScanProgress');
        if (hint) hint.textContent = `تم استقبال ${received} من ${total} — استمر بتوجيه الكاميرا`;
      },
    });

    document.getElementById('peerStep1').classList.add('hidden');
    document.getElementById('peerStep2').classList.remove('hidden');

    // إنشاء Answer وعرضها كـ QR متحرك
    const answerJson = await window.deliveryP2P.createAnswer(offerJson);
    answerQRController = startAnimatedQR('peerAnswerQR', answerJson);

    // انتظار فتح DataChannel (المضيف يمسح الـ Answer ويكمل الـ Handshake)
    await waitForChannel();
    answerQRController?.stop();

    document.getElementById('peerStep2').classList.add('hidden');
    document.getElementById('peerConnected').classList.remove('hidden');
    document.getElementById('peerCloseBtn').addEventListener('click', closeModal);

    window.showToast('تم الاتصال — الجلسة نشطة', 'success');

  } catch (err) {
    answerQRController?.stop();
    stopQRScan();
    closeModal();
    const msg = err?.name === 'NotAllowedError'
      ? 'لا يوجد إذن للكاميرا. فعّل الإذن من إعدادات التطبيق ثم أعد المحاولة.'
      : connectionErrorMessage(err);
    window.showToast(msg, 'error', 6000);
  }
}

/* -----------------------------------------------------------------------
   انتظار فتح DataChannel (مع timeout)
   -------------------------------------------------------------------------
   15 ثانية كافية جداً لشبكة محلية (Wi-Fi/Hotspot) — لو لم يتصل خلالها فعلياً
   لن يتصل بعد 30 ثانية أيضاً؛ تقصير المهلة يعطي شعوراً أسرع وأوضح بالخطأ
   بدل صمت طويل يبدو للمستخدم وكأن التطبيق لا يستجيب إطلاقاً.
   ----------------------------------------------------------------------- */
function waitForChannel() {
  return new Promise((resolve, reject) => {
    if (window.deliveryP2P.connected) { resolve(); return; }

    const timeout = setTimeout(() => {
      reject(new Error('TIMEOUT'));
    }, 15000);

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

/**
 * رسالة خطأ تشخيصية لفشل إكمال الاتصال — أشيع سبب فعلياً هو أن أحد
 * الجهازين آيفون ولم يمنح إذن "الشبكة المحلية" لسفاري (أو أن الجهازين
 * ليسا على نفس شبكة الواي فاي فعلياً)، فنذكر هذا صراحة بدل رسالة عامة.
 */
function connectionErrorMessage(err) {
  if (err?.message === 'TIMEOUT') {
    return 'تعذّر إكمال الاتصال. تأكد أن الجهازين على نفس شبكة الواي فاي، وإن كان أحدهما آيفون تأكد من تفعيل إذن "الشبكة المحلية" لسفاري من: الإعدادات ← الخصوصية والأمان ← الشبكة المحلية. ثم أعد المحاولة.';
  }
  return 'تعذّر إكمال الاتصال. حاول مجدداً.';
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
