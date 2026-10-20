package com.example.users;

import jakarta.servlet.http.HttpSession;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** Finds the signed-in user from the session's user id. Roles come from the database, never from the client. */
@Component
public class CurrentUser {
    public record User(long id, String name, boolean admin) {}

    private final JdbcTemplate jdbc;
    private final HttpSession session;

    public CurrentUser(JdbcTemplate jdbc, HttpSession session) {
        this.jdbc = jdbc;
        this.session = session;
    }

    /** Ends the request with 401 when nobody is signed in. */
    public User require() {
        if (!(session.getAttribute("userId") instanceof Long id)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        return jdbc.queryForObject(
                "SELECT id, name, is_admin FROM users WHERE id = ?",
                (row, number) -> new User(row.getLong("id"), row.getString("name"), row.getBoolean("is_admin")),
                id);
    }
}
