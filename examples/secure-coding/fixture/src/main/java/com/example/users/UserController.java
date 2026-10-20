package com.example.users;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** The user management API. The demo adds endpoints to this class. */
@RestController
public class UserController {
    public record UserSummary(long id, String name) {}

    private static final RowMapper<UserSummary> SUMMARY = (row, number) -> new UserSummary(row.getLong("id"), row.getString("name"));

    private final JdbcTemplate jdbc;
    private final CurrentUser currentUser;
    private final String avatarDir;

    public UserController(JdbcTemplate jdbc, CurrentUser currentUser, @Value("${app.avatar-dir}") String avatarDir) {
        this.jdbc = jdbc;
        this.currentUser = currentUser;
        this.avatarDir = avatarDir;
    }

    @GetMapping("/users/{id}")
    public UserSummary get(@PathVariable long id) {
        currentUser.require();
        return jdbc.queryForObject("SELECT id, name FROM users WHERE id = ?", SUMMARY, id);
    }
}
