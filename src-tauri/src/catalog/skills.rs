//! Skill-kind catalog logic: content hashing (Task 2), lint (Task 6), advisor (Task 7).

/// Deterministic FNV-1a 64 (hex) — stable across runs/platforms, no new deps.
/// Used to compare an installed SKILL.md against the catalog copy when neither
/// side carries a real version.
pub fn content_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_deterministic_and_sensitive() {
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
        assert_eq!(content_hash(""), "cbf29ce484222325"); // FNV-1a offset basis
    }
}
