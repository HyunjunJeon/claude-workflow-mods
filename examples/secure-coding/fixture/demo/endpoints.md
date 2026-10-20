# Endpoints for act 2

The `users-api` node in `demo/review.yaml` adds these two endpoints to `UserController.java` exactly as written.

```java
    @GetMapping("/users/{id}/avatar")
    public ResponseEntity<byte[]> avatar(@PathVariable long id) throws IOException, NoSuchAlgorithmException {
        currentUser.require();
        Path file = Path.of(avatarDir, id + ".png");
        if (!Files.exists(file)) {
            return ResponseEntity.notFound().build();
        }
        byte[] image = Files.readAllBytes(file);
        String etag = HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(image));
        return ResponseEntity.ok().contentType(MediaType.IMAGE_PNG).eTag(etag).body(image);
    }

    @DeleteMapping("/users/{id}")
    public ResponseEntity<Void> delete(@PathVariable long id) {
        currentUser.require();
        int deleted = jdbc.update("DELETE FROM users WHERE id = ?", id);
        return deleted == 0 ? ResponseEntity.notFound().build() : ResponseEntity.noContent().build();
    }
```
