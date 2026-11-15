import type { DbConfig } from "../config.js";
import type { Db } from "./types.js";

export type { Db } from "./types.js";
export { LeastPrivilegeError } from "./types.js";

/** 설정된 DB 종류의 어댑터만 불러온다(쓰지 않는 DB 드라이버는 설치하지 않아도 된다). */
export async function connectDb(cfg: DbConfig): Promise<Db> {
  switch (cfg.kind) {
    case "postgres":
      return (await import("./postgres.js")).connectPostgres(cfg);
    case "mysql":
      return (await import("./mysql.js")).connectMysql(cfg);
    case "sqlserver":
      return (await import("./sqlserver.js")).connectSqlServer(cfg);
  }
}
