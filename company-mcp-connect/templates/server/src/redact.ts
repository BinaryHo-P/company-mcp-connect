/**
 * 결과 가림 — "두 번째 겹".
 *
 * 첫 번째 겹은 DB 뷰다: 연락처 칸을 뷰에 넣지 않고, 비공개 건의 이름은 뷰에서 가린다.
 * 여기서는 그 뷰가 실수로 바뀌어도 새 나가지 않게 한 번 더 거른다.
 *  ① 칸 이름이 연락처처럼 생겼으면 칸을 통째로 뺀다.
 *  ② 글자 안에 이메일·전화번호가 섞여 있으면 가린다.
 * 회사마다 가릴 칸이 다르면 CONTACT_KEYS 에 더한다.
 */
const CONTACT_KEYS = /(phone|mobile|tel|fax|email|e_mail|address|addr|zip|ssn|birth|account_no|연락처|전화|휴대|팩스|메일|주소|우편|주민|생년|계좌)/i;
const EMAIL_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/* 국내 휴대폰·지역번호(0으로 시작)·대표번호(15xx-xxxx, 구분자 필수) 꼴. 날짜(2026-11-12)·금액(18000000)은 걸리지 않게 좁혔다. */
const PHONE_TEXT = /(?<![\d-])(0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|1[568]\d{2}-\d{4})(?![\d-])/g;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(EMAIL_TEXT, "[이메일 가림]").replace(PHONE_TEXT, "[전화 가림]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !CONTACT_KEYS.test(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}
