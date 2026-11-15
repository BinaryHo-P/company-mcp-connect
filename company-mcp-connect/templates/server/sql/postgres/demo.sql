-- ─────────────────────────────────────────────────────────────────────────────
-- 가상 회사 「새봄인테리어」 데모 DB — PostgreSQL
-- 모든 이름·전화·주소는 지어낸 것이다. 실제 회사에서는 app 스키마 대신 회사의 기존 표가 있고,
-- 여기서 할 일은 아래 ②~④(뷰·함수·권한 축소 롤)를 회사 표에 맞춰 만드는 것뿐이다.
--
-- 실행(관리자 계정으로, 시험용 DB 에서):  psql "postgres://관리자@localhost:5432/saebom" -f demo.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ① 원본 표 (회사에 이미 있는 것이라고 생각한다)
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.customer (
  id          serial PRIMARY KEY,
  code        text UNIQUE NOT NULL,          -- C0001
  name        text NOT NULL,
  phone       text,                          -- ⛔ AI 에 보여 주지 않는다
  email       text,                          -- ⛔
  address     text,                          -- ⛔
  created_at  date NOT NULL DEFAULT current_date
);

CREATE TABLE app.project (
  id           serial PRIMARY KEY,
  code         text UNIQUE NOT NULL,         -- P2026-001
  customer_id  int NOT NULL REFERENCES app.customer(id),
  site_name    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('견적', '계약', '시공', '완료')),
  confidential boolean NOT NULL DEFAULT false, -- 계약 전 비공개 견적
  amount       bigint,                       -- ⛔ 공사 금액은 AI 에 보여 주지 않기로 했다
  start_date   date,
  end_date     date,
  manager      text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.deadline (
  id          serial PRIMARY KEY,
  project_id  int NOT NULL REFERENCES app.project(id),
  title       text NOT NULL,
  kind        text NOT NULL,                 -- 계약 · 자재 · 시공 · 검수
  due_date    date NOT NULL,
  done        boolean NOT NULL DEFAULT false
);

-- 가상 데이터 (날짜는 오늘 기준으로 잡아 언제 실행해도 "다가오는 일정"이 보이게 했다)
INSERT INTO app.customer (code, name, phone, email, address, created_at) VALUES
  ('C0001', '김하늘', '010-0000-0001', 'sky@example.com',   '가상시 가상구 1', current_date - 400),
  ('C0002', '이도윤', '010-0000-0002', 'doyun@example.com', '가상시 가상구 2', current_date - 200),
  ('C0003', '(주)푸른상사', '02-000-0003', 'office@example.com', '가상시 가상구 3', current_date - 90),
  ('C0004', '박서준', '010-0000-0004', 'sj@example.com',    '가상시 가상구 4', current_date - 10);

INSERT INTO app.project (code, customer_id, site_name, status, confidential, amount, start_date, end_date, manager) VALUES
  ('P' || to_char(current_date, 'YYYY') || '-001', 1, '햇살마을 아파트 302호 전체 리모델링', '완료', false, 48000000, current_date - 120, current_date - 60, '최현장'),
  ('P' || to_char(current_date, 'YYYY') || '-002', 2, '은행나무 빌라 욕실 2곳',             '시공', false, 12000000, current_date - 5,   current_date + 10, '정반장'),
  ('P' || to_char(current_date, 'YYYY') || '-003', 3, '푸른상사 본사 3층 사무실',           '계약', false, 95000000, current_date + 7,   current_date + 40, '최현장'),
  ('P' || to_char(current_date, 'YYYY') || '-004', 3, '푸른상사 신규 지점 (입찰 중)',       '견적', true,  NULL,     NULL,                NULL,              '최현장'),
  ('P' || to_char(current_date, 'YYYY') || '-005', 4, '단풍로 주택 주방',                   '견적', false, NULL,     NULL,                NULL,              '정반장');

INSERT INTO app.deadline (project_id, title, kind, due_date, done) VALUES
  (2, '욕실 방수층 양생 확인', '검수', current_date + 2,  false),
  (2, '타일 자재 발주',         '자재', current_date - 1,  false),   -- 지난 일정(미완료)
  (2, '욕실 공사 준공 검수',    '검수', current_date + 10, false),
  (3, '계약금 입금 확인',       '계약', current_date + 3,  false),
  (3, '천장재·조명 자재 발주',  '자재', current_date + 5,  false),
  (3, '착공 전 현장 실측',      '시공', current_date + 6,  false),
  (1, '1년 하자 점검',          '검수', current_date + 300, false),
  (1, '준공 검수',              '검수', current_date - 60, true);

-- ② AI 전용 창구: mcp 스키마의 뷰. 여기 없는 칸은 AI 가 영영 볼 수 없다.
CREATE SCHEMA IF NOT EXISTS mcp;

CREATE VIEW mcp.v_project AS
SELECT p.code,
       CASE WHEN p.confidential AND p.status = '견적' THEN '(비공개 견적)' ELSE p.site_name END AS site_name,
       c.code AS customer_code,
       c.name AS customer_name,
       p.status, p.start_date, p.end_date, p.manager
  FROM app.project p JOIN app.customer c ON c.id = p.customer_id;
  -- amount(금액)·연락처는 일부러 뺐다

CREATE VIEW mcp.v_customer AS
SELECT c.code, c.name, count(p.id)::int AS project_count, c.created_at AS first_order_date
  FROM app.customer c LEFT JOIN app.project p ON p.customer_id = c.id
 GROUP BY c.id, c.code, c.name, c.created_at;
  -- phone·email·address 없음

CREATE VIEW mcp.v_deadline AS
SELECT p.code AS project_code,
       CASE WHEN p.confidential AND p.status = '견적' THEN '(비공개 견적)' ELSE p.site_name END AS site_name,
       d.title, d.kind, d.due_date,
       (d.due_date - current_date) AS days_left,   -- DB 마다 다른 날짜 계산은 뷰 안에서
       d.done::int AS done                          -- 0/1 로 통일(도구 SQL 을 DB 공통으로 쓰려고)
  FROM app.deadline d JOIN app.project p ON p.id = d.project_id;

-- ③ 쓰기는 표 권한이 아니라 "정해진 함수"로만. 함수가 규칙(고객 확인·번호 매기기·기록자)을 지킨다.
CREATE FUNCTION mcp.peek_next_project_code() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT 'P' || to_char(current_date, 'YYYY') || '-' ||
         lpad((coalesce(max(substring(code from '-(\d+)$')::int), 0) + 1)::text, 3, '0')
    FROM app.project WHERE code LIKE 'P' || to_char(current_date, 'YYYY') || '-%';
$$;

CREATE FUNCTION mcp.create_project(p_customer text, p_site text, p_start date, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_customer int;
  v_code text;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION '기록자(actor)가 없다 — 등록하지 않는다';
  END IF;
  SELECT id INTO v_customer FROM app.customer WHERE code = upper(p_customer);
  IF v_customer IS NULL THEN
    RAISE EXCEPTION '고객 코드 % 가 없다 — 등록하지 않는다', p_customer;
  END IF;
  LOCK TABLE app.project IN SHARE ROW EXCLUSIVE MODE;   -- 동시에 두 건이 같은 번호를 받지 않게
  v_code := mcp.peek_next_project_code();
  INSERT INTO app.project (code, customer_id, site_name, status, start_date, created_by)
  VALUES (v_code, v_customer, p_site, '견적', p_start, p_actor);
  RETURN v_code;
END $$;

-- ④ 권한 축소 롤: mcp 스키마의 뷰 읽기 + 정해진 함수 실행만. app 스키마는 아예 못 들어간다.
--    ⛔ 아래 비밀번호는 데모용이다. 실제로는 클라우드 IAM 인증을 쓰거나(references/adapters.md), 긴 무작위 값으로 바꾼다.
CREATE ROLE mcp_reader LOGIN PASSWORD 'demo-only-change-me' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA mcp TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA mcp TO mcp_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mcp.peek_next_project_code() TO mcp_reader;
-- 쓰기를 허용하기로 했을 때만:
GRANT EXECUTE ON FUNCTION mcp.create_project(text, text, date, text) TO mcp_reader;
