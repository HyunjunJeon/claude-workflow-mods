# kisa: 소프트웨어 개발보안 가이드, 구현 단계 보안약점

Edition: 행정안전부·한국인터넷진흥원(KISA) 「소프트웨어 개발보안 가이드」 5차 개정판(2021.11, KISA 게시 파일 2021.12.29), 구현 단계 보안약점 제거 기준 7개 유형 49개 항목. Still the latest edition on 2026-10-12. The same 49 items, in the same order, are 별표 3 「소프트웨어 보안약점 기준」 of 「행정기관 및 공공기관 정보시스템 구축·운영 지침」(행정안전부고시 제2025-1호).
Source: https://www.kisa.or.kr/2060204/form?postSeq=5 (guide), https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=2100000252582 (지침 별표 3)
Item names follow the guide's appendix (제5장 제2절); chapter 4 and 별표 3 differ only in spacing.

Cite an item as `kisa <type>-<item> <항목명>`, for example `kisa 1-1 SQL 삽입`.
The CWE column lists the CWEs the guide itself cites for the item (its 참고자료), for cross-reference with `owasp`; one weakness that both guides name is one breach citing both.
The Lens column names the lens node that checks the item; a lens applies only its own rows.
The "Breach when" column is the missing control. An item whose source, sink or control does not appear in the change does not apply.

## 1. 입력데이터 검증 및 표현

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 1-1 | SQL 삽입 | 89 | `injection` | External input reaches a SQL string by concatenation, interpolation or format instead of a bound parameter or a parameterized ORM call. |
| 1-2 | 코드 삽입 | 94, 95 | `injection` | External input reaches `eval`, `Function`, `exec`, a template compiled at runtime, or a dynamic import or class load. |
| 1-3 | 경로 조작 및 자원 삽입 | 99, 22 | `resources` | External input builds a file path, URL path, socket, port or other resource identifier without normalizing it and checking it stays inside an allowed base or allow-list. |
| 1-4 | 크로스사이트 스크립트 | 79 | `injection` | External or stored data is written to HTML, an attribute, JavaScript or a URL without encoding for that context, or through a raw-HTML API (`innerHTML`, `dangerouslySetInnerHTML`, `v-html`, the `safe` filter) without sanitizing. |
| 1-5 | 운영체제 명령어 삽입 | 78 | `injection` | External input reaches a shell command string (`sh -c`, `system`, `exec` with `shell: true`, backticks) instead of an argv list with a fixed program, or an argument is not checked against an allow-list. |
| 1-6 | 위험한 형식 파일 업로드 | 434 | `resources` | An upload is stored or served without checking type by content and extension against an allow-list, limiting size, renaming it, and keeping it outside an executable or web-served path. |
| 1-7 | 신뢰되지 않는 URL 주소로 자동접속 연결 | 601 | `resources` | A redirect or forward target comes from input without checking it against an allow-list of hosts or relative paths. |
| 1-8 | 부적절한 XML 외부 개체 참조 | 611 | `resources` | An XML parser reads external input with DTDs or external entities enabled. |
| 1-9 | XML 삽입 | 652, 643 | `injection` | External input is concatenated into an XPath or XQuery expression or an XML document without parameterizing or escaping it. |
| 1-10 | LDAP 삽입 | 90 | `injection` | External input is concatenated into an LDAP filter or DN without escaping LDAP special characters. |
| 1-11 | 크로스사이트 요청 위조 | 352 | `access` | A state-changing endpoint reached by a browser session accepts the request without a CSRF token, a `SameSite` cookie policy or an origin check. |
| 1-12 | 서버사이드 요청 위조 | 918 | `resources` | The server fetches a URL or host taken from input without an allow-list, and without blocking internal, loopback, link-local and metadata addresses after resolution. |
| 1-13 | HTTP 응답분할 | 113 | `injection` | External input is written into a response header or cookie without removing CR and LF. |
| 1-14 | 정수형 오버플로우 | 190 | `memory` | Arithmetic on an external number that sizes a buffer, an allocation, a loop bound or an index has no range check. |
| 1-15 | 보안기능 결정에 사용되는 부적절한 입력값 | 807 | `access` | An authentication, authorization, price or role decision trusts a client-controlled value (hidden field, cookie, header, request body flag) instead of server-side state. |
| 1-16 | 메모리 버퍼 오버플로우 | 119 | `memory` | A copy, write or index into a fixed buffer is not bounded by the buffer's size (C, C++, unsafe Rust, native bindings). |
| 1-17 | 포맷 스트링 삽입 | 134 | `injection` | External input is used as the format string of a `printf`-style or logging call. |

## 2. 보안기능

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 2-1 | 적절한 인증 없는 중요 기능 허용 | 306 | `access` | A sensitive function (account change, payment, admin action, data export) runs without checking the caller is authenticated, or without re-authentication where the guide requires it. |
| 2-2 | 부적절한 인가 | 285 | `access` | A handler acts on a resource without checking the authenticated user may access that resource (an object id from the request is used as is). |
| 2-3 | 중요한 자원에 대한 잘못된 권한 설정 | 732 | `access` | A file, directory, key, bucket or database object is created world-readable or writable, or with wider permissions than its use needs. |
| 2-4 | 취약한 암호화 알고리즘 사용 | 327 | `crypto` | Code uses DES, 3DES, RC2, RC4, MD5 or SHA-1 for protection, ECB mode, or a home-made cipher. |
| 2-5 | 암호화되지 않은 중요정보 | 312, 319 | `crypto` | Passwords, personal data, tokens or keys are stored or sent in plain text (no encryption at rest, `http://`, unencrypted socket). |
| 2-6 | 하드코드된 중요정보 | 259, 321 | `crypto` | A password, API key, token, private key or encryption key is written in code or committed configuration. |
| 2-7 | 충분하지 않은 키 길이 사용 | 326 | `crypto` | RSA or DH keys under 2048 bits, ECC under 224 bits, or symmetric keys under 128 bits. |
| 2-8 | 적절하지 않은 난수 값 사용 | 330 | `crypto` | A token, session id, password reset code, nonce or key comes from a non-cryptographic generator (`Math.random`, `random.random`, `java.util.Random`, `rand`). |
| 2-9 | 취약한 비밀번호 허용 | 521 | `access` | Setting or changing a password accepts it without a length and complexity rule. |
| 2-10 | 부적절한 전자서명 확인 | 347 | `crypto` | Signed data (JWT, signed package, signed message) is used without verifying its signature, or with `alg: none` or a key the attacker can choose. |
| 2-11 | 부적절한 인증서 유효성 검증 | 295 | `crypto` | TLS certificate or hostname checks are disabled or bypassed (`rejectUnauthorized: false`, `verify=False`, a trust-all manager). |
| 2-12 | 사용자 하드디스크에 저장되는 쿠키를 통한 정보노출 | 539 | `crypto` | A persistent cookie holds personal or session-sensitive data, or a session cookie lacks `Secure` and `HttpOnly`. |
| 2-13 | 주석문 안에 포함된 시스템 주요정보 | 615 | `crypto` | A comment holds a password, key, internal host, account or other system detail. |
| 2-14 | 솔트 없이 일방향 해쉬 함수 사용 | 759 | `crypto` | Passwords are hashed without a per-user random salt, or with a fast hash instead of a password hash (bcrypt, scrypt, Argon2, PBKDF2). |
| 2-15 | 무결성 검사 없는 코드 다운로드 | 494 | `integrity` | Code, plugins or updates are downloaded and run without a checksum or signature check. |
| 2-16 | 반복된 인증시도 제한 기능 부재 | 307 | `access` | A login, OTP or password-reset check has no attempt limit, lockout, delay or rate limit. |

## 3. 시간 및 상태

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 3-1 | 경쟁조건 : 검사 시점과 사용 시점(TOCTOU) | 367 | `memory` | A resource is checked (exists, permission, balance) and then used in a separate step a concurrent actor can change, without a lock, an atomic operation or a transaction. |
| 3-2 | 종료되지 않는 반복문 또는 재귀함수 | 674, 835 | `memory` | A loop or recursion driven by input has no reachable exit or depth bound. |

## 4. 에러처리

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 4-1 | 오류 메시지 정보노출 | 209, 497 | `errors` | An error response or page shows a stack trace, SQL, file path, internal host or version to the client. |
| 4-2 | 오류상황 대응 부재 | 390 | `errors` | An error is caught and ignored (empty `catch`, unchecked return code) where the code then continues as if it succeeded. |
| 4-3 | 부적절한 예외 처리 | 754 | `errors` | A broad catch-all hides failures that need distinct handling, or an exceptional result (null, -1, short read) is not checked before use. |

## 5. 코드오류

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 5-1 | Null Pointer 역참조 | 476 | `memory` | A value that can be null or undefined (lookup miss, optional field, failed call) is dereferenced without a check. |
| 5-2 | 부적절한 자원 해제 | 404 | `memory` | A file, socket, connection, lock or stream is not released on every path, including error paths (no `finally`, `with`, `using`, `defer` or try-with-resources). |
| 5-3 | 해제된 자원 사용 | 416 | `memory` | Memory or a handle is used after it is freed or closed. |
| 5-4 | 초기화되지 않은 변수 사용 | 457 | `memory` | A variable is read before every path assigns it. |
| 5-5 | 신뢰할 수 없는 데이터의 역직렬화 | 502 | `integrity` | Untrusted data is deserialized with a format that can build arbitrary objects (`pickle`, Java native serialization, `yaml.load` without a safe loader, `BinaryFormatter`) or without a type allow-list and integrity check. |

## 6. 캡슐화

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 6-1 | 잘못된 세션에 의한 데이터 정보노출 | 488, 543 | `memory` | Per-user data is kept in shared state (a singleton field, a module-level variable, a static member) that concurrent requests can read. |
| 6-2 | 제거되지 않고 남은 디버그 코드 | 489 | `errors` | Debug endpoints, debug flags, test backdoors or verbose debug output remain in code that ships. |
| 6-3 | Public 메서드부터 반환된 Private 배열 | 495 | `memory` | A public method returns a reference to a private mutable array or collection instead of a copy or read-only view. |
| 6-4 | Private 배열에 Public 데이터 할당 | 496 | `memory` | A public method stores a caller's array or collection in a private field without copying it. |

## 7. API 오용

| id | 항목 | CWE | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 7-1 | DNS lookup에 의존한 보안결정 | 350, 247 | `access` | An access or trust decision uses a host name from DNS or reverse DNS instead of an authenticated identity or an IP checked against an allow-list. |
| 7-2 | 취약한 API 사용 | 676, 242, 246, 382 | `memory` | Code calls an API the platform marks dangerous or deprecated for security (`gets`, `strcpy`, `sprintf`, `mktemp`, `eval`-style loaders) where a safe alternative exists. |
