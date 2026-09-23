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
    if name == "private-key-block" {
        return format!("at line {line}: it contains a PEM private key block");
    }
    if CREDENTIAL_PREFIXES.contains(&name) {
        return format!(
            "at line {line}: a quoted literal begins with `{name}`, which is a credential prefix by convention. \
             This rule reads the value, so it does not matter what the literal is assigned to or where on the line it sits. \
             It ignores the placeholders {placeholders}. If this is not a credential, give it a placeholder value.",
            placeholders = PLACEHOLDERS.join(", "),
        );
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

/// Prefixes that make a literal a credential whatever it is assigned to.
///
/// The name rule above reads the left-hand side, which is where it is blind: a
/// live campaign planted `sk_live_` + 32 characters and the gate passed it,
/// because the identifier was camelCase - `shippingapikey` puts a letter in
/// front of `apikey`, so the whole-word check rejects it - and because the
/// literal sat after `||` rather than immediately after `=`. Two accidental
/// evasions, and neither had anything to do with the value.
///
/// Worse than the miss: the security reviewer saw the literal, and cleared it
/// because "the secret scan confirmed it's synthetic". Silence from a gate was
/// read one layer up as a positive finding. So this rule looks at the value and
/// nothing else, and only at shapes that are unambiguous - a prefix that is
/// already a credential by convention. Entropy heuristics are deliberately
/// absent: a gate that blocks a delivery on a guess costs more than it saves.
pub const CREDENTIAL_PREFIXES: [&str; 17] = [
    "AIza",
    "AKIA",
    "ASIA",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "npm_",
    "rk_live_",
    "sk-ant-",
    "sk-proj-",
    "sk_live_",
    "sk_test_",
    "xoxb-",
];

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
        if let Some(shape) = known_credential(line) {
            return Some((index + 1, shape));
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

/// The credential shape this line carries, read from the value alone.
///
/// A PEM block is not quoted and needs no prefix table. Everything else has to
/// be a quoted literal, because an unquoted `sk_live_...` on a line is as likely
/// to be documentation or a refusal message as a credential - including the ones
/// this very gate writes into evidence.
fn known_credential(line: &str) -> Option<&'static str> {
    if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
        return Some("private-key-block");
    }
    quoted_literals(line).into_iter().find_map(|literal| {
        if PLACEHOLDERS
            .iter()
            .any(|placeholder| literal.contains(placeholder))
        {
            return None;
        }
        CREDENTIAL_PREFIXES
            .iter()
            .find(|prefix| literal.len() >= prefix.len() + 16 && literal.starts_with(**prefix))
            .copied()
    })
}

/// Whether free text - a request, not code - talks about credential material.
///
/// The router used to keep its own word list, and it drifted from this one: the
/// 1.0.11 campaign sent a request that asked for an `sk_live_` literal and it
/// was routed to `quick`, because the request never used the word "secret".
/// The gate caught the literal later, but the independent security review that
/// `full` guarantees had already been skipped. Routing now asks this table.
///
/// Prose is not code, so the rule is wider than the gate's: a token that begins
/// with a separator-bearing prefix (`sk_live_`, `ghp_`, `sk-ant-`) counts even
/// on its own, because naming the prefix is already talking about the
/// credential. The bare-letter prefixes (`AKIA`, `ASIA`, `AIza`) count only at
/// full length, so "ASIA" in capitals is not a credential. Placeholders are
/// ignored as the gate ignores them. Over-routing costs a review; under-routing
/// costs the review that would have caught it.
pub(crate) fn mentions_credential_material(text: &str) -> bool {
    if text.contains("PRIVATE KEY") {
        return true;
    }
    text.split(|character: char| {
        !character.is_ascii_alphanumeric() && character != '_' && character != '-'
    })
    .filter(|token| {
        !PLACEHOLDERS
            .iter()
            .any(|placeholder| token.to_ascii_lowercase().contains(placeholder))
    })
    .any(|token| {
        CREDENTIAL_PREFIXES.iter().any(|prefix| {
            let bare = prefix.contains(['_', '-']);
            token.starts_with(prefix) && (bare || token.len() >= prefix.len() + 16)
        })
    })
}

/// The contents of every quoted run on the line, for `"`, `'` and a backtick.
///
/// Deliberately naive: it does not understand escapes or nesting, and it does
/// not need to. It is looking for a prefix at the start of a literal, and an
/// escape cannot appear there.
fn quoted_literals(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut found = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let quote = bytes[index];
        if quote == b'"' || quote == b'\'' || quote == b'`' {
            let Some(offset) = bytes[index + 1..].iter().position(|byte| *byte == quote) else {
                break;
            };
            found.push(&line[index + 1..index + 1 + offset]);
            index += offset + 2;
            continue;
        }
        index += 1;
    }
    found
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

    /// A synthetic value whose shape matches a known prefix, assembled at
    /// runtime.
    ///
    /// Never write one of these out whole in a source file. The first version of
    /// this test did, and GitHub's own push protection refused the commit -
    /// which is a fair verdict on the shape, and the cleanest possible second
    /// opinion that the gate below should have refused it too.
    fn shaped_like(prefix: &str) -> String {
        format!("{prefix}51H8xQ2KtestTESTtestTESTtest0000")
    }

    /// The live case. A campaign planted a Stripe-shaped key and the gate passed
    /// it twice over: the identifier was camelCase, so the whole-word check never
    /// saw `apikey`, and the literal sat after `||` rather than immediately after
    /// `=`. Both lines below come from the candidate the gate cleared.
    #[test]
    fn a_credential_shape_is_refused_whatever_it_is_assigned_to() {
        let value = shaped_like("sk_live_");
        let camel_case_behind_a_fallback =
            format!("const shippingApiKey = process.env.SHIPPING_API_KEY || '{value}'\n");
        let (line, name) =
            finding(&camel_case_behind_a_fallback).expect("a live-key shape must be refused");
        assert_eq!(line, 1);
        assert_eq!(name, "sk_live_");

        // The second file assigned the same value to a name carrying none of the
        // five credential words at all.
        let unrelated_name = format!("const fallbackKey = '{value}'\n");
        assert!(finding(&unrelated_name).is_some());
    }

    #[test]
    fn other_well_known_shapes_are_refused_too() {
        for prefix in ["ghp_", "AKIA", "xoxb-", "sk-ant-", "glpat-", "npm_"] {
            let line = format!("value = [\"{}\"]\n", shaped_like(prefix));
            assert!(finding(&line).is_some(), "not refused: {prefix}");
        }
        assert!(
            finding("-----BEGIN RSA PRIVATE KEY-----\n").is_some(),
            "a PEM private key block must be refused"
        );
    }

    /// The value rule must not undo the work the name rule's exemptions do. A
    /// placeholder is still a placeholder whatever shape it wears, and a prefix
    /// that is merely mentioned is not a credential.
    #[test]
    fn the_value_rule_keeps_the_existing_exemptions() {
        assert!(finding("key = \"sk_live_example_not_a_real_key_here\"\n").is_none());
        assert!(finding("// keys look like sk_live_ followed by 32 characters\n").is_none());
        assert!(finding("prefix = \"sk_live_\"\n").is_none());
        // The gate writes its own refusals into evidence; those must not trip it.
        assert!(
            finding("a quoted literal begins with `sk_live_`, which is a credential prefix\n")
                .is_none()
        );
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
