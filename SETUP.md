# خطوات رفع المشروع وبناء APK
# (مرة وحدة بس، بعدها كل تعديل يبني تلقائياً)

## الخطوات

### ١) فكّ ضغط الملف
فكّ delivery-apk.zip في أي مكان على حاسوبك.

### ٢) ثبّت GitHub Desktop
حمّله من: https://desktop.github.com
افتحه وسجّل دخول بحساب GitHub الخاص فيك.

### ٣) ارفع المشروع على GitHub
- افتح GitHub Desktop
- اضغط File → Add Local Repository
- اختر مجلد delivery-apk
- اضغط "create a repository" لو طلب منك
- Repository Name: delivery-apk
- اضغط Publish repository (يكون Public أو Private، ما يفرق)

### ٤) ابدأ البناء
- اذهب لـ github.com وافتح الـ repository الجديد
- اضغط تبويب "Actions" من القائمة العلوية
- اضغط "بناء APK" من القائمة اليسرى
- اضغط "Run workflow" (زر أزرق على اليمين) → "Run workflow"
- انتظر 5-8 دقائق (شريط أصفر يتحول أخضر)

### ٥) حمّل APK
- بعد انتهاء البناء، اضغط على اسم الـ workflow
- انزل لأسفل إلى قسم "Artifacts"
- اضغط "delivery-apk-1" لتحميل الملف
- فكّ الضغط → ستجد app-debug.apk
- أرسله للموبايل عبر واتساب أو USB وثبّته

---

## كل مرة تعدّل على الكود:
١) عدّل الملفات في مجلد public/
٢) افتح GitHub Desktop → اكتب وصف قصير → اضغط Commit → Push
٣) GitHub سيبني APK جديد تلقائياً (تجده في Actions)
