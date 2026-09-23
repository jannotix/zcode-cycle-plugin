//! Checkable prohibitions read out of the immutable original request.
//!
//! DEFECT-15: the stored request read, verbatim, "Implement only that change in
//! greet.js; do not modify any test file." The approved candidate's file list
//! was `greet.js` and `greet.test.mjs`, and the arbitration entry named both.
//! Judging the candidate against the immutable original request is the
//! arbiter's whole purpose, and the reason that text is frozen before any role
//! interprets it. The constraint was explicit, unambiguous, and decidable by
//! comparing a file list.
//!
//! This module does not try to understand the request. It recognises a small
//! set of prohibitions stated plainly enough that reading them wrong is not
//! possible, and reports which changed files break them. Everything else is
//! left to judgement, where it belongs: silence here means "nothing mechanical
//! to say", never "approved".
//!
//! The asymmetry is deliberate. A missed prohibition leaves the product exactly
//! where it is today; a wrongly-invented one blocks honest work. So a phrase
//! earns a constraint only when it is unambiguous, and a constraint fires only
//! when a changed path plainly matches it.

/// A prohibition found in the request, and what it forbids.
#[derive(Clone, Debug, Eq, PartialEq)]
enum Prohibition {
    /// No test file may be touched.
    TestFiles,
    /// A specific path, as written in the request, may not be touched.
    Path(String),
}

/// Every way the changed files contradict the request, in the request's terms.
///
/// Returns an empty vector when nothing checkable applies, which is the common
/// case and is not an approval.
#[must_use]
pub fn violations(request_text: &str, changed_paths: &[String]) -> Vec<String> {
    let mut reported = Vec::new();
    for prohibition in prohibitions(request_text) {
        for path in changed_paths {
            let breaks = match &prohibition {
                Prohibition::TestFiles => is_test_path(path),
                Prohibition::Path(forbidden) => same_path(path, forbidden),
            };
            if !breaks {
                continue;
            }
            let description = match &prohibition {
                Prohibition::TestFiles => {
                    format!(
                        "the request forbids modifying any test file, and this candidate changes {path}"
                    )
                }
                Prohibition::Path(forbidden) => {
                    format!(
                        "the request forbids modifying {forbidden}, and this candidate changes {path}"
                    )
                }
            };
            if !reported.contains(&description) {
                reported.push(description);
            }
        }
    }
    reported
}

/// The prohibitions stated plainly enough to be checked.
fn prohibitions(request_text: &str) -> Vec<Prohibition> {
    let text = request_text.to_ascii_lowercase();
    let mut found = Vec::new();

    // "do not modify any test file", and the ordinary ways of writing it. The
    // verb list is closed on purpose: "do not break the tests" is a different
    // instruction and must not become a path prohibition.
    for verb in ["modify", "change", "touch", "edit", "alter"] {
        for prefix in ["do not ", "don't ", "never ", "without "] {
            let opening = if prefix == "without " {
                format!("{prefix}{verb}ing")
            } else {
                format!("{prefix}{verb}")
            };
            let Some(rest) = text.split(&opening).nth(1) else {
                continue;
            };
            let clause = first_clause(rest);
            if mentions_test_files(clause) {
                found.push(Prohibition::TestFiles);
            }
            if let Some(path) = explicit_path(clause) {
                found.push(Prohibition::Path(path));
            }
        }
    }
    found.dedup();
    found
}

/// The clause a prohibition governs: everything up to the next sentence end.
///
/// A period inside a word is part of a filename, not a sentence end — splitting
/// naively on `.` cuts `config.toml` down to `config` and the prohibition then
/// names a file that does not exist.
fn first_clause(rest: &str) -> &str {
    let mut end = rest.len();
    for (index, character) in rest.char_indices() {
        let terminates = match character {
            ';' | '\n' => true,
            '.' => rest[index + character.len_utf8()..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace),
            _ => false,
        };
        if terminates {
            end = index;
            break;
        }
    }
    rest[..end].trim()
}

/// Whether a clause names test files as a class rather than one file.
fn mentions_test_files(clause: &str) -> bool {
    let words = clause
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    (words.contains("test") || words.contains("spec"))
        && (words.contains("file") || words.contains("files") || words.contains("suite"))
}

/// A single concrete path written in a clause, if there is exactly one.
///
/// Requiring exactly one candidate keeps "do not modify a.js or b.js" out:
/// guessing which of two was meant would be inventing a constraint.
fn explicit_path(clause: &str) -> Option<String> {
    let mut candidates = clause
        .split(|character: char| {
            character.is_whitespace() || matches!(character, ',' | '"' | '\'' | '`' | '(' | ')')
        })
        .map(|word| word.trim_matches(|character: char| matches!(character, '.' | ':' | ';')))
        .filter(|word| looks_like_a_path(word));
    let first = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    Some(first.to_owned())
}

fn looks_like_a_path(word: &str) -> bool {
    // A path here is a filename with an extension, or something with a
    // separator in it. Bare words are prose.
    if word.len() < 3 || word.len() > 512 {
        return false;
    }
    let normalized = word.replace('\\', "/");
    if normalized.contains('/') {
        return true;
    }
    normalized
        .rsplit_once('.')
        .is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && (1..=16).contains(&extension.len())
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
}

/// Whether a changed path is the path the request named.
///
/// The request may name `greet.js` for a file the candidate reports as
/// `src/greet.js`, so a suffix on a path boundary counts, and nothing shorter.
fn same_path(changed: &str, forbidden: &str) -> bool {
    let changed = changed.replace('\\', "/").to_ascii_lowercase();
    let forbidden = forbidden.replace('\\', "/").to_ascii_lowercase();
    changed == forbidden
        || changed
            .strip_suffix(&forbidden)
            .is_some_and(|prefix| prefix.ends_with('/'))
}

/// Whether a path is a test file by the conventions in ordinary use.
fn is_test_path(path: &str) -> bool {
    let path = path.replace('\\', "/").to_ascii_lowercase();
    let in_a_test_directory = path
        .split('/')
        .any(|segment| matches!(segment, "test" | "tests" | "__tests__" | "spec" | "specs"));
    if in_a_test_directory {
        return true;
    }
    let Some(name) = path.rsplit('/').next() else {
        return false;
    };
    let Some((stem, _)) = name.rsplit_once('.') else {
        return false;
    };
    // greet.test.mjs, greet_test.rs, greet-test.ts, test_greet.py, greet.spec.ts
    stem.ends_with(".test")
        || stem.ends_with("_test")
        || stem.ends_with("-test")
        || stem.starts_with("test_")
        || stem.ends_with(".spec")
        || stem.ends_with("_spec")
        || stem.ends_with("-spec")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn the_exact_request_that_was_approved_is_now_a_violation() {
        let request = "Implement only that change in greet.js; do not modify any test file.";
        let found = violations(request, &paths(&["greet.js", "greet.test.mjs"]));
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("greet.test.mjs"));
    }

    #[test]
    fn the_same_request_satisfied_reports_nothing() {
        let request = "Implement only that change in greet.js; do not modify any test file.";
        assert!(violations(request, &paths(&["greet.js"])).is_empty());
    }

    #[test]
    fn a_named_path_is_matched_through_a_directory_prefix() {
        let request = "Do not modify config.toml while fixing this.";
        assert_eq!(violations(request, &paths(&["src/config.toml"])).len(), 1);
        // A different file that merely ends in the same characters is not it.
        assert!(violations(request, &paths(&["srcconfig.toml"])).is_empty());
    }

    #[test]
    fn test_file_conventions_are_recognised_across_ecosystems() {
        for path in [
            "greet.test.mjs",
            "greet_test.rs",
            "greet-test.ts",
            "test_greet.py",
            "greet.spec.ts",
            "tests/helper.rs",
            "src/__tests__/helper.js",
        ] {
            assert!(is_test_path(path), "{path} should read as a test file");
        }
        for path in ["greet.js", "src/latest.js", "contest.rs", "protest/main.go"] {
            assert!(!is_test_path(path), "{path} should not read as a test file");
        }
    }

    #[test]
    fn prose_about_tests_does_not_become_a_path_prohibition() {
        // An instruction about outcomes is not an instruction about files.
        assert!(violations("Do not break the tests.", &paths(&["greet.test.mjs"])).is_empty());
        assert!(
            violations(
                "Make sure the tests still pass.",
                &paths(&["greet.test.mjs"])
            )
            .is_empty()
        );
    }

    #[test]
    fn an_ambiguous_prohibition_is_left_to_judgement() {
        // Two candidate paths: guessing which was meant would invent a
        // constraint the request did not state.
        assert!(violations("Do not modify a.js or b.js.", &paths(&["a.js"])).is_empty());
    }

    #[test]
    fn a_request_with_no_prohibition_says_nothing() {
        assert!(
            violations(
                "Add an aria-label to the submit button.",
                &paths(&["public/index.html", "public/index.test.js"])
            )
            .is_empty()
        );
    }
}
