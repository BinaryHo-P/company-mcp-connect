/**
 * ⛔ main.ts 의 "첫 import" 여야 한다. 다른 모듈이 읽히기 전에 돌아야 뜻이 있다.
 *
 * ① stdout 은 MCP 통신 전용이다. 어디선가 console.log 한 줄만 찍혀도 Claude 와의 연결이 깨진다.
 *    로그는 전부 stderr 로 돌린다.
 * ② 서버가 쓰지 않는 환경변수(다른 DB 주소, 결제·메일·AI 서비스 키 등)는 지운다.
 *    .env 를 통째로 읽혀도 이 서버 안에서는 쓸 수 없게 하려는 것이다.
 *    "지울 것"을 나열하면 빠뜨리기 쉬우므로 "남길 것"만 나열한다(허용 목록).
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

/** 이 서버 설정(MCP_*)과 OS·클라우드 로그인 도구가 쓰는 최소한의 변수만 남긴다. */
const KEEP_PREFIXES = ["MCP_", "NODE_", "LC_"];
const KEEP_EXACT = new Set([
  // OS 기본
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR", "TEMP", "TMP",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PROGRAMDATA",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "XDG_CONFIG_HOME",
  // 사내 프록시·인증서
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE",
  // GCP — 로그인 정보(ADC) 위치만. 키 파일 경로를 쓰는 회사만 GOOGLE_APPLICATION_CREDENTIALS 를 쓴다.
  "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  // AWS — 프로필·지역만. 액세스 키(AWS_ACCESS_KEY_ID 등)는 남기지 않는다: SSO 프로필 로그인을 쓴다.
  "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  // Azure — 테넌트·클라이언트 지정만(az login 세션을 쓴다)
  "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_AUTHORITY_HOST",
]);

/** 회사 사정상 꼭 더 남겨야 하는 변수는 MCP_KEEP_ENV=이름1,이름2 로 적는다. */
const extra = new Set(
  (process.env.MCP_KEEP_ENV ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
);

for (const key of Object.keys(process.env)) {
  const k = key.toUpperCase();
  if (KEEP_EXACT.has(k) || extra.has(k) || KEEP_PREFIXES.some((p) => k.startsWith(p))) continue;
  delete process.env[key];
}

export {};
