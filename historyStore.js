'use strict';
/**
 * 중앙 학습 기록 저장소 (Supabase).
 *
 * 지금까지는 학습 기록이 각자 브라우저의 localStorage에만 남아서, 개발자가
 * 여러 참가자의 데이터를 모아 볼 방법이 없었다. 이 모듈은 진단 결과(점수,
 * 오류 유형)와 실제 녹음 파일을 Supabase(Postgres + Storage)에 중앙 저장해서,
 * 기획서 0-B.3/0-B.4에서 필요로 하는 "여러 참가자 데이터를 모아서 분석"을
 * 가능하게 한다.
 *
 * 사전 준비 (Supabase 대시보드에서 1회):
 * 1) SQL Editor에서 아래 테이블 생성:
 *
 *    create table diagnosis_history (
 *      id bigint generated always as identity primary key,
 *      user_id text not null,
 *      mode text not null,
 *      sentence text not null,
 *      category text,
 *      lang text,
 *      overall jsonb,
 *      rule_hits jsonb,
 *      audio_path text,
 *      created_at timestamptz default now()
 *    );
 *
 * 2) Storage에서 'recordings'라는 이름의 버킷 생성 (Public 여부는 선택 —
 *    비공개로 두고 서버에서만 접근해도 충분하다).
 */

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
function getClient() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 필요합니다.');
  }
  supabase = createClient(url, key);
  return supabase;
}

/**
 * 녹음 파일을 Storage에 올리고, 진단 메타데이터를 DB에 저장한다.
 * audioBuffer가 없으면(예: 업로드 실패) audio_path 없이 메타데이터만 저장한다.
 */
async function saveHistoryRecord({ userId, mode, sentence, category, lang, overall, ruleHits, audioBuffer }) {
  const client = getClient();

  let audioPath = null;
  if (audioBuffer) {
    const fileName = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`;
    const { error: uploadError } = await client.storage
      .from('recordings')
      .upload(fileName, audioBuffer, { contentType: 'audio/wav' });
    if (uploadError) {
      console.error('녹음 업로드 실패(메타데이터는 계속 저장):', uploadError.message);
    } else {
      audioPath = fileName;
    }
  }

  const { error: insertError } = await client.from('diagnosis_history').insert({
    user_id: userId,
    mode,
    sentence,
    category: category || null,
    lang: lang || null,
    overall: overall || {},
    rule_hits: ruleHits || [],
    audio_path: audioPath,
  });
  if (insertError) throw new Error('기록 저장 실패: ' + insertError.message);

  return { audioPath };
}

/**
 * 특정 계정(userId)의 전체 학습 기록을 시간순으로 가져온다.
 * 주의: 지금은 요청자가 진짜 그 userId의 주인인지 서버가 별도로 검증하지 않는다
 * (Supabase 세션 토큰 검증 없이 query param만 신뢰). 소규모 파일럿에서는
 * 위험이 낮지만, 더 넓게 배포하기 전에는 인증 토큰 검증을 추가하는 걸 권장한다.
 */
async function fetchHistoryForUser(userId) {
  const client = getClient();
  const { data, error } = await client
    .from('diagnosis_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error('기록 조회 실패: ' + error.message);
  return data;
}

module.exports = { saveHistoryRecord, fetchHistoryForUser };
