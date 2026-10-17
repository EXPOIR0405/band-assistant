/**
 * 밴드 비서 — Xiaomi Smart Band 11 + Gmail + Google Calendar + ChatGPT
 *
 * 5분마다 tick()이 실행되며:
 *  - 새 메일 분류 → 중요 메일 알림 / 메일 속 일정 감지 → "캘린더에 추가할까요?"
 *  - 일정 10분 전 리마인드(관련 메일 맥락 포함), 장소 있는 일정은 출발 알림
 *  - 08:00 아침 브리핑(날씨 포함), 21:00 저녁 마무리 + 남은 일 "완료할까요?"
 * 알림은 텔레그램 봇 → 폰 → Mi Fitness → 밴드로 전달된다. 설치 순서는 README.md 참고.
 */

// 기본 설정. 개인 값(주소·좌표 등)은 여기 말고 Local.gs의 LOCAL_CONFIG에 적는다(README 5장).
const DEFAULT_CONFIG = {
  // 가장 저렴한 모델(2026-10 기준). 추론형 모델이라 생각 단계를 최소로 줄여 빠르고 싸게 쓴다.
  // 추론형이 아닌 모델(gpt-4.1-mini 등)로 바꾸면 OPENAI_REASONING_EFFORT는 ''로 비운다.
  OPENAI_MODEL: 'gpt-5-nano',
  OPENAI_REASONING_EFFORT: 'minimal',

  MORNING_TIME: '08:00',
  EVENING_TIME: '21:00',

  DONE_LABEL: '완료',        // 직접 완료 표시할 때 쓰는 Gmail 라벨
  IMPORTANT_LABEL: 'AI중요', // 스크립트가 중요 메일에 붙이는 라벨

  IMPORTANT_CRITERIA: [
    '결제·청구·환불·카드·은행·세금·구독 갱신 등 돈과 관련된 메일',
    '업무 메일: 동료·상사·고객·거래처, 채용·면접·계약',
    '공공기관·학교 등에서 온 공식 안내나 서류 제출 요청',
    '마감 기한이 있거나 내 답장·조치가 필요한 메일',
  ],
  CATEGORIES: ['결제', '업무', '공공', '기타'], // 알림 제목의 [분류] 후보
  NOT_IMPORTANT: '광고, 뉴스레터, 프로모션, SNS 알림, 마케팅 자동 발송 메일',

  // 출발 알림의 기본 출발지(집 또는 회사). 그날 앞 일정에 장소가 있으면 그곳에서 출발한다고 계산.
  ORIGIN: '서울특별시 중구 세종대로 110',
  // 날씨 위치 (기본: 서울시청)
  LAT: 37.5665,
  LON: 126.9780,

  REMIND_BEFORE_MIN: 10,
  DEPART_BUFFER_MIN: 10,     // 이동 시간에 더할 여유 시간
  MAX_DONE_PROMPTS: 3,       // 저녁에 "완료할까요?" 버튼 알림을 보낼 최대 개수
  STRIP_EMOJI: true,         // 밴드 글꼴이 일부 이모지를 못 그려 □로 깨지므로 알림 본문에서 뺀다(버튼은 유지)
};

/**
 * LOCAL_CONFIG(Local.gs, 선택)에 있는 값이 DEFAULT_CONFIG보다 우선한다.
 * 파일 로드 순서와 상관없도록 값을 읽는 시점에 찾아본다.
 */
const CONFIG = new Proxy(DEFAULT_CONFIG, {
  get(defaults, key) {
    const local = typeof LOCAL_CONFIG === 'undefined' ? {} : LOCAL_CONFIG;
    return key in local ? local[key] : defaults[key];
  },
});

/* ───────────────────────── 설치 / 테스트 ───────────────────────── */

/** 처음 한 번 실행: 라벨·보안 토큰·트리거(5분 tick, 1분 pollTelegram)를 만들고 텔레그램을 연결한다. */
function setup() {
  const p = props_();
  if (!p.getProperty('ACTION_TOKEN')) {
    p.setProperty('ACTION_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  label_(CONFIG.DONE_LABEL);
  label_(CONFIG.IMPORTANT_LABEL);

  ScriptApp.getProjectTriggers()
    .filter(t => ['tick', 'pollTelegram'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();

  if (!p.getProperty('LAST_MAIL_CHECK')) {
    p.setProperty('LAST_MAIL_CHECK', String(nowSec_() - 3600));
  }

  Logger.log('✅ 설정 완료');
  if (!p.getProperty('OPENAI_API_KEY')) Logger.log('⚠️ 스크립트 속성에 OPENAI_API_KEY를 추가하세요.');
  if (!p.getProperty('TELEGRAM_BOT_TOKEN')) {
    Logger.log('⚠️ 스크립트 속성에 TELEGRAM_BOT_TOKEN을 추가한 뒤 connectTelegram을 실행하세요.');
  } else if (!p.getProperty('TELEGRAM_CHAT_ID')) {
    connectTelegram();
  }
}

/** 봇에게 텔레그램 메시지를 하나 보낸 뒤 실행: 내 채팅방 ID를 찾아 저장한다. */
function connectTelegram() {
  const res = tg_('getUpdates', {});
  const chats = (res.result || [])
    .map(u => (u.message || u.my_chat_member || {}).chat)
    .filter(c => c && c.type === 'private');
  if (!chats.length) {
    Logger.log('⚠️ 텔레그램에서 내 봇에게 "시작"을 누르거나 아무 메시지나 보낸 뒤 다시 실행하세요.');
    return;
  }
  const chat = chats[chats.length - 1];
  props_().setProperty('TELEGRAM_CHAT_ID', String(chat.id));
  Logger.log('✅ 텔레그램 연결 완료: ' + (chat.first_name || chat.id));
  notify_({ title: '🔗 밴드 비서 연결 완료', message: '이제 여기로 알림이 와요.', keyboard: true });
}

function testNotify() {
  notify_({ title: '🔔 밴드 비서 테스트', message: '이 알림이 밴드에 보이면 연결 성공!', priority: 4 });
}
function testMorning() { morningBriefing(); }
function testEvening() { eveningWrapUp(); }
function testMail() { checkMail_(); }

/* ───────────────────────── 메인 루프 ───────────────────────── */

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const now = new Date();
    safely_('poll-trigger', ensurePollTrigger_);
    safely_('mail', checkMail_);
    safely_('events', () => checkUpcomingEvents_(now));
    if (isDue_('MORNING', CONFIG.MORNING_TIME, now)) safely_('morning', morningBriefing);
    if (isDue_('EVENING', CONFIG.EVENING_TIME, now)) safely_('evening', eveningWrapUp);
  } finally {
    lock.releaseLock();
  }
}

/* ───────────────────────── 텔레그램 고정 버튼 ───────────────────────── */

const QUICK_BUTTONS = ['오늘 일정', '내일 일정', '남은 일'];

/** 채팅창 아래에 항상 떠 있는 버튼 */
function quickKeyboard_() {
  return { keyboard: [QUICK_BUTTONS.map(text => ({ text }))], resize_keyboard: true, is_persistent: true };
}

/** 편집기에서 직접 실행: 1분 트리거를 확인하고 고정 버튼을 다시 띄운다. */
function showButtons() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'pollTelegram');
  if (!has) ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  Logger.log(has ? 'pollTelegram 트리거 있음' : 'pollTelegram 트리거를 새로 만들었어요');
  notify_({ title: '고정 버튼', message: '채팅창 아래 버튼을 눌러 보세요: ' + QUICK_BUTTONS.join(' / '), keyboard: true, priority: 2 });
  Logger.log('✅ 고정 버튼 메시지를 보냈어요');
}

/** 편집기에서 직접 실행: 고정 버튼에 답이 안 올 때 어디서 막혔는지 로그로 보여 준다. */
function testPoll() {
  const p = props_();
  Logger.log('트리거: ' + ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', '));
  Logger.log('저장된 채팅 ID: ' + p.getProperty('TELEGRAM_CHAT_ID') + ' / offset: ' + p.getProperty('TG_OFFSET'));
  Logger.log('웹훅: ' + (tg_('getWebhookInfo', {}).result || {}).url);
  const res = tg_('getUpdates', { offset: Number(p.getProperty('TG_OFFSET') || 0), timeout: 0 });
  Logger.log('ok=' + res.ok + ' / 대기 중인 메시지: ' + JSON.stringify((res.result || []).map(u => u.message
    ? { chat: u.message.chat.id, text: u.message.text, 몇초전: nowSec_() - u.message.date }
    : Object.keys(u))));
  pollTelegram();
  Logger.log('pollTelegram 실행 완료 → 텔레그램에 답이 왔는지 확인하세요');
}

/** setup을 다시 실행하지 않아도, 기존 설치에 1분 트리거와 고정 버튼을 한 번 붙인다. */
function ensurePollTrigger_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'pollTelegram')) return;
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  notify_({
    title: '고정 버튼을 추가했어요',
    message: '채팅창 아래 버튼으로 오늘 일정, 내일 일정, 남은 일을 물어볼 수 있어요.\n' +
      '버튼을 누르고 폰을 잠그면 1분 안에 답이 밴드로 와요.',
    priority: 2,
    keyboard: true,
  });
}

/** 1분마다 실행: 내 채팅방에서 온 메시지(고정 버튼)와 버튼 누름(✅ 완료 등)을 처리한다. */
function pollTelegram() {
  const lock = LockService.getUserLock(); // tick의 스크립트 잠금과 별개라 서로 막지 않는다
  if (!lock.tryLock(1000)) return;
  try {
    const p = props_();
    const chatId = p.getProperty('TELEGRAM_CHAT_ID');
    if (!chatId) return;
    const res = tg_('getUpdates', {
      offset: Number(p.getProperty('TG_OFFSET') || 0),
      timeout: 0,
      allowed_updates: ['message', 'callback_query'],
    });
    const updates = res.result || [];
    if (!updates.length) return;
    p.setProperty('TG_OFFSET', String(updates[updates.length - 1].update_id + 1));
    updates.forEach(u => {
      const cq = u.callback_query;
      if (cq) {
        if (String(cq.from.id) === chatId) safely_('callback', () => handleCallback_(cq));
        return;
      }
      const m = u.message;
      if (!m || !m.text || String(m.chat.id) !== chatId) return; // 내 채팅방 외에는 무시
      if (nowSec_() - m.date > 600) return;                      // 10분 넘은 메시지는 건너뜀
      safely_('reply', () => answer_(m.text.trim()));
    });
  } finally {
    lock.releaseLock();
  }
}

function answer_(text) {
  const now = new Date();
  if (text === '오늘 일정' || text === '내일 일정') {
    const offset = text === '오늘 일정' ? 0 : 1;
    const day = new Date(now.getTime() + offset * 86400e3);
    notify_({
      title: `${text} ${fmt_(day, 'M/d')}(${dow_(day)})`,
      message: `${eventsOn_(day)}\n\n날씨: ${weather_(offset)}`,
    });
  } else if (text === '남은 일') {
    const open = openItems_(10);
    if (!open.length) {
      notify_({ title: '남은 일 없음', message: '중요 메일을 모두 처리했어요.' });
      return;
    }
    const buttons = open.map((o, i) => doneAction_(o.threadId, `✅ ${i + 1}`));
    notify_({
      title: `남은 일 ${open.length}개`,
      message: open.map((o, i) => `${i + 1}. ${o.subject} (${o.from}, ${o.age})`).join('\n'),
      rows: chunk_(buttons, 5),
    });
  } else {
    notify_({ title: '밴드 비서', message: '아래 버튼을 눌러 주세요: ' + QUICK_BUTTONS.join(' / '), keyboard: true });
  }
}

/** 오늘 지정 시각이 지났고 아직 안 보냈으면 true (지정 시각 후 90분 이내만). */
function isDue_(name, hhmm, now) {
  const [h, m] = hhmm.split(':').map(Number);
  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  const today = fmt_(now, 'yyyy-MM-dd');
  const key = 'SENT_' + name;
  if (now < due || now - due > 90 * 60000 || props_().getProperty(key) === today) return false;
  props_().setProperty(key, today);
  return true;
}

/* ───────────────────────── 메일 ───────────────────────── */

function checkMail_() {
  const p = props_();
  const since = Number(p.getProperty('LAST_MAIL_CHECK') || nowSec_() - 3600);
  const checkedAt = nowSec_();
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const seen = loadJson_('SEEN_MSGS', []);

  const query = `in:inbox after:${since - 300} -label:${q_(CONFIG.DONE_LABEL)} -category:promotions -category:social`;
  const fresh = [];
  GmailApp.search(query, 0, 30).forEach(th => {
    th.getMessages().forEach(m => {
      if (m.getDate().getTime() / 1000 < since - 300) return;
      if (seen.includes(m.getId())) return;
      if (m.getFrom().toLowerCase().includes(me)) return;
      fresh.push({ id: m.getId(), thread: th, from: m.getFrom(), subject: m.getSubject(),
                   body: m.getPlainBody().slice(0, 1500) });
    });
  });

  if (fresh.length) {
    const batch = fresh.slice(0, 15);
    const result = classifyMails_(batch);
    const byId = {};
    (result.items || []).forEach(it => { byId[it.id] = it; });

    batch.forEach(mail => {
      const it = byId[mail.id];
      if (!it) return;
      if (it.important) {
        mail.thread.addLabel(label_(CONFIG.IMPORTANT_LABEL));
        notify_({
          title: `📧 [${it.category || '중요'}] ${senderName_(mail.from)}`,
          message: it.summary || mail.subject,
          priority: 4,
          actions: [doneAction_(mail.thread.getId()), viewAction_(mail.thread.getId())],
        });
      }
      if (it.event) proposeEvent_(it.event, mail.thread.getId());
    });

    batch.forEach(m => seen.push(m.id));
    saveJson_('SEEN_MSGS', seen.slice(-300));
  }
  // 처리에 성공했을 때만 기준 시각을 옮긴다(실패하면 다음 tick에서 재시도).
  p.setProperty('LAST_MAIL_CHECK', String(checkedAt));
}

function classifyMails_(mails) {
  const now = new Date();
  const system = [
    '너는 메일 분류 비서다. 각 메일을 판단해 JSON으로만 답하라.',
    '중요 기준:', ...CONFIG.IMPORTANT_CRITERIA.map(c => '- ' + c),
    '중요하지 않음: ' + CONFIG.NOT_IMPORTANT,
    `category: ${CONFIG.CATEGORIES.map(c => `"${c}"`).join(' | ')} 중 하나.`,
    'summary: 손목 밴드 화면용 한국어 한 줄, 30자 이내, 내가 해야 할 일 위주.',
    `event: 메일에 구체적인 날짜·시간의 약속/회의/방문/마감이 제안되거나 확정됐을 때만 채운다. ` +
      `start/end는 'YYYY-MM-DDTHH:mm:00${tzOffset_()}' 형식, 종료 시각이 없으면 시작+1시간. ` +
      `마감이면 title 앞에 '마감: '을 붙인다. 해당 없으면 null.`,
    '출력 형식: {"items":[{"id":"","important":true,"category":"","summary":"",' +
      '"event":{"title":"","start":"","end":"","location":""}}]}',
  ].join('\n');
  const user = `오늘: ${fmt_(now, 'yyyy-MM-dd')} (${dow_(now)})\n\n` + mails.map(m =>
    `### id: ${m.id}\n보낸 사람: ${m.from}\n제목: ${m.subject}\n본문:\n${m.body}`).join('\n\n');
  return gpt_(system, user, true);
}

/** 메일에서 찾은 일정을 임시 저장하고 "캘린더에 추가할까요?" 알림을 보낸다. */
function proposeEvent_(ev, threadId) {
  const start = new Date(ev.start);
  const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 3600e3);
  if (isNaN(start) || isNaN(end) || start < new Date()) return;

  const overlapping = CalendarApp.getDefaultCalendar().getEvents(start, end);
  if (overlapping.some(e => e.getTitle() === ev.title)) return; // 이미 등록됨

  const pid = Utilities.getUuid().slice(0, 8);
  props_().setProperty('EVT_' + pid, JSON.stringify({
    title: ev.title, start: start.toISOString(), end: end.toISOString(),
    location: ev.location || '', threadId, created: Date.now(),
  }));

  const lines = [
    ev.title,
    `${fmt_(start, 'M/d')}(${dow_(start)}) ${fmt_(start, 'HH:mm')}` + (ev.location ? ` @${ev.location}` : ''),
  ];
  if (overlapping.length) lines.push(`⚠️ 겹치는 일정 ${overlapping.length}개`);
  lines.push('캘린더에 추가할까요?');
  notify_({
    title: '📅 메일에서 일정 발견',
    message: lines.join('\n'),
    actions: [addEventAction_(pid), viewAction_(threadId)],
  });
}

/** 아직 완료 라벨이 없는 중요 메일 (최근 30일). */
function openItems_(limit) {
  const q = `label:${q_(CONFIG.IMPORTANT_LABEL)} -label:${q_(CONFIG.DONE_LABEL)} newer_than:30d`;
  return GmailApp.search(q, 0, limit).map(th => ({
    threadId: th.getId(),
    subject: th.getFirstMessageSubject(),
    from: senderName_(th.getMessages()[0].getFrom()),
    age: ageText_(th.getLastMessageDate()),
  }));
}

function ageText_(date) {
  const days = Math.floor((Date.now() - date.getTime()) / 86400e3);
  return days === 0 ? '오늘' : days + '일 전';
}

/* ───────────────────────── 일정 리마인드 / 출발 알림 ───────────────────────── */

function checkUpcomingEvents_(now) {
  const cal = CalendarApp.getDefaultCalendar();
  const horizon = new Date(now.getTime() + 3 * 3600e3);
  const events = cal.getEvents(now, horizon)
    .filter(e => !e.isAllDayEvent() && e.getStartTime() > now);
  const notified = loadJson_('NOTIFIED', {});

  events.forEach(ev => {
    const start = ev.getStartTime();
    const key = ev.getId() + '@' + start.getTime();
    const minsLeft = (start - now) / 60000;

    const loc = ev.getLocation();
    if (loc && !notified['D:' + key]) {
      const travel = cachedTravel_(key, originFor_(cal, ev), loc, start);
      if (travel !== null) {
        const departAt = start.getTime() - (travel + CONFIG.DEPART_BUFFER_MIN) * 60000;
        if (now.getTime() >= departAt) {
          notify_({
            title: `🚶 지금 출발하세요 — ${ev.getTitle()}`,
            message: `${fmt_(start, 'HH:mm')} 시작 · 대중교통 약 ${travel}분\n장소: ${loc}`,
            priority: 5,
          });
          notified['D:' + key] = Date.now();
        }
      }
    }

    if (!notified['R:' + key] && minsLeft <= CONFIG.REMIND_BEFORE_MIN) {
      sendReminder_(ev);
      notified['R:' + key] = Date.now();
    }
  });

  Object.keys(notified).forEach(k => { if (Date.now() - notified[k] > 2 * 86400e3) delete notified[k]; });
  saveJson_('NOTIFIED', notified);
}

function sendReminder_(ev) {
  const title = ev.getTitle();
  const start = ev.getStartTime();
  let context = '';
  const keyword = title.replace(/"/g, '').trim();
  if (keyword.length >= 2) {
    const related = GmailApp.search(`"${keyword}" newer_than:30d`, 0, 3);
    if (related.length) {
      const snippets = related.map(t =>
        `- ${t.getFirstMessageSubject()}: ${t.getMessages().pop().getPlainBody().slice(0, 400)}`).join('\n');
      context = gpt_(
        '너는 일정 직전에 손목 밴드로 맥락을 알려주는 비서다. 관련 메일을 보고 이 일정에서 기억할 점을 ' +
        '한국어 한 줄(40자 이내)로만 써라. 쓸 만한 정보가 없으면 아무것도 쓰지 마라.',
        `일정: ${title}\n설명: ${(ev.getDescription() || '').slice(0, 300)}\n관련 메일:\n${snippets}`);
    }
  }
  const lines = [];
  if (ev.getLocation()) lines.push('장소: ' + ev.getLocation());
  if (context) lines.push('참고: ' + context);
  notify_({
    title: `⏰ ${fmt_(start, 'HH:mm')} ${title}`,
    message: lines.join('\n') || `${CONFIG.REMIND_BEFORE_MIN}분 뒤 시작해요`,
    priority: 4,
  });
}

/** 그날 이 일정 직전에 장소가 있는 일정이 있으면 그곳, 없으면 기본 출발지. */
function originFor_(cal, ev) {
  const dayStart = new Date(ev.getStartTime());
  dayStart.setHours(0, 0, 0, 0);
  const before = cal.getEvents(dayStart, ev.getStartTime())
    .filter(e => !e.isAllDayEvent() && e.getEndTime() <= ev.getStartTime() && e.getLocation());
  return before.length ? before[before.length - 1].getLocation() : CONFIG.ORIGIN;
}

/** 대중교통 이동 시간(분). 한국은 구글 지도 자동차 길찾기를 지원하지 않아 대중교통 기준. */
function cachedTravel_(key, origin, dest, arriveBy) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('T:' + key);
  if (hit !== null) return hit === '-1' ? null : Number(hit);
  let mins = null;
  try {
    const r = Maps.newDirectionFinder()
      .setOrigin(origin).setDestination(dest)
      .setMode(Maps.DirectionFinder.Mode.TRANSIT)
      .setArrive(arriveBy)
      .getDirections();
    const leg = r.routes && r.routes[0] && r.routes[0].legs[0];
    if (leg) mins = Math.ceil(leg.duration.value / 60);
  } catch (e) {
    console.warn('길찾기 실패: ' + e);
  }
  cache.put('T:' + key, mins === null ? '-1' : String(mins), 6 * 3600);
  return mins;
}

/* ───────────────────────── 아침 브리핑 / 저녁 마무리 ───────────────────────── */

const BAND_STYLE =
  '손목 밴드 화면에 띄울 글이다. 최대 5줄, 줄당 25자 안팎, 각 줄은 "· "로 시작. 이모지와 특수 기호는 밴드에서 깨지니 쓰지 마라.' +
  '인사말·마무리 문장 금지. 핵심만.';

function morningBriefing() {
  const now = new Date();
  const events = eventsOn_(now);
  const open = openItems_(10);
  const text = gpt_(
    '너는 아침 브리핑 비서다. ' + BAND_STYLE +
    ' 일정은 시간순 핵심만. 비 올 확률이 높은 시간대에 장소가 있는 일정이 있으면 우산을 챙기라고 말해라. ' +
    '완료 안 한 중요 메일은 개수와 가장 급해 보이는 것 하나만.',
    `오늘: ${fmt_(now, 'M월 d일')} (${dow_(now)})\n\n[날씨] ${weather_(0)}\n\n[일정]\n${events}\n\n` +
    `[아직 완료 안 한 중요 메일 ${open.length}개]\n` +
    open.map(o => `- ${o.subject} (${o.from}, ${o.age})`).join('\n'));
  notify_({ title: `🌅 ${fmt_(now, 'M/d')}(${dow_(now)}) 아침 브리핑`, message: text, priority: 4 });
}

function eveningWrapUp() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400e3);
  const open = openItems_(10);
  const text = gpt_(
    '너는 하루 마무리 비서다. ' + BAND_STYLE +
    ' 남은 일 개수, 내일 첫 일정과 전체 일정 수, 내일 날씨 중 챙길 것(비·추위)을 알려라.',
    `[아직 완료 안 한 중요 메일 ${open.length}개]\n` +
    open.map(o => `- ${o.subject} (${o.from}, ${o.age})`).join('\n') +
    `\n\n[내일 ${fmt_(tomorrow, 'M월 d일')} (${dow_(tomorrow)}) 일정]\n${eventsOn_(tomorrow)}` +
    `\n\n[내일 날씨] ${weather_(1)}`);
  notify_({ title: '🌙 오늘 마무리 · 내일 미리보기', message: text, priority: 3 });

  open.slice(0, CONFIG.MAX_DONE_PROMPTS).forEach(o => {
    notify_({
      title: '📌 남은 일 — 완료할까요?',
      message: `${o.subject}\n(${o.from}, ${o.age})`,
      actions: [doneAction_(o.threadId), viewAction_(o.threadId)],
    });
  });
  cleanupPendingEvents_();
}

function eventsOn_(day) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);
  const list = CalendarApp.getDefaultCalendar().getEvents(start, end).map(e => e.isAllDayEvent()
    ? `- 종일 ${e.getTitle()}`
    : `- ${fmt_(e.getStartTime(), 'HH:mm')}~${fmt_(e.getEndTime(), 'HH:mm')} ${e.getTitle()}` +
      (e.getLocation() ? ` @${e.getLocation()}` : ''));
  return list.join('\n') || '(일정 없음)';
}

/** Open-Meteo(무료, 키 불필요). dayOffset 0=오늘, 1=내일. */
function weather_(dayOffset) {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${CONFIG.LAT}&longitude=${CONFIG.LON}` +
      '&hourly=precipitation_probability' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&timezone=${encodeURIComponent(Session.getScriptTimeZone())}&forecast_days=2`;
    const j = JSON.parse(UrlFetchApp.fetch(url).getContentText());
    const d = j.daily;
    const date = d.time[dayOffset];
    const rainyHours = j.hourly.time
      .map((t, i) => ({ t, p: j.hourly.precipitation_probability[i] }))
      .filter(x => x.t.startsWith(date) && x.p >= 50)
      .map(x => Number(x.t.slice(11, 13)) + '시');
    return `최고 ${Math.round(d.temperature_2m_max[dayOffset])}° / 최저 ${Math.round(d.temperature_2m_min[dayOffset])}°, ` +
      `강수확률 최대 ${d.precipitation_probability_max[dayOffset]}%` +
      (rainyHours.length ? `, 비 예상 시간: ${rainyHours.join(' ')}` : '');
  } catch (e) {
    console.warn('날씨 조회 실패: ' + e);
    return '(날씨 정보 없음)';
  }
}

function cleanupPendingEvents_() {
  const p = props_();
  Object.entries(p.getProperties())
    .filter(([k]) => k.startsWith('EVT_'))
    .forEach(([k, v]) => {
      try { if (Date.now() - JSON.parse(v).created > 3 * 86400e3) p.deleteProperty(k); }
      catch (e) { p.deleteProperty(k); }
    });
}

/* ───────────────────────── 버튼 처리 ───────────────────────── */

/**
 * 텔레그램 콜백 버튼(✅ 완료, 📅 추가)을 눌렀을 때 pollTelegram이 호출한다.
 * 결과를 짧게 띄우고, 누른 버튼은 메시지에서 지운다.
 */
function handleCallback_(cq) {
  const [kind, arg] = String(cq.data || '').split(':');
  const [icon, text] = runAction_(kind, arg);
  tg_('answerCallbackQuery', { callback_query_id: cq.id, text: `${icon} ${text.split('\n')[0]}` });
  const msg = cq.message;
  if (msg && msg.reply_markup) {
    const rows = msg.reply_markup.inline_keyboard
      .map(row => row.filter(b => b.callback_data !== cq.data))
      .filter(row => row.length);
    tg_('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id,
                                    reply_markup: { inline_keyboard: rows } });
  }
  notify_({ title: `${icon} ${text.split('\n')[0]}`, message: text.split('\n').slice(1).join('\n'), priority: 2 });
}

/** @return {[string, string]} [아이콘, 결과 문구] */
function runAction_(kind, arg) {
  if (kind === 'done' && arg) {
    const th = GmailApp.getThreadById(arg);
    if (!th) return ['❓', '메일을 찾을 수 없어요'];
    th.addLabel(label_(CONFIG.DONE_LABEL));
    th.markRead();
    return ['✅', '완료 처리했어요\n' + th.getFirstMessageSubject()];
  }
  if (kind === 'addevt' && arg) {
    const raw = props_().getProperty('EVT_' + arg);
    if (!raw) return ['ℹ️', '이미 추가했거나 만료된 요청이에요'];
    const ev = JSON.parse(raw);
    CalendarApp.getDefaultCalendar().createEvent(ev.title, new Date(ev.start), new Date(ev.end), {
      location: ev.location,
      description: '메일에서 자동 추가: https://mail.google.com/mail/u/0/#all/' + ev.threadId,
    });
    props_().deleteProperty('EVT_' + arg);
    const s = new Date(ev.start);
    return ['📅', `캘린더에 추가했어요\n${ev.title}\n${fmt_(s, 'M/d')}(${dow_(s)}) ${fmt_(s, 'HH:mm')}`];
  }
  return ['❓', '알 수 없는 요청이에요'];
}

/* 예전 버전이 보낸 링크 버튼(웹 앱 주소)도 계속 동작하도록 남겨 둔다. 새 메시지는 콜백 버튼을 쓴다. */
function doGet(e) {
  const q = (e && e.parameter) || {};
  const [icon, text] = q.a ? handleAction_(q) : ['🟢', '밴드 비서 동작 중'];
  return HtmlService.createHtmlOutput(
    `<div style="font-family:sans-serif;text-align:center;padding:48px 16px">` +
    `<div style="font-size:56px">${icon}</div>` +
    `<p style="font-size:20px;white-space:pre-line">${esc_(text)}</p></div>`)
    .setTitle('밴드 비서')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  const q = (e && e.parameter) || {};
  return ContentService.createTextOutput(handleAction_(q)[1]);
}

function handleAction_(q) {
  if (!q.token || q.token !== props_().getProperty('ACTION_TOKEN')) return ['⛔', '권한이 없는 요청이에요'];
  return runAction_(q.a, q.a === 'done' ? q.t : q.id);
}

/* 콜백 데이터는 64바이트 제한 — "done:<스레드 ID>", "addevt:<8자리 ID>"로 충분히 짧다. */
function doneAction_(threadId, label) {
  return { label: label || '✅ 완료', data: 'done:' + threadId };
}

function addEventAction_(pid) {
  return { label: '📅 추가', data: 'addevt:' + pid };
}

function viewAction_(threadId) {
  return { label: '메일 열기', url: 'https://mail.google.com/mail/u/0/#all/' + threadId };
}

/* ───────────────────────── 외부 연동 ───────────────────────── */

/**
 * priority 2 이하는 소리·진동 없이 보낸다.
 * actions는 버튼 한 줄, rows는 여러 줄. keyboard: true면 대신 고정 버튼을 (다시) 띄운다.
 */
function notify_({ title, message, priority = 3, actions = [], rows = null, keyboard = false }) {
  const chatId = props_().getProperty('TELEGRAM_CHAT_ID');
  if (!chatId) throw new Error('텔레그램이 연결되지 않았어요. connectTelegram을 실행하세요.');
  const inline = (rows || [actions])
    .map(row => row.filter(Boolean).map(a => a.data
      ? { text: a.label, callback_data: a.data }
      : { text: a.label, url: a.url }))
    .filter(row => row.length);
  tg_('sendMessage', {
    chat_id: chatId,
    text: `<b>${esc_(bandSafe_(title))}</b>\n${esc_(bandSafe_(message))}`,
    parse_mode: 'HTML',
    disable_notification: priority <= 2,
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard ? quickKeyboard_() : inline.length ? { inline_keyboard: inline } : undefined,
  });
}

function tg_(method, payload) {
  const token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('스크립트 속성에 TELEGRAM_BOT_TOKEN이 없습니다.');
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());
  if (!body.ok) console.error(`텔레그램 ${method} 실패: ${res.getContentText().slice(0, 300)}`);
  return body;
}

function gpt_(system, user, json) {
  const key = props_().getProperty('OPENAI_API_KEY');
  if (!key) throw new Error('스크립트 속성에 OPENAI_API_KEY가 없습니다.');
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({
      model: CONFIG.OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: json ? { type: 'json_object' } : undefined,
      reasoning_effort: CONFIG.OPENAI_REASONING_EFFORT || undefined,
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`OpenAI ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  }
  const out = JSON.parse(res.getContentText()).choices[0].message.content || '';
  return json ? JSON.parse(out) : out.trim();
}

/* ───────────────────────── 유틸 ───────────────────────── */

function props_() { return PropertiesService.getScriptProperties(); }
function nowSec_() { return Math.floor(Date.now() / 1000); }
function fmt_(d, f) { return Utilities.formatDate(d, Session.getScriptTimeZone(), f); }
function dow_(d) { return ['일', '월', '화', '수', '목', '금', '토'][Number(fmt_(d, 'u')) % 7]; }
function tzOffset_() { return fmt_(new Date(), 'XXX'); }
function q_(labelName) { return labelName.replace(/\s+/g, '-'); }
/** CONFIG.STRIP_EMOJI면 이모지와 그 뒤 공백을 지운다. */
function bandSafe_(s) {
  if (!CONFIG.STRIP_EMOJI) return String(s);
  return String(s).replace(/[\p{Extended_Pictographic}️‍]+\s?/gu, '').replace(/^[ \t]+/gm, '');
}
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function chunk_(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function senderName_(from) {
  const m = from.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return (m ? m[1] : from).trim();
}

function loadJson_(key, fallback) {
  try { return JSON.parse(props_().getProperty(key)) || fallback; } catch (e) { return fallback; }
}
function saveJson_(key, value) { props_().setProperty(key, JSON.stringify(value)); }

function safely_(name, fn) {
  try { fn(); } catch (e) { console.error(`[${name}] ${e && e.stack || e}`); }
}
