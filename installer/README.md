# توثيق المُثبِّت — VencordMe

يشرح هذا الملف كيف يُبنى `VencordMe-Setup.exe`، وكيف يعمل، وكيف ترسله لصديقك.

---

## 1. ماذا يُسلّم المستخدم النهائي

ملف واحد فقط:

```
VencordMe-Setup.exe   (~3.1 MB)
```

النافذة تعرض تثبيتات Discord المكتشفة (مع زر **Browse...** لمسار غير معتاد)،
ثم ثلاثة أزرار:

| الزر | ماذا يفعل |
|---|---|
| **Install** | الترقين + كتابة الإعدادات الافتراضية: **كل الإضافات معطّلة (210 إضافة، صفر مُفعَّلة)** |
| **Install + Settings** | الترقين + كتابة **ملف إعداداتي** المضمَّن (`settings.mine.json`) بإعداداتك الكاملة المُفعَّلة، **ماعدا `pnygo` المعطَّل** (لا webhook) |
| **Uninstall** | إرجاع `app.asar` الأصلية (واختيارياً حذف مجلد البيانات) |

وملاحظة أسفل الأزرار توضّح الفرق بين الزرّين. إن لم يوجد ملف إعدادات مضمَّن
يظل زر **Install + Settings** معطَّلاً.

خيارات أخرى:

- ☑ **Close Discord automatically while installing** — يغلق ديسكورد قبل الترقين (مُفعَّل افتراضياً).
- ☑ **Overwrite settings with the defaults** — يفرض الإعدادات الافتراضية حتى لو
  كان `%APPDATA%\VencordMe\settings` موجوداً (زر **Install + Settings** يكتب
  ملفه مهما كان الوضع، ولا يحتاج هذا الخيار).
- ☑ **Also delete the VencordMe data folder when uninstalling** — يحذف
  `%APPDATA%\VencordMe` كلياً عند الإزالة.

ومن الطرفية:

```powershell
VencordMe-Setup.exe --install --with-profile   # الترقين + ملف الإعدادات المضمَّن
VencordMe-Setup.exe --install                  # الترقين + الافتراضي
```

**خصوصية ملف الإعدادات المضمَّن**: `settings.mine.json` يحتوي إعداداتك الشخصية
(روابط CustomRPC، مساحات PinDMs، مسار حفظ الصوت … إلخ) وهو يُبنى داخل
`VencordMe-Setup.exe`؛ أي من يملك الملف يملك هذه الإعدادات. `pnygo` يُصفَّر
كلياً (لا webhook). راجع قرار النشر قبل رفعه على مستودع عام.

---

## 2. بناء المُثبِّت من الصفر

المتطلبات:

| الأداة | ملاحظة |
|---|---|
| Node.js + pnpm | لإعادة بناء `dist/` |
| csc.exe (.NET Framework 4.x) | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` |

خطوات البناء:

```powershell
# 1) التبعيات
pnpm install

# 2) بناء ملفات التشغيل (standalone، بدون updater)
pnpm buildStandalone --disable-updater

# 3) توليد ملفات الإعدادات (اختياري: الـ payload محفوظ في المستودع)
node installer\makeSettings.mjs "C:\path\to\your\vencord-settings.json"
#    → installer\payload\settings.json        (الافتراضي: 210 إضافة، صفر مُفعَّلة، صفر روابط/مسارات)
node installer\makeSettings.mjs "C:\path\to\your\vencord-settings.json" --profile
#    → installer\payload\settings.mine.json   (إعداداتك: مُفعَّلة كما هي، pnygo معطَّل بلا webhook)
#    → installer\payload\quickCss.css         (فارغ)

# 4) بناء المُثبِّت نفسه
powershell -ExecutionPolicy Bypass -File installer\build.ps1
#    → VencordMe-Setup.exe
#    (يُضمِّن settings.mine.json فقط إن كان موجوداً، وإلا يبقى الزر الثاني معطَّلاً)
```

> لا تنسَ أن مجلد `installer\payload\` مطلوب أثناء الخطوة 4،
> وكذلك ملفات `dist\` الستة.

---

## 3. كيف يعمل حقًّا

### أ) ملفات البيانات

| المسار | المحتوى |
|---|---|
| `%APPDATA%\VencordMe\dist\` | `patcher.js` `preload.js` `renderer.js` `renderer.css` + ملفات `.LEGAL.txt` |
| `%APPDATA%\VencordMe\settings\settings.json` | الإعدادات (كل الإضافات معطّلة) |
| `%APPDATA%\VencordMe\settings\quickCss.css` | CSS مخصّص (فارغ افتراضيًا) |

### ب) حقن Discord (app.asar)

يبحث المُثبِّت عن التثبيتات في:

```
%LOCALAPPDATA%\Discord\app-*\resources\
%LOCALAPPDATA%\DiscordCanary\app-*\resources\
%LOCALAPPDATA%\DiscordPTB\app-*\resources\
```

لكل مجلد `resources`:

1. إن لم يوجد `_app.asar` → يُغيّر اسم `app.asar` إلى `_app.asar` (نسخة أصلية محفوظة).
2. يكتب `app.asar` جديدًا بحجم يقارب 240 بايت فقط، يحوي:

```
index.js      →  require("C:\\Users\\...\\AppData\\Roaming\\VencordMe\\dist\\patcher.js")
package.json  →  {\n\t"name": "discord",\n\t"main": "index.js"\n}
```

الصفحة الافتتاحية للـ asar بالصيغة القياسية:

```
uint32le  4
uint32le  headerSize = hss + 8
uint32le  headerObjSize = hss + 4
uint32le  headerStringSize = hss      (JSON، مُحاذى إلى مضاعف 4)
JSON      {"files":{"index.js":{...},"package.json":{...}}}
payload   index.js ثم package.json
```

ثم يُشغِّل Discord فيقوم `patcher.js` بتفعيل VencordMe.

### ج) عملية Uninstall

1. إن كان `app.asar` عبارة عن patcher (نقرأ الترويسة ونتأكد أن `index.js` تبدأ بـ `require(`) نحذفه.
2. نُعيد تسمية `_app.asar` → `app.asar`.
3. اختياري: حذف مجلد `%APPDATA%\VencordMe`.

العملية آمنة للتكرار: التشغيل مرّتين لا يُفسد نسخة الاحتياطية،
والإزالة مرّتين تُترك في الحالة الأصلية.

### د) بعد تحديث Discord

يوجد `src/main/persistAfterDiscordUpdates.ts` ينسخ ملف الـ asar المُرقّن
وأصله إلى أي إصدار جديد `app-*` يظهر، فيبقى التفعيل بعد التحديث.

---

## 4. خيارات سطر الأوامر

المُثبِّت يعمل كنافذة GUI افتراضيًا، ويمكن التحكّم به من الطرفية.
**الأمر يكون أول معامل دائمًا**، ثم تأتي الخيارات بعده:

```
VencordMe-Setup.exe                          فتح النافذة
  --install [--yes] [--reset] [--with-profile]  ترقين كل التثبيتات المكتشفة
  --uninstall [--yes]                        إزالة الترقين
  --list                                     عرض التثبيتات المكتشفة
  --patch <resourcesDir> [--data-dir <dir>]  ترقين مجلد resources واحد (اختبار)
  --unpatch <resourcesDir> [--data-dir <dir>] إزالة ترقين مجلد واحد (اختبار)
  --gen-asar <patcherPath> <out>             توليد app.asar فقط (فحص)
  --data-dir <dir>                           تجاوز مجلد %APPDATA%\VencordMe (يوضع بعد الأمر)
  --help                                     عرض المساعدة
```

أمثلة مفيدة:

```powershell
.\VencordMe-Setup.exe --list
.\VencordMe-Setup.exe --install --with-profile
.\VencordMe-Setup.exe --patch "C:\X\Discord\app-1.0.9260\resources" --data-dir "$env:TEMP\vmtest\data"
.\VencordMe-Setup.exe --patch "C:\X\Discord\app-1.0.9260\resources" --data-dir "$env:TEMP\vmtest\data" --with-profile
.\VencordMe-Setup.exe --unpatch "C:\X\Discord\app-1.0.9260\resources" --data-dir "$env:TEMP\vmtest\data"
```

> ملاحظة: في الطرفية استخدم `Start-Process ... -RedirectStandardOutput file.txt -Wait`
> لالتقاط المخرجات، لأن تطبيقات WinExe لا ترث الـ stdout عند التوجيه بـ `>` مباشرة.

في نافذة GUI: المُثبِّت يعرض كل تثبيتات Discord المكتشفة (مع خيار **Browse...** لإضافة
مسار غير معتاد)، وتُرقَّن **التثبيتات المحددة فقط** في الـ ListView؛ وإن لم تُحدَّد أي واحدة
تُرقَّن كل القائمة.


---

## 5. قبل أن ترسل الملف

1. **SmartScreen**: الملف غير موقّع، قد تظهر رسالة
   «Windows حمت جهازك» → اضغط **مزيد من المعلومات ← تشغيل على أي طريق**.
   شارك ذلك مع صديقك.
2. حجم الملف ~3 MB → يصلح للإرسال عبر ديسكورد مباشرة.
3. تحقّق قبل الإرسال:

```powershell
.\VencordMe-Setup.exe --list
```

---

## 6. ملفات المشروع

```
installer\
  Setup.cs            مصدر المُثبِّت (WinForms، C# 5)
  build.ps1           سكربت البناء (csc.exe)
  setup.manifest      manifest لـ DPI/الأذونات
  makeSettings.mjs    يولّد ملفي الإعدادات
  payload\
    settings.json       الافتراضي (كل الإضافات معطّلة)
    settings.mine.json  ملفي الشخصي (pnygo معطَّل) - اختياري
    quickCss.css        فارغ
```

أنواع البناء متاحة في `makeSettings.mjs`:

| الأمر | المخرَج |
|---|---|
| `node installer\makeSettings.mjs <ملف الإعدادات>` | `payload\settings.json` — الافتراضي |
| `node installer\makeSettings.mjs <ملف الإعدادات> --profile` | `payload\settings.mine.json` — إعداداتك |

كلا الملفين يحذف كتلة `cloud`، ويدمج كل إضافات هذا البناء (210)، ويستبعد
الإضافات غير الموجودة هنا (7: `FunnyButton`, `AppleMusicRichPresence`,
`FavoriteGifSearch`, `FriendsSince`, `Summaries`, `Fake Voice Options`, `JumpTo`)،
ويُصفّر `pnygo` (بلا webhook).
