# owasp: OWASP Top 10 and the CWE Top 25

Edition: OWASP Top 10:2025 (final; the release-candidate label was removed 2025-12-24) and the 2025 CWE Top 25 Most Dangerous Software Weaknesses (MITRE, 2025-12-11). Both are still the latest editions on 2026-10-12.
Source: https://top10.owasp.org/2025/, https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html

Cite an OWASP category as `owasp A<nn> <name>` and a CWE entry as `owasp CWE-<id> <name>`.
When a line breaks a CWE entry that sits under an OWASP category, cite both in one breach: `owasp A05 Injection / CWE-89`.
The Lens column names the lens node that checks the entry; a lens applies only its own rows.
The "Breach when" column is the missing control. An entry whose source, sink or control does not appear in the change does not apply.
Several OWASP categories are about design, configuration or process. Judge them only through what the changed lines add or edit; a missing process (no threat model, no SBOM) is a judgment call, never a breach.

## OWASP Top 10:2025

| id | Category | Lens | Breach when |
| --- | --- | --- | --- |
| A01 | Broken Access Control | `access` | A handler reads or changes a resource without checking on the server that the caller may access that resource or function: an object id from the request used as is, a missing role check, a CORS policy that trusts any origin, or a client-side-only check. SSRF (CWE-918) also sits here. |
| A02 | Security Misconfiguration | `integrity` | The change adds or edits configuration that ships insecure defaults: debug mode on, default credentials, verbose errors to clients, directory listing, permissive CORS or headers, unneeded services or sample apps enabled. |
| A03 | Software Supply Chain Failures | `integrity` | The change adds a dependency, action or image that is unpinned, fetched without integrity checking, taken from an untrusted source, or a version with a known vulnerability; or a build or CI step runs remote code without verifying it. |
| A04 | Cryptographic Failures | `crypto` | Sensitive data is stored or sent without encryption, or protected with a weak algorithm or mode (MD5, SHA-1, DES, RC4, ECB), a hard-coded or short key, a non-cryptographic random source, a fast unsalted password hash, or disabled certificate checks. |
| A05 | Injection | `injection` | External input reaches an interpreter as code instead of data: SQL, NoSQL, OS command, LDAP, XPath, template or expression language, or HTML and JavaScript output without context encoding (XSS). |
| A06 | Insecure Design | `integrity` | The changed code's own logic lacks a control its purpose needs: no rate or quantity limit on a costly or abusable operation, a business rule enforced only on the client, a trust boundary crossed with no check. Missing design process is a judgment call. |
| A07 | Authentication Failures | `access` | Login, session or credential code allows credential stuffing or brute force (no attempt limit), weak passwords, session ids in URLs, sessions not rotated on login or invalidated on logout, or missing multi-factor where the code's own policy requires it. |
| A08 | Software or Data Integrity Failures | `integrity` | Code deserializes untrusted data unsafely, or trusts updates, plugins, cookies, tokens or CI artifacts whose integrity or signature it does not verify. |
| A09 | Security Logging & Alerting Failures | `errors` | Security-relevant events the change adds (login, access denial, privilege change, input validation failure) are not logged, or a log line writes secrets, tokens or personal data, or writes unneutralized input that can forge log entries. |
| A10 | Mishandling of Exceptional Conditions | `errors` | An error or unusual condition is ignored, fails open (grants access or skips a check when an exception is thrown), leaves a transaction or resource half done, or leaks internals in the error shown to the user. |

## CWE Top 25 (2025)

| Rank | CWE | Name | Lens | Breach when |
| --- | --- | --- | --- | --- |
| 1 | CWE-79 | Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting') | `injection` | External or stored data is written to HTML, an attribute, JavaScript or a URL without encoding for that context, or through a raw-HTML API without sanitizing. |
| 2 | CWE-89 | Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection') | `injection` | External input reaches a SQL string by concatenation, interpolation or format instead of a bound parameter. |
| 3 | CWE-352 | Cross-Site Request Forgery (CSRF) | `access` | A state-changing endpoint reached by a browser session has no CSRF token, `SameSite` cookie policy or origin check. |
| 4 | CWE-862 | Missing Authorization | `access` | A handler acts on a resource or function with no authorization check at all. |
| 5 | CWE-787 | Out-of-bounds Write | `memory` | A write to a buffer or array is not bounded by its size (C, C++, unsafe Rust, native bindings). |
| 6 | CWE-22 | Improper Limitation of a Pathname to a Restricted Directory ('Path Traversal') | `resources` | External input builds a file path without normalizing it and checking it stays inside an allowed base. |
| 7 | CWE-416 | Use After Free | `memory` | Memory or a handle is used after it is freed or closed. |
| 8 | CWE-125 | Out-of-bounds Read | `memory` | A read from a buffer or array uses an index or length not checked against its size. |
| 9 | CWE-78 | Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection') | `injection` | External input reaches a shell command string instead of an argv list with a fixed program. |
| 10 | CWE-94 | Improper Control of Generation of Code ('Code Injection') | `injection` | External input reaches `eval`, `Function`, `exec`, a runtime-compiled template, or a dynamic import or class load. |
| 11 | CWE-120 | Buffer Copy without Checking Size of Input ('Classic Buffer Overflow') | `memory` | A copy into a fixed buffer (`strcpy`, `memcpy`, `sprintf`) is not bounded by the destination size. |
| 12 | CWE-434 | Unrestricted Upload of File with Dangerous Type | `resources` | An upload is stored or served without an allow-list check on content and extension, a size limit, a new name, and a non-executable location. |
| 13 | CWE-476 | NULL Pointer Dereference | `memory` | A value that can be null or undefined is dereferenced without a check. |
| 14 | CWE-121 | Stack-based Buffer Overflow | `memory` | A write to a stack buffer is not bounded by its size. |
| 15 | CWE-502 | Deserialization of Untrusted Data | `integrity` | Untrusted data is deserialized with a format that can build arbitrary objects, or without a type allow-list and integrity check. |
| 16 | CWE-122 | Heap-based Buffer Overflow | `memory` | A write to a heap buffer is not bounded by its allocated size. |
| 17 | CWE-863 | Incorrect Authorization | `access` | An authorization check exists but checks the wrong thing: the wrong user, role, tenant or resource, or a check that can be bypassed by another path. |
| 18 | CWE-20 | Improper Input Validation | `injection` | External input that the code relies on for type, range, length or format is used without validating it. Cite this only when no more specific entry fits. |
| 19 | CWE-284 | Improper Access Control | `access` | Access to a resource is not restricted to the actors that should have it, and no more specific entry (CWE-862, CWE-863, CWE-639) fits. |
| 20 | CWE-200 | Exposure of Sensitive Information to an Unauthorized Actor | `errors` | A response, log, error or client bundle exposes secrets, personal data, internal paths or versions to someone not entitled to them. |
| 21 | CWE-306 | Missing Authentication for Critical Function | `access` | A sensitive function runs without checking the caller is authenticated. |
| 22 | CWE-918 | Server-Side Request Forgery (SSRF) | `resources` | The server fetches a URL or host taken from input without an allow-list, and without blocking internal, loopback, link-local and metadata addresses after resolution. |
| 23 | CWE-77 | Improper Neutralization of Special Elements used in a Command ('Command Injection') | `injection` | External input reaches any command interpreter (not only the OS shell) as part of the command. |
| 24 | CWE-639 | Authorization Bypass Through User-Controlled Key | `access` | A record is looked up by an id, key or path from the request without checking it belongs to the caller. |
| 25 | CWE-770 | Allocation of Resources Without Limits or Throttling | `memory` | Input controls how much memory, disk, connections, threads or work is allocated, with no size limit, quota or rate limit. |
