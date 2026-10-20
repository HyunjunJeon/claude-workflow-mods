# Users API

A user management API on Spring MVC, Spring Security and JdbcTemplate. The sources are in `src/main/java/com/example/users/`.
This demo repository has no build file: changes are verified by reading the source, not by compiling or running it.

## Security rules

- Secure-coding reviews follow the KISA software security guide (the 49 implementation-phase weaknesses).
- `SecurityConfig.java` requires a signed-in session for every request and a CSRF token for every state-changing request.
- Profile pictures (avatars) are public: any signed-in user may view anyone's avatar.
