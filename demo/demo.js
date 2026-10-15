/* =========================================================================
   demo.js — طبقة النسخة التجريبية (تُحقن فقط في بناء الديمو، لا في التطبيق)
   - تعبئة بيانات وهمية تلقائياً عند أول فتح
   - عدّاد تنازلي لكل زائر: بعد ساعة تُمسح كل البيانات المحلية ويُعاد التعبئة
   - نافذة تعريفية بالعربية والإنجليزية + ملف إكسل تجريبي للتحميل
   يعتمد على دوال/متغيرات عامة من script.js: db, allRecords, finalizeImport,
   getAllRecords, updateRecord, renderApp, DB_NAME
   ========================================================================= */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  // ?demoMinutes=0.2 — للاختبار فقط
  var DEMO_MINUTES = Number(params.get("demoMinutes")) || 60;
  var DURATION_MS = DEMO_MINUTES * 60 * 1000;
  var KEY_START = "tam-demo-start";
  var KEY_INTRO = "tam-demo-intro-seen";
  var ID_COLUMN = "رقم الهوية";
  var COLUMNS = [
    "رقم الهوية",
    "الاسم الرباعي",
    "رقم التواصل الأساسي",
    "رقم التواصل البديل",
    "رقم هوية الطفل",
    "اسم الطفل",
    "تاريخ الميلاد",
    "المنطقة",
  ];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- مولّد بيانات وهمية (حتمي حتى تبقى ثابتة بين التصفيرات) ---------------- */
  function rng(seed) {
    return function () {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  var MALE = ["محمد", "أحمد", "ابراهيم", "خالد", "يوسف", "سامي", "عمر", "علي", "حسن", "محمود", "سليمان", "زكريا", "كمال", "عبد الله", "عبد الكريم", "عبد العزيز", "رامي", "نبيل", "ماهر", "جمال", "وليد", "طارق", "هاني", "سعيد"];
  var FEMALE = ["ريما", "ميرا", "سيلا", "جوان", "علاء", "لين", "مريم", "سارة", "جنى", "تالا", "رهف", "هبة", "نور", "ليان"];
  var KIDS_M = ["تميم", "وائل", "آدم", "كريم", "زيد", "يامن", "حمزة", "أنس"];
  var FAMILY = ["الشيخ", "حمدان", "سلمان", "منصور", "الرقب", "العمور", "الزاملي", "شحده", "أبو حية", "النجار", "الحلو", "عيسى", "عودة", "البنا", "الأغا", "المصري", "صالح", "قاسم"];
  var AREAS = ["الشمال", "الوسطى", "الجنوب", "الشرق", "الغرب", "المركز"];

  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function digits(r, prefix, len) {
    var s = String(prefix);
    while (s.length < len) s += Math.floor(r() * 10);
    return s;
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function generateRows(count) {
    var r = rng(20261015);
    var rows = [];
    var used = {};
    for (var i = 0; i < count; i++) {
      var father = pick(r, MALE);
      var grand = pick(r, MALE);
      var family = pick(r, FAMILY);
      var first = pick(r, MALE);
      var id;
      do { id = digits(r, pick(r, ["4", "8", "9"]), 9); } while (used[id]);
      used[id] = 1;
      var phone = digits(r, pick(r, ["59", "56"]), 9);
      var kid = r() < 0.5 ? pick(r, FEMALE) : pick(r, KIDS_M);
      var month = 1 + Math.floor(r() * 12);
      var day = 1 + Math.floor(r() * 28);
      var year = month > 9 ? 2025 : 2026;
      var row = {};
      row["رقم الهوية"] = id;
      row["الاسم الرباعي"] = first + " " + father + " " + grand + " " + family;
      row["رقم التواصل الأساسي"] = phone;
      row["رقم التواصل البديل"] = r() < 0.3 ? phone : digits(r, pick(r, ["59", "56"]), 9);
      row["رقم هوية الطفل"] = digits(r, "47", 9);
      row["اسم الطفل"] = kid + " " + first + " " + father + " " + family;
      row["تاريخ الميلاد"] = year + "-" + pad(month) + "-" + pad(day);
      row["المنطقة"] = pick(r, AREAS);
      rows.push(row);
    }
    return rows;
  }

  /* ---------------- التعبئة التلقائية ---------------- */
  function waitForDb() {
    return new Promise(function (resolve) {
      (function check(tries) {
        // db و allRecords متغيرات let عامة من script.js
        if (typeof db !== "undefined" && db && typeof allRecords !== "undefined") return resolve();
        if (tries > 200) return resolve();
        setTimeout(function () { check(tries + 1); }, 50);
      })(0);
    });
  }

  async function seedIfEmpty() {
    await waitForDb();
    if (typeof db === "undefined" || !db) return;
    if (allRecords.length > 0) return;

    var rows = generateRows(220);
    await finalizeImport(rows, COLUMNS.slice(), ID_COLUMN, "بيانات-تجريبية.xlsx");

    // نعلّم ~15% كـ "تم الاستلام" حتى تظهر الإحصائيات والتقرير بشكل حي
    var r = rng(7);
    var receivers = ["الأم", "الأب", "الجدة", "صاحب الهوية"];
    var now = Date.now();
    var records = await getAllRecords();
    for (var i = 0; i < records.length; i++) {
      if (r() >= 0.15) continue;
      var rec = records[i];
      rec.__status = true;
      rec.__receiver = pick(r, receivers);
      rec.__deliveredAt = now - Math.floor(r() * 3 * 60 * 60 * 1000);
      rec.__deliveredByName = "جهاز تجريبي";
      rec.__deliveredByDeviceId = null;
      rec.__updatedAt = now;
      await updateRecord(rec);
    }
    allRecords = await getAllRecords();
    renderApp();
  }

  /* ---------------- التصفير ---------------- */
  var resetting = false;
  function resetDemo() {
    if (resetting) return;
    resetting = true;
    try { if (typeof db !== "undefined" && db) db.close(); } catch (e) {}
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("tam-") === 0 && k !== KEY_INTRO) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
    lsSet(KEY_START, String(Date.now()));
    var done = function () { location.reload(); };
    try {
      var req = indexedDB.deleteDatabase(typeof DB_NAME !== "undefined" ? DB_NAME : "DeliveryCoreDB");
      req.onsuccess = req.onerror = req.onblocked = done;
    } catch (e) { done(); }
  }

  /* ---------------- الشارة العائمة + العدّاد ---------------- */
  var start = Number(lsGet(KEY_START));
  if (!start || Date.now() - start > DURATION_MS) {
    // أول زيارة، أو انتهت المدة والصفحة كانت مغلقة: نبدأ عدّاً جديداً
    if (start) { lsSet(KEY_START, String(Date.now())); resetDemo(); return; }
    start = Date.now();
    lsSet(KEY_START, String(start));
  }

  var pill = document.createElement("div");
  pill.className = "demo-pill";
  pill.setAttribute("dir", "rtl");
  pill.innerHTML =
    '<button type="button" class="demo-pill__info" title="عن النسخة التجريبية · About this demo">' +
    '<span class="demo-pill__dot"></span><span>نسخة تجريبية</span></button>' +
    '<span class="demo-pill__sep"></span>' +
    '<span class="demo-pill__time" title="تُمسح كل التعديلات وتعود البيانات لحالتها الأولى · Resets to fresh data">' +
    'تصفير خلال <b dir="ltr">--:--</b></span>' +
    '<button type="button" class="demo-pill__reset" title="تصفير الآن · Reset now">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>' +
    "</button>";
  document.body.appendChild(pill);

  var timeEl = pill.querySelector(".demo-pill__time b");
  function tick() {
    var left = DURATION_MS - (Date.now() - start);
    if (left <= 0) {
      timeEl.textContent = "00:00";
      resetDemo();
      return;
    }
    var s = Math.ceil(left / 1000);
    timeEl.textContent = pad(Math.floor(s / 60)) + ":" + pad(s % 60);
  }
  tick();
  setInterval(tick, 1000);

  pill.querySelector(".demo-pill__reset").addEventListener("click", function () {
    if (window.confirm("تصفير النسخة التجريبية وإعادة البيانات لحالتها الأولى؟\nReset the demo to fresh data?")) {
      resetDemo();
    }
  });
  pill.querySelector(".demo-pill__info").addEventListener("click", openIntro);

  /* ---------------- النافذة التعريفية ---------------- */
  var intro = null;
  function buildIntro() {
    intro = document.createElement("div");
    intro.className = "demo-intro";
    intro.setAttribute("role", "dialog");
    intro.setAttribute("aria-modal", "true");
    intro.setAttribute("aria-labelledby", "demoIntroTitle");
    intro.innerHTML =
      '<div class="demo-intro__card" dir="rtl">' +
      '<div class="demo-intro__head">' +
      '<div class="stamp-mark shrink-0" aria-hidden="true"><span>تم</span></div>' +
      '<div><h2 id="demoIntroTitle">برنامج التسليم الميداني</h2>' +
      '<p class="demo-intro__en" dir="ltr">Tam — offline-first field delivery app</p></div>' +
      "</div>" +
      '<ul class="demo-intro__list">' +
      "<li><b>تسليم ميداني بدون إنترنت</b> — بحث فوري، تسجيل الاستلام، تقرير الجلسة وسجل النشاط." +
      '<span dir="ltr">Works fully offline: instant search, delivery marking, session report and activity log.</span></li>' +
      "<li><b>استيراد وتصدير Excel</b> — يحافظ على ترتيب أعمدة الملف الأصلي." +
      '<span dir="ltr">Excel import/export that keeps the original column layout.</span></li>' +
      "<li><b>مزامنة بين الأجهزة عبر QR</b> — اتصال مباشر (P2P) بدون خادم، مع منع التسليم المزدوج." +
      '<span dir="ltr">Device-to-device sync over QR + WebRTC, no server, with double-delivery guards.</span></li>' +
      "</ul>" +
      '<p class="demo-intro__note">كل ما تراه بيانات وهمية، محفوظة في متصفحك فقط، وتعود لحالتها الأولى كل ساعة.' +
      '<span dir="ltr">Everything here is fictional, stays in your browser, and resets every hour.</span></p>' +
      '<div class="demo-intro__actions">' +
      '<button type="button" class="demo-intro__start">ابدأ التجربة · Start</button>' +
      '<button type="button" class="demo-intro__sample">تحميل ملف Excel تجريبي · Sample file</button>' +
      "</div>" +
      '<p class="demo-intro__credit" dir="ltr">Designed &amp; built by Omar Kilany</p>' +
      "</div>";
    document.body.appendChild(intro);
    intro.addEventListener("click", function (e) { if (e.target === intro) closeIntro(); });
    intro.querySelector(".demo-intro__start").addEventListener("click", closeIntro);
    intro.querySelector(".demo-intro__sample").addEventListener("click", downloadSample);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && intro.classList.contains("is-open")) closeIntro();
    });
  }
  function openIntro() {
    if (!intro) buildIntro();
    intro.classList.add("is-open");
    intro.querySelector(".demo-intro__start").focus();
  }
  function closeIntro() {
    if (!intro) return;
    intro.classList.remove("is-open");
    lsSet(KEY_INTRO, "1");
  }

  function downloadSample() {
    if (typeof XLSX === "undefined") return;
    var rows = generateRows(60).map(function (row) {
      // أسماء مختلفة عن البيانات المحمّلة حتى يظهر الاستيراد كقائمة جديدة
      row["رقم الهوية"] = "3" + row["رقم الهوية"].slice(1);
      return row;
    });
    var ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "المستفيدين");
    XLSX.writeFile(wb, "tam-sample.xlsx");
  }

  if (!lsGet(KEY_INTRO)) openIntro();
  seedIfEmpty().catch(function (e) { console.warn("demo seed failed:", e); });
})();
