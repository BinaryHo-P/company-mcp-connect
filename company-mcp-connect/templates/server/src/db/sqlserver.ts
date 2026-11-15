import type { DbConfig } from "../config.js";
import { LeastPrivilegeError, optional, positional, type Db } from "./types.js";

/**
 * SQL Server 어댑터(npm install mssql). 인증 두 가지:
 *  - password : MCP_DB_URL = mssql://사용자:비밀번호@호스트:1433/DB이름  (사내 서버의 권한 축소 로그인)
 *  - azure-ad : Azure SQL. az login 한 계정(DefaultAzureCredential)으로 붙는다. 비밀번호 없음.
 * GCP·AWS 의 SQL Server 는 IAM DB 로그인을 지원하지 않으므로 config.ts 에서 미리 막는다.
 */
export async function connectSqlServer(cfg: DbConfig): Promise<Db> {
  const mssql = (await optional("mssql", "SQL Server 연결")).default;

  let config: Record<string, unknown>;
  if (cfg.auth === "password") {
    const u = new URL(cfg.url!);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
    config = {
      server: u.hostname, port: Number(u.port || 1433),
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
      /* 로컬 시험용 컨테이너만 자체 서명 인증서를 받아 준다. 원격은 정식 인증서로 검증한다. */
      options: { encrypt: true, trustServerCertificate: local },
    };
  } else {
    config = {
      server: cfg.host, port: cfg.port, database: cfg.database,
      authentication: { type: "azure-active-directory-default", options: {} },
      options: { encrypt: true },
    };
  }
  const pool = await new mssql.ConnectionPool({ ...config, pool: { max: 4 } }).connect();

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const p = positional(sql, params, (i) => `@p${i}`);
    const req = pool.request();
    p.params.forEach((v, i) => req.input(`p${i + 1}`, v));
    return (await req.query(p.sql)).recordset as T[];
  };

  const currentUser = async (): Promise<string> =>
    (await query<{ u: string }>("SELECT SUSER_SNAME() AS u"))[0]!.u;

  return {
    kind: "sqlserver",
    query,
    /* SQL Server 는 LIMIT 이 없다. ORDER BY 뒤에 OFFSET/FETCH 를 붙인다. */
    limit: (n) => `OFFSET 0 ROWS FETCH NEXT $${n} ROWS ONLY`,
    currentUser,

    async assertLeastPrivilege(probe) {
      const who = await currentUser();
      const [r] = await query<Record<string, number | null>>(
        `SELECT IS_SRVROLEMEMBER('sysadmin') AS sa, IS_MEMBER('db_owner') AS owner,
                IS_MEMBER('db_datawriter') AS writer, IS_MEMBER('db_ddladmin') AS ddl,
                IS_MEMBER('db_securityadmin') AS sec,
                HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL') AS control`,
      );
      const bad = Object.entries({
        sa: "sysadmin", owner: "db_owner", writer: "db_datawriter", ddl: "db_ddladmin",
        sec: "db_securityadmin", control: "DB CONTROL",
      }).filter(([k]) => r?.[k] === 1).map(([, label]) => label);
      if (bad.length) {
        throw new LeastPrivilegeError(`접속 로그인 ${who} 은(는) 권한 축소 계정이 아니다: ${bad.join(", ")}. 서버를 띄우지 않는다.`);
      }
      if (probe) {
        try {
          await query(`SELECT 1 FROM ${probe} WHERE 1 = 0`);
        } catch (e) {
          const num = (e as { number?: number; originalError?: { info?: { number?: number } } });
          const n = num.number ?? num.originalError?.info?.number;
          if (n === 229) return who; // permission denied — 기대한 결과
          /* 권한이 없으면 표가 "없는 것처럼"(208) 보일 수도 있다(메타데이터 가시성). 그래서 208 은 관리자 확인을 요구한다. */
          if (n === 208) throw new LeastPrivilegeError(`격리 확인용 표 ${probe} 가 없다. MCP_ISOLATION_PROBE 를 고친다.`);
          throw e;
        }
        throw new LeastPrivilegeError(`접속 로그인 ${who} 이(가) 원본 표 ${probe} 를 읽을 수 있다. 뷰만 열어야 한다.`);
      }
      return who;
    },

    async close() {
      await pool.close();
    },
  };
}
