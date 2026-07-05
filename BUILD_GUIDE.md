# دليل بناء APK — نواة التسليم الميداني
## خطوات التثبيت والبناء من الصفر

---

## المتطلبات (ثبّتها مرة وحدة بس)

| الأداة | الرابط | ملاحظة |
|--------|--------|--------|
| Node.js 18+ | https://nodejs.org | اختر LTS |
| Java JDK 17 | https://adoptium.net | اختر JDK 17 LTS |
| Android Studio | https://developer.android.com/studio | ثبّت مع Android SDK |

بعد تثبيت Android Studio:
1. افتح Android Studio → More Options → SDK Manager
2. تأكد من تثبيت: Android 14 (API 34) أو أحدث
3. تأكد من تثبيت: Android SDK Build-Tools

---

## الخطوات

### الخطوة ١ — تثبيت حزم المشروع
cd delivery-apk
npm install

### الخطوة ٢ — إضافة منصة Android
npx cap add android

### الخطوة ٣ — نسخ ملف الصلاحيات
انسخ AndroidManifest.xml إلى:
android/app/src/main/AndroidManifest.xml
(استبدل الملف الموجود بالكامل)

### الخطوة ٤ — مزامنة الملفات
npx cap sync android

### الخطوة ٥ — فتح Android Studio
npx cap open android

### الخطوة ٦ — بناء APK
للتجربة: Build → Build APK(s)
الملف: android/app/build/outputs/apk/debug/app-debug.apk

للنشر: Build → Generate Signed Bundle / APK → APK → release

---

## تثبيت APK على الموبايل

من USB (يحتاج USB debugging مفعّل):
adb install android/app/build/outputs/apk/debug/app-debug.apk

من الملف مباشرة:
انسخ APK للموبايل عبر واتساب/بلوتوث، افتحه، وافق على التثبيت.

---

## كل مرة تعدّل على الكود:
npx cap sync android
ثم Build APK من Android Studio.

---

## iOS
npx cap add ios
npx cap sync ios
npx cap open ios
ثم Build من Xcode (يحتاج Mac)

---

## استكشاف الأخطاء

JAVA_HOME not set:
  Windows: Environment Variables → JAVA_HOME = مسار JDK
  PATH += %JAVA_HOME%\bin

SDK location not found:
  أنشئ android/local.properties وأضف:
  sdk.dir=C\:\\Users\\YourName\\AppData\\Local\\Android\\Sdk

الكاميرا لا تعمل في المتصفح (PWA):
  يحتاج HTTPS. استخدم: npx serve public --ssl
