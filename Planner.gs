/**
 * AI 플래너
 *
 *  - 아침: 컨디션 체크(좋음/보통/피곤) → 오늘 시간표 제안 → [확정]하면 "AI 플랜" 캘린더에 등록
 *  - 낮: 블록 시작 알림, 끝나면 "다 했어요?" [완료]/[미루기]
 *  - 아무 때나: 텔레그램에 글·음성으로 던지면 할 일 등록 / 아이디어 실행 계획 조사 / 생각 정리 / 계획 다시 짜기
 * 할 일은 Google Tasks 기본 목록에, 하루 기록은 구글 시트 "밴드 비서 기록"에 쌓는다.
 * PLAN은 pollTelegram만 쓰고 tick은 읽기만 한다. 알림 여부(PLAN_NUDGES)는 tick만, 블록 결과(PLAN_STATUS)는
 * pollTelegram만 써서 두 트리거가 같은 값을 덮어쓰지 않게 한다.
 */

const CONDITIONS = { good: '좋음', ok: '보통', tired: '피곤' };

/* ───────────────────────── 아침 체크인 ───────────────────────── */

function sendCheckin_() {
  const now = new Date();
  saveJson_('CHECKIN', { date: today_(), askedAt: Date.now() });
  notify_({
    title: `좋은 아침이에요 ${fmt_(now, 'M/d')}(${dow_(now)})`,
    message: '오늘 컨디션은 어때요? 고르면 1분 안에 오늘 계획을 보내 드릴게요.',
    priority: 4,
    actions: Object.entries(CONDITIONS).map(([k, v]) => ({ label: v, data: 'ci:' + k })),
  });
}

function onCheckin_(key) {
  const condition = CONDITIONS[key] || '보통';
  saveJson_('CHECKIN', Object.assign(loadJson_('CHECKIN', {}), { date: today_(), condition }));
  safely_('log', () => logDay_({ checkin: fmt_(new Date(), 'HH:mm'), condition }));
  notify_({ title: `컨디션: ${condition}`, message: '오늘 계획을 짜고 있어요.', priority: 2 });
  makePlan_({ condition });
}

/** tick에서 호출: 체크인 응답이 없으면 보통으로 계획, 확정된 계획의 블록 알림. */
function plannerTick_(now) {
  const ci = loadJson_('CHECKIN', {});
  if (ci.date === today_() && ci.askedAt && !ci.condition &&
      Date.now() - ci.askedAt > CONFIG.CHECKIN_TIMEOUT_MIN * 60000) {
    saveJson_('CHECKIN', Object.assign(ci, { condition: '보통', auto: true }));
    makePlan_({ condition: '보통', request: '아침 체크인에 응답이 없었다. 아직 자고 있을 수 있으니 오전은 느슨하게.' });
  }
  nudgeBlocks_(now);
}

/* ───────────────────────── 계획 만들기 ───────────────────────── */

/**
 * 지금부터 하루 끝(DAY_END)까지의 시간표를 짜서 보낸다. 확정된 계획이 있으면 아직 안 지난 블록만 새로 짠다.
 * @param {{condition: string, request?: string}} opt
 */
function makePlan_(opt) {
  const now = new Date();
  const start = new Date(Math.ceil((now.getTime() + 10 * 60000) / (10 * 60000)) * 10 * 60000);
  const end = at_(CONFIG.DAY_END);
  if (end - start < 60 * 60000) {
    notify_({ title: '오늘 계획', message: '오늘 남은 시간이 1시간도 안 돼요. 내일 아침에 새로 짤게요.' });
    return;
  }

  const prev = loadJson_('PLAN', null);
  const status = loadJson_('PLAN_STATUS', {});
  const prevToday = prev && prev.date === today_() ? prev : null;
  const doneToday = prevToday
    ? prevToday.blocks.filter((b, i) => status.date === today_() && status[i] === 'done').map(b => b.title)
    : [];

  const fixed = CalendarApp.getDefaultCalendar().getEvents(now, end)
    .map(e => e.isAllDayEvent()
      ? `- 종일 ${e.getTitle()}`
      : `- ${fmt_(e.getStartTime(), 'HH:mm')}~${fmt_(e.getEndTime(), 'HH:mm')} ${e.getTitle()}`);
  const tasks = listTasks_(40);
  const mails = openItems_(5);

  const system = [
    '너는 사용자의 개인 플래너다. 사용자는 생각 정리와 계획 세우기를 어려워하고 하루를 효율적으로 보내고 싶어 한다.',
    `오늘 ${fmt_(start, 'HH:mm')}부터 ${CONFIG.DAY_END}까지의 시간표를 짠다.`,
    '규칙:',
    '- 고정 일정과 겹치지 않게 짠다. 고정 일정 자체는 blocks에 넣지 않는다(이미 캘린더에 있다).',
    '- 집중 블록은 25~90분, 블록 사이에 휴식을 둔다. 식사 시간을 넣는다(kind: meal).',
    '- 컨디션 좋음: 집중 5~6시간 / 보통: 4시간 / 피곤: 2~3시간, 쉬운 일부터, 휴식 넉넉히.',
    '- 프로필의 목표와 마감이 가까운 할 일을 우선한다. 할 일 목록에 있는 일을 넣으면 task_id에 그 id를 넣는다.',
    '- 목록에 없어도 목표에 필요한 일(예: 운동)은 task_id 없이 넣어도 된다.',
    '- 이미 오늘 끝낸 일은 다시 넣지 않는다.',
    '- top3: 오늘 꼭 할 액션 아이템 3개. "~하기"처럼 구체적인 행동으로.',
    '- note: 이 계획의 의도를 한두 문장으로. 칭찬·응원 문구는 쓰지 않는다.',
    '출력 JSON: {"top3":[""],"blocks":[{"start":"HH:mm","end":"HH:mm","title":"","kind":"task|meal|break|move","task_id":null}],"note":""}',
  ].join('\n');
  const user = [
    `지금: ${fmt_(now, 'yyyy-MM-dd HH:mm')} (${dow_(now)})`,
    `컨디션: ${opt.condition}`,
    opt.request ? `요청: ${opt.request}` : '',
    `[프로필]\n${CONFIG.PROFILE || '(없음)'}`,
    `[고정 일정]\n${fixed.join('\n') || '(없음)'}`,
    `[할 일]\n${tasks.map(t => `- id=${t.id} ${t.title}${t.due ? ` (마감 ${t.due})` : ''} ${t.notes}`).join('\n') || '(없음)'}`,
    `[답장·처리가 필요한 중요 메일]\n${mails.map(m => `- ${m.subject} (${m.from})`).join('\n') || '(없음)'}`,
    `[오늘 이미 끝낸 일]\n${doneToday.join('\n') || '(없음)'}`,
    `[날씨] ${weather_(0)}`,
  ].filter(Boolean).join('\n\n');

  const out = gpt_(system, user, true, { model: CONFIG.PLANNER_MODEL, effort: CONFIG.PLANNER_REASONING_EFFORT });
  const taskIds = new Set(tasks.map(t => t.id));
  const blocks = (out.blocks || [])
    .filter(b => validTime_(b.start) && validTime_(b.end) && b.title)
    .filter(b => at_(b.start) < at_(b.end) && at_(b.start) >= new Date(start - 10 * 60000) && at_(b.end) <= end)
    .map(b => ({ start: b.start, end: b.end, title: String(b.title).slice(0, 60),
                 kind: ['task', 'meal', 'break', 'move'].includes(b.kind) ? b.kind : 'task',
                 task_id: taskIds.has(b.task_id) ? b.task_id : null }))
    .sort((a, b) => at_(a.start) - at_(b.start));

  // 다시 짜는 경우: 이전 계획 중 아직 시작 안 한 캘린더 블록은 지운다(지난 블록과 기록은 남긴다).
  if (prevToday && prevToday.confirmed) removeFutureEvents_(prevToday, now);

  const plan = { date: today_(), condition: opt.condition, confirmed: false,
                 top3: (out.top3 || []).slice(0, 3), blocks, note: out.note || '', eventIds: [] };
  saveJson_('PLAN', plan);
  saveJson_('PLAN_STATUS', { date: today_() });
  saveJson_('PLAN_NUDGES', { date: today_(), s: {}, e: {} });

  notify_({
    title: `오늘 계획 (컨디션 ${opt.condition})`,
    message: planText_(plan, {}) + `\n\n날씨: ${weather_(0)}`,
    priority: 4,
    actions: [{ label: '✅ 확정', data: 'plan:ok' }, { label: '🔄 다시 짜기', data: 'plan:redo' }],
  });
}

function planText_(plan, status) {
  const lines = ['액션 아이템', ...plan.top3.map((t, i) => `${i + 1}. ${t}`), '', '시간표'];
  plan.blocks.forEach((b, i) => {
    const mark = status[i] === 'done' ? '(완료) ' : status[i] === 'skipped' ? '(미룸) ' : '';
    lines.push(`${b.start}~${b.end} ${mark}${b.title}`);
  });
  if (plan.note) lines.push('', plan.note);
  return lines.join('\n');
}

function confirmPlan_() {
  const plan = loadJson_('PLAN', null);
  if (!plan || plan.date !== today_()) {
    notify_({ title: '계획 없음', message: '확정할 오늘 계획이 없어요. "오늘 계획" 버튼으로 새로 짜 주세요.' });
    return;
  }
  const cal = planCalendar_();
  plan.eventIds = plan.blocks
    .filter(b => b.kind !== 'break')
    .map(b => cal.createEvent(b.title, at_(b.start), at_(b.end), { description: 'AI 플래너가 만든 블록' }).getId());
  plan.confirmed = true;
  saveJson_('PLAN', plan);
  safely_('log', () => logDay_({ planned: plan.blocks.filter(b => b.kind === 'task').length }));
  notify_({ title: '계획을 확정했어요', message: `"${CONFIG.PLAN_CALENDAR}" 캘린더에 ${plan.eventIds.length}개 등록했어요.\n블록이 시작할 때 알려 드릴게요.`, priority: 2 });
}

function removeFutureEvents_(plan, now) {
  const cal = planCalendar_();
  (plan.eventIds || []).forEach(id => {
    const ev = cal.getEventById(id);
    if (ev && ev.getStartTime() > now) ev.deleteEvent();
  });
}

function planCalendar_() {
  return CalendarApp.getCalendarsByName(CONFIG.PLAN_CALENDAR)[0] ||
    CalendarApp.createCalendar(CONFIG.PLAN_CALENDAR, { color: CalendarApp.Color.PURPLE });
}

/** 오늘 계획 보기: 있으면 다시 보여 주고, 없으면 새로 짠다. */
function showPlan_() {
  const plan = loadJson_('PLAN', null);
  if (!plan || plan.date !== today_()) {
    const ci = loadJson_('CHECKIN', {});
    makePlan_({ condition: ci.date === today_() && ci.condition ? ci.condition : '보통' });
    return;
  }
  const status = loadJson_('PLAN_STATUS', {});
  notify_({
    title: `오늘 계획 (컨디션 ${plan.condition})${plan.confirmed ? '' : ' — 확정 전'}`,
    message: planText_(plan, status.date === today_() ? status : {}),
    actions: plan.confirmed
      ? [{ label: '🔄 다시 짜기', data: 'plan:redo' }]
      : [{ label: '✅ 확정', data: 'plan:ok' }, { label: '🔄 다시 짜기', data: 'plan:redo' }],
  });
}

/* ───────────────────────── 블록 알림 ───────────────────────── */

function nudgeBlocks_(now) {
  const plan = loadJson_('PLAN', null);
  if (!plan || plan.date !== today_() || !plan.confirmed) return;
  let nudges = loadJson_('PLAN_NUDGES', {});
  if (nudges.date !== today_()) nudges = { date: today_(), s: {}, e: {} };
  const status = loadJson_('PLAN_STATUS', {});
  let changed = false;

  plan.blocks.forEach((b, i) => {
    const start = at_(b.start), end = at_(b.end);
    if (!nudges.s[i] && now >= start && now < end) {
      if (now - start < 15 * 60000 && b.kind !== 'break') {
        notify_({ title: `지금: ${b.title}`, message: `${b.start}~${b.end} (${Math.round((end - start) / 60000)}분)`, priority: 4 });
      }
      nudges.s[i] = 1; changed = true;
    }
    if (b.kind === 'task' && !nudges.e[i] && now >= end) {
      if (now - end < 30 * 60000 && !status[i]) {
        notify_({
          title: `다 했어요? ${b.title}`,
          message: `${b.start}~${b.end} 블록이 끝났어요.`,
          priority: 3,
          actions: [{ label: '✅ 완료', data: `blk:done:${i}` }, { label: '⏭ 미루기', data: `blk:skip:${i}` }],
        });
      }
      nudges.e[i] = 1; changed = true;
    }
  });
  if (changed) saveJson_('PLAN_NUDGES', nudges);
}

function onBlock_(action, i) {
  const plan = loadJson_('PLAN', null);
  if (!plan || plan.date !== today_() || !plan.blocks[i]) return;
  const b = plan.blocks[i];
  let status = loadJson_('PLAN_STATUS', {});
  if (status.date !== today_()) status = { date: today_() };
  if (status[i]) return; // 이미 처리
  status[i] = action === 'done' ? 'done' : 'skipped';
  saveJson_('PLAN_STATUS', status);
  if (action === 'done') {
    if (b.task_id) safely_('task', () => completeTask_(b.task_id));
    safely_('log', () => logDay_({ doneInc: 1 }));
    notify_({ title: `완료: ${b.title}`, message: '', priority: 2 });
  } else {
    safely_('log', () => logDay_({ skipInc: 1 }));
    notify_({ title: `미룸: ${b.title}`, message: '다음 계획에 다시 넣을게요.', priority: 2 });
  }
}

/** 저녁 마무리에 붙일 한 줄 */
function planStatsText_() {
  const plan = loadJson_('PLAN', null);
  if (!plan || plan.date !== today_() || !plan.confirmed) return '';
  const status = loadJson_('PLAN_STATUS', {});
  const taskIdx = plan.blocks.map((b, i) => b.kind === 'task' ? i : -1).filter(i => i >= 0);
  const done = taskIdx.filter(i => status[i] === 'done').length;
  const skipped = taskIdx.filter(i => status[i] === 'skipped').length;
  return `오늘 계획 ${taskIdx.length}개 중 ${done}개 완료, ${skipped}개 미룸`;
}

/* ───────────────────────── 던지기: 글·음성 ───────────────────────── */

/** 고정 버튼이 아닌 메시지. 의도를 나눠 할 일 등록 / 아이디어 조사 / 생각 정리 / 계획 수정 / 질문 답변. */
function plannerMessage_(text) {
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86400e3);
  const events = CalendarApp.getDefaultCalendar().getEvents(now, week).slice(0, 40)
    .map(e => `- ${fmt_(e.getStartTime(), 'M/d(E) HH:mm')} ${e.getTitle()}`);
  const tasks = listTasks_(40);
  const plan = loadJson_('PLAN', null);

  const system = [
    '사용자가 개인 비서 텔레그램 봇에 보낸 메시지를 분류하고 처리한다. intent는 하나만 고른다.',
    '- tasks: 해야 할 일을 던짐 → tasks에 정리(제목은 구체적 행동, due는 YYYY-MM-DD 또는 null, est_min 예상 분, priority 1~3)',
    '- idea: 하고 싶은 것·배우고 싶은 것·사고 싶은 것·가고 싶은 곳처럼 비용·장소·시간 조사가 필요한 것 → idea에 한 줄 요약',
    '- thoughts: 고민·생각을 털어놓음 → reply에 정리(상황 / 핵심 / 선택지 / 다음 행동). 할 일이 나오면 tasks에도 넣는다',
    '- replan: 오늘 계획을 바꿔 달라는 요청 → request에 요청 요약',
    '- done: 어떤 일을 끝냈다고 알림 → 할 일 목록에서 해당 id를 done_task_ids에',
    '- question: 일정·할 일 등에 대한 질문 → 아래 데이터로 reply에 답. 모르면 모른다고 한다',
    '공통: reply는 한국어로 짧고 구체적으로. 칭찬·응원 문구는 쓰지 않는다.',
    '출력 JSON: {"intent":"","reply":"","tasks":[{"title":"","due":null,"est_min":30,"priority":2,"notes":""}],' +
      '"idea":"","request":"","done_task_ids":[]}',
  ].join('\n');
  const user = [
    `지금: ${fmt_(now, 'yyyy-MM-dd HH:mm')} (${dow_(now)})`,
    `[프로필]\n${CONFIG.PROFILE || '(없음)'}`,
    `[앞으로 7일 일정]\n${events.join('\n') || '(없음)'}`,
    `[할 일]\n${tasks.map(t => `- id=${t.id} ${t.title}${t.due ? ` (마감 ${t.due})` : ''}`).join('\n') || '(없음)'}`,
    plan && plan.date === today_() ? `[오늘 계획]\n${planText_(plan, {})}` : '',
    `[메시지]\n${text}`,
  ].filter(Boolean).join('\n\n');

  const r = gpt_(system, user, true, { model: CONFIG.PLANNER_MODEL, effort: CONFIG.PLANNER_REASONING_EFFORT });
  const added = (r.tasks || []).filter(t => t && t.title).map(t => { addTask_(t); return t; });
  const addedText = added.map(t => `- ${t.title}` + [t.due ? ` 마감 ${t.due.slice(5).replace('-', '/')}` : '',
    t.est_min ? ` ${t.est_min}분` : ''].join(',').replace(/^,|,$/g, '')).join('\n');
  const replanButton = plan && plan.date === today_() ? [{ label: '🔄 오늘 계획에 반영', data: 'plan:redo' }] : [];

  switch (r.intent) {
    case 'idea':
      researchIdea_(r.idea || text, text);
      return;
    case 'replan':
      makePlan_({ condition: (plan && plan.condition) || '보통', request: r.request || text });
      return;
    case 'done': {
      const titles = (r.done_task_ids || []).filter(id => tasks.some(t => t.id === id)).map(id => {
        completeTask_(id);
        return tasks.find(t => t.id === id).title;
      });
      notify_({ title: titles.length ? '완료 처리했어요' : '해당하는 할 일을 못 찾았어요',
                message: titles.map(t => `- ${t}`).join('\n') || r.reply || '', priority: 2 });
      return;
    }
    case 'thoughts':
    case 'question':
      notify_({ title: r.intent === 'thoughts' ? '생각 정리' : '답변',
                message: [r.reply, added.length ? `\n할 일로 추가했어요\n${addedText}` : ''].join(''),
                actions: added.length ? replanButton : [] });
      return;
    default: // tasks
      notify_({
        title: added.length ? `할 일 ${added.length}개 추가했어요` : '정리할 할 일을 못 찾았어요',
        message: addedText || r.reply || '',
        priority: 2,
        actions: added.length ? replanButton : [],
      });
  }
}

/** 텔레그램 음성 메시지 → 글자 */
function transcribe_(fileId) {
  const file = tg_('getFile', { file_id: fileId }).result;
  const token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  const blob = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    .getBlob().setName('voice.ogg');
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + props_().getProperty('OPENAI_API_KEY') },
    payload: { file: blob, model: CONFIG.TRANSCRIBE_MODEL, language: 'ko' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`음성 인식 ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  }
  return JSON.parse(res.getContentText()).text || '';
}

function onVoice_(voice) {
  const text = transcribe_(voice.file_id);
  if (!text.trim()) {
    notify_({ title: '음성 인식 실패', message: '잘 안 들렸어요. 다시 보내 주세요.', priority: 2 });
    return;
  }
  notify_({ title: '들은 내용', message: text, priority: 2 });
  plannerMessage_(text);
}

/* ───────────────────────── 아이디어 → 실행 계획 ───────────────────────── */

/** 웹 검색으로 장소·비용·시간을 조사해 실행 계획으로 정리한다. */
function researchIdea_(idea, original) {
  notify_({ title: '아이디어 조사 중', message: `${idea}\n장소·비용·시간을 찾아보고 있어요.`, priority: 2 });
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86400e3);
  const busy = CalendarApp.getDefaultCalendar().getEvents(now, week)
    .map(e => `- ${fmt_(e.getStartTime(), 'M/d(E) HH:mm')}~${fmt_(e.getEndTime(), 'HH:mm')} ${e.getTitle()}`);

  const system = [
    '사용자가 즉흥적으로 하고 싶다고 한 일을 실행 계획으로 바꾼다. 칭찬·응원·"좋은 생각" 같은 말은 쓰지 않는다.',
    `웹 검색으로 사용자 지역(${CONFIG.REGION}) 기준 실제 장소·가격·소요 시간을 확인한다.`,
    '확인하지 못한 숫자는 "추정"이라고 표시한다. 숫자는 범위로 쓴다.',
    '사용자 프로필의 목표·상황과 비교해 지금 할 만한지, 우선순위를 솔직하게 판단한다.',
    '출력은 JSON 하나만:',
    '{"title":"","where":"어디서(장소 1~2곳이나 방법)","cost":"비용(초기 / 매달)","time_per_session":"1회 소요(이동 포함)",' +
      '"duration":"목표 수준까지 기간","fit":"판단 한두 문장","first_step":"이번 주에 할 첫 행동",' +
      '"steps":[{"title":"","est_min":60}],"sources":["url"]}',
  ].join('\n');
  const user = [
    `[아이디어] ${idea}`,
    `[원래 메시지] ${original}`,
    `[프로필]\n${CONFIG.PROFILE || '(없음)'}`,
    `[앞으로 7일 일정]\n${busy.join('\n') || '(없음)'}`,
  ].join('\n\n');

  const r = research_(system, user);
  const id = Utilities.getUuid().slice(0, 8);
  props_().setProperty('IDEA_' + id, JSON.stringify({ title: r.title || idea, steps: r.steps || [], created: Date.now() }));
  const lines = [
    r.where && `어디서: ${r.where}`,
    r.cost && `비용: ${r.cost}`,
    r.time_per_session && `1회: ${r.time_per_session}`,
    r.duration && `기간: ${r.duration}`,
    r.fit && `판단: ${r.fit}`,
    r.first_step && `첫 행동: ${r.first_step}`,
    (r.steps || []).length && `\n단계\n${r.steps.map((s, i) => `${i + 1}. ${s.title}${s.est_min ? ` (${s.est_min}분)` : ''}`).join('\n')}`,
    (r.sources || []).length && `\n출처: ${r.sources.slice(0, 3).map(u => String(u).replace(/^https?:\/\/(www\.)?/, '').split('/')[0]).join(', ')}`,
  ].filter(Boolean);
  notify_({
    title: `아이디어 정리: ${r.title || idea}`,
    message: lines.join('\n'),
    actions: [{ label: '📋 할 일로 추가', data: 'idea:add:' + id }, { label: '보류', data: 'idea:drop:' + id }],
  });
}

function onIdea_(action, id) {
  const raw = props_().getProperty('IDEA_' + id);
  if (!raw) {
    notify_({ title: '만료된 아이디어', message: '다시 보내 주시면 새로 정리할게요.', priority: 2 });
    return;
  }
  props_().deleteProperty('IDEA_' + id);
  const idea = JSON.parse(raw);
  if (action !== 'add') {
    notify_({ title: `보류: ${idea.title}`, message: '', priority: 2 });
    return;
  }
  idea.steps.forEach(s => addTask_({ title: s.title, est_min: s.est_min, due: s.due, priority: 2,
                                     notes: idea.source || `아이디어: ${idea.title}` }));
  notify_({ title: `할 일 ${idea.steps.length}개 추가`, message: idea.steps.map(s => `- ${s.title}`).join('\n'), priority: 2,
            actions: [{ label: '🔄 오늘 계획에 반영', data: 'plan:redo' }] });
}

/** OpenAI Responses API + 웹 검색. 마지막 JSON 객체를 꺼내 돌려준다. */
function research_(system, user) {
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + props_().getProperty('OPENAI_API_KEY') },
    payload: JSON.stringify({
      model: CONFIG.PLANNER_MODEL,
      instructions: system,
      input: user,
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'KR' } }],
      reasoning: { effort: 'low' }, // 웹 검색은 minimal에서 쓸 수 없다
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`OpenAI 조사 ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  }
  const text = (JSON.parse(res.getContentText()).output || [])
    .filter(o => o.type === 'message')
    .flatMap(o => o.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text).join('\n');
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('조사 결과에 JSON이 없어요: ' + text.slice(0, 200));
  return JSON.parse(json[0]);
}

/* ───────────────────────── 버튼 처리 ───────────────────────── */

const PLANNER_CALLBACKS = ['ci', 'plan', 'blk', 'idea'];

/** 한 번 고르면 끝나는 선택지라 메시지의 버튼을 모두 지운다. */
function plannerCallback_(cq) {
  const [kind, a, b] = String(cq.data).split(':');
  tg_('answerCallbackQuery', { callback_query_id: cq.id });
  if (cq.message) {
    tg_('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
                                    reply_markup: { inline_keyboard: [] } });
  }
  if (kind === 'ci') onCheckin_(a);
  else if (kind === 'plan' && a === 'ok') confirmPlan_();
  else if (kind === 'plan') makePlan_({ condition: (loadJson_('PLAN', {}) || {}).condition || '보통' });
  else if (kind === 'blk') onBlock_(a, Number(b));
  else if (kind === 'idea') onIdea_(a, b);
}

/* ───────────────────────── Google Tasks ───────────────────────── */

function listTasks_(limit) {
  const res = Tasks.Tasks.list('@default', { showCompleted: false, maxResults: limit || 40 });
  return (res.items || []).filter(t => t.title).map(t => ({
    id: t.id, title: t.title, due: t.due ? t.due.slice(0, 10) : null,
    notes: (t.notes || '').replace(/\s+/g, ' ').slice(0, 120),
  }));
}

function addTask_(t) {
  const notes = [t.notes, `[예상 ${t.est_min || 30}분] [우선순위 ${t.priority || 2}]`].filter(Boolean).join('\n');
  const resource = { title: String(t.title).slice(0, 200), notes };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.due || '')) resource.due = t.due + 'T00:00:00.000Z';
  return Tasks.Tasks.insert(resource, '@default');
}

function completeTask_(id) {
  Tasks.Tasks.patch({ status: 'completed' }, '@default', id);
}

/** "할 일" 버튼: 열린 할 일 목록 + 번호별 완료 버튼 */
function showTasks_() {
  const tasks = listTasks_(15);
  if (!tasks.length) {
    notify_({ title: '할 일 없음', message: '텔레그램에 해야 할 일을 보내면 정리해서 넣어 드릴게요.' });
    return;
  }
  notify_({
    title: `할 일 ${tasks.length}개`,
    message: tasks.map((t, i) => `${i + 1}. ${t.title}${t.due ? ` (마감 ${t.due.slice(5).replace('-', '/')})` : ''}`).join('\n'),
    rows: chunk_(tasks.map((t, i) => ({ label: `✅ ${i + 1}`, data: 'tk:' + t.id })), 5),
  });
}

/* ───────────────────────── 하루 기록 (구글 시트) ───────────────────────── */

const LOG_HEADER = ['날짜', '체크인 시각', '컨디션', '계획 블록', '완료', '미룸'];

function logSheet_() {
  const p = props_();
  const id = p.getProperty('LOG_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id).getSheets()[0];
  const ss = SpreadsheetApp.create('밴드 비서 기록');
  const sh = ss.getSheets()[0].setName('하루');
  sh.getRange('A:A').setNumberFormat('@');
  sh.appendRow(LOG_HEADER);
  sh.setFrozenRows(1);
  p.setProperty('LOG_SHEET_ID', ss.getId());
  return sh;
}

/** 오늘 행을 찾아(없으면 만들어) 값을 채우거나 더한다. */
function logDay_(f) {
  const sh = logSheet_();
  const today = today_();
  const dates = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues().map(r => r[0]);
  let row = dates.indexOf(today) + 1;
  if (!row) {
    sh.appendRow([today, '', '', 0, 0, 0]);
    row = sh.getLastRow();
  }
  const cell = c => sh.getRange(row, c);
  if (f.checkin) cell(2).setValue(f.checkin);
  if (f.condition) cell(3).setValue(f.condition);
  if (f.planned !== undefined) cell(4).setValue(f.planned);
  if (f.doneInc) cell(5).setValue(Number(cell(5).getValue() || 0) + f.doneInc);
  if (f.skipInc) cell(6).setValue(Number(cell(6).getValue() || 0) + f.skipInc);
}

/* ───────────────────────── 유틸 ───────────────────────── */

function today_() { return fmt_(new Date(), 'yyyy-MM-dd'); }

/** "HH:mm"이고 00:00~23:59 범위인지 (AI가 "25:00" 같은 값을 줄 때 거른다) */
function validTime_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/** 오늘 날짜의 "HH:mm" 시각 */
function at_(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}
