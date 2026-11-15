import type { DbKind } from "../config.js";

/**
 * DB 어댑터 공통 모양. 도구(tools.ts)는 이것만 본다.
 *
 * SQL 은 어느 DB 든 `$1, $2 …` 자리표시자로 쓴다. 어댑터가 MySQL 은 `?`, SQL Server 는 `@p1` 로 바꾼다.
 * 그래서 SQL 문자열 안에 `$` 문자를 직접 쓰지 않는다.
 * DB 마다 문법이 다른 부분(날짜 계산 등)은 도구가 아니라 "뷰" 안에 넣는다 — 뷰는 DB 별로 따로 만든다.
 */
export interface Db {
  kind: DbKind;
  /** 행 목록을 돌려준다. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** `ORDER BY` 뒤에 붙일 개수 제한 절. n 은 자리표시자 번호. 예: limit(2) → "LIMIT $2" */
  limit(n: number): string;
  /** DB 가 인증한 접속 계정 이름 */
  currentUser(): Promise<string>;
  /**
   * 접속 계정이 "권한 축소 롤"인지 확인한다. 관리자·소유자·쓰기 권한이 보이면 예외를 던져 서버가 뜨지 않게 한다.
   * probe 를 주면 그 원본 표가 실제로 "권한 없음"으로 막히는지도 확인한다.
   */
  assertLeastPrivilege(probe: string | null): Promise<string>;
  close(): Promise<void>;
}

/** 선택 설치 패키지를 불러온다. 없으면 무엇을 설치해야 하는지 알려 준다. */
export async function optional<T = any>(pkg: string, why: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(`${why} 에는 패키지 ${pkg} 가 필요하다: npm install ${pkg}`);
    }
    throw e;
  }
}

/** `$1` 자리표시자를 다른 DB 문법으로 바꾼다. 같은 번호가 여러 번 나와도 값 순서를 맞춘다. */
export function positional(sql: string, params: unknown[], mark: (i: number) => string): { sql: string; params: unknown[] } {
  const out: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_m, d: string) => {
    const i = Number(d) - 1;
    if (i < 0 || i >= params.length) throw new Error(`SQL 자리표시자 $${d} 에 해당하는 값이 없다.`);
    out.push(params[i]);
    return mark(out.length);
  });
  return { sql: text, params: out };
}

export class LeastPrivilegeError extends Error {}
