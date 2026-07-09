/* =========================================================================
   webrtc-p2p.js — محرك الاتصال المباشر بين الأجهزة (WebRTC DataChannel)
   =========================================================================
   يستبدل هذا الملف خادم Node.js بالكامل. لا إنترنت، لا خادم، لا IP يدوي.
   الاتصال مباشر 100% عبر الشبكة المحلية (Wi-Fi / Hotspot).

   الفكرة:
     1) الجهاز "المضيف" (Host) يولّد "Offer" (عرض اتصال WebRTC مشفّر)
        ويحوّلها إلى QR Code يظهر على شاشته.
     2) الجهاز "التابع" (Peer) يمسح QR → يستقبل الـ Offer → يولّد "Answer"
        → يحوّل الـ Answer إلى QR يظهر على شاشته.
     3) المضيف يمسح QR الـ Answer → يكتمل握手 (Handshake) → DataChannel يفتح.
     4) من هنا فصاعداً: كل رسائل المزامنة تمر عبر DataChannel مباشرة.

   ملاحظة: نستخدم "Trickle ICE off" (جمع كل ICE candidates قبل الإرسال)
   حتى تكون الـ Offer/Answer قابلة للتمثيل كـ QR بدون تبادل إضافي.
   ========================================================================= */

const RTC_CONFIG = {
  // بلا STUN: نحن على شبكة محلية (Wi-Fi/Hotspot) بدون إنترنت، فلا فائدة من
  // محاولة الاتصال بسيرفر STUN خارجي — هذا كان يسبب فقط انتظاراً بلا طائل.
  // بهذا الشكل نجمع فقط "host candidates" المحلية، وهي كافية 100% للشبكة المحلية.
  iceServers: [],
};

// الحد الأقصى لحجم الرسالة الواحدة عبر DataChannel (Chrome: 256KB، iOS: 64KB)
// نختار 60KB حداً آمناً يشتغل على الكل، وأي حمولة أكبر تُقسَّم تلقائياً.
const CHUNK_SIZE = 60 * 1024;

/* -------------------------------------------------------------------------
   ضغط/فك ضغط بيانات Offer/Answer قبل تحويلها لـ QR
   -------------------------------------------------------------------------
   نص SDP طويل ومليان تكرار (خصوصاً مع عدّة ICE candidates)، فضغطه بصيغة
   gzip قبل التحويل لـ QR يقلّل حجمه بشكل كبير جداً → QR أصغر وأسرع بالقراية.
   نستخدم CompressionStream/DecompressionStream المدمجتين بالمتصفح (بدون أي
   مكتبة خارجية أو حاجة لإنترنت)، مع بادئة (GZ:/RAW:) للتوافق مع الأجهزة التي
   لا تدعم هذه الواجهة (نادر جداً على المتصفحات الحديثة).
   ------------------------------------------------------------------------- */
function _bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function _base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function compressForQR(str) {
  if (typeof CompressionStream === 'undefined') return 'RAW:' + str;
  try {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    const buffer = await blob.arrayBuffer();
    return 'GZ:' + _bufferToBase64(buffer);
  } catch (e) {
    console.warn('تعذّر ضغط البيانات، سيتم إرسالها بدون ضغط:', e);
    return 'RAW:' + str;
  }
}

async function decompressFromQR(payload) {
  if (payload.startsWith('RAW:')) return payload.slice(4);
  if (payload.startsWith('GZ:')) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('هذا الجهاز/المتصفح لا يدعم فك ضغط البيانات — استخدم متصفحاً أحدث.');
    }
    const buffer = _base64ToBuffer(payload.slice(3));
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    return await blob.text();
  }
  // توافق احتياطي مع أي بيانات قديمة غير معلَّمة بالبادئة
  return payload;
}

class DeliveryP2P extends EventTarget {
  constructor() {
    super();
    this.pc = null;           // RTCPeerConnection الحالي
    this.dc = null;           // RTCDataChannel الحالي
    this.role = null;         // 'host' أو 'peer'
    this.connected = false;
    this._receiveBuffer = ''; // بافر لتجميع chunks الرسائل الكبيرة
    this._disconnectGraceTimer = null; // مهلة سماح قبل إعلان انقطاع حقيقي

    // لو المستخدم رجع لواجهة التطبيق بينما مهلة السماح "الطويلة" (بالخلفية)
    // لسا شغالة، نلغيها فوراً ونبدأ مهلة قصيرة طبيعية بدلها مع محاولة
    // استرجاع جديدة — لا داعي للانتظار دقائق إضافية بعد ما صار المستخدم
    // فعلياً ينظر للشاشة من جديد.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !this._disconnectGraceTimer) return;
      clearTimeout(this._disconnectGraceTimer);
      this._disconnectGraceTimer = null;
      if (this.pc && !['connected', 'closed'].includes(this.pc.connectionState)) {
        this._attemptIceRestart();
        this._armDisconnectGraceTimer();
      }
    });
  }

  /* -----------------------------------------------------------------------
     1) دور المضيف (Host): إنشاء Offer
     ----------------------------------------------------------------------- */
  async createOffer() {
    this.role = 'host';
    this._createPeerConnection();

    // المضيف يفتح القناة — التابع يستقبلها عبر ondatachannel
    // مهم جداً: بلا maxRetransmits ولا maxPacketLifeTime، تكون القناة "موثوقة
    // بالكامل" (reliable, ordered) — أي قطعة بيانات لازم توصل مهما تكرر
    // إعادة الإرسال. كنا سابقاً نستخدم maxRetransmits: 10 وهذا كان يجعل
    // القناة "موثوقية جزئية" (partial reliability): لو فُقدت قطعة بيانات على
    // شبكة هوت سبوت مزدحمة/ضعيفة ولم تصل خلال 10 محاولات، تُهمَل نهائياً
    // بصمت — وبما أن ملف الإكسل الكبير يُقسَّم لعشرات القطع (chunks)، فقدان
    // قطعة واحدة فقط كان يعلّق عملية التجميع للأبد بلا أي خطأ ظاهر — وهذا
    // بالضبط سبب عدم وصول بيانات الإكسل للأجهزة المتصلة.
    this.dc = this.pc.createDataChannel('delivery', {
      ordered: true,
    });
    this._setupDataChannel(this.dc);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // انتظار اكتمال جمع ICE candidates قبل تحويل الـ Offer لـ QR
    const fullOffer = await this._waitForIceCandidates();
    return await compressForQR(fullOffer); // نص مضغوط جاهز للتحويل لـ QR
  }

  /* -----------------------------------------------------------------------
     2) دور التابع (Peer): استقبال Offer وإنشاء Answer
     ----------------------------------------------------------------------- */
  async createAnswer(offerJson) {
    this.role = 'peer';
    this._createPeerConnection();

    // التابع يستقبل DataChannel من المضيف
    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this._setupDataChannel(this.dc);
    };

    const offerRaw = await decompressFromQR(offerJson);
    const offer = JSON.parse(offerRaw);
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    const fullAnswer = await this._waitForIceCandidates();
    return await compressForQR(fullAnswer); // نص مضغوط جاهز للتحويل لـ QR
  }

  /* -----------------------------------------------------------------------
     3) المضيف يستقبل Answer (بعد مسح QR التابع) ويكمل الـ Handshake
     ----------------------------------------------------------------------- */
  async receiveAnswer(answerJson) {
    if (this.role !== 'host') throw new Error('receiveAnswer فقط للمضيف');
    const answerRaw = await decompressFromQR(answerJson);
    const answer = JSON.parse(answerRaw);
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    // DataChannel سيُفتح تلقائياً وstatus يتغيّر إلى "open"
  }

  /* -----------------------------------------------------------------------
     4) إرسال رسالة (مع تقسيم تلقائي للرسائل الكبيرة)
     ----------------------------------------------------------------------- */
  send(type, payload) {
    if (!this.dc || this.dc.readyState !== 'open') return false;

    const message = JSON.stringify({ type, payload });

    if (message.length <= CHUNK_SIZE) {
      this.dc.send(message);
    } else {
      // تقسيم الرسالة إلى chunks مرقّمة
      const totalChunks = Math.ceil(message.length / CHUNK_SIZE);
      const chunkId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      for (let i = 0; i < totalChunks; i++) {
        const chunk = message.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        this.dc.send(JSON.stringify({
          __chunk: true, chunkId, index: i, total: totalChunks, data: chunk,
        }));
      }
    }
    return true;
  }

  /* -----------------------------------------------------------------------
     محاولة استرجاع الاتصال بدون مسح QR (فقط تعمل إن كانت الصفحة نفسها لا
     تزال حية بالذاكرة — أي أن هذا "تجميد مؤقت" وليس إغلاقاً فعلياً للتطبيق).
     الجهاز "المضيف" وحده من يملك الصلاحية لبدء ICE restart (نفس منطق من
     ينشئ Offer أصلاً)؛ الجهاز التابع ينتظر عرض المضيف الجديد تلقائياً.
     ----------------------------------------------------------------------- */
  async _attemptIceRestart() {
    if (this.role !== 'host' || !this.pc || typeof this.pc.restartIce !== 'function') return;
    try {
      this.pc.restartIce();
    } catch (e) {
      console.warn('تعذّرت محاولة استرجاع الاتصال (ICE restart):', e);
    }
  }

  /**
   * يضبط مهلة السماح قبل إعلان انقطاع حقيقي. المدة تعتمد على ظهور الصفحة:
   * - بالمقدمة (الشاشة مضوية والتطبيق ظاهر): 25 ثانية — فرصة معقولة لتذبذب
   *   شبكة عابر دون تأخير إشعار المستخدم بمشكلة حقيقية طويلاً.
   * - بالخلفية (مصغّر/الشاشة مطفية): 10 دقائق — الهدف هنا ليس "انتظار تعافي
   *   الشبكة" بقدر ما هو تجنّب إصدار حكم نهائي بالانقطاع بينما المستخدم
   *   أصلاً لا يرى الشاشة ولا يستفيد من إشعار فوري؛ لحظة عودته للواجهة
   *   (visibilitychange) تُعاد هذه المهلة لقيمتها القصيرة الطبيعية فوراً.
   */
  _armDisconnectGraceTimer() {
    const duration = document.hidden ? 10 * 60 * 1000 : 25000;
    this._disconnectGraceTimer = setTimeout(() => {
      this._disconnectGraceTimer = null;
      if (this.pc && this.pc.connectionState !== 'connected') {
        this.connected = false;
        this._dispatch('disconnected', { state: this.pc.connectionState });
      }
    }, duration);
  }

  /**
   * تُستدعى من الواجهة (مثلاً عند عودة التطبيق من الخلفية) لتحفيز محاولة
   * استرجاع فورية بدل انتظار مهلة السماح كاملة.
   */
  tryReconnect() {
    if (this.pc && this.pc.connectionState && this.pc.connectionState !== 'connected') {
      this._attemptIceRestart();
    }
  }

  disconnect() {
    if (this._disconnectGraceTimer) {
      clearTimeout(this._disconnectGraceTimer);
      this._disconnectGraceTimer = null;
    }
    if (this.dc) { try { this.dc.close(); } catch {} }
    if (this.pc) { try { this.pc.close(); } catch {} }
    this.dc = null;
    this.pc = null;
    this.connected = false;
    this.role = null;
    this._receiveBuffer = '';
    this._dispatch('disconnected', {});
  }

  /* -----------------------------------------------------------------------
     داخلي: إنشاء RTCPeerConnection وربط أحداث الاتصال
     ----------------------------------------------------------------------- */
  _createPeerConnection() {
    if (this.pc) this.pc.close();
    this.pc = new RTCPeerConnection(RTC_CONFIG);

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;

      if (state === 'connected') {
        // اتصال ناجح (أو تعافى من تذبذب مؤقت) — نلغي أي مهلة سماح معلّقة
        if (this._disconnectGraceTimer) {
          clearTimeout(this._disconnectGraceTimer);
          this._disconnectGraceTimer = null;
        }
        this.connected = true;
        this._dispatch('connected', { role: this.role });

      } else if (state === 'disconnected') {
        // "disconnected" غالباً حالة عابرة (تصغير التطبيق، قفل الشاشة، أو
        // تذبذب شبكة مؤقت) وتتعافى تلقائياً أو عبر إعادة تفاوض ICE. لا نُعلن
        // انقطاع الاتصال فوراً؛ أولاً نحاول "ICE restart" (يُبقي نفس
        // RTCPeerConnection/DataChannel بدون أي حاجة لمسح QR من جديد، طالما
        // الصفحة نفسها لم تُغلق فعلياً) — فقط إن فشلت كل المحاولات خلال مهلة
        // السماح نعتبره انقطاعاً حقيقياً ونطلب جلسة جديدة.
        if (!this._disconnectGraceTimer) {
          this._attemptIceRestart();
          this._armDisconnectGraceTimer();
        }

      } else if (['failed', 'closed'].includes(state)) {
        // انقطاع حاسم ومؤكد — لا داعي لانتظار أي مهلة سماح
        if (this._disconnectGraceTimer) {
          clearTimeout(this._disconnectGraceTimer);
          this._disconnectGraceTimer = null;
        }
        this.connected = false;
        this._dispatch('disconnected', { state });
      }
    };

    this.pc.onicecandidateerror = (e) => {
      // ICE errors شائعة جداً (timeout على STUN في الشبكات المحلية) وعادة
      // لا تعني فشل الاتصال — نتجاهلها إلا إذا فشل الاتصال كلياً
      console.warn('ICE candidate error (غالباً غير حرجة):', e.errorText);
    };
  }

  /* -----------------------------------------------------------------------
     داخلي: ربط DataChannel بالمستمعين
     ----------------------------------------------------------------------- */
  _setupDataChannel(dc) {
    dc.onopen = () => {
      this.connected = true;
      this._dispatch('channel-open', { role: this.role });
    };

    dc.onclose = () => {
      this.connected = false;
      this._dispatch('channel-closed', {});
    };

    dc.onerror = (e) => {
      this._dispatch('channel-error', { error: e.error?.message });
    };

    dc.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        // استقبال chunk من رسالة كبيرة
        if (parsed.__chunk) {
          this._handleChunk(parsed);
          return;
        }

        this._dispatch('message', parsed);
      } catch (e) {
        console.error('خطأ في تحليل رسالة DataChannel:', e);
      }
    };
  }

  /* -----------------------------------------------------------------------
     داخلي: تجميع chunks رسائل كبيرة
     ----------------------------------------------------------------------- */
  _chunkBuffers = new Map();
  _chunkTimeouts = new Map();

  _handleChunk({ chunkId, index, total, data }) {
    if (!this._chunkBuffers.has(chunkId)) {
      this._chunkBuffers.set(chunkId, new Array(total).fill(null));

      // مهلة أمان: لو ما اكتملت كل القطع خلال 20 ثانية (مثلاً بسبب انقطاع
      // مفاجئ بمنتصف النقل)، نُبلّغ بدل ما تبقى العملية معلّقة بصمت للأبد.
      const timeoutId = setTimeout(() => {
        if (this._chunkBuffers.has(chunkId)) {
          const buffer = this._chunkBuffers.get(chunkId);
          const received = buffer.filter((c) => c !== null).length;
          this._chunkBuffers.delete(chunkId);
          this._chunkTimeouts.delete(chunkId);
          this._dispatch('transfer-incomplete', { received, total: buffer.length });
        }
      }, 20000);
      this._chunkTimeouts.set(chunkId, timeoutId);
    }
    const buffer = this._chunkBuffers.get(chunkId);
    buffer[index] = data;

    if (buffer.every((c) => c !== null)) {
      clearTimeout(this._chunkTimeouts.get(chunkId));
      this._chunkTimeouts.delete(chunkId);
      this._chunkBuffers.delete(chunkId);
      try {
        const full = JSON.parse(buffer.join(''));
        this._dispatch('message', full);
      } catch (e) {
        console.error('خطأ في تجميع chunks:', e);
      }
    }
  }

  /* -----------------------------------------------------------------------
     داخلي: انتظار اكتمال ICE gathering (ضروري لـ QR-only signaling)
     ----------------------------------------------------------------------- */
  _waitForIceCandidates() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // بدون STUN، جمع الـ host candidates المحلية سريع جداً — ثانيتان
        // كحد أقصى كافيتان تماماً (كنا نستنى 8 ثوانٍ سابقاً بلا فائدة).
        resolve(JSON.stringify(this.pc.localDescription));
      }, 2000);

      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve(JSON.stringify(this.pc.localDescription));
        }
      };

      this.pc.onicecandidate = (event) => {
        if (event.candidate === null) {
          // candidate === null يعني اكتمل الجمع
          clearTimeout(timeout);
          resolve(JSON.stringify(this.pc.localDescription));
        }
      };
    });
  }

  _dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// instance عام واحد يُستخدم عبر كل التطبيق
window.deliveryP2P = new DeliveryP2P();
