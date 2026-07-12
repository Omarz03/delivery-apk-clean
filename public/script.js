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
let currentStatusFilter = null; // null = الكل، true = تم الاستلام، false = لم يتم
let openRecordId = null;
let socket = null;       // legacy — kept for compatibility; actual sync via window.deliveryP2P
let deviceId = null;
let deviceName = null;   // اسم مبسّط يُعرض لبقية الأجهزة (مثال: "موبايل • a1b2")
// نسخة في الذاكرة من عمود المعرّف الفريد (مثل "رقم الهوية") المحفوظ في meta،
// حتى نقدر نستخدمه بشكل متزامن (sync) في فحص "التسليم المزدوج" أثناء التفاعل
// مع الواجهة دون الحاجة لقراءة IndexedDB في كل مرة. تُحدَّث عند init وعند
// كل استيراد جديد يحدد عمود معرّف (finalizeImport).
let identifierColumnCache = null;
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
  deliveryAttribution: document.getElementById('deliveryAttribution'),
  appendixAttribution: document.getElementById('appendixAttribution'),
  duplicateWarning: document.getElementById('duplicateWarning'),
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
  appendixFilterBtn: document.getElementById('appendixFilterBtn'),
  statusFilterCount: document.getElementById('statusFilterCount'),
  statusFilterClearBtn: document.getElementById('statusFilterClearBtn'),
  // نافذة "إضافة ملحق"
  appendixBtn: document.getElementById('appendixBtn'),
  appendixModal: document.getElementById('appendixModal'),
  appendixModalOverlay: document.getElementById('appendixModalOverlay'),
  appendixModalClose: document.getElementById('appendixModalClose'),
  appendixModeIndividual: document.getElementById('appendixModeIndividual'),
  appendixModeExcel: document.getElementById('appendixModeExcel'),
  appendixIndividualView: document.getElementById('appendixIndividualView'),
  appendixExcelView: document.getElementById('appendixExcelView'),
  appendixFormFields: document.getElementById('appendixFormFields'),
  appendixIndividualSubmit: document.getElementById('appendixIndividualSubmit'),
  appendixIdWarning: document.getElementById('appendixIdWarning'),
  appendixFileInput: document.getElementById('appendixFileInput'),
  appendixTemplateBtn: document.getElementById('appendixTemplateBtn'),
  appendixExcelStatus: document.getElementById('appendixExcelStatus'),
  appendixDuplicatesList: document.getElementById('appendixDuplicatesList'),
  appendixDuplicatesDownloadBtn: document.getElementById('appendixDuplicatesDownloadBtn'),
  // نافذة تقرير ختام الجلسة
  reportBtn: document.getElementById('reportBtn'),
  reportModal: document.getElementById('reportModal'),
  reportModalOverlay: document.getElementById('reportModalOverlay'),
  reportModalClose: document.getElementById('reportModalClose'),
  reportGeneratedAt: document.getElementById('reportGeneratedAt'),
  reportStatsGrid: document.getElementById('reportStatsGrid'),
  reportBreakdownWrap: document.getElementById('reportBreakdownWrap'),
  reportBreakdownColumnName: document.getElementById('reportBreakdownColumnName'),
  reportBreakdownTable: document.getElementById('reportBreakdownTable'),
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
 * تجزئة نصية بسيطة وحتمية (FNV-1a 32-bit): نفس المُدخل ينتج نفس المُخرج
 * دائماً، على أي جهاز وفي أي وقت. تُستخدم كمعرّف مزامنة احتياطي (__syncId)
 * عندما لا يتوفر عمود هوية موثوق لصف معيّن — بدل معرّف عشوائي، حتى لا
 * تتكرر بيانات الشخص نفسه لو استُورد نفس الملف من جهاز آخر بشكل منفصل.
 * (تنازل واعٍ: لو صفّان مختلفان تماماً تطابقا بكل القيم بالحرف، سيُعامَلان
 * كسجل واحد — احتمال نادر جداً، ومفضّل على تكرار بيانات الشخص نفسه بصمت.)
 */
function hashRowContent(row, columns) {
  const content = columns.map((col) => normalizeIdValue(row[col])).join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/* -------------------------------------------------------------------------
   كشف "التسليم المزدوج" — حماية نزاهة التوزيع
   -------------------------------------------------------------------------
   يعتمد على قيمة عمود المعرّف الفريد (رقم الهوية) نفسها، وليس __syncId،
   لأن سجلّين قد يحملان نفس رقم الهوية لكن معرّفي مزامنة مختلفين — أشهر
   حالة: نفس الهوية تكررت داخل ملف الإكسل الأصلي، فالصف الثاني يأخذ
   __syncId احتياطياً (content hash) بدل الاصطدام بالأول (راجع finalizeImport)،
   فيصيران سجلّين منفصلين قابلين للتسليم كلٌّ على حدة دون هذا الفحص.
   ------------------------------------------------------------------------- */

/**
 * يبحث عن سجلات أخرى (غير السجل الممرَّر) تحمل نفس قيمة عمود المعرّف
 * الفريد وهي مُعلَّمة "تم الاستلام" فعلاً حالياً — بغض النظر إن كانت من
 * البيانات الأصلية أو أُضيفت كملحق. يعيد مصفوفة فارغة إن لم يتوفر عمود
 * معرّف موثوق لهذه الجلسة، أو كانت قيمته فارغة لهذا السجل تحديداً.
 * @param {Object} record
 * @returns {Array<Object>}
 */
function findDuplicateDeliveries(record) {
  if (!identifierColumnCache) return [];
  const key = normalizeIdValue(record[identifierColumnCache]);
  if (!key) return [];
  return allRecords.filter(
    (r) =>
      r.id !== record.id &&
      r.__status === true &&
      normalizeIdValue(r[identifierColumnCache]) === key
  );
}

/**
 * يبحث عن سجل موجود فعلاً (أصلي أو ملحق) بنفس قيمة عمود المعرّف الفريد —
 * تُستخدم للتحقق الفوري وقت كتابة رقم الهوية بنموذج "إضافة ملحق فردي"، قبل
 * حتى الضغط على زر الإضافة، تمييزاً عن findDuplicateDeliveries التي تتحقق
 * فقط من السجلات المُسلَّمة فعلاً لسجل موجود مسبقاً بالجدول.
 * @param {string} rawValue القيمة كما كُتبت بالحقل
 * @returns {Object|null}
 */
function findRecordByIdentifierValue(rawValue) {
  if (!identifierColumnCache) return null;
  const key = normalizeIdValue(rawValue);
  if (!key) return null;
  return allRecords.find((r) => normalizeIdValue(r[identifierColumnCache]) === key) || null;
}


/**
 * يبحث ضمن دفعة صفوف (وقت الاستيراد، قبل أي حفظ) عن قيم معرّف مكررة —
 * يُستخدم لإظهار تنبيه واضح بالقيم الفعلية المكررة بدل رقم الصف فقط،
 * حتى يقدر المستخدم يتحقق من ملف المصدر مباشرة.
 * @returns {Array<string>} قيم المعرّف المكررة (بلا تكرار بالنتيجة نفسها)
 */
function findDuplicateIdValuesInRows(rows, identifierColumn) {
  if (!identifierColumn) return [];
  const seen = new Set();
  const duplicates = new Set();
  rows.forEach((row) => {
    const key = normalizeIdValue(row[identifierColumn]);
    if (!key) return;
    if (seen.has(key)) duplicates.add(String(row[identifierColumn]).trim());
    seen.add(key);
  });
  return Array.from(duplicates);
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

/**
 * محاولة اكتشاف عمود "اسم المستفيد" من بين أعمدة الملف المستورد، لاستخدامه
 * لاحقاً في تعبئة "اسم المستلم" تلقائياً إن تُرك فارغاً. نفضّل عموداً اسمه
 * "الاسم" حرفياً، ثم أي عمود يحوي كلمة "اسم" لكن ليس اسم والد/زوج/أم (تفادياً
 * لأعمدة مثل "اسم الأب")، وإلا نرجع أول عمود كحل احتياطي أخير.
 */
function detectNameColumn(columns) {
  const exact = columns.find((col) => col.trim() === 'الاسم' || col.trim() === 'اسم المستفيد');
  if (exact) return exact;

  const excludeHints = /(والد|أب|اب\b|زوج|أم\b|ام\b|مستلم)/;
  const nameHint = columns.find((col) => /اسم|name/i.test(col) && !excludeHints.test(col));
  if (nameHint) return nameHint;

  return columns[0] || null;
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * تنسيق طابع زمني (Date.now()) كنص "yyyy-MM-dd HH:mm" ثابت وغير قابل للبس،
 * بعيداً عن أرقام هندية عربية أو تنسيقات محلية متغيرة قد تربك عرض الأرقام
 * داخل خلايا Excel. تُستخدم لعمود "وقت التسليم" بالتقرير المُصدَّر.
 */
function formatDeliveryTimestamp(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');

  let hours12 = d.getHours() % 12;
  if (hours12 === 0) hours12 = 12;
  const period = d.getHours() < 12 ? 'ص' : 'م';

  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = `${pad(hours12)}:${pad(d.getMinutes())} ${period}`;
  return `${datePart} ${timePart}`;
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

/* -------------------------------------------------------------------------
   لوحة "الأجهزة المتصلة" — تعرض جهازك دائماً ("أنت")، بالإضافة للجهاز الآخر
   إن كان متصلاً حالياً. سابقاً كانت اللوحة تعرض فقط الجهاز الآخر (أو رسالة
   فراغ)، فكان جهازك نفسه لا يظهر إطلاقاً حتى أثناء الاتصال الفعلي.
   ------------------------------------------------------------------------- */
function renderDevicesList(peer) {
  if (!el.devicesList || !el.devicesEmptyMsg) return;

  el.devicesEmptyMsg.classList.add('hidden'); // جهازك نفسه موجود بالقائمة دائماً

  const selfItem = `
    <li class="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-pine/10 border border-line">
      <span class="w-2 h-2 rounded-full bg-clay shrink-0"></span>
      <span class="font-medium text-sm flex-1 overflow-hidden whitespace-nowrap">${escapeHtml(deviceName || 'هذا الجهاز')} <span class="text-ink/40">(أنت)</span></span>
      <button onclick="window.renameThisDevice?.()" class="text-ink/40 hover:text-ink p-1 rounded-lg shrink-0" aria-label="تعديل اسمك" title="تعديل اسمك الظاهر لبقية الأجهزة">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
    </li>
  `;

  const peerItem = peer
    ? `
    <li class="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-pineLight/70">
      <span class="w-2 h-2 rounded-full bg-delivered shrink-0"></span>
      <span class="font-medium text-sm overflow-hidden whitespace-nowrap">${escapeHtml(peer.deviceName || 'جهاز غير معروف')}</span>
    </li>
  `
    : '';

  el.devicesList.innerHTML = selfItem + peerItem;

  if (el.devicesCountBadge) {
    el.devicesCountBadge.textContent = String(peer ? 2 : 1);
    el.devicesCountBadge.classList.remove('hidden');
  }
}
window.renderDevicesList = renderDevicesList;

/**
 * يتيح للمستخدم تخصيص اسمه الظاهر لبقية الأجهزة (بدل الاسم التلقائي
 * "موبايل • xxxx")، مهم خصوصاً لتمييز اسم الموظف الفعلي بتقرير التسليم
 * المُصدَّر لاحقاً (عمود "اسم المستخدم المسلِّم").
 */
async function renameThisDevice() {
  const current = deviceName || '';
  const next = window.prompt('اسمك الظاهر لبقية الأجهزة (يُستخدم أيضاً بتقرير التسليم):', current);
  if (next === null) return; // المستخدم ألغى
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return;

  deviceName = trimmed;
  await setMeta('deviceName', trimmed);
  renderDevicesList(window.deliveryP2P?.connected ? window.__lastKnownPeer : null);
  window.showToast?.('تم تحديث اسمك بنجاح', 'success', 2000);

  // نعلم الجهاز المتصل حالياً (إن وُجد) بالاسم الجديد فوراً
  if (window.deliveryP2P?.connected) {
    window.deliveryP2P.send('device-hello', { deviceId, deviceName });
  }
}
window.renameThisDevice = renameThisDevice;

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
window.showToast = showToast; // مطلوبة من sync-bridge.js (إشعارات الاتصال والمزامنة)

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
window.openSessionPanel = openSessionPanel; // يُستخدم من زر "إعادة الاتصال" بـ index.html

/* -------------------------------------------------------------------------
   شريط "كان عندك جلسة سابقة" — يظهر عند فتح التطبيق إن وُجدت جلسة P2P
   محفوظة (state: lastSessionRole)، حتى لو كان الإغلاق بالكامل (مو بس
   تصغير). الضغط عليه يستأنف نفس تدفق QR بضغطة واحدة (دور محفوظ)، بدل ما
   يضطر المستخدم يفتح اللوحة ويختار "مضيف"/"تابع" يدوياً من جديد.
   ------------------------------------------------------------------------- */
function showResumeSessionBanner(role) {
  if (window.deliveryP2P?.connected) return; // متصل فعلاً، لا داعي للتذكير

  const banner = document.createElement('div');
  banner.id = 'resumeSessionBanner';
  banner.className =
    'fixed inset-x-0 top-0 z-[70] bg-clay text-white px-4 py-3 flex items-center justify-between gap-3 shadow-sm';
  banner.innerHTML = `
    <span class="text-sm font-medium">كان عندك جلسة تسليم سابقة (${role === 'host' ? 'كمضيف' : 'كتابع'}) — هل تريد استئنافها؟</span>
    <div class="flex items-center gap-2 shrink-0">
      <button id="resumeSessionBtn" class="bg-white text-clay hover:bg-paper transition-colors px-3 py-1.5 rounded-lg text-sm font-semibold">استئناف</button>
      <button id="dismissResumeBtn" class="text-white px-2 py-1.5 text-sm" aria-label="تجاهل">✕</button>
    </div>
  `;
  document.body.prepend(banner);

  document.getElementById('resumeSessionBtn').addEventListener('click', () => {
    banner.remove();
    if (role === 'host') window.startHostSession?.(true);
    else window.startPeerSession?.(true);
  });

  document.getElementById('dismissResumeBtn').addEventListener('click', () => {
    banner.remove();
    clearLastSessionRole();
  });
}

/** تُستدعى فور نجاح أي اتصال P2P (channel-open) لحفظ الدور للاستئناف لاحقاً. */
async function saveLastSessionRole(role) {
  try {
    await setMeta('lastSessionRole', role);
  } catch (e) {
    console.warn('تعذّر حفظ دور الجلسة (غير حرج):', e);
  }
}
window.saveLastSessionRole = saveLastSessionRole;

/** تُستدعى عند إنهاء الجلسة يدوياً (زر قطع الاتصال) أو تجاهل شريط الاستئناف. */
async function clearLastSessionRole() {
  document.getElementById('resumeSessionBanner')?.remove();
  try {
    await setMeta('lastSessionRole', null);
  } catch (e) {
    console.warn('تعذّر مسح دور الجلسة (غير حرج):', e);
  }
}
window.clearLastSessionRole = clearLastSessionRole;

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
/* -------------------------------------------------------------------------
   إضافة مستفيدين كـ"ملحق" بعد بدء الجلسة (بدون استبدال البيانات الحالية)
   -------------------------------------------------------------------------
   يفيد ميدانياً لما يظهر مستفيدون إضافيون بعد بدء التسليم (لم يكونوا
   بالملف الأصلي). الإضافة تصير آخر الجدول، مع علامة داخلية (__isAppendix)
   وملاحظة تلقائية "ملحق" لتمييزها، وتُبَث فوراً لبقية الأجهزة عبر نفس
   آلية بث التحديثات العادية (record_updated) — أي جهاز متصل يقدر يضيف.
   ------------------------------------------------------------------------- */

/**
 * تبني معرّف مزامنة (__syncId) لسجل ملحق جديد بنفس منطق الاستيراد الأساسي
 * تماماً (عمود المعرّف المحفوظ إن وُجد، وإلا hash لمحتوى الصف).
 * مهم: لا تتحقق من وجود تصادم هنا ولا "تتحايل" عليه بمعرّف بديل — تعيد
 * دائماً المعرّف المبني على عمود الهوية إن توفّر، وتترك اكتشاف التصادم فعلياً
 * لـ addAppendixRecords (التي تقارنه بـ existingSyncIds). النسخة السابقة
 * كانت تولّد معرّفاً بديلاً (content hash) فور اكتشاف تصادم بدل التبليغ عنه،
 * مما كان يُسقط فحص "رفض المكرر" بالكامل ويُدخل السجل المكرر بصمت.
 */
function buildAppendixSyncId(row, columns, identifierColumn) {
  if (identifierColumn) {
    const key = normalizeIdValue(row[identifierColumn]);
    if (key) return `key:${identifierColumn}:${key}`;
  }
  return `content:${hashRowContent(row, columns)}`;
}

/**
 * تجهّز وتحفظ وتبثّ دفعة من سجلات "ملحق" جديدة. مشتركة بين مسار الإضافة
 * الفردية ومسار استيراد ملف Excel كملحق.
 * @param {Array<Object>} rawRows صفوف خام (مفاتيحها = أسماء الأعمدة)
 */
/** يحسب أعلى قيمة رقمية موجودة حالياً بعمود الترقيم، ليبدأ الملحق بعدها مباشرة. */
function getNextAppendixNumber(numberColumn) {
  let max = 0;
  allRecords.forEach((r) => {
    const n = Number(String(r[numberColumn] ?? '').trim());
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max + 1;
}

async function addAppendixRecords(rawRows) {
  if (!rawRows.length) return { added: 0, skipped: 0, duplicateValues: [], duplicateDetails: [] };

  const identifierColumn = (await getMeta('identifierColumn')) || null;
  // العمود الأول غالباً ما يكون عمود الترقيم التسلسلي بالملف الأصلي — نولّده
  // تلقائياً لسجلات الملحق بدل الاعتماد على إدخال يدوي (أو قيمة الملف
  // المستورَد إن وُجدت)، حتى يبقى الترقيم متسلسلاً وصحيحاً دائماً.
  const numberColumn = allColumns[0] || null;
  let nextNumber = numberColumn ? getNextAppendixNumber(numberColumn) : null;
  const existingSyncIds = new Set(allRecords.map((r) => r.__syncId));
  // خريطة syncId → السجل الفعلي، تُستخدم لعرض بيانات "السجل السابق" الذي
  // تعارض معه كل صف مرفوض (تشمل سجلات مقبولة حديثاً ضمن نفس هذه الدفعة،
  // حتى تُكتشف التكرارات الداخلية بنفس الملف بشكل صحيح).
  const recordsBySyncId = new Map(allRecords.map((r) => [r.__syncId, r]));
  const now = Date.now();
  let skipped = 0;
  const duplicateValues = []; // قيم المعرّف الفعلية المرفوضة — لعرضها للمستخدم بدل رقم مجرّد
  const duplicateDetails = []; // { row, existing } — لتصدير ملف الأخطاء عند الحاجة

  const newRecords = [];
  for (const row of rawRows) {
    // نطبّع الصف على نفس أعمدة الجلسة الحالية بالضبط (نتجاهل أي عمود زائد
    // غير معروف، ونملأ أي عمود ناقص بقيمة فارغة) حتى يبقى الجدول متّسقاً.
    const normalizedRow = {};
    allColumns.forEach((col) => {
      normalizedRow[col] = row[col] ?? '';
    });
    if (numberColumn) {
      normalizedRow[numberColumn] = nextNumber;
      nextNumber += 1;
    }

    const syncId = buildAppendixSyncId(normalizedRow, allColumns, identifierColumn);
    if (existingSyncIds.has(syncId)) {
      skipped += 1; // نفس الشخص مضاف مسبقاً (نفس عمود المعرّف) — نتجاهله بدل تكراره
      if (identifierColumn && normalizedRow[identifierColumn]) {
        duplicateValues.push(String(normalizedRow[identifierColumn]).trim());
      }
      duplicateDetails.push({ row: normalizedRow, existing: recordsBySyncId.get(syncId) || null });
      if (numberColumn) nextNumber -= 1; // نتراجع عن الرقم حتى لا تظهر فجوة بالترقيم
      continue;
    }
    existingSyncIds.add(syncId);

    const record = {
      ...normalizedRow,
      __status: false,
      __receiver: '',
      __notes: 'ملحق',
      __isAppendix: true,
      __addedByName: deviceName || 'غير معروف',
      __addedAt: now,
      __syncId: syncId,
      __updatedAt: now,
    };

    const localId = await addSingleRecord(record);
    const saved = { ...record, id: localId };
    allRecords.push(saved);
    recordsBySyncId.set(syncId, saved);
    newRecords.push(saved);
  }

  if (newRecords.length > 0) {
    renderApp();
    // نبثّ كل سجل جديد فوراً لبقية الأجهزة — نفس آلية بث أي تعديل عادي،
    // وستُدمَج تلقائياً عند الطرف الآخر عبر upsertBySyncId (يضيفها كسجل
    // جديد بما أن معرّفها غير موجود لديه).
    newRecords.forEach((r) => broadcastRecordUpdate(r));
  }

  return { added: newRecords.length, skipped, duplicateValues, duplicateDetails };
}

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
        // قيمة فارغة أو مكررة داخل نفس الملف — لا يمكن الاعتماد عليها كمعرّف
        // فريد لهذا الصف، فنلجأ لمعرّف حتمي مبني على محتوى الصف بالكامل
        // (بدل معرّف عشوائي) حتى لا تتكرر بيانات هذا الشخص لو استُورد نفس
        // الملف من جهاز آخر بشكل منفصل.
        usedFallbackIds.push(index + 2); // +2 لتقريب رقم الصف كما يظهر في إكسل (يشمل صف العناوين)
        syncId = `content:${hashRowContent(row, columns)}`;
      }
    } else {
      syncId = `content:${hashRowContent(row, columns)}`;
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
  identifierColumnCache = identifierColumn || null;

  allColumns = columns;
  allRecords = await getAllRecords();
  currentSearch = '';
  el.searchInput.value = '';
  setStatusFilter('all');

  renderApp();

  let statusMessage = `تم استيراد ${rows.length} سجل بنجاح من "${fileName}".`;
  if (identifierColumn) {
    statusMessage += ` (المعرّف الفريد: عمود "${identifierColumn}")`;
  }
  if (usedFallbackIds.length > 0) {
    const duplicateValues = findDuplicateIdValuesInRows(rows, identifierColumn);
    const sample = duplicateValues.slice(0, 5).join('، ');
    statusMessage += ` ⚠ تنبيه: ${usedFallbackIds.length} صف بمعرّف فارغ أو مكرر داخل الملف نفسه`;
    if (duplicateValues.length > 0) {
      statusMessage += ` — من ضمنها قيم مكررة: ${sample}${duplicateValues.length > 5 ? ' وغيرها...' : ''}`;
      statusMessage += `. يُنصح بمراجعة الملف الأصلي لتفادي احتمال تسليم مزدوج لنفس الشخص.`;
    }
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
  setStatusFilter('all');
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
  // بحث برقم الصف يتجاوز أي تصفية أخرى تماماً — يعيد صفاً واحداً بالضبط
  if (currentRowFilter !== null) {
    const idx = currentRowFilter - 1;
    return allRecords[idx] ? [allRecords[idx]] : [];
  }

  let filtered = allRecords;

  if (currentStatusFilter === 'appendix') {
    filtered = filtered.filter((record) => record.__isAppendix === true);
  } else if (currentStatusFilter !== null) {
    filtered = filtered.filter((record) => record.__status === currentStatusFilter);
  }

  if (currentSearch) {
    const needle = normalizeArabic(currentSearch);
    filtered = filtered.filter((record) =>
      allColumns.some((col) => normalizeArabic(record[col]).includes(needle))
    );
  }

  return filtered;
}

function renderTableRows() {
  const filtered = getFilteredRecords();
  el.noResults.classList.toggle('hidden', filtered.length !== 0);
  updateStatusFilterBar(filtered.length);

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

      const editedFields = record.__editedFields || [];
      const dataCells = allColumns
        .map((col) => {
          const cellClass = editedFields.includes(col) ? ' class="cell-edited"' : '';
          return `<td${cellClass}>${escapeHtml(record[col])}</td>`;
        })
        .join('');

      const lockedClass = isLockedByOther ? ' row-locked' : '';
      const appendixClass = record.__isAppendix ? ' bg-clay/10' : '';
      return `<tr data-id="${record.id}" class="${lockedClass}${appendixClass}">${`<td>${statusCell}</td>`}${dataCells}</tr>`;
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
   تصفية حسب حالة الاستلام (الكل / تم الاستلام / لم يتم الاستلام)
   ------------------------------------------------------------------------- */
const statusFilterMap = { all: null, delivered: true, pending: false, appendix: 'appendix' };

/**
 * تُستدعى مع كل عرض للجدول: تُظهر/تُخفي زر تصفية "ملحق" حسب وجود سجلات
 * ملحق فعلاً بالبيانات الحالية، وتحدّث عداد نتائج التصفية أقصى يسار الشريط.
 */
function updateStatusFilterBar(count) {
  const hasAppendix = allRecords.some((r) => r.__isAppendix === true);

  if (el.appendixFilterBtn) {
    el.appendixFilterBtn.classList.toggle('hidden', !hasAppendix);
    // لو اختفى آخر سجل ملحق بينما فلتر "ملحق" هو المُفعّل حالياً، نرجع
    // تلقائياً لفلتر "الكل" حتى لا يبقى الجدول عالقاً بحالة فارغة دائمة.
    if (!hasAppendix && currentStatusFilter === 'appendix') {
      setStatusFilter('all');
      return; // setStatusFilter تنادي renderTableRows من جديد وتحدّث العداد بنفسها
    }
  }

  if (el.statusFilterClearBtn) {
    const isFiltered = currentStatusFilter !== null;
    el.statusFilterClearBtn.classList.toggle('hidden', !isFiltered);
    el.statusFilterClearBtn.classList.toggle('inline-flex', isFiltered);
  }

  if (el.statusFilterCount) {
    el.statusFilterCount.textContent = String(count);
  }
}

el.statusFilterClearBtn?.addEventListener('click', () => setStatusFilter('all'));

function setStatusFilter(key) {
  currentStatusFilter = statusFilterMap[key] ?? null;
  document.querySelectorAll('.status-filter-btn').forEach((btn) => {
    const isActive = btn.dataset.statusFilter === key;
    const wasHidden = btn.classList.contains('hidden'); // نحافظ على إخفاء زر "ملحق" إن لم تتوفر سجلات ملحق
    btn.className = `status-filter-btn px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
      isActive ? 'bg-pine text-white' : 'text-ink/55 hover:bg-paper hover:text-ink'
    }${wasHidden ? ' hidden' : ''}`;
  });
  renderTableRows();
}

document.querySelectorAll('.status-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => setStatusFilter(btn.dataset.statusFilter));
});


/* -------------------------------------------------------------------------
   8) النافذة الجانبية (Drawer): عرض التفاصيل وتعديل الحالة
   ------------------------------------------------------------------------- */

/**
 * يعرض جملة "تم التسليم في [الوقت] من خلال المستخدم [الاسم]" أسفل مفتاح
 * حالة الاستلام مباشرة، أثناء الجلسة نفسها (وليس فقط بالتقرير المُصدَّر
 * لاحقاً). تُخفى الجملة كلياً إن لم يكن السجل مُسلَّماً بعد.
 */
function renderDeliveryAttribution(record) {
  if (!el.deliveryAttribution) return;

  if (!record?.__status || !record.__deliveredAt) {
    el.deliveryAttribution.classList.add('hidden');
    el.deliveryAttribution.textContent = '';
    return;
  }

  const time = formatDeliveryTimestamp(record.__deliveredAt);
  const name = record.__deliveredByName || 'غير معروف';
  el.deliveryAttribution.textContent = `تم التسليم في ${time} من خلال المستخدم ${name}`;
  el.deliveryAttribution.classList.remove('hidden');
}

/** يعرض ملاحظة "تمت الإضافة كملحق في [وقت] بواسطة [اسم]" أعلى النافذة الجانبية. */
function renderAppendixAttribution(record) {
  if (!el.appendixAttribution) return;

  if (!record?.__isAppendix) {
    el.appendixAttribution.classList.add('hidden');
    el.appendixAttribution.textContent = '';
    return;
  }

  const time = record.__addedAt ? formatDeliveryTimestamp(record.__addedAt) : 'غير معروف';
  const name = record.__addedByName || 'غير معروف';
  el.appendixAttribution.textContent = `ملحق — تمت الإضافة في ${time} بواسطة ${name}`;
  el.appendixAttribution.classList.remove('hidden');
}

/**
 * يعرض تنبيه "احتمال تسليم مزدوج" أعلى النافذة الجانبية إن وُجدت سجلات
 * أخرى بنفس رقم الهوية مُعلَّمة "تم الاستلام" فعلاً. يُستدعى عند فتح
 * النافذة وعند كل تبديل لمفتاح حالة الاستلام، حتى يبقى التحذير محدَّثاً
 * ومرئياً *قبل* أن يضغط المستخدم "حفظ".
 * @param {Array<Object>} matches نتيجة findDuplicateDeliveries
 */
function renderDuplicateWarning(matches) {
  if (!el.duplicateWarning) return;

  if (!matches || matches.length === 0) {
    el.duplicateWarning.classList.add('hidden');
    el.duplicateWarning.innerHTML = '';
    return;
  }

  const items = matches
    .slice(0, 4)
    .map((m) => {
      const receiver = escapeHtml(m.__receiver || 'غير محدد');
      const time = escapeHtml(formatDeliveryTimestamp(m.__deliveredAt));
      const by = escapeHtml(m.__deliveredByName || 'غير معروف');
      const tag = m.__isAppendix ? ' <span style="opacity:.7">(ملحق)</span>' : '';
      return `<li>استلمه <b>${receiver}</b>${tag} بتاريخ ${time} — سجّله ${by}</li>`;
    })
    .join('');
  const more = matches.length > 4 ? `<li>و${matches.length - 4} حالة أخرى مطابقة...</li>` : '';

  el.duplicateWarning.innerHTML = `
    <strong>⚠ احتمال تسليم مزدوج لنفس الشخص</strong>
    نفس رقم الهوية مُسجَّل "تم الاستلام" مسبقاً بسجل آخر بهذا الجدول:
    <ul>${items}${more}</ul>
  `;
  el.duplicateWarning.classList.remove('hidden');
}

function openDrawer(id) {
  const record = allRecords.find((r) => r.id === id);
  if (!record) return;

  openRecordId = id;

  el.drawerOriginalData.innerHTML = allColumns
    .map((col) => {
      const isEdited = (record.__editedFields || []).includes(col);
      return `
      <div class="drawer-field${isEdited ? ' drawer-field--edited' : ''}">
        <span class="label">${escapeHtml(col)}${isEdited ? ' <span class="edited-tag">(معدّل)</span>' : ''}</span>
        <input type="text" class="value drawer-original-input" data-column="${escapeAttr(col)}" value="${escapeAttr(record[col] ?? '')}" />
      </div>`;
    })
    .join('');

  setStatusToggle(Boolean(record.__status));
  el.receiverInput.value = record.__receiver || '';
  el.notesInput.value = record.__notes || '';
  renderDeliveryAttribution(record);
  renderAppendixAttribution(record);
  renderDuplicateWarning(findDuplicateDeliveries(record));

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
  const nextChecked = !currentlyChecked;
  setStatusToggle(nextChecked);

  // معاينة حية لسطر "تم التسليم..." فور التبديل، قبل الحفظ الفعلي حتى —
  // حتى يشوف المستخدم النتيجة أثناء التسليم مباشرة وليس بعد إغلاق النافذة.
  const record = allRecords.find((r) => r.id === openRecordId);
  if (!nextChecked) {
    renderDeliveryAttribution(null);
  } else if (record?.__deliveredAt) {
    renderDeliveryAttribution(record); // كان مُسلَّماً أصلاً بنفس هذه الجلسة — نُبقي بياناته
  } else {
    renderDeliveryAttribution({ __status: true, __deliveredAt: Date.now(), __deliveredByName: deviceName });
  }
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

  // جمع القيم الجديدة من حقول البيانات الأصلية (صارت قابلة للتعديل الآن)
  // وتحديد أي الحقول تغيّرت فعلياً عن قيمتها الحالية بالسجل.
  const editedFields = new Set(record.__editedFields || []);
  const updatedFieldValues = {};
  el.drawerOriginalData.querySelectorAll('.drawer-original-input').forEach((input) => {
    const col = input.dataset.column;
    const newVal = input.value.trim();
    updatedFieldValues[col] = newVal;
    if (newVal !== String(record[col] ?? '').trim()) {
      editedFields.add(col);
    }
  });

  const statusChecked = el.statusToggle.dataset.checked === 'true';
  let receiverValue = el.receiverInput.value.trim();

  // لو تُرك اسم المستلم فاضياً، نعتبره استلمه المستفيد نفسه (بدل تكرار اسمه
  // الكامل تلقائياً — القيمة الثابتة "نفسه" أوضح وأسرع قراءة بالتقرير).
  if (!receiverValue) {
    receiverValue = 'نفسه';
    el.receiverInput.value = receiverValue; // انعكاس فوري بالحقل بالواجهة
  }

  const updated = {
    ...record,
    ...updatedFieldValues,
    __status: statusChecked,
    __receiver: receiverValue,
    __notes: el.notesInput.value.trim(),
    __editedFields: Array.from(editedFields),
    __updatedAt: Date.now(),
  };

  // نسجّل من قام فعلياً بعملية التسليم ومتى — فقط لحظة الانتقال الحقيقي إلى
  // "تم الاستلام" (وليس أي حفظ لاحق لا يغيّر الحالة، كتعديل ملاحظة مثلاً)،
  // حتى لا نفقد بيانات أول تسليم فعلي بتعديلات لاحقة. لو تراجع المستخدم عن
  // "تم الاستلام" (تصحيح خطأ)، نمسح النسبة لتبقى متسقة مع الحالة الفعلية.
  const wasDelivered = record.__status === true;
  if (statusChecked && !wasDelivered) {
    // فحص أخير قبل الحفظ الفعلي: لو فيه سجل آخر بنفس رقم الهوية "تم
    // استلامه" فعلاً، نوقف الحفظ ونطلب تأكيداً صريحاً — حماية أخيرة حتى لو
    // فات المستخدم التنبيه المرئي أعلى النافذة.
    const duplicates = findDuplicateDeliveries(record);
    if (duplicates.length > 0) {
      const details = duplicates
        .slice(0, 4)
        .map((m) => `- ${m.__receiver || 'غير محدد'} (${formatDeliveryTimestamp(m.__deliveredAt)})`)
        .join('\n');
      const proceed = window.confirm(
        `⚠ تنبيه: احتمال تسليم مزدوج\n\nنفس رقم الهوية مُسجَّل "تم الاستلام" مسبقاً:\n${details}\n\nهل تريد تأكيد تسليم هذا السجل رغم ذلك؟`
      );
      if (!proceed) return; // نوقف الحفظ بالكامل — السجل يبقى كما كان دون أي تغيير
    }
    updated.__deliveredByName = deviceName || 'غير معروف';
    updated.__deliveredByDeviceId = deviceId || null;
    updated.__deliveredAt = Date.now();
  } else if (!statusChecked) {
    updated.__deliveredByName = null;
    updated.__deliveredByDeviceId = null;
    updated.__deliveredAt = null;
  }
  // (الحالة الثالثة: كانت مُسلَّمة وضلّت مُسلَّمة — نُبقي بيانات أول تسليم
  // كما هي تلقائياً، لأننا لم نلمسها أعلاه، وهي محفوظة أصلاً بـ ...record)

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
    row['اسم المستخدم المسلِّم'] = record.__deliveredByName || '';
    row['وقت التسليم'] = formatDeliveryTimestamp(record.__deliveredAt);
    row['ملاحظات'] = record.__notes || '';
    // عمود إضافي يوضّح أي حقول من البيانات الأصلية عُدّلت يدوياً بعد الاستيراد
    // (بديل مضمون 100% عن تلوين الخلايا، الذي لا تدعمه مكتبة الإكسل المجانية
    // بثقة عند الكتابة).
    row['الحقول المعدّلة'] = (record.__editedFields || []).join('، ');
    return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'المستفيدين');

  // ورقة "تقرير الجلسة" تُضاف تلقائياً كجزء من نفس ملف التصدير النهائي —
  // بلا حاجة لتصدير منفصل، فالمكتب يستلم كل شيء بملف واحد.
  appendSessionReportSheets(workbook);

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `تسليم_محدث_${today}.xlsx`);
});

/* -------------------------------------------------------------------------
   9.1) تقرير ختام الجلسة/اليوم
   -------------------------------------------------------------------------
   ملخّص سريع (وقابل للتصدير كملف إكسل منفصل وخفيف) لحالة التسليم الحالية:
   إجمالي/تم/متبقي/نسبة، عدد سجلات الملحق وكم منها سُلِّم، وتفصيل حسب عمود
   "منطقة/مخيم/قطاع" إن اكتُشف تلقائياً بين أعمدة الملف المستورد. يفيد عند
   تسليم التقرير اليومي للمكتب دون تصدير واستعراض الجدول الكامل يدوياً.
   ------------------------------------------------------------------------- */

/**
 * يحاول اكتشاف عمود "تصنيف جغرافي" (منطقة/مخيم/قطاع...) من بين أعمدة
 * الملف المستورد، لاستخدامه كأساس لتفصيل التقرير. يعيد null إن لم يجد
 * عموداً مناسباً — عندها يعرض التقرير الإجماليات فقط بدون جدول تفصيلي.
 */
function detectBreakdownColumn(columns) {
  const hints = /(منطق|مخيم|قطاع|تجمع|حي\b|قرية|block|camp|area|zone|region|sector|district)/i;
  return columns.find((col) => hints.test(col)) || null;
}

/** يبني كل أرقام تقرير ختام الجلسة اعتماداً على allRecords الحالية. */
function computeSessionReport() {
  const total = allRecords.length;
  const delivered = allRecords.filter((r) => r.__status).length;
  const pending = total - delivered;
  const percent = total > 0 ? Math.round((delivered / total) * 100) : 0;

  const appendixRecords = allRecords.filter((r) => r.__isAppendix);
  const appendixDelivered = appendixRecords.filter((r) => r.__status).length;

  const breakdownColumn = detectBreakdownColumn(allColumns);
  let breakdown = null;
  if (breakdownColumn) {
    const groups = new Map();
    allRecords.forEach((r) => {
      const key = String(r[breakdownColumn] ?? '').trim() || 'غير محدد';
      if (!groups.has(key)) groups.set(key, { total: 0, delivered: 0 });
      const g = groups.get(key);
      g.total += 1;
      if (r.__status) g.delivered += 1;
    });
    breakdown = {
      column: breakdownColumn,
      // ترتيب تنازلي حسب الإجمالي — أكبر منطقة أولاً، أسهل للمراجعة السريعة
      groups: Array.from(groups.entries()).sort((a, b) => b[1].total - a[1].total),
    };
  }

  const deliveredTimestamps = allRecords.filter((r) => r.__deliveredAt).map((r) => r.__deliveredAt);
  const firstDeliveryAt = deliveredTimestamps.length ? Math.min(...deliveredTimestamps) : null;
  const lastDeliveryAt = deliveredTimestamps.length ? Math.max(...deliveredTimestamps) : null;

  return {
    total,
    delivered,
    pending,
    percent,
    appendixCount: appendixRecords.length,
    appendixDelivered,
    breakdown,
    firstDeliveryAt,
    lastDeliveryAt,
  };
}

/** يملأ محتوى نافذة تقرير ختام الجلسة بأرقام محدَّثة، وقت كل فتح. */
function renderSessionReport() {
  const r = computeSessionReport();

  const now = new Date();
  el.reportGeneratedAt.textContent = `تم إنشاء هذا التقرير في ${now.toLocaleDateString('ar-EG')} — ${now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;

  const cards = [
    { label: 'إجمالي المستفيدين', value: r.total, cls: '' },
    { label: 'تم التسليم', value: r.delivered, cls: 'is-positive' },
    { label: 'متبقي', value: r.pending, cls: 'is-pending' },
    { label: 'نسبة الإنجاز', value: `${r.percent}%`, cls: '' },
  ];
  if (r.appendixCount > 0) {
    cards.push({ label: 'أُضيفوا كملحق', value: r.appendixCount, cls: '' });
    cards.push({ label: 'ملحق تم تسليمه', value: r.appendixDelivered, cls: 'is-positive' });
  }
  el.reportStatsGrid.innerHTML = cards
    .map(
      (c) => `
    <div class="report-stat-card ${c.cls}">
      <span class="report-stat-value">${escapeHtml(String(c.value))}</span>
      <span class="report-stat-label">${escapeHtml(c.label)}</span>
    </div>`
    )
    .join('');

  if (r.breakdown && r.breakdown.groups.length > 0) {
    el.reportBreakdownColumnName.textContent = r.breakdown.column;
    el.reportBreakdownTable.innerHTML = `
      <thead>
        <tr><th>${escapeHtml(r.breakdown.column)}</th><th>تم</th><th>الإجمالي</th><th>النسبة</th></tr>
      </thead>
      <tbody>
        ${r.breakdown.groups
          .map(([key, g]) => {
            const pct = g.total > 0 ? Math.round((g.delivered / g.total) * 100) : 0;
            return `<tr><td>${escapeHtml(key)}</td><td>${g.delivered}</td><td>${g.total}</td><td>${pct}%</td></tr>`;
          })
          .join('')}
      </tbody>`;
    el.reportBreakdownWrap.classList.remove('hidden');
  } else {
    el.reportBreakdownWrap.classList.add('hidden');
    el.reportBreakdownTable.innerHTML = '';
  }
}

function openReportModal() {
  if (allRecords.length === 0) return;
  renderSessionReport();
  el.reportModal.classList.add('open');
  el.reportModal.setAttribute('aria-hidden', 'false');
  el.reportModalOverlay.classList.add('open');
}

function closeReportModal() {
  el.reportModal.classList.remove('open');
  el.reportModal.setAttribute('aria-hidden', 'true');
  el.reportModalOverlay.classList.remove('open');
}

el.reportBtn?.addEventListener('click', openReportModal);
el.reportModalClose?.addEventListener('click', closeReportModal);
el.reportModalOverlay?.addEventListener('click', closeReportModal);
// الضغط في أي مكان خارج بطاقة النافذة (المساحة الفارغة حول الصندوق) يُغلقها
// أيضاً — نتحقق أن الهدف الفعلي للضغطة هو الحاوية الخارجية نفسها وليس أي
// عنصر داخلي (وإلا كان أي ضغط داخل النافذة سيُغلقها بالخطأ عبر الفقاعة).
el.reportModal?.addEventListener('click', (event) => {
  if (event.target === el.reportModal) closeReportModal();
});

/**
 * يضيف ورقة/ورقتَي "تقرير الجلسة" (ملخّص + تفصيل حسب المنطقة إن وُجدت) إلى
 * ملف Excel الذي يُصدَّر بالفعل من زر "تصدير كملف Excel" الرئيسي — بدل ملف
 * منفصل، حتى يستلم المكتب كل شيء (بيانات المستفيدين + ملخّص الجلسة) بملف
 * واحد جاهز.
 * @param {XLSX.WorkBook} workbook
 */
function appendSessionReportSheets(workbook) {
  const r = computeSessionReport();

  const summaryRows = [
    { البند: 'إجمالي المستفيدين', القيمة: r.total },
    { البند: 'تم التسليم', القيمة: r.delivered },
    { البند: 'متبقي', القيمة: r.pending },
    { البند: 'نسبة الإنجاز', القيمة: `${r.percent}%` },
    { البند: 'أُضيفوا كملحق خلال الجلسة', القيمة: r.appendixCount },
    { البند: 'ملحق تم تسليمه', القيمة: r.appendixDelivered },
    { البند: 'أول عملية تسليم', القيمة: formatDeliveryTimestamp(r.firstDeliveryAt) },
    { البند: 'آخر عملية تسليم', القيمة: formatDeliveryTimestamp(r.lastDeliveryAt) },
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'تقرير الجلسة');

  if (r.breakdown && r.breakdown.groups.length > 0) {
    const breakdownRows = r.breakdown.groups.map(([key, g]) => ({
      [r.breakdown.column]: key,
      'تم التسليم': g.delivered,
      'الإجمالي': g.total,
      'نسبة الإنجاز': g.total > 0 ? `${Math.round((g.delivered / g.total) * 100)}%` : '0%',
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(breakdownRows), `حسب ${r.breakdown.column}`.slice(0, 31));
  }
}

/* -------------------------------------------------------------------------
   نافذة "إضافة ملحق" — التفاعل مع الواجهة
   ------------------------------------------------------------------------- */
function openAppendixModal() {
  if (allColumns.length === 0) return; // لا معنى للإضافة قبل بدء جلسة أصلاً
  setAppendixMode('individual');
  renderAppendixForm();
  el.appendixExcelStatus.textContent = '';
  el.appendixDuplicatesList?.classList.add('hidden');
  if (el.appendixDuplicatesList) el.appendixDuplicatesList.innerHTML = '';
  el.appendixDuplicatesDownloadBtn?.classList.add('hidden');
  // تصفير حالة تحذير التكرار من فتحة سابقة — الحقول تُبنى من جديد، لكن زر
  // "إضافة" وصندوق التحذير عنصران ثابتان بالـ HTML فلا يُعاد إنشاؤهما.
  el.appendixIdWarning?.classList.add('hidden');
  if (el.appendixIdWarning) el.appendixIdWarning.innerHTML = '';
  if (el.appendixIndividualSubmit) el.appendixIndividualSubmit.disabled = false;
  el.appendixModal.classList.remove('hidden');
  el.appendixModal.classList.add('flex');
  el.appendixModalOverlay.classList.add('open');
}

function closeAppendixModal() {
  el.appendixModal.classList.add('hidden');
  el.appendixModal.classList.remove('flex');
  el.appendixModalOverlay.classList.remove('open');
}

function setAppendixMode(mode) {
  const isIndividual = mode === 'individual';
  el.appendixIndividualView.classList.toggle('hidden', !isIndividual);
  el.appendixExcelView.classList.toggle('hidden', isIndividual);
  el.appendixModeIndividual.className = `flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
    isIndividual ? 'bg-white text-pine shadow-sm' : 'text-ink/50'
  }`;
  el.appendixModeExcel.className = `flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
    !isIndividual ? 'bg-white text-pine shadow-sm' : 'text-ink/50'
  }`;
}

/** يبني حقول نموذج الإضافة الفردية ديناميكياً حسب أعمدة الجلسة الحالية. */
function renderAppendixForm() {
  // العمود الأول (عمود الترقيم غالباً) لا يظهر كحقل إدخال — يُحدَّد تلقائياً
  const numberColumn = allColumns[0];
  const editableColumns = allColumns.slice(1);

  const numberNote = numberColumn
    ? `<p class="text-xs text-ink/40 mb-1">"${escapeHtml(numberColumn)}" سيُحدَّد تلقائياً (ترقيم تسلسلي)</p>`
    : '';

  el.appendixFormFields.innerHTML =
    numberNote +
    editableColumns
      .map(
        (col) => `
      <label class="block">
        <span class="block text-xs font-semibold text-ink/55 mb-1.5">${escapeHtml(col)}</span>
        <input type="text" class="appendix-field-input w-full border border-line rounded-lg py-2.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-clay/40 focus:border-clay" data-column="${escapeAttr(col)}" />
      </label>`
      )
      .join('');

  // تحقق فوري من تكرار رقم الهوية أثناء الكتابة — قبل حتى الضغط على "إضافة
  // للجدول"، تماشياً مع نفس مبدأ حماية التسليم المزدوج لكن بمرحلة أبكر
  // (منع الإدخال المكرر أصلاً بدل تحذير بعد وقوعه).
  if (identifierColumnCache) {
    const idInput = el.appendixFormFields.querySelector(
      `.appendix-field-input[data-column="${CSS.escape(identifierColumnCache)}"]`
    );
    if (idInput) {
      const checkForDuplicate = () => {
        const existing = findRecordByIdentifierValue(idInput.value);
        if (existing) {
          const status = existing.__status ? 'وتم تسليمه بالفعل' : 'ولم يُسلَّم بعد';
          const tag = existing.__isAppendix ? ' (كملحق)' : '';
          el.appendixIdWarning.innerHTML = `<strong>⚠ هذا المعرّف موجود مسبقاً بالجدول${tag}</strong>${escapeHtml(status)} — لا يمكن إضافته مرة أخرى.`;
          el.appendixIdWarning.classList.remove('hidden');
          el.appendixIndividualSubmit.disabled = true;
        } else {
          el.appendixIdWarning.classList.add('hidden');
          el.appendixIdWarning.innerHTML = '';
          el.appendixIndividualSubmit.disabled = false;
        }
      };
      idInput.addEventListener('input', checkForDuplicate);
      idInput.addEventListener('blur', checkForDuplicate);
    }
  }
}

/**
 * يولّد ملف Excel فارغاً بنفس أعمدة الجلسة الحالية بالضبط (نفس الأسماء
 * والترتيب) ليعبّيه المستخدم يدوياً ويرفعه كملحق، بدل ما يخمّن أسماء
 * الأعمدة بنفسه. الورقة تُضبط صراحة كـ"من اليمين لليسار" (RTL) عبر
 * '!views' — بدون هذا الضبط، إكسل يفتحها افتراضياً من اليسار لليمين حتى
 * لو المحتوى عربي، وتبدو مقلوبة الاتجاه بصرياً.
 */
function downloadAppendixTemplate() {
  if (allColumns.length === 0) return;

  const worksheet = XLSX.utils.aoa_to_sheet([allColumns]);
  worksheet['!views'] = [{ rightToLeft: true }];
  // عرض معقول لكل عمود حسب طول اسمه، حتى تظهر العناوين كاملة دون قصّ
  worksheet['!cols'] = allColumns.map((col) => ({ wch: Math.max(12, col.length + 4) }));

  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { views: [{ RTL: true }] }; // اتجاه المصنّف بالكامل RTL أيضاً (تبويبات/شريط الأدوات)
  XLSX.utils.book_append_sheet(workbook, worksheet, 'نموذج ملحق');
  XLSX.writeFile(workbook, 'نموذج_إضافة_ملحق.xlsx');
}

el.appendixTemplateBtn?.addEventListener('click', downloadAppendixTemplate);

el.appendixBtn?.addEventListener('click', openAppendixModal);
el.appendixModalClose?.addEventListener('click', closeAppendixModal);
el.appendixModalOverlay?.addEventListener('click', closeAppendixModal);
// إغلاق إضافي عند الضغط خارج الصندوق الأبيض مباشرة (على خلفية النافذة
// نفسها، لا الطبقة المنفصلة)، لضمان الإغلاق بغض النظر عن ترتيب الطبقات.
el.appendixModal?.addEventListener('click', (event) => {
  if (event.target === el.appendixModal) closeAppendixModal();
});
el.appendixModeIndividual?.addEventListener('click', () => setAppendixMode('individual'));
el.appendixModeExcel?.addEventListener('click', () => setAppendixMode('excel'));

el.appendixIndividualSubmit?.addEventListener('click', async () => {
  const row = {};
  let hasAnyValue = false;
  el.appendixFormFields.querySelectorAll('.appendix-field-input').forEach((input) => {
    const val = input.value.trim();
    row[input.dataset.column] = val;
    if (val) hasAnyValue = true;
  });

  if (!hasAnyValue) {
    window.showToast?.('عبّئ حقلاً واحداً على الأقل قبل الإضافة', 'error', 2500);
    return;
  }

  const { added, skipped } = await addAppendixRecords([row]);
  if (added > 0) {
    window.showToast?.('تمت إضافة المستفيد كملحق بنجاح', 'success', 2500);
    closeAppendixModal();
  } else if (skipped > 0) {
    window.showToast?.('هذا المستفيد مضاف مسبقاً (نفس المعرّف الفريد)', 'error', 3000);
  }
});

/**
 * تعرض نتيجة استيراد ملف الملحق للمستخدم: رسالة واضحة، وقائمة الهويات
 * المرفوضة كاملةً (النافذة تدعم سكرول عمودي طبيعي فلا حاجة لعتبة عدد)، إلى
 * جانب زر تنزيل ملف الأخطاء دائماً كخيار إضافي — بغض النظر عن العدد. لا
 * تُغلق النافذة تلقائياً إطلاقاً إن وُجد أي خطأ، فقط عند نجاح الاستيراد
 * بالكامل بلا أي رفض.
 */
function renderAppendixDuplicatesResult({ added, skipped, duplicateValues, duplicateDetails }) {
  if (skipped === 0) {
    el.appendixExcelStatus.textContent = `تمت إضافة ${added} سجل كملحق بنجاح.`;
    el.appendixDuplicatesList.classList.add('hidden');
    el.appendixDuplicatesList.innerHTML = '';
    el.appendixDuplicatesDownloadBtn.classList.add('hidden');
    if (added > 0) {
      window.showToast?.(`تمت إضافة ${added} مستفيد كملحق بنجاح`, 'success', 3000);
      setTimeout(closeAppendixModal, 1200);
    }
    return;
  }

  // يوجد خطأ — لا نُغلق النافذة تلقائياً مهما كان، حتى يقدر المستخدم يقرأ
  // التفاصيل بهدوء.
  el.appendixExcelStatus.textContent =
    `⚠ يوجد خطأ: تم رفض ${skipped} سجل${added > 0 ? `، وإضافة ${added} سجل بنجاح` : ''} — رقم الهوية مكرر (موجود مسبقاً بالجدول أو مكرر داخل الملف نفسه).`;

  const items = duplicateDetails
    .map(({ row, existing }) => {
      const idValue = identifierColumnCache ? escapeHtml(String(row[identifierColumnCache] ?? '')) : '';
      const existingLabel = existing
        ? `— موجود مسبقاً${existing.__isAppendix ? ' (ملحق)' : ''}، ${existing.__status ? 'تم استلامه' : 'لم يُستلم بعد'}`
        : '';
      return `<li><b>${idValue}</b> ${existingLabel}</li>`;
    })
    .join('');
  el.appendixDuplicatesList.innerHTML = `<strong>الهويات المرفوضة (${duplicateValues.length}):</strong><ul>${items}</ul>`;
  el.appendixDuplicatesList.classList.remove('hidden');

  el.appendixDuplicatesDownloadBtn.classList.remove('hidden');
  el.appendixDuplicatesDownloadBtn.onclick = () => downloadAppendixDuplicatesFile(duplicateDetails);
}

/**
 * يصدّر ملف Excel منفصل بكل الصفوف المرفوضة بسبب تكرار المعرّف — كل صف
 * يحتوي بيانات الصف المرفوض كما ورد بالملف، بالإضافة لعمود "سبب الرفض"
 * وأعمدة إضافية موسومة بـ"(سجل موجود مسبقاً)" تعرض بيانات السجل الأصلي
 * صاحب نفس المعرّف — للمقارنة المباشرة بدون رجوع للجدول يدوياً.
 */
function downloadAppendixDuplicatesFile(duplicateDetails) {
  const rows = duplicateDetails.map(({ row, existing }) => {
    const out = {};
    allColumns.forEach((col) => {
      out[col] = row[col] ?? '';
    });
    out['سبب الرفض'] = 'رقم الهوية مكرر مع سجل موجود مسبقاً';
    allColumns.forEach((col) => {
      out[`(سجل موجود مسبقاً) ${col}`] = existing ? existing[col] ?? '' : '';
    });
    out['(سجل موجود مسبقاً) الحالة'] = existing ? (existing.__status ? 'تم الاستلام' : 'لم يتم الاستلام') : 'غير معروف';
    return out;
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!views'] = [{ rightToLeft: true }];
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(workbook, worksheet, 'هويات مكررة مرفوضة');

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `أخطاء_ملحق_هويات_مكررة_${today}.xlsx`);
}

el.appendixFileInput?.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  el.appendixExcelStatus.textContent = 'جاري القراءة...';

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      el.appendixExcelStatus.textContent = 'الملف لا يحتوي على بيانات قابلة للقراءة.';
      return;
    }

    const fileColumns = Object.keys(rows[0]);
    const overlap = fileColumns.filter((c) => allColumns.includes(c));
    if (overlap.length === 0) {
      el.appendixExcelStatus.textContent =
        'أعمدة هذا الملف لا تطابق أعمدة الجلسة الحالية إطلاقاً — تأكد من استخدام نفس الملف الأصلي كقالب.';
      return;
    }

    const { added, skipped, duplicateValues, duplicateDetails } = await addAppendixRecords(rows);
    renderAppendixDuplicatesResult({ added, skipped, duplicateValues, duplicateDetails });
  } catch (error) {
    console.error(error);
    el.appendixExcelStatus.textContent = 'تعذّرت قراءة الملف. تأكد أنه بصيغة Excel صحيحة (.xlsx أو .xls).';
  } finally {
    el.appendixFileInput.value = '';
  }
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
 * استقبال رسالة قفل عبر WebRTC P2P، بالشكل: applyLock(syncId, ownerId, ownerName)).
 * نخزّن معلومات الجهاز القافل، ونضبط مؤقّت احتياطي 30 ثانية يفكّ القفل تلقائياً
 * إن لم يصل إعلام فكّ قفل صريح (مثلاً بسبب انقطاع اتصال الجهاز الآخر).
 * @param {string} syncId
 * @param {string} [deviceId]
 * @param {string} [deviceName]
 */
function applyLock(syncId, deviceId, deviceName) {
  if (!syncId) return;

  // إن كان هناك مؤقّت سابق لنفس السجل، نلغيه قبل ضبط مؤقّت جديد
  if (lockExpiryTimers.has(syncId)) {
    clearTimeout(lockExpiryTimers.get(syncId));
  }

  lockedRecords.set(syncId, {
    deviceId: deviceId || null,
    deviceName: deviceName || 'جهاز آخر',
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
  setStatusFilter('all');
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
window.applyIncomingFullDataset = applyIncomingFullDataset;

/**
 * إعادة ضبط الحالة المحلية بالكامل عند استقبال "بدء جلسة جديدة" من جهاز آخر
 * (بدل الاكتفاء بمسح IndexedDB فقط، لازم نصفّر أيضاً المتغيرات الداخلية
 * الفعلية التي تُستخدم فعلياً بالعرض، وإلا تبقى البيانات القديمة ظاهرة
 * بالشاشة رغم أنها انمسحت من قاعدة البيانات).
 */
async function resetLocalStateForRemoteReset() {
  await clearAllData();
  allRecords = [];
  allColumns = [];
  currentSearch = '';
  el.searchInput.value = '';
  setStatusFilter('all');
  renderApp();
}
window.resetLocalStateForRemoteReset = resetLocalStateForRemoteReset;

/**
 * ضبط أعمدة البيانات من مصدر خارجي (جهاز آخر) فقط إن لم تكن معرّفة محلياً
 * بعد. تُستخدم من sync-bridge.js عند استقبال بيانات من جهاز آخر قبل أي
 * استيراد محلي على هذا الجهاز.
 */
async function setAllColumnsIfMissing(columns) {
  if (columns?.length && allColumns.length === 0) {
    allColumns = columns;
    await setMeta('columns', columns);
  }
}
window.setAllColumnsIfMissing = setAllColumnsIfMissing;

// مرايا حيّة (live getters) بدل نسخ جامدة تُلتقط مرة واحدة فقط: أي كود خارجي
// (مثل sync-bridge.js) يقرأ window.allRecords/allColumns/deviceId/deviceName
// يحصل دائماً على القيمة الحالية الحقيقية للمتغيرات الداخلية أعلاه، مهما
// تغيّرت لاحقاً (استيراد جديد، مزامنة، دمج بيانات...). هذا يمنع مشكلة "نسخة
// قديمة جامدة" التي كانت السبب الجذري لعدم مزامنة الاستيراد وعدم عمل مبدأ
// "الأحدث يفوز" بعد إعادة الاتصال، وعدم عمل قفل السجلات (deviceId/deviceName
// لم يكونا مُصدَّرين إطلاقاً من قبل).
Object.defineProperty(window, 'allRecords', { get: () => allRecords, configurable: true });
Object.defineProperty(window, 'allColumns', { get: () => allColumns, configurable: true });
Object.defineProperty(window, 'deviceId', { get: () => deviceId, configurable: true });
Object.defineProperty(window, 'deviceName', { get: () => deviceName, configurable: true });


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
   13) اعتراض زر الرجوع (أندرويد) — لا يُغلق التطبيق إطلاقاً
   -------------------------------------------------------------------------
   الخروج المفاجئ من التطبيق (بالخطأ عبر زر الرجوع) يقطع اتصال WebRTC فوراً
   لأن الصفحة/JS كلها تُغلق. بعد ملاحظة أن هذا يصير كثيراً بالخطأ أثناء
   الاستخدام الفعلي، قررنا تعطيل الخروج عبر زر الرجوع نهائياً: هو فقط يُغلق
   أي قائمة/نافذة مفتوحة (كأنه ضغط "إلغاء" أو ×)، وإلا لا يفعل شيئاً. الخروج
   الفعلي الوحيد المتاح صار عبر زر الرئيسية (Home) أو سحب التطبيق من قائمة
   التطبيقات الأخيرة — وهذان مساران يديرهما النظام مباشرة، خارج تحكم الصفحة،
   فلا حاجة لأي منطق إضافي لهما هنا.
   نغطي حالتين مختلفتين لأن التطبيق قد يعمل إما كـ APK حقيقي (Capacitor) أو
   كـ PWA على المتصفح مباشرة (الحالة الحالية عبر GitHub Pages) — وزر الرجوع
   بالأندرويد يُدار بطريقة مختلفة تماماً بكل حالة.
   ------------------------------------------------------------------------- */
function setupBackButtonGuard() {
  /**
   * تتحقق من أي قائمة جانبية/نافذة مفتوحة حالياً وتسكرها (بمثابة الضغط على
   * "إلغاء" أو ×)، وتُعيد true إن كانت أغلقت شيئاً فعلاً.
   * الترتيب مهم: نتحقق من الأعمق (نافذة QR) قبل الأسطح الأبعد.
   */
  function closeTopmostOverlay() {
    if (document.getElementById('sessionModal')?.classList.contains('open')) {
      window.closeModal?.();
      return true;
    }
    if (el.appendixModal && !el.appendixModal.classList.contains('hidden')) {
      closeAppendixModal();
      return true;
    }
    if (el.identifierModal && !el.identifierModal.classList.contains('hidden')) {
      closeIdentifierModal();
      return true;
    }
    if (el.drawer?.classList.contains('open')) {
      closeDrawer();
      return true;
    }
    if (el.devicesPanel?.classList.contains('open')) {
      closeDevicesPanel();
      return true;
    }
    if (el.sessionPanel?.classList.contains('open')) {
      closeSessionPanel();
      return true;
    }
    if (document.getElementById('resumeSessionBanner')) {
      document.getElementById('resumeSessionBanner').remove();
      return true;
    }
    return false;
  }

  // "معالج القرار" المشترك: يُستدعى من أي مصدر (Capacitor أو popstate) عند
  // ضغطة رجوع واحدة، ويُعيد true إن كان يجب فعلاً الخروج الآن.
  //
  // ملاحظة فنية مهمة: لا توجد طريقة تجعل الخروج عبر زر الرجوع "مستحيلاً"
  // 100% — هذا قرار أمان متعمّد بتصميم المتصفحات نفسها (لمنع مواقع خبيثة من
  // "حبس" المستخدم داخل الصفحة)، وليس قصوراً بالتنفيذ. أقصى ما يمكن ضمانه
  // فعلياً هو نمط "اضغط رجوع مرتين للخروج" المعتاد بمعظم تطبيقات أندرويد.
  const EXIT_CONFIRM_WINDOW_MS = 2500;
  let awaitingExitConfirm = false;
  let exitConfirmTimer = null;

  function shouldExitNow() {
    if (closeTopmostOverlay()) return false;

    if (awaitingExitConfirm) {
      clearTimeout(exitConfirmTimer);
      awaitingExitConfirm = false;
      return true; // ضغطة ثانية خلال المهلة — خروج فعلي
    }

    awaitingExitConfirm = true;
    window.showToast('اضغط رجوع مرة أخرى للخروج من التطبيق', 'info', EXIT_CONFIRM_WINDOW_MS);
    exitConfirmTimer = setTimeout(() => {
      awaitingExitConfirm = false;
    }, EXIT_CONFIRM_WINDOW_MS);
    return false; // ضغطة أولى — تحذير فقط
  }

  // --- الحالة 1: تطبيق أندرويد أصلي (APK) عبر Capacitor ---
  // نتحقق فعلياً أننا داخل منصة أصلية وليس مجرد وجود stub ويب وهمي لـ
  // Capacitor (المعرّف في index.html للتوافق على الويب) — نفضّل
  // isNativePlatform() (الطريقة الرسمية الموصى بها بتوثيق Capacitor) على
  // مقارنة getPlatform() يدوياً وحدها.
  const isNative = window.Capacitor?.isNativePlatform?.() ?? (window.Capacitor?.getPlatform?.() !== 'web');

  if (isNative) {
    // ملاحظة مهمة جداً: على أندرويد الحقيقي (APK)، الاعتماد على
    // history.pushState/popstate (فرع "الحالة 2" أدناه) لا يعمل إطلاقاً
    // لاعتراض زر الرجوع الفعلي بالجهاز — هذا الزر حدث نظام أندرويد أصلي
    // (Activity.onBackPressed) ولا علاقة له بتاريخ تصفح الصفحة، فلا يُطلق
    // popstate مطلقاً بدون تدخّل Capacitor نفسها. المسار الوحيد الفعّال هو
    // مكوّن Capacitor's App وحدث backButton الخاص به. إن فشلنا بالوصول له،
    // زر الرجوع سيُغلق التطبيق فوراً بسلوك أندرويد الافتراضي — بالضبط ما
    // كان يحصل قبل هذا الإصلاح.
    //
    // المشكلة الفعلية التي عالجناها هنا: عند بدء تشغيل الصفحة، جسر
    // Capacitor (bridge) وتسجيل الإضافات (plugins) قد لا يكون جاهزاً تماماً
    // باللحظة التي يُنفَّذ فيها هذا الكود (خصوصاً على أجهزة أبطأ أو عند فتح
    // التطبيق بارداً) — فحص واحد فوري كان يفشل صامتاً (appPlugin=undefined)
    // ويسقط الكود بالخطأ لفرع popstate غير الفعّال إطلاقاً على أندرويد، فيصير
    // زر الرجوع بلا أي اعتراض ويُغلق التطبيق مباشرة بضغطة واحدة بلا تحذير —
    // بالضبط العرض المُبلَّغ عنه. الآن نعيد المحاولة عدة مرات بمهلة قصيرة
    // قبل الاستسلام.
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    const RETRY_DELAY_MS = 300;

    const tryAttach = () => {
      const appPlugin = window.Capacitor?.Plugins?.App;
      if (appPlugin && typeof appPlugin.addListener === 'function') {
        appPlugin.addListener('backButton', () => {
          if (shouldExitNow()) appPlugin.exitApp();
        });
        return;
      }
      attempts += 1;
      if (attempts < MAX_ATTEMPTS) {
        setTimeout(tryAttach, RETRY_DELAY_MS);
      } else {
        console.warn(
          'تعذّر العثور على إضافة Capacitor App بعد عدة محاولات — تأكد أن ' +
          '@capacitor/app مضافة بالمشروع وتم تشغيل "npx cap sync android". ' +
          'زر الرجوع سيعمل بسلوك أندرويد الافتراضي (خروج فوري بلا تحذير) حتى يُحل هذا.'
        );
      }
    };
    tryAttach();
    return;
  }

  // --- الحالة 2: PWA/صفحة ويب عادية (تصفح مباشر عبر Chrome، وليس APK) ---
  // زر رجوع أندرويد هنا يُترجَم لحدث popstate على تاريخ المتصفح. نضيف حالة
  // وهمية بالتاريخ عند التحميل؛ كل ضغطة رجوع "تستهلك" هذه الحالة فتُطلق
  // popstate بدل الخروج مباشرة من الصفحة/التطبيق — فنعترضها هنا ونقرر.
  history.pushState({ __exitGuard: true }, '');
  window.addEventListener('popstate', () => {
    if (shouldExitNow()) {
      // خروج فعلي: نُرجع خطوة تاريخ إضافية بدل إعادة إدراج الحارس، حتى
      // تُغلق الصفحة/التبويب فعلاً (أو تُصغَّر إن كان تطبيقاً مثبَّتاً) بدل
      // الدخول بحلقة لا نهائية.
      history.back();
      return;
    }
    // البقاء بالتطبيق: نعيد إدراج نفس حالة الحارس حتى تبقى الحماية فعّالة
    // لأي ضغطة رجوع لاحقة.
    history.pushState({ __exitGuard: true }, '');
  });
}

/* -------------------------------------------------------------------------
   14) نقطة البداية: فتح القاعدة، تحميل البيانات المحفوظة سابقاً، وعرضها
   ------------------------------------------------------------------------- */
(async function init() {
  updateConnectionStatus();

  // نعزل هذا الاستدعاء بـ try/catch خاص به حتى لا يوقف أي خطأ فيه بقية init
  // (وتحديداً فتح قاعدة البيانات) — هذا بالضبط ما كان يحدث سابقاً.
  try {
    setupBackButtonGuard();
  } catch (guardError) {
    console.warn('تعذّر تفعيل حارس زر الرجوع (غير حرج):', guardError);
  }

  try {
    db = await openDatabase();
    allColumns = (await getMeta('columns')) || [];
    allRecords = await getAllRecords();
    identifierColumnCache = (await getMeta('identifierColumn')) || null;
    renderApp();

    await ensureDeviceIdentity();
    renderDevicesList(null); // يعرض جهازك ("أنت") فوراً حتى بدون أي اتصال

    // إن كان قد سبق واتصل هذا الجهاز بخادم مزامنة، نعبّئ العنوان تلقائياً
    // ونحاول إعادة الاتصال به دون تدخل المستخدم.
    // P2P — لا يوجد خادم للاتصال به تلقائياً، الجلسة تبدأ عبر QR Code

    // إن كانت هناك جلسة P2P سابقة (حتى لو التطبيق أُغلق بالكامل ثم أُعيد
    // فتحه) نعرض شريط تذكير يتيح استئنافها بضغطة واحدة بدل البدء من الصفر.
    try {
      const lastRole = await getMeta('lastSessionRole');
      if (lastRole === 'host' || lastRole === 'peer') {
        showResumeSessionBanner(lastRole);
      }
    } catch (metaError) {
      console.warn('تعذّرت قراءة معلومات الجلسة السابقة (غير حرج):', metaError);
    }
  } catch (error) {
    console.error('تعذّر فتح قاعدة البيانات المحلية:', error);
    setImportStatus('تعذّر الوصول إلى التخزين المحلي في هذا المتصفح.', 'error');
  }
})();
