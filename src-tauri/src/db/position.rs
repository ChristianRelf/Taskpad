//! Fractional indexing for sibling order.
//!
//! Sibling order is a short base-62 string rather than an integer, so inserting
//! between two rows only writes the one new row. Nothing has to be renumbered,
//! which is what makes the order safe to replicate record-by-record later on.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit_index(c: u8) -> Option<usize> {
    DIGITS.iter().position(|&d| d == c)
}

/// True when `s` is a usable order key: base-62 and not trailing in the lowest
/// digit (a trailing `0` has no room left below it).
pub fn is_valid(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|c| digit_index(c).is_some())
        && !s.ends_with(DIGITS[0] as char)
}

fn midpoint(a: &str, b: Option<&str>) -> String {
    if let Some(b) = b {
        debug_assert!(a < b, "midpoint expects a < b");
        // Walk past the shared prefix so we only bisect the part that differs.
        let ab = a.as_bytes();
        let bb = b.as_bytes();
        let mut n = 0;
        while n < bb.len() && ab.get(n).copied().unwrap_or(DIGITS[0]) == bb[n] {
            n += 1;
        }
        if n > 0 {
            let tail_a = a.get(n..).unwrap_or("");
            return format!("{}{}", &b[..n], midpoint(tail_a, Some(&b[n..])));
        }
    }

    let lo = a.bytes().next().and_then(digit_index).unwrap_or(0);
    let hi = match b {
        Some(b) => digit_index(b.as_bytes()[0]).unwrap_or(DIGITS.len()),
        None => DIGITS.len(),
    };

    if hi - lo > 1 {
        // Room for a digit strictly between the two.
        let mid = (lo + hi) / 2;
        return (DIGITS[mid] as char).to_string();
    }

    if let Some(b) = b {
        if b.len() > 1 {
            // `b` has a tail; borrowing its first digit already lands below it.
            return b[..1].to_string();
        }
    }
    // Digits are adjacent: keep a's digit and descend into the next place.
    let head = a.chars().next().unwrap_or(DIGITS[0] as char);
    format!("{}{}", head, midpoint(a.get(1..).unwrap_or(""), None))
}

/// Produce an order key strictly between `before` and `after`.
///
/// `None` means "no neighbour on that side". Invalid or out-of-order input is
/// tolerated rather than fatal: the caller gets a key it can still store.
pub fn key_between(before: Option<&str>, after: Option<&str>) -> String {
    let before = before.filter(|s| is_valid(s));
    let after = after.filter(|s| is_valid(s));
    match (before, after) {
        (None, None) => midpoint("", None),
        (Some(a), None) => midpoint(a, None),
        (None, Some(b)) => midpoint("", Some(b)),
        (Some(a), Some(b)) => {
            if a >= b {
                // Neighbours disagree with the requested order; fall back to
                // appending after `a` so the write still succeeds.
                midpoint(a, None)
            } else {
                midpoint(a, Some(b))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_key_is_valid() {
        let k = key_between(None, None);
        assert!(is_valid(&k), "{k}");
    }

    #[test]
    fn appends_grow_monotonically() {
        let mut prev = key_between(None, None);
        for _ in 0..500 {
            let next = key_between(Some(&prev), None);
            assert!(next > prev, "{next} !> {prev}");
            assert!(is_valid(&next));
            prev = next;
        }
    }

    #[test]
    fn prepends_shrink_monotonically() {
        let mut prev = key_between(None, None);
        for _ in 0..500 {
            let next = key_between(None, Some(&prev));
            assert!(next < prev, "{next} !< {prev}");
            assert!(is_valid(&next));
            prev = next;
        }
    }

    #[test]
    fn repeated_bisection_stays_ordered() {
        let mut lo = key_between(None, None);
        let hi = key_between(Some(&lo), None);
        for _ in 0..500 {
            let mid = key_between(Some(&lo), Some(&hi));
            assert!(mid > lo && mid < hi, "{lo} < {mid} < {hi} violated");
            assert!(is_valid(&mid));
            lo = mid;
        }
    }

    #[test]
    fn out_of_order_input_still_yields_a_key() {
        let k = key_between(Some("z"), Some("a"));
        assert!(is_valid(&k));
        assert!(k.as_str() > "z");
    }

    #[test]
    fn invalid_neighbours_are_ignored() {
        assert!(is_valid(&key_between(Some(""), Some("!!"))));
        assert!(is_valid(&key_between(Some("a0"), None)));
    }
}
