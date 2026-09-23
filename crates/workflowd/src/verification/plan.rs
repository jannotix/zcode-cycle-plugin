use std::{collections::BTreeSet, path::Path};

use serde::{Deserialize, Serialize};
use workflow_core::{ArchitecturePlan, EvidenceId, EvidenceKind, VerificationPlanId};

const DEFAULT_TIMEOUT_SECONDS: u64 = 600;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationRisk {
    InternalInspection,
    ProjectCode,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VerificationExecutor {
    CandidateIntegrity,
    Command {
        arguments: Vec<String>,
        program: String,
    },
    SecretScan,
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VerificationGate {
    pub executor: VerificationExecutor,
    pub id: EvidenceId,
    pub kind: EvidenceKind,
    pub mandatory: bool,
    pub name: String,
    pub precondition: String,
    pub risk: VerificationRisk,
    pub timeout_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VerificationPlan {
    pub gates: Vec<VerificationGate>,
    pub id: VerificationPlanId,
}

impl VerificationPlan {
    pub fn validate(
        id: VerificationPlanId,
        gates: Vec<VerificationGate>,
    ) -> Result<Self, VerificationPlanError> {
        if gates.is_empty() || gates.len() > 256 {
            return Err(VerificationPlanError::InvalidGate);
        }
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for gate in &gates {
            if !ids.insert(gate.id)
                || !names.insert(gate.name.as_str())
                || gate.name.trim().is_empty()
                || gate.precondition.trim().is_empty()
                || gate.timeout_seconds == 0
                || gate.timeout_seconds > 7_200
            {
                return Err(VerificationPlanError::InvalidGate);
            }
            if let VerificationExecutor::Command { arguments, program } = &gate.executor {
                validate_command(program, arguments)?;
            }
        }
        Ok(Self { gates, id })
    }

    #[must_use]
    pub fn evidence_ids(&self) -> Vec<EvidenceId> {
        self.gates.iter().map(|gate| gate.id).collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VerificationPlanError {
    InvalidCommand,
    InvalidGate,
    InvalidProjectConfiguration,
    Io,
}

impl std::fmt::Display for VerificationPlanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCommand => "verification command is unsafe or malformed",
            Self::InvalidGate => "verification plan contains an invalid or duplicate gate",
            Self::InvalidProjectConfiguration => "project verification configuration is invalid",
            Self::Io => "project verification configuration could not be read",
        })
    }
}

impl std::error::Error for VerificationPlanError {}

pub fn discover(
    repository: &Path,
    architecture: &ArchitecturePlan,
) -> Result<VerificationPlan, VerificationPlanError> {
    discover_for(repository, architecture, VerificationPlanId::new())
}

pub fn discover_for(
    repository: &Path,
    architecture: &ArchitecturePlan,
    plan_id: VerificationPlanId,
) -> Result<VerificationPlan, VerificationPlanError> {
    let mut gates = Vec::new();
    let mut invocations = BTreeSet::new();
    for command in architecture
        .tasks
        .iter()
        .flat_map(|task| task.verification_commands.iter())
    {
        add_command(&mut gates, &mut invocations, command, true)?;
    }
    discover_package_scripts(repository, &mut gates, &mut invocations)?;
    discover_cargo(repository, &mut gates, &mut invocations)?;
    gates.push(VerificationGate {
        executor: VerificationExecutor::SecretScan,
        id: EvidenceId::new(),
        kind: EvidenceKind::Security,
        mandatory: true,
        name: "security:changed-content-secret-scan".to_owned(),
        precondition: "A frozen candidate exists.".to_owned(),
        risk: VerificationRisk::InternalInspection,
        timeout_seconds: 120,
    });
    gates.push(VerificationGate {
        executor: VerificationExecutor::CandidateIntegrity,
        id: EvidenceId::new(),
        kind: EvidenceKind::Inspection,
        mandatory: true,
        name: "candidate:immutable-bytes".to_owned(),
        precondition: "The frozen candidate and exact diff are available.".to_owned(),
        risk: VerificationRisk::InternalInspection,
        timeout_seconds: 120,
    });

    let scopes = expanded_scopes(repository, architecture);
    if scopes.iter().any(|scope| database_scope(scope))
        && !gates.iter().any(|gate| gate.kind == EvidenceKind::Database)
    {
        gates.push(unavailable(
            "database:real-integration",
            EvidenceKind::Database,
            "Persistence changes require a project-native real or disposable database check.",
        ));
    }
    if scopes.iter().any(|scope| user_interface_scope(scope)) {
        if !gates.iter().any(|gate| gate.kind == EvidenceKind::Browser) {
            gates.push(unavailable(
                "browser:affected-user-flow",
                EvidenceKind::Browser,
                "User-interface changes require a project-native browser flow.",
            ));
        }
        if !gates
            .iter()
            .any(|gate| gate.name.starts_with("accessibility:"))
        {
            gates.push(unavailable(
                "accessibility:affected-user-flow",
                EvidenceKind::Browser,
                "User-interface changes require a project-native accessibility check.",
            ));
        }
    }
    if scopes.iter().any(|scope| dependency_scope(scope)) {
        if !gates.iter().any(|gate| {
            gate.kind == EvidenceKind::Security
                && contains_any(&gate.name, &["audit", "security", "vulnerab"])
                && !matches!(gate.executor, VerificationExecutor::SecretScan)
        }) {
            gates.push(unavailable(
                "security:dependency-vulnerability",
                EvidenceKind::Security,
                "Dependency changes require a project-native vulnerability audit.",
            ));
        }
        if !gates
            .iter()
            .any(|gate| gate.kind == EvidenceKind::Security && gate.name.contains("license"))
        {
            gates.push(unavailable(
                "security:dependency-license",
                EvidenceKind::Security,
                "Dependency changes require a project-native license policy check.",
            ));
        }
    }
    if scopes.iter().any(|scope| packaging_scope(scope))
        && !gates.iter().any(|gate| gate.kind == EvidenceKind::Package)
    {
        gates.push(unavailable(
            "package:production-artifact",
            EvidenceKind::Package,
            "Packaging changes require a project-native production artifact and installation check.",
        ));
    }
    VerificationPlan::validate(plan_id, gates)
}

fn discover_package_scripts(
    repository: &Path,
    gates: &mut Vec<VerificationGate>,
    invocations: &mut BTreeSet<String>,
) -> Result<(), VerificationPlanError> {
    let path = repository.join("package.json");
    if !path.is_file() {
        return Ok(());
    }
    let bytes = std::fs::read(path).map_err(|_| VerificationPlanError::Io)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(VerificationPlanError::InvalidProjectConfiguration);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| VerificationPlanError::InvalidProjectConfiguration)?;
    let scripts = value
        .get("scripts")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let manager = if repository.join("bun.lock").is_file() || repository.join("bun.lockb").is_file()
    {
        "bun"
    } else if repository.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if repository.join("yarn.lock").is_file() {
        "yarn"
    } else {
        "npm"
    };
    for name in [
        "format:check",
        "lint",
        "typecheck",
        "check",
        "build",
        "test",
        "test:integration",
        "test:database",
        "test:db",
        "db:test",
        "test:e2e",
        "e2e",
        "test:browser",
        "test:a11y",
        "test:accessibility",
        "a11y",
        "accessibility",
        "security",
        "audit",
        "audit:dependencies",
        "license:check",
        "licenses",
        "test:package",
        "package:verify",
    ] {
        if scripts.get(name).is_some_and(serde_json::Value::is_string) {
            let command = if manager == "npm" {
                format!("npm run {name}")
            } else {
                format!("{manager} run {name}")
            };
            add_command(gates, invocations, &command, true)?;
        }
    }
    Ok(())
}

fn discover_cargo(
    repository: &Path,
    gates: &mut Vec<VerificationGate>,
    invocations: &mut BTreeSet<String>,
) -> Result<(), VerificationPlanError> {
    if !repository.join("Cargo.toml").is_file() {
        return Ok(());
    }
    for command in [
        "cargo fmt --check",
        "cargo clippy --all-targets --all-features -- -D warnings",
        "cargo test --all-features",
    ] {
        add_command(gates, invocations, command, true)?;
    }
    Ok(())
}

fn add_command(
    gates: &mut Vec<VerificationGate>,
    invocations: &mut BTreeSet<String>,
    command: &str,
    mandatory: bool,
) -> Result<(), VerificationPlanError> {
    let words = shlex::split(command).ok_or(VerificationPlanError::InvalidCommand)?;
    let (program, arguments) = words
        .split_first()
        .ok_or(VerificationPlanError::InvalidCommand)?;
    validate_command(program, arguments)?;
    let invocation = std::iter::once(program.as_str())
        .chain(arguments.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    if !invocations.insert(invocation) {
        return Ok(());
    }
    let (name, kind) = classify(command);
    gates.push(VerificationGate {
        executor: VerificationExecutor::Command {
            arguments: arguments.to_vec(),
            program: program.clone(),
        },
        id: EvidenceId::new(),
        kind,
        mandatory,
        name,
        precondition: "The project command is configured and the candidate worktree is isolated."
            .to_owned(),
        risk: VerificationRisk::ProjectCode,
        timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
    });
    Ok(())
}

fn validate_command(program: &str, arguments: &[String]) -> Result<(), VerificationPlanError> {
    // DEFECT-16: the metacharacter check read the arguments, so a whole shell
    // expression parked in `program` with no arguments passed every test and was
    // accepted as a mandatory gate. The daemon spawns `program` directly, so no
    // such executable exists: the gate could never start, and a gate that cannot
    // start yields neither a pass nor a fail.
    //
    // DEFECT-23: that fix enumerated what a program may not contain, and
    // `CI=1 npm run check:changelog` slipped through it - `CI=1` is one word,
    // carries no metacharacter and is on no denylist, yet it is an environment
    // assignment the shell would have consumed and not a program at all. A
    // denylist is a guess about every way a string can fail to be an executable.
    // Saying what a program *may* be settles the whole class at once.
    if !is_program_name(program) {
        return Err(VerificationPlanError::InvalidCommand);
    }
    if arguments.iter().any(|argument| {
        argument.contains(['\0', '\n', '\r'])
            || matches!(argument.as_str(), "&&" | "||" | ";" | "|" | "<" | ">")
    }) {
        return Err(VerificationPlanError::InvalidCommand);
    }
    let executable = program
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(program)
        .trim_end_matches(".exe")
        .to_ascii_lowercase();
    if matches!(
        executable.as_str(),
        "cmd" | "del" | "git" | "powershell" | "pwsh" | "rm" | "sh" | "shutdown"
    ) || arguments.iter().any(|argument| {
        matches!(
            argument.to_ascii_lowercase().as_str(),
            "deploy" | "destroy" | "drop" | "publish" | "push" | "reset"
        )
    }) {
        return Err(VerificationPlanError::InvalidCommand);
    }
    Ok(())
}

/// Whether `program` can name an executable at all.
///
/// A program is a bare command name, or a path whose final component is one. A
/// command name is made of the characters an executable on any supported
/// platform may carry: letters, digits, and `_ - . +`. Everything else - an `=`,
/// a space, a quote, a redirection, a substitution - belongs to a shell, and the
/// daemon has no shell to give it to.
///
/// Path separators and a Windows drive colon are allowed in the rest of the
/// string so that `./scripts/check.sh` and `C:\tools\node.exe` still resolve;
/// the final component is held to the stricter rule either way.
fn is_program_name(program: &str) -> bool {
    fn command_character(character: char) -> bool {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '+')
    }

    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.chars().all(command_character)
        && program
            .chars()
            .all(|character| command_character(character) || matches!(character, '/' | '\\' | ':'))
}

fn classify(command: &str) -> (String, EvidenceKind) {
    let lower = command.to_ascii_lowercase();
    if contains_any(&lower, &["a11y", "accessibility", "axe"]) {
        (format!("accessibility:{command}"), EvidenceKind::Browser)
    } else if contains_any(
        &lower,
        &["playwright", "cypress", "test:e2e", "test:browser", " e2e"],
    ) {
        (format!("browser:{command}"), EvidenceKind::Browser)
    } else if contains_any(
        &lower,
        &[
            "database",
            "migration",
            "postgres",
            "mysql",
            " db",
            ":db",
            "db:",
        ],
    ) {
        (format!("database:{command}"), EvidenceKind::Database)
    } else if contains_any(
        &lower,
        &["package:verify", "test:package", "artifact:verify"],
    ) {
        (format!("package:{command}"), EvidenceKind::Package)
    } else if contains_any(
        &lower,
        &["security", "audit", "vulnerab", "secret", "license"],
    ) {
        (format!("security:{command}"), EvidenceKind::Security)
    } else if contains_any(&lower, &["lint", "clippy", "format", " fmt"]) {
        (format!("lint:{command}"), EvidenceKind::Lint)
    } else if contains_any(&lower, &["build", "compile", "typecheck", " check"]) {
        (format!("build:{command}"), EvidenceKind::Build)
    } else if lower.contains("test") {
        (format!("test:{command}"), EvidenceKind::Test)
    } else {
        (format!("command:{command}"), EvidenceKind::Command)
    }
}

fn unavailable(name: &str, kind: EvidenceKind, reason: &str) -> VerificationGate {
    VerificationGate {
        executor: VerificationExecutor::Unavailable {
            reason: reason.to_owned(),
        },
        id: EvidenceId::new(),
        kind,
        mandatory: true,
        name: name.to_owned(),
        precondition: reason.to_owned(),
        risk: VerificationRisk::InternalInspection,
        timeout_seconds: 1,
    }
}

/// Every declared write scope, plus the files beneath any scope that names a
/// directory in the repository.
///
/// DEFECT-17: the mandatory browser and accessibility gates attach from the
/// architect's own wording of the scope. Declaring `public` rather than
/// `public/index.html` removed both, and an interface with two unnamed controls
/// passed every gate in its plan and was promoted. No deception is needed -
/// naming a directory as a write scope is an ordinary thing to do.
///
/// A scope is a claim about where the work may write, so a directory scope
/// covers every file under it. Expanding it here means the classification is
/// decided by what is actually in the tree rather than by how coarsely the
/// scope was phrased.
fn expanded_scopes(repository: &Path, architecture: &ArchitecturePlan) -> Vec<String> {
    const SCOPE_FILE_BUDGET: usize = 4_096;

    let mut scopes = Vec::new();
    for declared in architecture
        .tasks
        .iter()
        .flat_map(|task| task.write_scopes.iter())
    {
        let normalized = declared.to_ascii_lowercase().replace('\\', "/");
        scopes.push(normalized.clone());

        // A scope that resolves to a directory inside the repository stands for
        // the files under it. A scope that escapes the repository is ignored
        // here: it is the write-scope enforcement's business, not the plan's.
        let candidate = repository.join(normalized.trim_start_matches('/'));
        if !candidate.starts_with(repository) || !candidate.is_dir() {
            continue;
        }
        let mut pending = vec![candidate];
        while let Some(directory) = pending.pop() {
            if scopes.len() >= SCOPE_FILE_BUDGET {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                    continue;
                }
                if path.is_dir() {
                    pending.push(path);
                } else if let Ok(relative) = path.strip_prefix(repository) {
                    scopes.push(
                        relative
                            .to_string_lossy()
                            .to_ascii_lowercase()
                            .replace('\\', "/"),
                    );
                }
            }
        }
    }
    scopes
}

fn database_scope(scope: &str) -> bool {
    scope.ends_with(".sql")
        || contains_any(scope, &["database", "migrations", "schema", "/db", "db/"])
}

fn user_interface_scope(scope: &str) -> bool {
    [".css", ".html", ".jsx", ".svelte", ".tsx", ".vue"]
        .iter()
        .any(|extension| scope.ends_with(extension))
        || contains_any(scope, &["components", "frontend", "pages", "ui/"])
}

fn dependency_scope(scope: &str) -> bool {
    [
        "bun.lock",
        "bun.lockb",
        "cargo.lock",
        "cargo.toml",
        "composer.json",
        "composer.lock",
        "go.mod",
        "go.sum",
        "package-lock.json",
        "package.json",
        "pnpm-lock.yaml",
        "poetry.lock",
        "pom.xml",
        "pyproject.toml",
        "requirements.txt",
        "yarn.lock",
    ]
    .iter()
    .any(|name| scope.ends_with(name))
}

fn packaging_scope(scope: &str) -> bool {
    dependency_scope(scope)
        || contains_any(
            scope,
            &[
                "installer",
                "packaging",
                "release",
                "distribution",
                "dockerfile",
            ],
        )
}

fn contains_any(value: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|candidate| value.contains(candidate))
}

#[cfg(test)]
mod tests {
    use super::{VerificationPlanError, is_program_name, validate_command};

    #[test]
    fn an_environment_assignment_is_not_a_program() {
        // DEFECT-23, exactly as the live 1.0.5 certification found it: the gate
        // `CI=1 npm run check:changelog` splits into program `CI=1`, which the
        // 1.0.5 denylist accepted as a mandatory gate.
        assert!(!is_program_name("CI=1"));
        assert!(!is_program_name("FOO=bar"));
        assert_eq!(
            validate_command("CI=1", &["npm".to_owned(), "test".to_owned()]),
            Err(VerificationPlanError::InvalidCommand)
        );
    }

    #[test]
    fn ordinary_programs_and_paths_are_still_accepted() {
        for program in [
            "npm",
            "node",
            "cargo",
            "python3",
            "pnpm",
            "dotnet",
            "node.exe",
            "./scripts/check.sh",
            ".\\gradlew.bat",
            "C:\\tools\\node.exe",
        ] {
            assert!(is_program_name(program), "rejected {program}");
        }
        assert_eq!(validate_command("npm", &["test".to_owned()]), Ok(()));
    }

    #[test]
    fn shell_lines_and_empty_names_are_refused() {
        for program in [
            "",
            ".",
            "..",
            "npm test",
            "npm&&rm",
            "$(whoami)",
            "a|b",
            "say \"hi\"",
            "scripts/",
            "npm\n",
        ] {
            assert!(!is_program_name(program), "accepted {program}");
        }
    }
}
