use std::path::Path;

use workflow_core::{CandidateFileKind, CandidateManifest};
use workflow_ledger::Redactor;

pub fn scan(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
) -> Result<(), String> {
    let redactor = Redactor::default();
    if let Some(finding) = sensitive(&redactor, &String::from_utf8_lossy(exact_diff)) {
        return Err(format!(
            "credential-like content was detected in the exact candidate diff, {}",
            describe(finding)
        ));
    }
    for file in manifest
        .files()
        .iter()
        .filter(|file| file.kind != CandidateFileKind::Deleted)
    {
        let path = repository.join(&file.path);
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > 16 * 1024 * 1024 {
            continue;
        }
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        if let Some(finding) = sensitive(&redactor, &String::from_utf8_lossy(&bytes)) {
            return Err(format!(
                "credential-like content was detected in {} {}",
                file.path,
                describe(finding)
            ));
        }
    }
    Ok(())
}

/// Says where the gate looked and what it matched, without printing the value.
///
/// DEFECT-09: the refusal used to name only the file. A role that cannot see
/// which line tripped the gate, or on what rule, has to guess - and the live run
/// guessed wrong three times before dumping the daemon's strings to find out.
fn describe((line, name): (usize, &'static str)) -> String {
    if name == "redaction-pattern" {
        return match line {
            0 => "matching a ledger redaction pattern".to_owned(),
            line => format!("at line {line}: it matches a ledger redaction pattern"),
        };
    }
    format!(
        "at line {line}: `{name}` is assigned a quoted literal of 8 or more characters. \
         The gate matches {names} assigned a quoted literal, and ignores the placeholders {placeholders}. \
         If this is not a credential, move the value out of a quoted literal or give it a placeholder value.",
        names = CREDENTIAL_NAMES.join(", "),
        placeholders = PLACEHOLDERS.join(", "),
    )
}

/// The names that make a quoted literal look like a committed credential.
///
/// Public so the gate can say what it matches. DEFECT-09: these lived only
/// inside the daemon binary, and a live run resorted to dispatching an executor
/// with a shell to extract them so it could write around the gate. A mandatory
/// gate whose rules can only be found by reverse-engineering the daemon is not
/// operable.
pub const CREDENTIAL_NAMES: [&str; 5] = ["api_key", "apikey", "password", "secret", "token"];

/// Values that are obviously not real credentials.
pub const PLACEHOLDERS: [&str; 4] = ["changeme", "example", "placeholder", "redacted"];

/// Returns the one-based line and the name that matched, so the refusal can say
/// where to look. The value itself is never returned: naming it would print the
/// credential into evidence that gets stored and read.
fn sensitive(redactor: &Redactor, value: &str) -> Option<(usize, &'static str)> {
    // Both rules are applied per line so the refusal can name one. The whole-value
    // redactor check stays as a fallback: its patterns may span lines, and a gate
    // that reports nothing is better than a gate that misses something.
    let located = value.lines().enumerate().find_map(|(index, line)| {
        if redactor.contains_sensitive(line) {
            return Some((index + 1, "redaction-pattern"));
        }
        let lower = line.to_ascii_lowercase();
        CREDENTIAL_NAMES
            .iter()
            .find(|name| assignment(&lower, name))
            .map(|name| (index + 1, *name))
    });
    located.or_else(|| {
        redactor
            .contains_sensitive(value)
            .then_some((0, "redaction-pattern"))
    })
}

/// True when `name` is assigned a quoted literal long enough to be a credential.
///
/// The literal requirement is what separates a committed secret from ordinary
/// cryptographic code. `secret = randomBytes(32)` derives a key at runtime and
/// `createHmac(algorithm, secret)` merely names a parameter - neither puts a
/// credential in the repository, and both used to fail this gate. A quoted
/// value, by contrast, is in the bytes being delivered.
fn assignment(line: &str, name: &str) -> bool {
    let Some(index) = line.find(name) else {
        return false;
    };
    // Only match a whole word: "secretary" and "tokenize" are not credentials.
    let preceded = line[..index]
        .chars()
        .next_back()
        .is_none_or(|character| !character.is_alphanumeric() && character != '_');
    if !preceded {
        return false;
    }
    let suffix = line[index + name.len()..].trim_start();
    let Some(value) = suffix
        .strip_prefix('=')
        .or_else(|| suffix.strip_prefix(':'))
    else {
        return false;
    };
    let value = value.trim();
    let Some(literal) = value
        .strip_prefix('"')
        .and_then(|rest| rest.split('"').next())
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|rest| rest.split('\'').next())
        })
    else {
        return false;
    };
    literal.len() >= 8
        && !PLACEHOLDERS
            .iter()
            .any(|placeholder| literal.contains(placeholder))
}

#[cfg(test)]
mod tests {
    use super::*;

    // DEFECT-09, found by scenario 3 of the live certification: the gate refused
    // a candidate whose only offence was ordinary cryptographic vocabulary, and
    // said nothing about which line or which rule. These pin both halves - what
    // is refused, and that the refusal can be acted on.

    fn finding(content: &str) -> Option<(usize, &'static str)> {
        sensitive(&Redactor::default(), content)
    }

    #[test]
    fn a_committed_credential_is_still_refused() {
        let (line, _) = finding("const config = {\n  api_key: \"sk-live-4f9a2b7c1d\",\n};\n")
            .expect("a quoted credential must be refused");
        assert_eq!(line, 2);
    }

    /// A literal the ledger's own redaction patterns do not recognise is still
    /// refused, by name: the name rule is what catches a credential nobody has
    /// written a pattern for yet.
    #[test]
    fn the_name_rule_catches_what_no_pattern_knows() {
        let (line, name) = finding("password = \"correct-horse-battery\"\n")
            .expect("a quoted credential must be refused");
        assert_eq!(line, 1);
        assert_eq!(name, "password");
    }

    /// The case that failed the live run: a key derived at runtime, and a
    /// parameter that merely carries one. Neither puts a credential in the tree.
    #[test]
    fn cryptographic_code_is_not_a_credential() {
        assert!(finding("const secret = randomBytes(32);\n").is_none());
        assert!(finding("return createHmac(algorithm, secret).digest();\n").is_none());
        assert!(finding("function sign(payload, secret) {\n").is_none());
        assert!(finding("let token = self.issue(claims)?;\n").is_none());
    }

    #[test]
    fn a_name_that_merely_contains_a_credential_word_is_not_one() {
        assert!(finding("secretary = \"Ada Lovelace\"\n").is_none());
        assert!(finding("access_token_prefix_label = \"authorization\"\n").is_none());
    }

    #[test]
    fn placeholders_and_short_values_stay_allowed() {
        assert!(finding("password = \"changeme-please\"\n").is_none());
        assert!(finding("password = \"abc\"\n").is_none());
    }

    /// The refusal has to name the line and the rule, or the role cannot act on
    /// it without reverse-engineering the daemon.
    #[test]
    fn the_refusal_says_where_and_why() {
        let message = describe(finding("x = 1\ntoken: \"opaque-value-here\"\n").unwrap());
        assert!(message.contains("line 2"), "{message}");
        assert!(message.contains("token"), "{message}");
        assert!(message.contains("quoted literal"), "{message}");
        assert!(message.contains("changeme"), "{message}");
        // The value itself must never appear: refusals are stored as evidence.
        assert!(!message.contains("opaque-value-here"), "{message}");
    }
}
