import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 쓰기 중복 방지 원장.
 *
 * "등록" 같은 쓰기는 두 번 부르면 두 건이 생긴다. Claude 는 응답이 늦거나 오류가 나면 같은 호출을 다시 할 수 있다.
 * 그래서 쓰기 "전에" 입력값의 지문(해시)으로 파일을 배타적으로 만든다(flag "wx").
 * Claude 창을 여러 개 띄워 서버가 여러 개 떠도 파일 시스템이 한 건만 통과시킨다.
 *
 * 파일에는 지문·상태·결과 번호·시각만 적는다. 고객명 같은 내용은 넣지 않는다.
 */
export type LedgerStatus = "IN_PROGRESS" | "DONE" | "UNKNOWN";

export interface LedgerEntry {
  status: LedgerStatus;
  ref: string | null;
  at: string | null;
}

export type Claim = { claimed: true; key: string } | { claimed: false; prior: LedgerEntry };

/** 같은 뜻의 입력이 같은 지문이 되도록 정리해서 해시한다(대소문자·공백·순서). */
export function digest(kind: string, fields: Record<string, unknown>): string {
  const canon = JSON.stringify([
    kind,
    Object.keys(fields).sort().map((k) => [k, typeof fields[k] === "string" ? (fields[k] as string).trim() : fields[k]]),
  ]);
  return createHash("sha256").update(canon).digest("hex");
}

export class WriteLedger {
  private readonly dir: string;

  constructor(stateDir: string, name: string) {
    this.dir = join(stateDir, "ledger", name);
  }

  private file(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private row(status: LedgerStatus, ref: string | null): string {
    return JSON.stringify({ status, ref, at: new Date().toISOString() } satisfies LedgerEntry);
  }

  /** allowDuplicate 면 기존 기록을 두고 새 칸으로 통과한다(사용자가 "별개 건"이라고 확인했을 때만). */
  async claim(hash: string, allowDuplicate = false): Promise<Claim> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = allowDuplicate ? `${hash}.${randomUUID()}` : hash;
    try {
      await writeFile(this.file(key), this.row("IN_PROGRESS", null), { flag: "wx", mode: 0o600 });
      return { claimed: true, key };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      return { claimed: false, prior: JSON.parse(await readFile(this.file(key), "utf8")) as LedgerEntry };
    } catch {
      return { claimed: false, prior: { status: "IN_PROGRESS", ref: null, at: null } };
    }
  }

  async done(key: string, ref: string): Promise<void> {
    await writeFile(this.file(key), this.row("DONE", ref), { mode: 0o600 });
  }

  /** 오류로 끝나 실제로 들어갔는지 모른다. 사람이 확인하기 전에는 다시 부르지 못하게 남긴다. */
  async unknown(key: string): Promise<void> {
    await writeFile(this.file(key), this.row("UNKNOWN", null), { mode: 0o600 });
  }

  /** DB 가 거절해 아무것도 생기지 않았다. 고쳐서 다시 부를 수 있게 지운다. */
  async release(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}
