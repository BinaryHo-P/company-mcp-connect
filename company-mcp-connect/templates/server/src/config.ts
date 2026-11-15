import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 환경변수 → 설정. 잘못된 값이면 서버를 띄우지 않는다(조용히 기본값으로 넘어가지 않는다).
 *
 * ⛔ 오류 메시지에 비밀번호가 든 원문을 넣지 않는다. Claude 화면·로그에 그대로 남는다.
 */

export type DbKind = "postgres" | "mysql" | "sqlserver";
export type DbAuth = "password" | "gcp-iam" | "aws-iam" | "azure-ad";
export type StorageKind = "none" | "local" | "gcs" | "s3" | "azure";

export interface DbConfig {
  kind: DbKind;
  auth: DbAuth;
  /** password 인증: 접속 주소(postgres://, mysql://, mssql://). 비밀번호가 들어 있다 — 어디에도 찍지 않는다. */
  url?: string;
  /** 클라우드 인증: 호스트·포트·사용자·DB 이름 */
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  /** gcp-iam: Cloud SQL 인스턴스 연결 이름 project:region:instance */
  gcpInstance?: string;
  gcpIpType?: "PUBLIC" | "PRIVATE" | "PSC";
  /** aws-iam: 지역, RDS 인증서 묶음 파일 */
  awsRegion?: string;
  sslCaFile?: string;
  /** 사람이 읽는 접속 대상 이름. 자격증명은 넣지 않는다. */
  label: string;
}

export interface StorageConfig {
  kind: StorageKind;
  /** local: 폴더 경로 / gcs·s3: 버킷 이름 / azure: 컨테이너 이름 */
  root: string;
  /** 버킷 안에서 이 접두어 아래만 본다(예: manuals/). 로컬은 무시. */
  prefix: string;
  /** 읽어도 되는 확장자 */
  extensions: string[];
  s3Region?: string;
  azureAccountUrl?: string;
}

export interface McpConfig {
  companyName: string;
  db: DbConfig;
  storage: StorageConfig;
  /** 감사 로그·등록자에 남는 사람. 없으면 쓰기 도구를 열 수 없다. */
  actor: string | null;
  writesEnabled: boolean;
  /** 이 롤로 "읽을 수 없어야 하는" 원본 표. 기동할 때 실제로 막히는지 확인한다. */
  isolationProbe: string | null;
  stateDir: string;
  auditLog: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** 쿼리 문자열로 접속지를 몰래 바꾸는 인자(pg 는 ?host= 가 본문 호스트를 덮어쓴다). */
const HOST_OVERRIDES = ["host", "hostaddr", "socket", "socketPath", "server"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const GCP_INSTANCE = /^[a-z][a-z0-9-]*(:[a-z0-9.-]+)?:[a-z0-9-]+:[a-z][a-z0-9-]*$/;

const DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, mysql: 3306, sqlserver: 1433 };
const URL_SCHEMES: Record<DbKind, string[]> = {
  postgres: ["postgres:", "postgresql:"],
  mysql: ["mysql:"],
  sqlserver: ["mssql:", "sqlserver:"],
};

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`${key} 가 비었다.`);
  return v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} 는 ${allowed.join(" | ")} 중 하나다.`);
  }
  return value as T;
}

/** password 인증 주소를 검사한다. 원격 주소는 명시적으로 허락했을 때만 받는다. */
export function checkPasswordUrl(kind: DbKind, raw: string, allowRemote: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("MCP_DB_URL 을 해석하지 못했다(원문은 비밀번호가 있어 표시하지 않는다).");
  }
  if (!URL_SCHEMES[kind].includes(u.protocol)) {
    throw new Error(`MCP_DB_URL 은 ${URL_SCHEMES[kind].join(" 또는 ")} 로 시작해야 한다(MCP_DB_KIND=${kind}).`);
  }
  if (HOST_OVERRIDES.some((k) => u.searchParams.has(k))) {
    throw new Error("MCP_DB_URL 의 쿼리 인자로 접속지를 바꿀 수 없다(host·hostaddr·socket 등).");
  }
  if (!LOCAL_HOSTS.has(u.hostname) && !allowRemote) {
    throw new Error(
      "MCP_DB_URL 이 내 컴퓨터(localhost)가 아니다. 클라우드 DB 는 비밀번호 대신 클라우드 계정 인증" +
        "(MCP_DB_AUTH=gcp-iam | aws-iam | azure-ad)을 쓴다. 사내 서버라 비밀번호 롤밖에 없으면 " +
        "MCP_DB_PASSWORD_REMOTE_OK=1 을 함께 준다(보안 체크리스트 B-4 참고).",
    );
  }
  return `${u.hostname}:${u.port || DEFAULT_PORT[kind]}${u.pathname}`;
}

function loadDb(env: NodeJS.ProcessEnv): DbConfig {
  const kind = oneOf(env.MCP_DB_KIND?.trim() || "postgres", ["postgres", "mysql", "sqlserver"] as const, "MCP_DB_KIND");
  const auth = oneOf(env.MCP_DB_AUTH?.trim() || "password", ["password", "gcp-iam", "aws-iam", "azure-ad"] as const, "MCP_DB_AUTH");

  if (auth === "password") {
    const url = need(env, "MCP_DB_URL");
    const label = checkPasswordUrl(kind, url, env.MCP_DB_PASSWORD_REMOTE_OK === "1");
    return { kind, auth, url, label };
  }

  /* 클라우드 계정 인증이 지원되지 않는 조합은 처음부터 막는다. */
  if (kind === "sqlserver" && auth !== "azure-ad") {
    throw new Error(
      `SQL Server 는 ${auth} DB 로그인을 지원하지 않는다. Azure SQL 이면 azure-ad, 그 밖에는 권한 축소 롤 + password 를 쓴다.`,
    );
  }

  const user = need(env, "MCP_DB_USER");
  const database = need(env, "MCP_DB_NAME");
  if (!IDENT.test(database)) throw new Error("MCP_DB_NAME 이 올바른 DB 이름이 아니다.");

  if (auth === "gcp-iam") {
    const gcpInstance = need(env, "MCP_GCP_INSTANCE");
    if (!GCP_INSTANCE.test(gcpInstance)) throw new Error("MCP_GCP_INSTANCE 는 project:region:instance 꼴이다.");
    const gcpIpType = oneOf(env.MCP_GCP_IP_TYPE?.trim() || "PUBLIC", ["PUBLIC", "PRIVATE", "PSC"] as const, "MCP_GCP_IP_TYPE");
    return { kind, auth, user, database, gcpInstance, gcpIpType, label: `cloudsql:${gcpInstance}/${database}` };
  }

  const host = need(env, "MCP_DB_HOST");
  const port = Number(env.MCP_DB_PORT?.trim() || DEFAULT_PORT[kind]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("MCP_DB_PORT 가 숫자가 아니다.");

  if (auth === "aws-iam") {
    const awsRegion = need(env, "MCP_AWS_REGION");
    const sslCaFile = need(env, "MCP_DB_SSL_CA"); // RDS 인증서 묶음(global-bundle.pem). 없으면 TLS 검증을 못 한다.
    return { kind, auth, host, port, user, database, awsRegion, sslCaFile, label: `rds:${host}/${database}` };
  }
  return { kind, auth, host, port, user, database, label: `azure:${host}/${database}` };
}

function loadStorage(env: NodeJS.ProcessEnv): StorageConfig {
  const kind = oneOf(env.MCP_STORAGE_KIND?.trim() || "none", ["none", "local", "gcs", "s3", "azure"] as const, "MCP_STORAGE_KIND");
  const extensions = (env.MCP_STORAGE_EXT?.trim() || ".md,.txt")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (kind === "none") return { kind, root: "", prefix: "", extensions };
  const root = need(env, "MCP_STORAGE_ROOT");
  const prefix = (env.MCP_STORAGE_PREFIX?.trim() ?? "").replace(/^\/+/, "");
  if (prefix.split("/").includes("..")) throw new Error("MCP_STORAGE_PREFIX 에 .. 을 쓸 수 없다.");
  const cfg: StorageConfig = { kind, root, prefix, extensions };
  if (kind === "s3") cfg.s3Region = need(env, "MCP_S3_REGION");
  if (kind === "azure") cfg.azureAccountUrl = need(env, "MCP_AZURE_ACCOUNT_URL");
  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv, home: string = homedir()): McpConfig {
  const db = loadDb(env);
  const storage = loadStorage(env);

  const actor = env.MCP_ACTOR?.trim() || null;
  if (actor && !EMAIL.test(actor)) throw new Error("MCP_ACTOR 는 이메일 형식이어야 한다.");

  const writesEnabled = env.MCP_ENABLE_WRITES === "1";
  /* 클라우드 계정 인증이면 기록자를 DB 가 확인한 접속 계정에서 받는다(main.ts bindActor). 비밀번호 롤이면 사람 이름이 따로 있어야 한다. */
  if (writesEnabled && !actor && db.auth === "password") {
    throw new Error("MCP_ENABLE_WRITES=1 에는 MCP_ACTOR 가 필요하다 — 누가 했는지 모르는 쓰기는 받지 않는다.");
  }

  const isolationProbe = env.MCP_ISOLATION_PROBE?.trim() || null;
  if (isolationProbe && !IDENT.test(isolationProbe)) throw new Error("MCP_ISOLATION_PROBE 는 schema.table 꼴이다.");

  const stateDir = env.MCP_STATE_DIR?.trim() || join(home, ".local", "state", "company-mcp");
  return {
    companyName: env.MCP_COMPANY_NAME?.trim() || "우리 회사",
    db, storage, actor, writesEnabled, isolationProbe, stateDir,
    auditLog: env.MCP_AUDIT_LOG?.trim() || join(stateDir, "audit.jsonl"),
  };
}

/**
 * 클라우드 계정 인증의 기록자는 DB 가 확인한 접속 계정이다. 환경변수 MCP_ACTOR 는 증명이 아니므로
 * 적었다면 접속 계정과 같아야 한다 — 다른 사람 이름으로 기록을 남기는 길을 막는다.
 */
export function bindActor(config: McpConfig, dbUser: string): McpConfig {
  if (config.db.auth === "password") return config;
  const who = dbUser.trim();
  if (!who) throw new Error("DB 접속 계정 이름을 확인하지 못했다.");
  if (config.actor && config.actor.toLowerCase() !== who.toLowerCase()) {
    throw new Error(`MCP_ACTOR(${config.actor})가 DB 접속 계정(${who})과 다르다. 비우거나 같은 값을 쓴다.`);
  }
  return { ...config, actor: config.actor ?? who };
}
