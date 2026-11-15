import { readFileSync } from "node:fs";
import type { DbConfig } from "../config.js";
import { LeastPrivilegeError, optional, positional, type Db } from "./types.js";

/**
 * MySQL 어댑터(npm install mysql2). 인증 네 가지:
 *  - password : MCP_DB_URL
 *  - gcp-iam  : Cloud SQL 커넥터 + Google 계정(ADC)
 *  - aws-iam  : RDS IAM 토큰을 평문 인증 플러그인으로 보낸다(TLS 필수)
 *  - azure-ad : Entra ID 토큰을 평문 인증 플러그인으로 보낸다(Azure Database for MySQL)
 */
export async function connectMysql(cfg: DbConfig): Promise<Db> {
  const mysql = await optional("mysql2/promise", "MySQL 연결");
  const base = { connectionLimit: 4, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
  let pool: any;
  let cleanup: () => void = () => {};

  if (cfg.auth === "password") {
    pool = mysql.createPool({ uri: cfg.url, ...base });
  } else if (cfg.auth === "gcp-iam") {
    const { Connector, AuthTypes, IpAddressTypes } = await optional(
      "@google-cloud/cloud-sql-connector", "GCP IAM 인증(Cloud SQL)",
    );
    const connector = new Connector();
    const opts = await connector.getOptions({
      instanceConnectionName: cfg.gcpInstance,
      ipType: IpAddressTypes[cfg.gcpIpType ?? "PUBLIC"],
      authType: AuthTypes.IAM,
    });
    pool = mysql.createPool({ ...opts, user: cfg.user, database: cfg.database, ...base });
    cleanup = () => connector.close();
  } else {
    let token: () => Promise<string>;
    let ssl: Record<string, unknown>;
    if (cfg.auth === "aws-iam") {
      const { Signer } = await optional("@aws-sdk/rds-signer", "AWS IAM 인증(RDS)");
      const signer = new Signer({ hostname: cfg.host, port: cfg.port, username: cfg.user, region: cfg.awsRegion });
      token = () => signer.getAuthToken();
      ssl = { rejectUnauthorized: true, ca: readFileSync(cfg.sslCaFile!, "utf8") };
    } else {
      const { DefaultAzureCredential } = await optional("@azure/identity", "Azure AD(Entra ID) 인증");
      const cred = new DefaultAzureCredential();
      token = async () => (await cred.getToken("https://ossrdbms-aad.database.windows.net/.default")).token;
      ssl = { rejectUnauthorized: true };
    }
    pool = mysql.createPool({
      host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, ssl, ...base,
      /* 토큰은 접속할 때마다 새로 받는다(만료 15~60분). */
      authPlugins: { mysql_clear_password: () => async () => Buffer.from(`${await token()}\0`) },
    });
  }

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const p = positional(sql, params, () => "?");
    const [rows] = await pool.query(p.sql, p.params);
    /* CALL 은 [결과집합, OK패킷] 배열로 온다 — 첫 결과집합만 돌려준다. */
    if (Array.isArray(rows) && Array.isArray(rows[0])) return rows[0] as T[];
    return (Array.isArray(rows) ? rows : []) as T[];
  };

  const currentUser = async (): Promise<string> => {
    /* CURRENT_USER() 는 'user@host' — 이메일 사용자도 있으니 마지막 @ 앞까지만 쓴다. */
    const [r] = await query<{ u: string }>("SELECT CURRENT_USER() AS u");
    const full = r!.u;
    return full.slice(0, full.lastIndexOf("@"));
  };

  return {
    kind: "mysql",
    query,
    limit: (n) => `LIMIT $${n}`,
    currentUser,

    async assertLeastPrivilege(probe) {
      const who = await currentUser();
      const [role] = await query<{ r: string }>("SELECT CURRENT_ROLE() AS r");
      const grantsSql = role && role.r && role.r !== "NONE"
        ? `SHOW GRANTS FOR CURRENT_USER() USING ${role.r}`
        : "SHOW GRANTS FOR CURRENT_USER()";
      const [rows] = await pool.query(grantsSql);
      const lines = (rows as Record<string, string>[]).map((r) => String(Object.values(r)[0]));

      const bad: string[] = [];
      for (const g of lines) {
        const onAll = / ON \*\.\* /.test(g);
        if (/ALL PRIVILEGES/.test(g)) bad.push("ALL PRIVILEGES");
        if (/WITH GRANT OPTION/.test(g)) bad.push("GRANT OPTION");
        if (/\bSUPER\b/.test(g)) bad.push("SUPER");
        if (onAll && !/^GRANT USAGE ON/.test(g)) bad.push(`서버 전체 권한(${g.slice(6, 60)}…)`);
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(g.split(" ON ")[0] ?? "")) {
          bad.push(`표 직접 쓰기·구조 변경 권한(${g.slice(6, 60)}…)`);
        }
      }
      if (bad.length) {
        throw new LeastPrivilegeError(
          `접속 계정 ${who} 은(는) 권한 축소 계정이 아니다: ${[...new Set(bad)].join(", ")}. 서버를 띄우지 않는다.`,
        );
      }

      if (probe) {
        try {
          await query(`SELECT 1 FROM ${probe} WHERE 1 = 0`);
        } catch (e) {
          const errno = (e as { errno?: number }).errno;
          if (errno === 1142 || errno === 1044) {
            /* MySQL 은 권한 없는 계정에게 "없는 표"도 같은 오류(1142)로 답한다. 이름이 맞는지는 관리자가 따로 확인해야 한다. */
            console.error(`[mcp] 참고: MySQL 은 ${probe} 가 실제로 있는지 이 계정으로 확인할 수 없다. 관리자 계정으로 SHOW TABLES 로 이름을 확인해 둔다.`);
            return who; // 권한 없음 — 기대한 결과
          }
          if (errno === 1146) throw new LeastPrivilegeError(`격리 확인용 표 ${probe} 가 없다. MCP_ISOLATION_PROBE 를 고친다.`);
          throw e;
        }
        throw new LeastPrivilegeError(`접속 계정 ${who} 이(가) 원본 표 ${probe} 를 읽을 수 있다. 뷰만 열어야 한다.`);
      }
      return who;
    },

    async close() {
      await pool.end();
      cleanup();
    },
  };
}
