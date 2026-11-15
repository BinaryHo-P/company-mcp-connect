import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 감사 로그. 도구 호출마다 두 줄(CALL·RESULT)을 JSON Lines 파일에 남긴다.
 * "누가, 언제, 어떤 도구를, 무슨 조건으로 불렀고, 몇 건이 나갔는가"를 나중에 확인하기 위한 것이다.
 *
 * 결과 본문(고객 정보 등)은 적지 않는다 — 로그 파일이 또 하나의 유출 경로가 되지 않게.
 * 회사가 DB 에 감사 표를 두는 편이 낫다면 write() 를 DB 함수 호출로 바꾼다(references/security-checklist.md D-2).
 */
export interface AuditRow {
  tool: string;
  phase: "CALL" | "RESULT";
  input: Record<string, unknown>;
  outcome?: "OK" | "EMPTY" | "DENIED" | "ERROR";
  rows?: number;
  ms?: number;
  error?: string;
}

/** 입력값 중 이 이름의 칸은 로그에 *** 로 남긴다. */
const SECRET_KEYS = /pass|token|secret|key|주민|계좌/i;

export class AuditLog {
  private ready: Promise<unknown>;

  constructor(private readonly file: string, private readonly actor: string | null) {
    this.ready = mkdir(dirname(file), { recursive: true, mode: 0o700 });
  }

  async write(row: AuditRow): Promise<void> {
    const input = Object.fromEntries(
      Object.entries(row.input).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "***" : v]),
    );
    const line = JSON.stringify({ at: new Date().toISOString(), actor: this.actor, ...row, input });
    try {
      await this.ready;
      await appendFile(this.file, line + "\n", { mode: 0o600 });
    } catch (e) {
      /* 로그를 못 쓰면 조용히 넘어가지 않고 stderr 에 알린다. 회사 방침상 "로그 없으면 차단"이면 여기서 throw 한다. */
      console.error("[audit] 감사 로그 기록 실패:", e instanceof Error ? e.message : e);
    }
  }
}
