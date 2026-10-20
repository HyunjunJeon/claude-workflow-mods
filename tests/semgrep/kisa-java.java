// semgrep --test fixture for rules/kisa-java.yaml: "ruleid" lines must match, "ok" lines must not.
package com.example.fixture;

import com.auth0.jwt.JWT;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Jwts;
import java.io.File;
import java.io.FileInputStream;
import java.io.ObjectInputStream;
import java.io.PrintWriter;
import java.net.URL;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.Statement;
import java.util.Random;
import javax.crypto.Cipher;
import javax.net.ssl.SSLSession;
import javax.net.ssl.X509TrustManager;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.sql.DataSource;
import javax.xml.parsers.DocumentBuilderFactory;
import org.apache.commons.io.FilenameUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestTemplate;

@RestController
public class Fixture {
    private final JdbcTemplate jdbc;
    private final Connection connection;
    private final RestTemplate rest = new RestTemplate();

    Fixture(JdbcTemplate jdbc, Connection connection) {
        this.jdbc = jdbc;
        this.connection = connection;
    }

    @GetMapping("/users")
    public Object users(@RequestParam("name") String name) throws Exception {
        // ruleid: kisa-1-1-sql-injection-java
        Object rows = jdbc.queryForList("SELECT * FROM users WHERE name = '" + name + "'");
        Statement statement = connection.createStatement();
        // ruleid: kisa-1-1-sql-injection-java
        statement.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
        // ok: kisa-1-1-sql-injection-java
        Object safe = jdbc.queryForList("SELECT * FROM users WHERE name = ?", name);
        return rows;
    }

    @GetMapping("/legacy")
    public void legacy(HttpServletRequest request, HttpServletResponse response) throws Exception {
        String id = request.getParameter("id");
        // ruleid: kisa-1-1-sql-injection-java
        connection.prepareStatement("DELETE FROM users WHERE id = " + id);
        // ruleid: kisa-1-4-xss-java
        response.getWriter().println("<p>" + request.getParameter("q") + "</p>");
        // ok: kisa-1-4-xss-java
        response.getWriter().println("<p>ok</p>");
        // ruleid: kisa-1-7-open-redirect-java
        response.sendRedirect(request.getParameter("next"));
    }

    @GetMapping("/files/{name}")
    public byte[] file(@PathVariable String name) throws Exception {
        // ruleid: kisa-1-3-path-traversal-java
        FileInputStream in = new FileInputStream("/srv/files/" + name);
        // ok: kisa-1-3-path-traversal-java
        File clean = new File("/srv/files", FilenameUtils.getName(name));
        return in.readAllBytes();
    }

    @GetMapping("/ping")
    public void ping(@RequestParam String host) throws Exception {
        // ruleid: kisa-1-5-os-command-injection-java
        Runtime.getRuntime().exec("ping -c 1 " + host);
        // ok: kisa-1-5-os-command-injection-java
        new ProcessBuilder("ping", "-c", "1", host).start();
    }

    @GetMapping("/fetch")
    public String fetch(@RequestParam String url) throws Exception {
        // ruleid: kisa-1-12-ssrf-java
        String body = rest.getForObject(url, String.class);
        // ok: kisa-1-12-ssrf-java
        String status = rest.getForObject("https://api.example.com/status", String.class);
        return body + status;
    }

    @GetMapping("/greet")
    public String greet(@RequestParam String template) {
        // ruleid: kisa-1-17-format-string-java
        return String.format(template, "user");
    }

    public void parse(String xml) throws Exception {
        DocumentBuilderFactory unsafe = DocumentBuilderFactory.newInstance();
        // ruleid: kisa-1-8-xxe-java
        unsafe.newDocumentBuilder();
        DocumentBuilderFactory safe = DocumentBuilderFactory.newInstance();
        safe.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        // ok: kisa-1-8-xxe-java
        safe.newDocumentBuilder();
    }

    public void security(HttpSecurity http) throws Exception {
        // ruleid: kisa-1-11-csrf-disabled-java
        http.csrf().disable();
    }

    public void permissions(File file) throws Exception {
        // ruleid: kisa-2-3-world-permissions-java
        java.nio.file.Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rwxrwxrwx"));
        // ruleid: kisa-2-3-world-permissions-java
        file.setWritable(true, false);
        // ok: kisa-2-3-world-permissions-java
        java.nio.file.Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-------"));
    }

    public void crypto(byte[] data, String password) throws Exception {
        // ruleid: kisa-2-4-weak-crypto-java
        MessageDigest.getInstance("MD5").digest(data);
        // ruleid: kisa-2-4-weak-crypto-java
        Cipher.getInstance("AES");
        // ruleid: kisa-2-4-weak-crypto-java
        Cipher.getInstance("DES/CBC/PKCS5Padding");
        // ok: kisa-2-4-weak-crypto-java
        Cipher.getInstance("AES/GCM/NoPadding");
        // ok: kisa-2-4-weak-crypto-java
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        // ruleid: kisa-2-14-unsalted-password-hash-java
        sha.digest(password.getBytes());
    }

    // ruleid: kisa-2-6-hardcoded-secret-java
    private static final String DB_PASSWORD = "s3cr3t-pass";
    // ok: kisa-2-6-hardcoded-secret-java
    private static final String DB_PASSWORD_ENV = System.getenv("DB_PASSWORD");
    // ok: kisa-2-6-hardcoded-secret-java
    private static final String TOKEN_HEADER = "";

    public void datasource(com.zaxxer.hikari.HikariConfig config) {
        // ruleid: kisa-2-6-hardcoded-secret-setter-java
        config.setPassword("Winter2026!");
        // ok: kisa-2-6-hardcoded-secret-setter-java
        config.setPassword(System.getenv("DB_PASSWORD"));
    }

    public void keys() throws Exception {
        KeyPairGenerator weak = KeyPairGenerator.getInstance("RSA");
        // ruleid: kisa-2-7-short-rsa-key-java
        weak.initialize(1024);
        KeyPairGenerator strong = KeyPairGenerator.getInstance("RSA");
        // ok: kisa-2-7-short-rsa-key-java
        strong.initialize(3072);
    }

    public void tokens() {
        // ruleid: kisa-2-8-insecure-random-java
        String resetToken = Long.toHexString(new Random().nextLong());
        // ruleid: kisa-2-8-insecure-random-java
        int otp = (int) (Math.random() * 1000000);
        // ok: kisa-2-8-insecure-random-java
        String sessionToken = Long.toHexString(new SecureRandom().nextLong());
        // ok: kisa-2-8-insecure-random-java
        int jitter = new Random().nextInt(100);
    }

    public void jwt(String token) {
        // ruleid: kisa-2-10-jwt-signature-not-verified-java
        Jwts.parser().parseClaimsJwt(token);
        // ruleid: kisa-2-10-jwt-signature-not-verified-java
        JWT.decode(token);
        // ok: kisa-2-10-jwt-signature-not-verified-java
        Jwts.parser().setSigningKey(key()).parseClaimsJws(token);
    }

    static class TrustAll implements X509TrustManager {
        // ruleid: kisa-2-11-tls-verification-disabled-java
        public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) {
        }

        public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) {
        }

        public java.security.cert.X509Certificate[] getAcceptedIssuers() {
            return new java.security.cert.X509Certificate[0];
        }
    }

    public void hostnames() {
        // ruleid: kisa-2-11-tls-verification-disabled-java
        javax.net.ssl.HttpsURLConnection.setDefaultHostnameVerifier((host, session) -> true);
    }

    public void cookies(HttpServletResponse response) {
        Cookie session = new Cookie("sid", "value");
        // ruleid: kisa-2-12-insecure-cookie-java
        session.setHttpOnly(false);
        // ok: kisa-2-12-insecure-cookie-java
        session.setSecure(true);
        response.addCookie(session);
    }

    public void errors(HttpServletResponse response, File file) throws Exception {
        try {
            file.delete();
        } catch (Exception error) {
            // ruleid: kisa-4-1-error-detail-exposed-java
            error.printStackTrace(response.getWriter());
        }
        // ruleid: kisa-4-2-swallowed-exception-java
        try {
            file.delete();
        } catch (SecurityException error) {
        }
        // ok: kisa-4-2-swallowed-exception-java
        try {
            file.delete();
        } catch (SecurityException error) {
            throw new IllegalStateException("cannot delete " + file, error);
        }
    }

    public Object deserialize(ObjectInputStream in, ObjectMapper mapper) throws Exception {
        // ruleid: kisa-5-5-unsafe-deserialization-java
        mapper.enableDefaultTyping();
        // ruleid: kisa-5-5-unsafe-deserialization-java
        return in.readObject();
    }

    private java.security.Key key() {
        return null;
    }
}
