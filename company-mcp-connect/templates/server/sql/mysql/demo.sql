-- ─────────────────────────────────────────────────────────────────────────────
-- 가상 회사 「새봄인테리어」 데모 DB — MySQL 8
-- MySQL 에는 스키마가 따로 없어서 "DB" 둘로 나눈다: app(원본 표) / mcp(AI 전용 뷰·함수).
-- 모든 이름·전화·주소는 지어낸 것이다.
--
-- 실행(관리자 계정으로, 시험용 서버에서):  mysql -u root -p < demo.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ① 원본 표
CREATE DATABASE IF NOT EXISTS app CHARACTER SET utf8mb4;
USE app;

CREATE TABLE customer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(30), email VARCHAR(100), address VARCHAR(200),   -- ⛔ AI 에 보여 주지 않는다
  created_at DATE NOT NULL
);

CREATE TABLE project (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  customer_id INT NOT NULL,
  site_name VARCHAR(200) NOT NULL,
  status VARCHAR(10) NOT NULL,
  confidential TINYINT NOT NULL DEFAULT 0,
  amount BIGINT,                                                   -- ⛔
  start_date DATE, end_date DATE, manager VARCHAR(50), created_by VARCHAR(100),
  CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customer(id),
  CONSTRAINT ck_status CHECK (status IN ('견적', '계약', '시공', '완료'))
);

CREATE TABLE deadline (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  kind VARCHAR(10) NOT NULL,
  due_date DATE NOT NULL,
  done TINYINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES project(id)
);

INSERT INTO customer (code, name, phone, email, address, created_at) VALUES
  ('C0001', '김하늘', '010-0000-0001', 'sky@example.com',   '가상시 가상구 1', CURDATE() - INTERVAL 400 DAY),
  ('C0002', '이도윤', '010-0000-0002', 'doyun@example.com', '가상시 가상구 2', CURDATE() - INTERVAL 200 DAY),
  ('C0003', '(주)푸른상사', '02-000-0003', 'office@example.com', '가상시 가상구 3', CURDATE() - INTERVAL 90 DAY),
  ('C0004', '박서준', '010-0000-0004', 'sj@example.com',    '가상시 가상구 4', CURDATE() - INTERVAL 10 DAY);

SET @y = YEAR(CURDATE());
INSERT INTO project (code, customer_id, site_name, status, confidential, amount, start_date, end_date, manager) VALUES
  (CONCAT('P', @y, '-001'), 1, '햇살마을 아파트 302호 전체 리모델링', '완료', 0, 48000000, CURDATE() - INTERVAL 120 DAY, CURDATE() - INTERVAL 60 DAY, '최현장'),
  (CONCAT('P', @y, '-002'), 2, '은행나무 빌라 욕실 2곳',             '시공', 0, 12000000, CURDATE() - INTERVAL 5 DAY,   CURDATE() + INTERVAL 10 DAY, '정반장'),
  (CONCAT('P', @y, '-003'), 3, '푸른상사 본사 3층 사무실',           '계약', 0, 95000000, CURDATE() + INTERVAL 7 DAY,   CURDATE() + INTERVAL 40 DAY, '최현장'),
  (CONCAT('P', @y, '-004'), 3, '푸른상사 신규 지점 (입찰 중)',       '견적', 1, NULL, NULL, NULL, '최현장'),
  (CONCAT('P', @y, '-005'), 4, '단풍로 주택 주방',                   '견적', 0, NULL, NULL, NULL, '정반장');

INSERT INTO deadline (project_id, title, kind, due_date, done) VALUES
  (2, '욕실 방수층 양생 확인', '검수', CURDATE() + INTERVAL 2 DAY, 0),
  (2, '타일 자재 발주',         '자재', CURDATE() - INTERVAL 1 DAY, 0),
  (2, '욕실 공사 준공 검수',    '검수', CURDATE() + INTERVAL 10 DAY, 0),
  (3, '계약금 입금 확인',       '계약', CURDATE() + INTERVAL 3 DAY, 0),
  (3, '천장재·조명 자재 발주',  '자재', CURDATE() + INTERVAL 5 DAY, 0),
  (3, '착공 전 현장 실측',      '시공', CURDATE() + INTERVAL 6 DAY, 0),
  (1, '1년 하자 점검',          '검수', CURDATE() + INTERVAL 300 DAY, 0),
  (1, '준공 검수',              '검수', CURDATE() - INTERVAL 60 DAY, 1);

-- ② AI 전용 창구: mcp DB 의 뷰(SQL SECURITY DEFINER — 만든 사람 권한으로 원본을 읽는다)
CREATE DATABASE IF NOT EXISTS mcp CHARACTER SET utf8mb4;
USE mcp;

CREATE SQL SECURITY DEFINER VIEW v_project AS
SELECT p.code,
       CASE WHEN p.confidential = 1 AND p.status = '견적' THEN '(비공개 견적)' ELSE p.site_name END AS site_name,
       c.code AS customer_code, c.name AS customer_name,
       p.status, p.start_date, p.end_date, p.manager
  FROM app.project p JOIN app.customer c ON c.id = p.customer_id;

CREATE SQL SECURITY DEFINER VIEW v_customer AS
SELECT c.code, c.name, COUNT(p.id) AS project_count, c.created_at AS first_order_date
  FROM app.customer c LEFT JOIN app.project p ON p.customer_id = c.id
 GROUP BY c.id, c.code, c.name, c.created_at;

CREATE SQL SECURITY DEFINER VIEW v_deadline AS
SELECT p.code AS project_code,
       CASE WHEN p.confidential = 1 AND p.status = '견적' THEN '(비공개 견적)' ELSE p.site_name END AS site_name,
       d.title, d.kind, d.due_date,
       DATEDIFF(d.due_date, CURDATE()) AS days_left,
       d.done
  FROM app.deadline d JOIN app.project p ON p.id = d.project_id;

-- ③ 쓰기는 정해진 함수·프로시저로만
DELIMITER //
CREATE FUNCTION peek_next_project_code() RETURNS VARCHAR(20)
  READS SQL DATA SQL SECURITY DEFINER
BEGIN
  DECLARE n INT;
  SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(code, '-', -1) AS UNSIGNED)), 0) + 1 INTO n
    FROM app.project WHERE code LIKE CONCAT('P', YEAR(CURDATE()), '-%');
  RETURN CONCAT('P', YEAR(CURDATE()), '-', LPAD(n, 3, '0'));
END //

CREATE PROCEDURE create_project(IN p_customer VARCHAR(10), IN p_site VARCHAR(200), IN p_start DATE, IN p_actor VARCHAR(100))
  MODIFIES SQL DATA SQL SECURITY DEFINER
BEGIN
  DECLARE v_customer INT;
  DECLARE v_code VARCHAR(20);
  IF p_actor IS NULL OR p_actor = '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '기록자(actor)가 없다 — 등록하지 않는다';
  END IF;
  SELECT id INTO v_customer FROM app.customer WHERE code = UPPER(p_customer);
  IF v_customer IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '고객 코드가 없다 — 등록하지 않는다';
  END IF;
  IF GET_LOCK('saebom_project_code', 5) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '번호 잠금을 얻지 못했다 — 잠시 뒤 다시';
  END IF;
  SET v_code = peek_next_project_code();
  INSERT INTO app.project (code, customer_id, site_name, status, start_date, created_by)
  VALUES (v_code, v_customer, p_site, '견적', p_start, p_actor);
  DO RELEASE_LOCK('saebom_project_code');
  SELECT v_code AS code;
END //
DELIMITER ;

-- ④ 권한 축소 계정: mcp DB 의 뷰 읽기 + 함수 실행만. app DB 는 권한이 없다.
--    ⛔ 데모용 비밀번호. 실제로는 IAM 인증을 쓰거나 긴 무작위 값으로 바꾼다.
CREATE USER 'mcp_reader'@'%' IDENTIFIED BY 'demo-only-change-me';
GRANT SELECT ON mcp.* TO 'mcp_reader'@'%';
GRANT EXECUTE ON FUNCTION mcp.peek_next_project_code TO 'mcp_reader'@'%';
-- 쓰기를 허용하기로 했을 때만:
GRANT EXECUTE ON PROCEDURE mcp.create_project TO 'mcp_reader'@'%';
