/**
 * 음성 일기
 *
 * [일기 쓰기]를 누르면(또는 밤 알림의 버튼) 일기 모드가 켜지고, 그동안 보낸 음성·글을 모은다.
 * [정리하기]를 누르면 AI가 1인칭 "~했다"체 일기로 옮겨 내 드라이브의 비공개 구글 문서
 * "오늘의 일기 — YYYY년 M월 D일"에 저장한다(같은 날 문서가 있으면 이어 붙인다).
 * 모은 원문은 정리가 끝나면 지운다.
 */

const DIARY_IDLE_FINISH_MIN = 30; // 마지막 메시지 후 이만큼 지나면 자동으로 정리

function diaryState_() { return loadJson_('DIARY', null); }

function startDiary_() {
  const st = diaryState_();
  if (st && st.parts.length) { // 이미 받은 내용이 있으면 지우지 않는다
    notify_({ title: `일기 쓰는 중 (${st.parts.length}개 받음)`, message: '이어서 말해 주세요.', priority: 2,
              actions: [{ label: '📝 정리하기', data: 'dy:done' }, { label: '취소', data: 'dy:cancel' }] });
    return;
  }
  saveJson_('DIARY', { startedAt: Date.now(), lastAt: Date.now(), parts: [] });
  notify_({
    title: '일기 쓰기',
    message: '오늘 있었던 일을 편하게 말해 주세요. 음성 여러 개로 나눠 보내도 돼요.\n' +
      '다 말했으면 [정리하기]를 누르거나 "끝"이라고 보내 주세요.',
    priority: 2,
    actions: [{ label: '📝 정리하기', data: 'dy:done' }, { label: '취소', data: 'dy:cancel' }],
  });
}

/** 일기 모드일 때 받은 글·음성을 모은다. 처리했으면 true. */
function diaryInput_(m) {
  const st = diaryState_();
  if (!st) return false;
  // 고정 버튼은 일기 내용이 아니다. "일기 쓰기"를 다시 누르면 startDiary_가 받은 내용을 유지한 채 안내한다.
  if (m.text && QUICK_BUTTONS.includes(m.text.trim())) return false;
  const text = m.voice ? transcribe_(m.voice.file_id) : String(m.text || '').trim();
  if (/^(끝|정리|정리해줘|다 했어)$/.test(text)) { finishDiary_(); return true; }
  if (/^취소$/.test(text)) { cancelDiary_(); return true; }
  if (!text) return true;
  st.parts.push(text);
  st.lastAt = Date.now();
  saveJson_('DIARY', st);
  notify_({
    title: `받았어요 (${st.parts.length})`,
    message: m.voice ? text.slice(0, 200) + (text.length > 200 ? '…' : '') : '',
    priority: 2,
    actions: [{ label: '📝 정리하기', data: 'dy:done' }],
  });
  return true;
}

function cancelDiary_() {
  props_().deleteProperty('DIARY');
  notify_({ title: '일기 취소', message: '모은 내용은 지웠어요.', priority: 2 });
}

function finishDiary_() {
  const st = diaryState_();
  if (!st || !st.parts.length) {
    props_().deleteProperty('DIARY');
    notify_({ title: '일기', message: '받은 내용이 없어서 저장하지 않았어요.', priority: 2 });
    return;
  }
  const day = diaryDate_(new Date(st.startedAt));
  const system = [
    '사용자가 말로 들려준 하루 이야기를 일기로 옮긴다.',
    '- 1인칭, "~했다"체의 담백한 문장. 일어난 순서대로. 문단은 내용에 맞게 3~10개.',
    '- 사용자가 말한 내용만 쓴다. 지어내거나 감정을 부풀리지 않는다. 숫자·이름·장소·금액은 그대로 살린다.',
    '- 말하면서 엇갈리거나 불확실했던 내용은 그렇다고 적는다(예: 금액이 엇갈려 정확한 숫자는 남기지 않았다).',
    '- 음성 인식 오타로 보이는 말은 문맥에 맞게 고치되, 확신이 없으면 그대로 둔다.',
    '- 마지막 문단은 사용자가 말한 생각이나 느낌으로 마무리한다. 말하지 않은 교훈·응원·다짐은 덧붙이지 않는다.',
    '- tomorrow: 이야기 속에 앞으로 하겠다고 한 일이 있으면 할 일로 뽑는다(title은 구체적 행동, due는 YYYY-MM-DD 또는 null).',
    '출력 JSON: {"paragraphs":[""],"tomorrow":[{"title":"","due":null}],"one_line":"하루 한 줄 요약"}',
  ].join('\n');
  const user = `일기 날짜: ${fmt_(day, 'yyyy-MM-dd')} (${dow_(day)})\n\n` +
    st.parts.map((p, i) => `[${i + 1}]\n${p}`).join('\n\n');
  const r = gpt_(system, user, true, { model: CONFIG.PLANNER_MODEL, effort: CONFIG.PLANNER_REASONING_EFFORT });

  const url = writeDiary_(day, (r.paragraphs || []).filter(Boolean), diaryFooter_(day));
  props_().deleteProperty('DIARY');

  const todo = (r.tomorrow || []).filter(t => t && t.title);
  let actions = [{ label: '일기 열기', url }];
  if (todo.length) {
    const id = Utilities.getUuid().slice(0, 8);
    props_().setProperty('IDEA_' + id, JSON.stringify({ title: '일기', source: `${fmt_(day, 'M/d')} 일기에서`,
      steps: todo.map(t => ({ title: t.title, due: t.due })), created: Date.now() }));
    actions = [{ label: '📋 할 일로 추가', data: 'dy:tasks:' + id }].concat(actions);
  }
  notify_({
    title: '일기를 저장했어요',
    message: [r.one_line, todo.length ? `\n말 속에 나온 할 일\n${todo.map(t => `- ${t.title}`).join('\n')}` : ''].join(''),
    priority: 2,
    actions,
  });
}

/** 새벽 5시 전에 쓴 일기는 전날 일기로 본다(늦게 자는 날). */
function diaryDate_(d) {
  const day = new Date(d);
  if (Number(fmt_(day, 'H')) < 5) day.setDate(day.getDate() - 1);
  return day;
}

/** 일기 끝에 붙일 그날의 기록(컨디션, 계획 결과). 같은 날짜일 때만. */
function diaryFooter_(day) {
  if (fmt_(day, 'yyyy-MM-dd') !== today_()) return '';
  const ci = loadJson_('CHECKIN', {});
  const parts = [];
  if (ci.date === today_() && ci.condition) parts.push(`아침 컨디션 ${ci.condition}`);
  const stats = typeof planStatsText_ === 'function' ? planStatsText_() : '';
  if (stats) parts.push(stats);
  return parts.length ? `오늘의 기록 — ${parts.join(' · ')}` : '';
}

/** 날짜별 문서에 쓴다. 이미 있으면 이어 붙인다. @return 문서 주소 */
function writeDiary_(day, paragraphs, footer) {
  const title = `오늘의 일기 — ${fmt_(day, 'yyyy년 M월 d일')}`;
  const folder = diaryFolder_();
  const existing = folder.getFilesByName(title);
  let doc, body;
  if (existing.hasNext()) {
    doc = DocumentApp.openById(existing.next().getId());
    body = doc.getBody();
    body.appendHorizontalRule();
    body.appendParagraph(`추가 기록 (${fmt_(new Date(), 'HH:mm')})`).setHeading(DocumentApp.ParagraphHeading.HEADING3);
  } else {
    doc = DocumentApp.create(title);
    DriveApp.getFileById(doc.getId()).moveTo(folder);
    body = doc.getBody();
    body.getParagraphs()[0].setText('오늘의 일기').setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph(fmt_(day, 'yyyy년 M월 d일'));
  }
  paragraphs.forEach(p => body.appendParagraph(p).setHeading(DocumentApp.ParagraphHeading.NORMAL));
  if (footer) body.appendParagraph(footer).setHeading(DocumentApp.ParagraphHeading.NORMAL).editAsText().setItalic(true);
  doc.saveAndClose();
  return doc.getUrl();
}

/** 내 드라이브의 일기 폴더(없으면 만든다). 새로 만든 문서·폴더는 공유하지 않는 한 나만 볼 수 있다. */
function diaryFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(CONFIG.DIARY_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(CONFIG.DIARY_FOLDER);
}

/** tick에서 호출: 밤 알림, 오래 멈춘 일기 모드 자동 정리 */
function diaryTick_(now) {
  if (CONFIG.DIARY_REMIND_TIME && isDue_('DIARY', CONFIG.DIARY_REMIND_TIME, now) && !diaryState_()) {
    notify_({
      title: '오늘 하루 어땠어요?',
      message: '자기 전에 말로 일기를 남겨 보세요. 정리해서 드라이브에 저장해 드릴게요.',
      priority: 3,
      actions: [{ label: '🎙 일기 쓰기', data: 'dy:start' }],
    });
  }
  const st = diaryState_();
  if (st && Date.now() - st.lastAt > DIARY_IDLE_FINISH_MIN * 60000) {
    if (st.parts.length) finishDiary_();
    else props_().deleteProperty('DIARY');
  }
}

function diaryCallback_(cq) {
  const [, action, id] = String(cq.data).split(':');
  tg_('answerCallbackQuery', { callback_query_id: cq.id });
  if (cq.message) {
    tg_('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
                                    reply_markup: { inline_keyboard: [] } });
  }
  if (action === 'start') startDiary_();
  else if (action === 'done') finishDiary_();
  else if (action === 'cancel') cancelDiary_();
  else if (action === 'tasks') onIdea_('add', id);
}
