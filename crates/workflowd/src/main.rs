use std::{ffi::OsString, path::PathBuf};

enum Command {
    Backup {
        data_directory: PathBuf,
        destination: PathBuf,
    },
    Serve {
        data_directory: PathBuf,
    },
    /// Prints the version this daemon was built from, and nothing else.
    ///
    /// The release check that compares a tracked daemon against the plugin
    /// manifest used to scan the binary for the expected version as a
    /// substring. In a 39 MB executable that string turns up by coincidence: a
    /// 1.0.5 daemon was reported as declaring 1.0.6 and passed the gate whose
    /// whole purpose is to stop an installation that cannot start. Asking the
    /// binary needs no data directory and no IPC handshake, and it cannot be
    /// satisfied by an accident of layout.
    Version,
}

#[tokio::main]
async fn main() {
    match parse_command(std::env::args_os().skip(1).collect()) {
        Ok(Command::Serve { data_directory }) => {
            if let Err(error) = workflowd::lifecycle::run(data_directory).await {
                eprintln!("workflowd failed: {error}");
                std::process::exit(1);
            }
        }
        Ok(Command::Backup {
            data_directory,
            destination,
        }) => {
            if let Err(error) = workflow_store::backup_existing_database(
                data_directory.join("control-plane.db"),
                destination,
            ) {
                eprintln!("workflowd backup failed: {error}");
                std::process::exit(1);
            }
        }
        Ok(Command::Version) => println!("{}", env!("CARGO_PKG_VERSION")),
        Err(error) => {
            eprintln!("workflowd failed: {error}");
            std::process::exit(2);
        }
    }
}

fn parse_command(arguments: Vec<OsString>) -> Result<Command, &'static str> {
    match arguments.as_slice() {
        [flag] if flag == "--version" => Ok(Command::Version),
        [flag, path] if flag == "--data-dir" => Ok(Command::Serve {
            data_directory: absolute(path)?,
        }),
        [data_flag, data_directory, backup_flag, destination]
            if data_flag == "--backup-data-dir" && backup_flag == "--backup-to" =>
        {
            Ok(Command::Backup {
                data_directory: absolute(data_directory)?,
                destination: absolute(destination)?,
            })
        }
        _ => Err(
            "expected --version, --data-dir <absolute-path> or --backup-data-dir <absolute-path> --backup-to <absolute-path>",
        ),
    }
}

fn absolute(path: &OsString) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(path);
    path.is_absolute()
        .then_some(path)
        .ok_or("path must be absolute")
}

#[cfg(test)]
mod tests {
    use super::{Command, parse_command};
    use std::ffi::OsString;

    #[test]
    fn backup_command_requires_two_explicit_absolute_paths() {
        let data_directory = std::env::temp_dir().join("zcode-cycle-backup-source");
        let destination = std::env::temp_dir().join("zcode-cycle-backup.db");
        let command = parse_command(vec![
            OsString::from("--backup-data-dir"),
            data_directory.into_os_string(),
            OsString::from("--backup-to"),
            destination.into_os_string(),
        ])
        .unwrap();
        assert!(matches!(command, Command::Backup { .. }));
        assert!(
            parse_command(vec![
                OsString::from("--backup-data-dir"),
                OsString::from("relative")
            ])
            .is_err()
        );
    }

    #[test]
    fn version_is_reported_without_a_data_directory() {
        assert!(matches!(
            parse_command(vec![OsString::from("--version")]).unwrap(),
            Command::Version
        ));
        // It answers on its own or not at all: a stray argument must not be
        // mistaken for a version query by a release check that trusts the answer.
        assert!(parse_command(vec![OsString::from("--version"), OsString::from("extra")]).is_err());
    }
}
