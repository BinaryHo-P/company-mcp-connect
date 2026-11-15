import { readFileSync } from "node:fs";
import pg from "pg";
import type { DbConfig } from "../config.js";
import { LeastPrivilegeError, optional, type Db } from "./types.js";

/**
 * PostgreSQL 어댑터. 인증 네 가지:
 *  - password : MCP_DB_URL (로컬 또는 사내 서버의 권한 축소 롤)
 *  - gcp-iam  : Cloud SQL 커넥터 + Google 계정(ADC). 비밀번호·프록시·열린 포트가 없다.
 *  - aws-iam  : RDS IAM 토큰(15분짜리)을 비밀번호 자리에 넣는다. 접속마다 새로 받는다.
 *  - azure-ad : Entra ID 토큰을 비밀번호 자리에 넣는다(Azure Database for PostgreSQL).
 */
export async function connectPostgres(cfg: DbConfig): Promise<Db> {
  /* DATE 를 JS Date 로 바꾸면 시간대 때문에 하루가 밀린다(한국 자정 → UTC 전날). 글자 그대로 받는다. */
  pg.types.setTypeParser(1082, (v: string) => v);
  let pool: pg.Pool;
  let cleanup: () => void = () => {};

  if (cfg.auth === "password") {
    pool = new pg.Pool({ connectionString: cfg.url, max: 4 });
  } else if (cfg.auth === "gcp-iam") {
    const { Connector, AuthTypes, IpAddressTypes } = await optional(
      "@google-cloud/cloud-sql-connector", "GCP IAM 인증(Cloud SQL)",
    );
    const connector = new Connector();
    let opts;
    try {
      opts = await connector.getOptions({
        instanceConnectionName: cfg.gcpInstance,
        ipType: IpAddressTypes[cfg.gcpIpType ?? "PUBLIC"],
        authType: AuthTypes.IAM,
      });
    } catch (e) {
      connector.close();
      throw new Error(
        `Cloud SQL 커넥터 초기화 실패 — ${e instanceof Error ? e.message : e}\n` +
          "  · 로그인이 없으면: gcloud auth application-default login\n" +
          "  · 권한이 없으면: 그 계정에 roles/cloudsql.client + roles/cloudsql.instanceUser",
      );
    }
    pool = new pg.Pool({ ...opts, user: cfg.user, database: cfg.database, max: 4 });
    cleanup = () => connector.close();
  } else if (cfg.auth === "aws-iam") {
    const { Signer } = await optional("@aws-sdk/rds-signer", "AWS IAM 인증(RDS)");
    const signer = new Signer({ hostname: cfg.host, port: cfg.port, username: cfg.user, region: cfg.awsRegion });
    pool = new pg.Pool({
      host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, max: 4,
      password: () => signer.getAuthToken(),
      ssl: { rejectUnauthorized: true, ca: readFileSync(cfg.sslCaFile!, "utf8") },
    });
  } else {
    const { DefaultAzureCredential } = await optional("@azure/identity", "Azure AD(Entra ID) 인증");
    const cred = new DefaultAzureCredential();
    pool = new pg.Pool({
      host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, max: 4,
      password: async () => (await cred.getToken("https://ossrdbms-aad.database.windows.net/.default")).token,
      ssl: { rejectUnauthorized: true },
    });
  }

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool.query(sql, params)).rows as T[];

  return {
    kind: "postgres",
    query,
    limit: (n) => `LIMIT $${n}`,
    currentUser: async () => (await query<{ u: string }>("SELECT current_user AS u"))[0]!.u,

    async assertLeastPrivilege(probe) {
      const [me] = await query<{
        u: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean;
      }>(
        `SELECT current_user AS u, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
           FROM pg_roles WHERE rolname = current_user`,
      );
      if (!me) throw new LeastPrivilegeError("접속 롤 정보를 읽지 못했다.");
      const bad: string[] = [];
      if (me.rolsuper) bad.push("슈퍼유저");
      if (me.rolbypassrls) bad.push("BYPASSRLS(행 보안 무시)");
      if (me.rolcreaterole) bad.push("CREATEROLE");
      if (me.rolcreatedb) bad.push("CREATEDB");

      /* 클라우드 관리자 묶음, 전체 읽기·쓰기 묶음에 속해 있으면 뷰로 가린 것이 소용없다. */
      const admin = await query<{ rolname: string }>(
        `SELECT r.rolname FROM pg_roles r
          WHERE r.rolname IN ('cloudsqlsuperuser','rds_superuser','azure_pg_admin','pg_read_all_data','pg_write_all_data')
            AND pg_has_role(current_user, r.oid, 'MEMBER')`,
      );
      bad.push(...admin.map((r) => `관리 묶음 ${r.rolname}`));

      /* 표를 소유하면 GRANT 와 상관없이 다 읽고 고친다. */
      const owned = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
          WHERE c.relkind IN ('r','p') AND s.nspname NOT IN ('pg_catalog','information_schema')
            AND pg_has_role(current_user, c.relowner, 'USAGE')`,
      );
      if (Number(owned[0]?.n) > 0) bad.push(`표 ${owned[0]!.n}개의 소유자`);

      /* 쓰기는 DB 함수(SECURITY DEFINER)로만 한다. 롤이 표를 직접 고칠 수 있으면 거절한다. */
      const writes = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.role_table_grants
          WHERE grantee IN (SELECT rolname FROM pg_roles WHERE pg_has_role(current_user, oid, 'USAGE'))
            AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`,
      );
      if (Number(writes[0]?.n) > 0) bad.push(`표 직접 쓰기 권한 ${writes[0]!.n}건`);

      if (bad.length) {
        throw new LeastPrivilegeError(
          `접속 롤 ${me.u} 은(는) 권한 축소 롤이 아니다: ${bad.join(", ")}. 서버를 띄우지 않는다.`,
        );
      }

      if (probe) {
        /* 스키마 접근 권한이 없으면 "없는 표"도 permission denied 로 온다. 표가 실제로 있는지 카탈로그(누구나 읽음)로 먼저 확인한다. */
        const [schema, table] = probe.includes(".") ? probe.split(".") : ["public", probe];
        const exists = await query(
          `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
          [schema, table],
        );
        if (!exists.length) throw new LeastPrivilegeError(`격리 확인용 표 ${probe} 가 없다. MCP_ISOLATION_PROBE 를 고친다.`);
        try {
          await query(`SELECT 1 FROM ${probe} WHERE 1 = 0`);
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "42501") return me.u; // permission denied — 기대한 결과
          if (code === "42P01") throw new LeastPrivilegeError(`격리 확인용 표 ${probe} 가 없다. MCP_ISOLATION_PROBE 를 고친다.`);
          throw e;
        }
        throw new LeastPrivilegeError(`접속 롤 ${me.u} 이(가) 원본 표 ${probe} 를 읽을 수 있다. 뷰만 열어야 한다.`);
      }
      return me.u;
    },

    async close() {
      await pool.end();
      cleanup();
    },
  };
}
