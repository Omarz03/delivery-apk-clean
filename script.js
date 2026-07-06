/* =========================================================================
   script.js — النواة (Core Module)
   إدارة عمليات التسليم الميداني: استيراد Excel، تخزين دائم عبر IndexedDB،
   بحث فوري، تعديل حالة الاستلام عبر نافذة جانبية، وتصدير محدث.
   ========================================================================= */

/* -------------------------------------------------------------------------
   1) إعدادات قاعدة البيانات (IndexedDB)
   -------------------------------------------------------------------------
   نستخدم مخزنين (Object Stores):
     - "beneficiaries": يحتوي كل صف مستورد من إكسل + حقول الحالة الميدانية.
     - "meta": يحتوي بيانات وصفية بسيطة (مثل: ترتيب الأعمدة الأصلية من آخر
       استيراد)، حتى نستطيع إعادة بناء الجدول والتصدير بنفس ترتيب الأعمدة.
   ------------------------------------------------------------------------- */
const DB_NAME = 'DeliveryCoreDB';
const DB_VERSION = 2; // رُفع الإصدار لإضافة فهرس __syncId اللازم للمزامنة بين الأجهزة
const STORE_RECORDS = 'beneficiaries';
const STORE_META = 'meta';

let db = null;          // مرجع اتصال قاعدة البيانات المفتوح
let allColumns = [];    // أسماء الأعمدة كما وردت من ملف إكسل (بالترتيب)
let allRecords = [];    // نسخة في الذاكرة من كل السجلات (لتسريع البحث والعرض)
let currentSearch = ''; // نص البحث الحالي
let openRecordId = null;
let socket = null;       // legacy — kept for compatibility; actual sync via window.deliveryP2P
let deviceId = null;
let deviceName = null;   // اسم مبسّط يُعرض لبقية الأجهزة (مثال: "موبايل • a1b2")
const lockedRecords = new Map(); // syncId → { deviceId, deviceName, expiresAt } لسجلات يعدّلها جهاز آخر الآن
let lockExpiryTimers = new Map(); // syncId → معرّف setTimeout محلي لفكّ القفل احتياطياً بعد 30 ثانية

/**
 * فتح (أو إنشاء عند أول استخدام) قاعدة بيانات IndexedDB.
 * IndexedDB قاعدة بيانات تعمل داخل المتصفح وتبقى محفوظة على القرص حتى بعد
 * إغلاق المتصفح أو إعادة تشغيل الجهاز — وهذا ما يجعلها مناسبة لتخزين بيانات
 * ميدانية لا يجوز أن تُفقد.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // يُستدعى فقط عند إنشاء القاعدة لأول مرة أو عند رفع رقم الإصدار (VERSION).
    // هنا نعرّف "شكل" التخزين: المخازن (stores) والفهارس (indexes).
    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      let store;
      if (!database.objectStoreNames.contains(STORE_RECORDS)) {
        // keyPath: 'id' مع autoIncrement يعني أن كل سجل يأخذ رقماً تسلسلياً
        // تلقائياً كمعرّف فريد محلياً على هذا الجهاز فقط، بدون أن نحتاج لتوليده يدوياً.
        store = database.createObjectStore(STORE_RECORDS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        // فهرس اختياري على حالة الاستلام يسهّل لاحقاً عمل إحصائيات سريعة
        store.createIndex('by_status', '__status', { unique: false });
      } else {
        // القاعدة موجودة مسبقاً من إصدار سابق — نصل إليها ضمن نفس معاملة الترقية
        store = event.target.transaction.objectStore(STORE_RECORDS);
      }

      // __syncId هو معرّف ثابت وفريد يبقى كما هو عبر كل الأجهزة لنفس السجل
      // (بخلاف 'id' التلقائي الذي يختلف من جهاز لآخر) — نعتمد عليه للمزامنة.
      if (!store.indexNames.contains('by_syncId')) {
        store.createIndex('by_syncId', '__syncId', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_META)) {
        database.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * تفريغ مخزن السجلات الحالي، ثم إدخال دفعة جديدة من السجلات دفعة واحدة
 * ضمن معاملة (transaction) واحدة لضمان تناسق البيانات (إما أن تُحفظ كلها
 * أو لا يُحفظ شيء في حال حدث خطأ).
 * @param {Array<Object>} records
 * @param {Array<string>} columns
 */
function replaceAllRecords(records, columns) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDS, STORE_META], 'readwrite');
    const recordsStore = tx.objectStore(STORE_RECORDS);
    const metaStore = tx.objectStore(STORE_META);

    recordsStore.clear();
    records.forEach((record) => recordsStore.add(record));
    metaStore.put({ key: 'columns', value: columns });

    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });
}

/** قراءة كل السجلات المخزّنة حالياً في IndexedDB. */
function getAllRecords() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const request = tx.objectStore(STORE_RECORDS).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/** قراءة قيمة وصفية (مثل ترتيب الأعمدة) من مخزن meta. */
function getMeta(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const request = tx.objectStore(STORE_META).get(key);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = (event) => reject(event.target.error);
  });
}

/** تحديث سجل موجود مسبقاً (يُستخدم عند حفظ التعديلات من النافذة الجانبية). */
function updateRecord(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    tx.objectStore(STORE_RECORDS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });
}

/** حفظ قيمة وصفية بسيطة (مثل عنوان خادم المزامنة الأخير) في مخزن meta. */
function setMeta(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });
}

/**
 * إضافة سجل جديد واحد وإرجاع المعرّف المحلي (id) الذي ولّدته IndexedDB تلقائياً.
 * تُستخدم عند استقبال سجل من جهاز آخر عبر المزامنة لا يوجد له مثيل محلي بعد.
 */
function addSingleRecord(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const request = tx.objectStore(STORE_RECORDS).add(record);
    request.onsuccess = () => resolve(request.result); // المفتاح التلقائي الجديد
    request.onerror = (event) => reject(event.target.error);
  });
}

/** مسح كامل البيانات (السجلات + الأعمدة المحفوظة) — يُستخدم في "بدء من جديد". */
function clearAllData() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDS, STORE_META], 'readwrite');
    tx.objectStore(STORE_RECORDS).clear();
    tx.objectStore(STORE_META).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });
}

/* -------------------------------------------------------------------------
   2) عناصر الواجهة (DOM References)
   ------------------------------------------------------------------------- */
const el = {
  fileInput: document.getElementById('fileInput'),
  resetBtn: document.getElementById('resetBtn'),
  importStatus: document.getElementById('importStatus'),
  emptyState: document.getElementById('emptyState'),
  emptyStateStartBtn: document.getElementById('emptyStateStartBtn'),
  sessionPanel: document.getElementById('sessionPanel'),
  sessionPanelOverlay: document.getElementById('sessionPanelOverlay'),
  sessionPanelToggle: document.getElementById('sessionPanelToggle'),
  sessionPanelClose: document.getElementById('sessionPanelClose'),
  sessionStatusDot: document.getElementById('sessionStatusDot'),
  dataSection: document.getElementById('dataSection'),
  searchInput: document.getElementById('searchInput'),
  tableHead: document.getElementById('tableHead'),
  tableBody: document.getElementById('tableBody'),
  noResults: document.getElementById('noResults'),
  exportBtn: document.getElementById('exportBtn'),
  connectionDot: document.getElementById('connectionDot'),
  connectionLabel: document.getElementById('connectionLabel'),
  drawer: document.getElementById('drawer'),
  drawerOverlay: document.getElementById('drawerOverlay'),
  drawerOriginalData: document.getElementById('drawerOriginalData'),
  drawerClose: document.getElementById('drawerClose'),
  drawerCancel: document.getElementById('drawerCancel'),
  drawerSave: document.getElementById('drawerSave'),
  statusToggle: document.getElementById('statusToggle'),
  statusLabel: document.getElementById('statusLabel'),
  receiverInput: document.getElementById('receiverInput'),
  notesInput: document.getElementById('notesInput'),
  syncDot: document.getElementById('syncDot'),
  syncLabel: document.getElementById('syncLabel'),
  syncMessage: document.getElementById('syncMessage'),
  // شريط إحصائيات التسليم (العداد الحي)
  counterBar: document.getElementById('counterBar'),
  deliveredCount: document.getElementById('deliveredCount'),
  totalCount: document.getElementById('totalCount'),
  progressFill: document.getElementById('progressFill'),
  progressPercent: document.getElementById('progressPercent'),
  // لوحة الأجهزة المتصلة
  devicesPanel: document.getElementById('devicesPanel'),
  devicesPanelOverlay: document.getElementById('devicesPanelOverlay'),
  devicesPanelToggle: document.getElementById('devicesPanelToggle'),
  devicesPanelClose: document.getElementById('devicesPanelClose'),
  devicesCountBadge: document.getElementById('devicesCountBadge'),
  devicesList: document.getElementById('devicesList'),
  devicesEmptyMsg: document.getElementById('devicesEmptyMsg'),
  // حاوية الإشعارات المنبثقة
  toastContainer: document.getElementById('toastContainer'),
  // نافذة اختيار عمود المعرّف الفريد
  identifierModal: document.getElementById('identifierModal'),
  identifierModalOverlay: document.getElementById('identifierModalOverlay'),
  identifierColumnsList: document.getElementById('identifierColumnsList'),
  identifierConfirmBtn: document.getElementById('identifierConfirmBtn'),
  identifierSkipBtn: document.getElementById('identifierSkipBtn'),
};

/* -------------------------------------------------------------------------
   3) أدوات مساعدة
   ------------------------------------------------------------------------- */

/**
 * تطبيع نص عربي لأغراض البحث فقط (لا يُستخدم للتخزين أو العرض):
 * يوحّد صور الألف والهمزة والتاء المربوطة، ويحذف التشكيل، حتى يجد البحث
 * تطابقاً حتى لو اختلف المستخدم في كتابة "أ/إ/ا" أو "ة/ه".
 */
function normalizeArabic(text) {
  return String(text)
    .toLowerCase()
    .replace(/[أإآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0640]/g, '') // تشكيل وتطويل
    .trim();
}

/**
 * تطبيع قيمة معرّف (مثل رقم الهوية) قبل استخدامها في بناء __syncId: تحويل
 * الأرقام العربية-الهندية (٠-٩) إلى أرقام غربية، وحذف الفراغات الزائدة.
 * الهدف: نفس رقم الهوية يُنتج نفس المعرّف دائماً، بغض النظر عن اختلافات
 * الكتابة الشكلية بين ملف وآخر أو جهاز وآخر.
 */
function normalizeIdValue(value) {
  const arabicIndicDigits = '٠١٢٣٤٥٦٧٨٩';
  return String(value ?? '')
    .trim()
    .replace(/[٠-٩]/g, (d) => String(arabicIndicDigits.indexOf(d)))
    .replace(/\s+/g, '');
}

/**
 * محاولة اكتشاف عمود "المعرّف الفريد" (مثل رقم الهوية) تلقائياً من بين
 * أعمدة الملف المستورد: نفضّل عموداً باسم يوحي بذلك (هوية، رقم وطني...)
 * وتكون قيمه شبه فريدة عبر كل الصفوف (95%+). إن لم نجد عموداً مناسباً
 * بثقة كافية، نعيد null ونطلب من المستخدم الاختيار يدوياً.
 */
function detectIdentifierColumn(rows, columns) {
  const nameHints = /(هوي|وطني|قيد|كود|رقم[_\s]*(ال)?مستفيد|national|id[_\s]*number|identifier)/i;
  let best = null;
  let bestScore = 0;

  for (const col of columns) {
    const values = rows.map((r) => normalizeIdValue(r[col]));
    const nonEmpty = values.filter((v) => v !== '');
    if (nonEmpty.length < rows.length * 0.8) continue; // فراغات كثيرة، غير مناسب كمعرّف

    const uniqueCount = new Set(nonEmpty).size;
    const uniqueness = uniqueCount / nonEmpty.length;
    if (uniqueness < 0.95) continue; // لازم يكون شبه فريد لكل صف

    let score = uniqueness;
    if (nameHints.test(col)) score += 1; // تفضيل قوي لعمود اسمه يوحي بأنه معرّف
    if (score > bestScore) {
      bestScore = score;
      best = col;
    }
  }

  return best;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * توليد معرّف فريد ثابت (__syncId) يُستخدم للتعرّف على "نفس السجل" عبر
 * أجهزة مختلفة، بخلاف 'id' التلقائي في IndexedDB الذي يختلف من جهاز لآخر.
 */
function generateSyncId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // بديل بسيط للمتصفحات القديمة التي لا تدعم crypto.randomUUID
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * تحديد/توليد هوية ثابتة لهذا الجهاز (deviceId + اسم مبسّط للعرض)، وحفظها
 * في IndexedDB حتى تبقى نفسها بين الجلسات. تُستخدم في: قفل السجلات (لمعرفة
 * من صاحب القفل) ولوحة الأجهزة المتصلة (لعرض اسم مفهوم بدل معرّف عشوائي).
 */
async function ensureDeviceIdentity() {
  let storedId = await getMeta('deviceId');
  let storedName = await getMeta('deviceName');

  if (!storedId) {
    storedId = generateSyncId();
    await setMeta('deviceId', storedId);
  }

  if (!storedName) {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const shortSuffix = storedId.slice(0, 4);
    storedName = `${isMobile ? 'موبايل' : 'لابتوب/كمبيوتر'} • ${shortSuffix}`;
    await setMeta('deviceName', storedName);
  }

  deviceId = storedId;
  deviceName = storedName;
}

/**
 * عرض إشعار منبثق (Toast) قصير في أسفل الشاشة، يختفي تلقائياً. يُستخدم
 * لتنبيهات المزامنة والأجهزة (انضمام/فصل جهاز، محاولة تعديل سجل مقفل...).
 */
function showToast(message, tone = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast--${tone}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);

  // إضافة كلاس "show" بعد إطار واحد لتفعيل حركة الظهور الانتقالية
  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

function setImportStatus(message, tone = 'neutral') {
  const colors = {
    neutral: 'text-ink/50',
    success: 'text-delivered',
    error: 'text-pending',
  };
  el.importStatus.className = `text-xs mt-3 font-medium ${colors[tone]}`;
  el.importStatus.textContent = message;
}

function setSyncMessage(message, tone = 'neutral') {
  const colors = {
    neutral: 'text-ink/45',
    success: 'text-delivered',
    error: 'text-pending',
  };
  el.syncMessage.className = `text-xs mt-2.5 font-medium ${colors[tone]}`;
  el.syncMessage.textContent = message;
}

/* -------------------------------------------------------------------------
   4) لوحة الجلسة (استيراد + مزامنة) — تُفتح وتُغلق من زر "الجلسة" بالأعلى
   -------------------------------------------------------------------------
   بدل أن يبقى قسما الاستيراد والمزامنة ظاهرين طوال الوقت فوق الجدول، جُمعا
   في لوحة جانبية واحدة تُفتح عند الحاجة فقط (بدء جلسة جديدة، أو التحقق من
   حالة الاتصال)، لتبقى الشاشة الرئيسية مخصصة للجدول والعمل الفعلي.
   وبنفس الفكرة: لوحة "الأجهزة المتصلة" تُفتح من زر منفصل بجانبه. اللوحتان
   تتشاركان نفس جهة الانزلاق، لذا نضمن أن فتح إحداهما يُغلق الأخرى تلقائياً.
   ------------------------------------------------------------------------- */
function openSessionPanel() {
  closeDevicesPanel();
  el.sessionPanel.classList.add('open');
  el.sessionPanel.setAttribute('aria-hidden', 'false');
  el.sessionPanelOverlay.classList.add('open');
}

function closeSessionPanel() {
  el.sessionPanel.classList.remove('open');
  el.sessionPanel.setAttribute('aria-hidden', 'true');
  el.sessionPanelOverlay.classList.remove('open');
}

el.sessionPanelToggle.addEventListener('click', () => {
  const isOpen = el.sessionPanel.classList.contains('open');
  if (isOpen) closeSessionPanel();
  else openSessionPanel();
});
el.sessionPanelClose.addEventListener('click', closeSessionPanel);
el.sessionPanelOverlay.addEventListener('click', closeSessionPanel);
el.emptyStateStartBtn.addEventListener('click', openSessionPanel);

function openDevicesPanel() {
  closeSessionPanel();
  el.devicesPanel.classList.add('open');
  el.devicesPanel.setAttribute('aria-hidden', 'false');
  el.devicesPanelOverlay.classList.add('open');
}

function closeDevicesPanel() {
  el.devicesPanel.classList.remove('open');
  el.devicesPanel.setAttribute('aria-hidden', 'true');
  el.devicesPanelOverlay.classList.remove('open');
}

el.devicesPanelToggle.addEventListener('click', () => {
  const isOpen = el.devicesPanel.classList.contains('open');
  if (isOpen) closeDevicesPanel();
  else openDevicesPanel();
});
el.devicesPanelClose.addEventListener('click', closeDevicesPanel);
el.devicesPanelOverlay.addEventListener('click', closeDevicesPanel);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (el.sessionPanel.classList.contains('open')) closeSessionPanel();
  if (el.devicesPanel.classList.contains('open')) closeDevicesPanel();
});

/* -------------------------------------------------------------------------
   5) استيراد ملف Excel
   ------------------------------------------------------------------------- */
let pendingImport = null; // { rows, columns, fileName } بانتظار اختيار عمود المعرّف

el.fileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  if (allRecords.length > 0) {
    const confirmed = window.confirm(
      'يوجد بيانات محفوظة مسبقاً. استيراد ملف جديد سيستبدل كل البيانات الحالية. هل تريد المتابعة؟'
    );
    if (!confirmed) {
      el.fileInput.value = '';
      return;
    }
  }

  setImportStatus('جاري قراءة الملف...', 'neutral');

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];

    // sheet_to_json يحوّل كل صف إلى كائن مفاتيحه = عناوين الأعمدة (الصف الأول)
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      setImportStatus('الملف لا يحتوي على بيانات قابلة للقراءة.', 'error');
      return;
    }

    const columns = Object.keys(rows[0]);
    const detectedColumn = detectIdentifierColumn(rows, columns);

    if (detectedColumn) {
      // اكتشاف واثق لعمود المعرّف (مثل رقم الهوية) → نتابع مباشرة بدون إزعاج المستخدم
      await finalizeImport(rows, columns, detectedColumn, file.name);
    } else {
      // لم نجد عموداً مناسباً بثقة كافية → نطلب من المستخدم الاختيار يدوياً
      pendingImport = { rows, columns, fileName: file.name };
      openIdentifierModal(columns);
    }
  } catch (error) {
    console.error(error);
    setImportStatus('تعذّرت قراءة الملف. تأكد أنه بصيغة Excel صحيحة (.xlsx أو .xls).', 'error');
  } finally {
    el.fileInput.value = ''; // للسماح برفع نفس الملف مرة أخرى إن احتاج الأمر
  }
});

/**
 * الاستيراد الفعلي بعد تحديد عمود المعرّف (أو تجاوزه). بناء __syncId من
 * قيمة عمود المعرّف (بعد تطبيعها) يضمن أن استيراد نفس الملف — من نفس
 * الجهاز أو جهاز آخر، الآن أو لاحقاً — يُنتج نفس المعرّفات دائماً، فلا
 * تتكرر بيانات المستفيدين عند المزامنة أو إعادة الاستيراد.
 */
async function finalizeImport(rows, columns, identifierColumn, fileName) {
  const now = Date.now();
  const usedFallbackIds = []; // صفوف اضطررنا نعطيها معرّفاً عشوائياً (قيمة معرّف فارغة أو مكررة)
  const seenKeys = new Set();

  const preparedRecords = rows.map((row, index) => {
    let syncId;
    if (identifierColumn) {
      const key = normalizeIdValue(row[identifierColumn]);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        syncId = `key:${identifierColumn}:${key}`;
      } else {
        // قيمة فارغة أو مكررة داخل نفس الملف — لا يمكن الاعتماد عليها كمعرّف فريد لهذا الصف
        usedFallbackIds.push(index + 2); // +2 لتقريب رقم الصف كما يظهر في إكسل (يشمل صف العناوين)
        syncId = generateSyncId();
      }
    } else {
      syncId = generateSyncId();
    }

    return {
      ...row,
      __status: false,
      __receiver: '',
      __notes: '',
      __syncId: syncId,
      __updatedAt: now,
    };
  });

  await replaceAllRecords(preparedRecords, columns);
  if (identifierColumn) await setMeta('identifierColumn', identifierColumn);

  allColumns = columns;
  allRecords = await getAllRecords();
  currentSearch = '';
  el.searchInput.value = '';

  renderApp();

  let statusMessage = `تم استيراد ${rows.length} سجل بنجاح من "${fileName}".`;
  if (identifierColumn) {
    statusMessage += ` (المعرّف الفريد: عمود "${identifierColumn}")`;
  }
  if (usedFallbackIds.length > 0) {
    statusMessage += ` تنبيه: ${usedFallbackIds.length} صف بدون معرّف موثوق (قيمة فارغة أو مكررة) — قد يتكرر عند إعادة الاستيراد لاحقاً.`;
  }
  setImportStatus(statusMessage, usedFallbackIds.length > 0 ? 'neutral' : 'success');

  // إعلام الأجهزة الأخرى المتصلة أن هناك مجموعة بيانات جديدة بالكامل
  broadcastFullDataset(preparedRecords, columns);

  // إغلاق لوحة الجلسة تلقائياً بعد استيراد ناجح ليرى المستخدم الجدول فوراً
  setTimeout(closeSessionPanel, 900);
}

/* -------------------------------------------------------------------------
   نافذة اختيار عمود المعرّف الفريد (تظهر فقط عند تعذّر الاكتشاف التلقائي)
   ------------------------------------------------------------------------- */
function openIdentifierModal(columns) {
  el.identifierColumnsList.innerHTML = columns
    .map(
      (col, i) => `
      <label class="flex items-center gap-2.5 border border-line rounded-xl px-3.5 py-2.5 cursor-pointer hover:bg-paper transition-colors">
        <input type="radio" name="identifierColumn" value="${escapeHtml(col)}" ${i === 0 ? 'checked' : ''} class="accent-clay" />
        <span class="text-sm font-medium text-ink">${escapeHtml(col)}</span>
      </label>`
    )
    .join('');

  el.identifierModal.classList.remove('hidden');
  el.identifierModal.classList.add('flex');
  el.identifierModalOverlay.classList.add('open');
}

function closeIdentifierModal() {
  el.identifierModal.classList.add('hidden');
  el.identifierModal.classList.remove('flex');
  el.identifierModalOverlay.classList.remove('open');
  pendingImport = null;
}

el.identifierConfirmBtn.addEventListener('click', async () => {
  if (!pendingImport) return;
  const selected = document.querySelector('input[name="identifierColumn"]:checked');
  const { rows, columns, fileName } = pendingImport;
  closeIdentifierModal();
  await finalizeImport(rows, columns, selected ? selected.value : null, fileName);
});

el.identifierSkipBtn.addEventListener('click', async () => {
  if (!pendingImport) return;
  const { rows, columns, fileName } = pendingImport;
  closeIdentifierModal();
  await finalizeImport(rows, columns, null, fileName);
});

el.identifierModalOverlay.addEventListener('click', closeIdentifierModal);

/* -------------------------------------------------------------------------
   6) "بدء من جديد" — مسح كل البيانات
   ------------------------------------------------------------------------- */
el.resetBtn.addEventListener('click', async () => {
  const isP2PConnected = window.deliveryP2P?.connected;
  const willAlsoResetOthers = isP2PConnected;
  const warning = willAlsoResetOthers
    ? 'سيتم حذف كل البيانات نهائياً من هذا الجهاز وبقية الأجهزة المتصلة. هل أنت متأكد؟'
    : 'سيتم حذف كل البيانات المحفوظة نهائياً من هذا الجهاز. هل أنت متأكد؟';
  const confirmed = window.confirm(warning);
  if (!confirmed) return;

  await clearAllData();
  allRecords = [];
  allColumns = [];
  currentSearch = '';
  el.searchInput.value = '';
  lockedRecords.clear();
  renderApp();
  setImportStatus('تم حذف كل البيانات — يمكنك الآن بدء جلسة جديدة.', 'neutral');

  // إعلام الخادم وبقية الأجهزة المتصلة ببدء جلسة جديدة بالكامل، حتى لا
  // تبقى بيانات قديمة على الخادم تتسبب لاحقاً بدمج غير مقصود (تكرار).
  window.p2pBroadcastReset?.();
});

/* -------------------------------------------------------------------------
   7) عرض الجدول والبحث
   ------------------------------------------------------------------------- */

function renderApp() {
  const hasData = allRecords.length > 0;

  el.emptyState.classList.toggle('hidden', hasData);
  el.dataSection.classList.toggle('hidden', !hasData);
  el.resetBtn.classList.toggle('hidden', !hasData);

  if (hasData) {
    buildTableHead();
    renderTableRows(); // renderTableRows تستدعي updateDeliveryCounter داخلياً
  } else {
    updateDeliveryCounter();
  }
}

/**
 * تحديث شريط "تم تسليم X من أصل Y" فوراً — يُستدعى من renderTableRows() في
 * كل مرة تتغيّر فيها البيانات (استيراد، تعديل حالة، تحديث وارد من جهاز آخر).
 */
function updateDeliveryCounter() {
  const total = allRecords.length;
  const delivered = allRecords.filter((r) => r.__status).length;
  const percent = total > 0 ? Math.round((delivered / total) * 100) : 0;

  el.deliveredCount.textContent = delivered;
  el.totalCount.textContent = total;
  el.progressFill.style.width = `${percent}%`;
  el.progressPercent.textContent = `${percent}%`;
  el.counterBar.classList.toggle('hidden', total === 0);
}

function buildTableHead() {
  const headerCells = ['الحالة', ...allColumns]
    .map((col) => `<th>${escapeHtml(col)}</th>`)
    .join('');
  el.tableHead.innerHTML = `<tr>${headerCells}</tr>`;
}

function getFilteredRecords() {
  // بحث برقم الصف يتجاوز البحث النصي تماماً — يعيد صفاً واحداً بالضبط
  if (currentRowFilter !== null) {
    const idx = currentRowFilter - 1;
    return allRecords[idx] ? [allRecords[idx]] : [];
  }
  if (!currentSearch) return allRecords;
  const needle = normalizeArabic(currentSearch);
  return allRecords.filter((record) =>
    allColumns.some((col) => normalizeArabic(record[col]).includes(needle))
  );
}

function renderTableRows() {
  const filtered = getFilteredRecords();
  el.noResults.classList.toggle('hidden', filtered.length !== 0);

  el.tableBody.innerHTML = filtered
    .map((record) => {
      // إن كان السجل مقفلاً من جهاز آخر يعدّله الآن، نعرض شارة القفل بدل
      // شارة الحالة العادية، ونضيف تنسيقاً بصرياً مميزاً للصف بالكامل.
      const lock = lockedRecords.get(record.__syncId);
      const isLockedByOther = Boolean(lock);

      const statusCell = isLockedByOther
        ? `<span class="lock-icon-cell" data-tip="قيد التعديل: ${escapeHtml(lock.deviceName)}" aria-label="قيد التعديل">
             <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
           </span>`
        : record.__status
        ? `<span class="status-badge status-badge--delivered" data-tip="تم الاستلام" aria-label="تم الاستلام"></span>`
        : `<span class="status-badge status-badge--pending" data-tip="لم يتم الاستلام" aria-label="لم يتم الاستلام"></span>`;

      const dataCells = allColumns
        .map((col) => `<td>${escapeHtml(record[col])}</td>`)
        .join('');

      const lockedClass = isLockedByOther ? ' row-locked' : '';
      return `<tr data-id="${record.id}" class="${lockedClass}">${`<td>${statusCell}</td>`}${dataCells}</tr>`;
    })
    .join('');

  updateDeliveryCounter();
}

// تفويض الحدث (Event Delegation): بدل ربط مستمع نقر بكل صف على حدة،
// نستمع للنقر على الجدول كاملاً ونحدد الصف المقصود — أداء أفضل مع آلاف الصفوف.
el.tableBody.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;

  const id = Number(row.dataset.id);
  const record = allRecords.find((r) => r.id === id);
  const lock = record && lockedRecords.get(record.__syncId);

  if (lock) {
    // الموبايل ما عنده hover/tooltip → نعرض toast بالنقر مباشرة على أي مكان
    // بالصف المقفول (اللابتوب عنده الـ tooltip بالـ CSS)
    showToast(`قيد التعديل من: ${lock.deviceName}`, 'error', 2500);
    return;
  }

  openDrawer(id);
});

/* -------------------------------------------------------------------------
   بحث رقم الصف + زر المسح
   رقم الصف هو الترتيب الظاهر بالجدول (١-based)، بغض النظر عن البحث العام.
   يفيد ميدانياً: "اذهب للصف ١٣٢" أسرع من البحث باسم طويل.
   ------------------------------------------------------------------------- */
const elRowSearch = {
  toggle: document.getElementById('rowSearchToggle'),
  wrapper: document.getElementById('rowSearchWrapper'),
  input: document.getElementById('rowSearchInput'),
  clearBtn: document.getElementById('clearSearchBtn'),
};

let currentRowFilter = null; // رقم الصف المحدد (١-based) أو null

function updateClearBtnVisibility() {
  const hasSearch = Boolean(currentSearch || currentRowFilter);
  elRowSearch.clearBtn.classList.toggle('hidden', !hasSearch);
}

elRowSearch.toggle.addEventListener('click', () => {
  const isOpen = !elRowSearch.wrapper.classList.contains('hidden');
  elRowSearch.wrapper.classList.toggle('hidden', isOpen);
  if (!isOpen) {
    elRowSearch.input.focus();
  } else {
    currentRowFilter = null;
    elRowSearch.input.value = '';
    renderTableRows();
    updateClearBtnVisibility();
  }
});

elRowSearch.input.addEventListener('input', () => {
  const val = parseInt(elRowSearch.input.value, 10);
  currentRowFilter = (!isNaN(val) && val > 0) ? val : null;
  renderTableRows();
  updateClearBtnVisibility();
});

elRowSearch.clearBtn.addEventListener('click', () => {
  currentSearch = '';
  currentRowFilter = null;
  el.searchInput.value = '';
  elRowSearch.input.value = '';
  elRowSearch.wrapper.classList.add('hidden');
  renderTableRows();
  updateClearBtnVisibility();
});

el.searchInput.addEventListener('input', (event) => {
  currentSearch = event.target.value;
  renderTableRows();
  updateClearBtnVisibility();
});

/* -------------------------------------------------------------------------
   8) النافذة الجانبية (Drawer): عرض التفاصيل وتعديل الحالة
   ------------------------------------------------------------------------- */

function openDrawer(id) {
  const record = allRecords.find((r) => r.id === id);
  if (!record) return;

  openRecordId = id;

  el.drawerOriginalData.innerHTML = allColumns
    .map(
      (col) => `
      <div class="drawer-field">
        <span class="label">${escapeHtml(col)}</span>
        <span class="value">${escapeHtml(record[col]) || '—'}</span>
      </div>`
    )
    .join('');

  setStatusToggle(Boolean(record.__status));
  el.receiverInput.value = record.__receiver || '';
  el.notesInput.value = record.__notes || '';

  el.drawer.classList.add('open');
  el.drawer.setAttribute('aria-hidden', 'false');
  el.drawerOverlay.classList.add('open');

  // نُعلم بقية الأجهزة أن هذا السجل الآن قيد التعديل لدينا (Record Locking)
  broadcastLockRecord(record.__syncId);
}

function closeDrawer() {
  if (openRecordId !== null) {
    const record = allRecords.find((r) => r.id === openRecordId);
    if (record) broadcastUnlockRecord(record.__syncId);
  }

  el.drawer.classList.remove('open');
  el.drawer.setAttribute('aria-hidden', 'true');
  el.drawerOverlay.classList.remove('open');
  openRecordId = null;
}

function setStatusToggle(checked) {
  el.statusToggle.dataset.checked = String(checked);
  el.statusLabel.textContent = checked ? 'تم الاستلام' : 'لم يتم الاستلام';
  el.statusLabel.className = `text-sm font-semibold ${checked ? 'text-delivered' : 'text-pending'}`;
}

el.statusToggle.addEventListener('click', () => {
  const currentlyChecked = el.statusToggle.dataset.checked === 'true';
  setStatusToggle(!currentlyChecked);
});

el.drawerClose.addEventListener('click', closeDrawer);
el.drawerCancel.addEventListener('click', closeDrawer);
el.drawerOverlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.drawer.classList.contains('open')) closeDrawer();
});

el.drawerSave.addEventListener('click', async () => {
  if (openRecordId === null) return;

  const record = allRecords.find((r) => r.id === openRecordId);
  if (!record) return;

  const updated = {
    ...record,
    __status: el.statusToggle.dataset.checked === 'true',
    __receiver: el.receiverInput.value.trim(),
    __notes: el.notesInput.value.trim(),
    __updatedAt: Date.now(),
  };

  await updateRecord(updated);

  // تحديث النسخة المحلية في الذاكرة بدل إعادة القراءة الكاملة من القاعدة
  const index = allRecords.findIndex((r) => r.id === openRecordId);
  allRecords[index] = updated;

  renderTableRows();
  closeDrawer();

  // بثّ هذا التحديث فوراً لبقية الأجهزة المتصلة (إن وُجد اتصال بالخادم)
  broadcastRecordUpdate(updated);
});

/* -------------------------------------------------------------------------
   9) تصدير البيانات كملف Excel محدث
   ------------------------------------------------------------------------- */
el.exportBtn.addEventListener('click', () => {
  if (allRecords.length === 0) return;

  const exportRows = allRecords.map((record) => {
    const row = {};
    allColumns.forEach((col) => {
      row[col] = record[col];
    });
    row['الحالة'] = record.__status ? 'تم الاستلام' : 'لم يتم الاستلام';
    row['اسم المستلم'] = record.__receiver || '';
    row['ملاحظات'] = record.__notes || '';
    return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'المستفيدين');

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `تسليم_محدث_${today}.xlsx`);
});

/* -------------------------------------------------------------------------
   10) المزامنة الآنية بين الأجهزة (Socket.io)
   -------------------------------------------------------------------------
   فكرة العمل:
     - كل جهاز يبقى يعمل محلياً بالكامل عبر IndexedDB بغض النظر عن الاتصال.
     - الخادم لا يخزّن شيئاً على القرص ولا يملك أي بيانات من تلقاء نفسه؛ هو
       فقط "لوح مرجعي" في الذاكرة يعتمد على أن تزوّده الأجهزة ببياناتها.
     - عند الاتصال (أو إعادة الاتصال): كل جهاز يرسل client-data (نسخته
       المحلية) للخادم أولاً، ثم يطلب request-all-data ليستقبل send-all-data
       التي قد تكون الآن مدموجة مع بيانات أجهزة أخرى أيضاً — وهذا بالتحديد
       ما يحل مشكلة "الموبايل لا يرى بيانات اللابتوب": فور اتصال اللابتوب
       يرسل بياناته للخادم، وفور اتصال الموبايل يطلبها فيحصل عليها فوراً.
     - أي تعديل لاحق (تغيير حالة الاستلام مثلاً) يُبَث فوراً (record_updated)،
       وأي استيراد كامل لملف جديد يُبَث بالكامل (dataset_replaced).
     - المطابقة بين الأجهزة تتم عبر __syncId (وليس id المحلي)، والفصل بين
       النسخ المتعارضة يتم عبر "الأحدث يفوز" باستخدام __updatedAt.
   ------------------------------------------------------------------------- */

function setSyncConnected(isConnected) {
  if (el.syncDot) el.syncDot.className = `w-2 h-2 rounded-full ${isConnected ? 'bg-delivered' : 'bg-ink/25'}`;
  if (el.syncLabel) el.syncLabel.textContent = isConnected ? 'جلسة نشطة' : 'غير متصل';
  const sessionDot = document.getElementById('sessionStatusDot');
  if (sessionDot) sessionDot.className = `absolute -top-1 -left-1 w-2.5 h-2.5 rounded-full border-2 border-pine ${isConnected ? 'bg-delivered' : 'bg-ink/0'}`;
}

/** إرسال تحديث سجل واحد لبقية الأجهزة عبر WebRTC P2P */
function broadcastRecordUpdate(record) {
  window.p2pBroadcastRecordUpdate?.(record);
}

/** إرسال مجموعة بيانات كاملة عبر WebRTC P2P */
function broadcastFullDataset(records, columns) {
  window.p2pBroadcastFullDataset?.(records, columns);
}

/** إعلام بقية الأجهزة بقفل سجل عبر WebRTC P2P */
function broadcastLockRecord(syncId) {
  window.p2pBroadcastLock?.(syncId);
}

/** إعلام بقية الأجهزة بفك قفل سجل عبر WebRTC P2P */
function broadcastUnlockRecord(syncId) {
  window.p2pBroadcastUnlock?.(syncId);
}

/**
 * تطبيق قفل وارد من جهاز آخر على سجل معيّن (تستدعيها sync-bridge.js عند
 * استقبال رسالة قفل عبر WebRTC P2P). نخزّن معلومات الجهاز القافل، ونضبط
 * مؤقّت احتياطي 30 ثانية يفكّ القفل تلقائياً إن لم يصل إعلام فكّ قفل صريح
 * (مثلاً بسبب انقطاع اتصال الجهاز الآخر).
 * @param {string} syncId
 * @param {{ deviceId?: string, deviceName?: string }} [lockInfo]
 */
function applyLock(syncId, lockInfo = {}) {
  if (!syncId) return;

  // إن كان هناك مؤقّت سابق لنفس السجل، نلغيه قبل ضبط مؤقّت جديد
  if (lockExpiryTimers.has(syncId)) {
    clearTimeout(lockExpiryTimers.get(syncId));
  }

  lockedRecords.set(syncId, {
    deviceId: lockInfo.deviceId || null,
    deviceName: lockInfo.deviceName || 'جهاز آخر',
    expiresAt: Date.now() + 30000,
  });

  const timerId = setTimeout(() => {
    lockedRecords.delete(syncId);
    lockExpiryTimers.delete(syncId);
    renderTableRows();
  }, 30000);
  lockExpiryTimers.set(syncId, timerId);

  renderTableRows();
}

/**
 * فكّ قفل سجل بعد استقبال إعلام فكّ قفل صريح من الجهاز الذي كان يعدّله
 * (أو بعد إغلاق النافذة الجانبية على ذلك الجهاز).
 * @param {string} syncId
 */
function releaseLock(syncId) {
  if (!syncId) return;

  lockedRecords.delete(syncId);
  if (lockExpiryTimers.has(syncId)) {
    clearTimeout(lockExpiryTimers.get(syncId));
    lockExpiryTimers.delete(syncId);
  }

  renderTableRows();
}

/**
 * دمج سجل وارد من جهاز آخر مع البيانات المحلية:
 * - إن لم يكن موجوداً محلياً (syncId جديد) → يُضاف كسجل جديد.
 * - إن كان موجوداً والوارد أحدث (__updatedAt أكبر) → يُحدَّث محلياً.
 * - إن كانت نسختنا المحلية أحدث → لا نغيّر شيئاً (ونتركها لتُبَث لاحقاً).
 * يُعيد true إن تغيّرت البيانات المحلية فعلياً (لتحديث الواجهة).
 */
async function upsertBySyncId(remoteRecord) {
  const localIndex = allRecords.findIndex((r) => r.__syncId === remoteRecord.__syncId);

  if (localIndex === -1) {
    const { id, ...withoutLocalId } = remoteRecord; // المعرّف المحلي خاص بكل جهاز
    const newLocalId = await addSingleRecord(withoutLocalId);
    const added = { ...withoutLocalId, id: newLocalId };
    allRecords.push(added);
    return true;
  }

  const local = allRecords[localIndex];
  if ((remoteRecord.__updatedAt || 0) > (local.__updatedAt || 0)) {
    const merged = { ...local, ...remoteRecord, id: local.id }; // الإبقاء على المعرّف المحلي
    await updateRecord(merged);
    allRecords[localIndex] = merged;
    return true;
  }

  return false;
}

/**
 * استبدال كامل للبيانات المحلية بمجموعة واردة من جهاز آخر استورد ملف Excel
 * جديداً بالكامل. نطلب تأكيد المستخدم إن كانت لديه بيانات محلية مختلفة،
 * أما إن كان جهازه فارغاً (أول اتصال) فنطبّق البيانات مباشرة بدون إزعاجه.
 */
async function applyIncomingFullDataset(records, columns, { requireConfirmation }) {
  if (requireConfirmation && allRecords.length > 0) {
    const confirmed = window.confirm(
      'جهاز آخر استورد ملف بيانات جديداً بالكامل. هل تريد استبدال بياناتك المحلية بهذه النسخة؟'
    );
    if (!confirmed) return;
  }

  await replaceAllRecords(records, columns);
  allColumns = columns;
  allRecords = await getAllRecords();
  currentSearch = '';
  el.searchInput.value = '';
  renderApp();
  setSyncMessage(`تمت مزامنة ${records.length} سجل من جهاز آخر.`, 'success');
}

/* -------------------------------------------------------------------------
   10b) تصدير الدوال لـ sync-bridge.js (WebRTC P2P)
   ------------------------------------------------------------------------- */
window.upsertBySyncId = upsertBySyncId;
window.replaceAllRecords = replaceAllRecords;
window.getAllRecords = getAllRecords;
window.renderApp = renderApp;
window.renderTableRows = renderTableRows;
window.setMeta = setMeta;
window.applyLock = applyLock;
window.releaseLock = releaseLock;
window.clearAllData = clearAllData;
window.allRecords = allRecords;
window.allColumns = allColumns;


/* -------------------------------------------------------------------------
   11) مؤشر حالة الاتصال بالإنترنت (مفيد ميدانياً لمعرفة أن البيانات تُحفظ محلياً)
   ------------------------------------------------------------------------- */
function updateConnectionStatus() {
  // مؤشر الاتصال — اختياري في النسخة P2P
  const dot = document.getElementById('connectionDot');
  const label = document.getElementById('connectionLabel');
  const online = navigator.onLine;
  if (dot) dot.className = `w-2 h-2 rounded-full ${online ? 'bg-delivered' : 'bg-pending'}`;
  if (label) label.textContent = online ? 'متصل' : 'غير متصل';
}
window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);

/* -------------------------------------------------------------------------
   12) تسجيل Service Worker (لتفعيل العمل كتطبيق PWA بدون اتصال)
   ------------------------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((error) => {
      console.warn('تعذّر تسجيل Service Worker:', error);
    });
  });
}

/* -------------------------------------------------------------------------
   13) نقطة البداية: فتح القاعدة، تحميل البيانات المحفوظة سابقاً، وعرضها
   ------------------------------------------------------------------------- */
(async function init() {
  updateConnectionStatus();

  try {
    db = await openDatabase();
    allColumns = (await getMeta('columns')) || [];
    allRecords = await getAllRecords();
    renderApp();

    await ensureDeviceIdentity();

    // إن كان قد سبق واتصل هذا الجهاز بخادم مزامنة، نعبّئ العنوان تلقائياً
    // ونحاول إعادة الاتصال به دون تدخل المستخدم.
    // P2P — لا يوجد خادم للاتصال به تلقائياً، الجلسة تبدأ عبر QR Code
  } catch (error) {
    console.error('تعذّر فتح قاعدة البيانات المحلية:', error);
    setImportStatus('تعذّر الوصول إلى التخزين المحلي في هذا المتصفح.', 'error');
  }
})();
