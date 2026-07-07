/* =========================================================================
   sync-bridge.js — جسر المزامنة: يربط WebRTC P2P بمنطق البيانات الموجود
   =========================================================================
   هذا الملف يُبقي نفس بروتوكول الرسائل (client-data / record_updated /
   dataset_replaced / reset-session / lock-record / unlock-record) لكن
   بدل إرسالها عبر socket.io → خادم Node، يرسلها عبر DataChannel مباشرة.

   النتيجة: script.js يبقى كما هو بدون تعديل جوهري — فقط نستبدل socket
   بـ deliveryP2P كـ transport layer.
   ========================================================================= */

const p2p = window.deliveryP2P;

/* -----------------------------------------------------------------------
   قفل الشاشة عن النوم أثناء الجلسة النشطة (Wake Lock)
   -------------------------------------------------------------------------
   قفل شاشة الموبايل التلقائي يوقف نشاط الشبكة بالخلفية على أغلب أجهزة
   أندرويد، وهذا سبب شائع جداً لانقطاع اتصال WebRTC رغم بقاء الجهازين على
   نفس الشبكة فعلياً. نطلب Wake Lock فقط أثناء وجود اتصال P2P نشط، ونحرره
   فوراً عند الانقطاع حتى لا نستهلك البطارية بلا داعٍ.
   ----------------------------------------------------------------------- */
let wakeLock = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    // شائع أن يفشل الطلب لو الصفحة بالخلفية وقت الطلب — غير حرج، نتجاهله
    console.warn('تعذّر تفعيل قفل الشاشة (Wake Lock):', e);
  }
}

function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

// Wake Lock يُلغى تلقائياً من المتصفح عند تصغير التطبيق/تبديل التبويب —
// نعيد طلبه فور عودة الظهور إن كان الاتصال لا يزال نشطاً.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && p2p.connected && !wakeLock) {
    requestWakeLock();
  }
});

/* -----------------------------------------------------------------------
   ربط أحداث P2P بمنطق script.js الموجود
   ----------------------------------------------------------------------- */
p2p.addEventListener('channel-open', async () => {
  console.log('P2P channel open — بدء المزامنة الأولية');
  updateP2PStatusUI(true);
  await requestWakeLock();

  // "تعارف" بسيط بين الجهازين: كل طرف يرسل هويته المبسّطة (بدون معلومات
  // حساسة) حتى تظهر بلوحة "الأجهزة المتصلة" باسم مفهوم بدل فراغ دائم.
  p2p.send('device-hello', { deviceId: window.deviceId, deviceName: window.deviceName });

  // نفس منطق performInitialSync في script.js لكن عبر P2P
  if (window.allRecords && window.allRecords.length > 0) {
    p2p.send('client-data', { records: window.allRecords, columns: window.allColumns });
  }
  p2p.send('request-all-data', {});
});

p2p.addEventListener('channel-closed', () => {
  console.log('P2P channel closed');
  updateP2PStatusUI(false);
  renderConnectedDevice(null);
  releaseWakeLock();
  window.showToast?.('انقطع الاتصال بالجهاز الآخر — التطبيق يعمل محلياً', 'info', 3000);
});

p2p.addEventListener('disconnected', () => {
  updateP2PStatusUI(false);
  renderConnectedDevice(null);
  releaseWakeLock();
});

p2p.addEventListener('transfer-incomplete', (event) => {
  const { received, total } = event.detail;
  console.warn(`نقل بيانات غير مكتمل: وصلت ${received} من ${total} قطعة`);
  window.showToast?.(
    `تعذّر إكمال استقبال البيانات (${received}/${total}) — الرجاء إعادة المحاولة`,
    'error',
    4000
  );
});

/* -----------------------------------------------------------------------
   معالجة الرسائل الواردة — نفس نوع الرسائل القديمة لكن بدون خادم
   ----------------------------------------------------------------------- */
p2p.addEventListener('message', async (event) => {
  const { type, payload } = event.detail;

  switch (type) {
    case 'device-hello': {
      renderConnectedDevice({ deviceId: payload?.deviceId, deviceName: payload?.deviceName });
      break;
    }

    case 'client-data': {
      // جهاز آخر يرسل بياناته — ندمج ونرد بنسختنا المدمجة
      if (!payload?.records?.length) break;
      let changed = false;
      for (const record of payload.records) {
        const applied = await window.upsertBySyncId?.(record);
        changed = changed || applied;
      }
      if (payload.columns?.length) {
        await window.setAllColumnsIfMissing?.(payload.columns);
      }
      if (changed) window.renderApp?.();
      // نرد بنسختنا المحدّثة
      if (window.allRecords?.length) {
        p2p.send('send-all-data', { records: window.allRecords, columns: window.allColumns });
      }
      break;
    }

    case 'request-all-data': {
      if (window.allRecords?.length) {
        p2p.send('send-all-data', { records: window.allRecords, columns: window.allColumns });
      }
      break;
    }

    case 'send-all-data': {
      if (!payload?.records) break;
      let changed = false;
      for (const record of (payload.records || [])) {
        const applied = await window.upsertBySyncId?.(record);
        changed = changed || applied;
      }
      if (payload.columns?.length) {
        await window.setAllColumnsIfMissing?.(payload.columns);
      }
      if (changed || payload.records?.length > 0) window.renderApp?.();
      window.showToast?.(`تمت المزامنة — ${payload.records?.length || 0} سجل`, 'success', 2000);
      break;
    }

    case 'record_updated': {
      const applied = await window.upsertBySyncId?.(payload);
      if (applied) window.renderTableRows?.();
      break;
    }

    case 'dataset_replaced': {
      if (!payload?.records) break;
      // نستخدم applyIncomingFullDataset (المعرّفة في script.js) لأنها تحدّث
      // المتغيرات الداخلية الفعلية مباشرة (وليس نسخاً منفصلة)، وتتولى بنفسها
      // منطق طلب التأكيد إن وُجدت بيانات محلية مختلفة.
      await window.applyIncomingFullDataset?.(payload.records, payload.columns, {
        requireConfirmation: true,
      });
      break;
    }

    case 'lock-record': {
      const { syncId, deviceId: ownerId, deviceName: ownerName } = payload;
      if (ownerId !== window.deviceId) {
        window.applyLock?.(syncId, ownerId, ownerName);
      }
      break;
    }

    case 'unlock-record': {
      window.releaseLock?.(payload.syncId);
      break;
    }

    case 'session-reset': {
      await window.resetLocalStateForRemoteReset?.();
      window.showToast?.('بدأ جهاز آخر جلسة جديدة — تم مسح البيانات هنا أيضاً', 'info');
      break;
    }

    default:
      console.warn('رسالة P2P غير معروفة:', type);
  }
});

/* -----------------------------------------------------------------------
   وظائف البث عبر P2P (تُستخدم من script.js بدل socket.emit)
   ----------------------------------------------------------------------- */
window.p2pBroadcastRecordUpdate = (record) => {
  p2p.send('record_updated', record);
};

window.p2pBroadcastFullDataset = (records, columns) => {
  p2p.send('dataset_replaced', { records, columns });
};

window.p2pBroadcastLock = (syncId) => {
  p2p.send('lock-record', {
    syncId,
    deviceId: window.deviceId,
    deviceName: window.deviceName,
  });
};

window.p2pBroadcastUnlock = (syncId) => {
  p2p.send('unlock-record', { syncId });
};

window.p2pBroadcastReset = () => {
  p2p.send('session-reset', {});
};

/* -----------------------------------------------------------------------
   تحديث لوحة "الأجهزة المتصلة" — لدينا اتصال مباشر (P2P) بجهاز واحد فقط،
   فنعرض إما بطاقة الجهاز المتصل حالياً أو رسالة "لا يوجد اتصال".
   ----------------------------------------------------------------------- */
function renderConnectedDevice(peer) {
  const list = document.getElementById('devicesList');
  const emptyMsg = document.getElementById('devicesEmptyMsg');
  const countBadge = document.getElementById('devicesCountBadge');
  if (!list || !emptyMsg) return;

  if (!peer) {
    list.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    if (countBadge) countBadge.classList.add('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
  const safeName = document.createElement('div');
  safeName.textContent = peer.deviceName || 'جهاز غير معروف';

  list.innerHTML = `
    <li class="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-pineLight/50">
      <span class="w-2 h-2 rounded-full bg-delivered shrink-0"></span>
      <span class="font-medium text-sm">${safeName.innerHTML}</span>
    </li>
  `;
  if (countBadge) {
    countBadge.textContent = '1';
    countBadge.classList.remove('hidden');
  }
}

/* -----------------------------------------------------------------------
   تحديث واجهة حالة P2P (شارة الاتصال في الهيدر)
   ----------------------------------------------------------------------- */
function updateP2PStatusUI(isConnected) {
  const dot = document.getElementById('p2pStatusDot');
  const label = document.getElementById('p2pStatusLabel');
  if (!dot || !label) return;

  dot.className = `w-2 h-2 rounded-full ${isConnected ? 'bg-delivered' : 'bg-ink/25'}`;
  label.textContent = isConnected ? 'جلسة نشطة' : 'غير متصل';

  // تحديث شارة زر الجلسة في الهيدر
  const sessionDot = document.getElementById('sessionStatusDot');
  if (sessionDot) {
    sessionDot.className = `absolute -top-1 -left-1 w-2.5 h-2.5 rounded-full border-2 border-pine ${
      isConnected ? 'bg-delivered' : 'bg-ink/0'
    }`;
  }
}
