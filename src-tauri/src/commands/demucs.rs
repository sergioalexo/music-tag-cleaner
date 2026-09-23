//! Demucs stem separation as an optional managed component (v0.13).
//!
//! Demucs splits a track into drums / bass / vocals / other — the acapella
//! and instrumental a DJ actually wants for edits and mashups.
//!
//! Unlike FFmpeg and yt-dlp, Demucs is not a single downloadable binary: it
//! is a Python package that pulls in PyTorch, which is a multi-gigabyte
//! platform- and CUDA-specific install. Shipping our own Python runtime to
//! avoid that is a large amount of machinery that breaks in a new way on
//! every machine, so this module follows the same shape as the other
//! components instead — **detect, then offer to install into the Python you
//! already have**:
//!
//! - find a Python interpreter (`python`, `python3`, `py -3` on Windows),
//! - ask it whether `demucs` imports, and what torch says about CUDA,
//! - offer a one-click `pip install -U demucs`, streaming pip's output.
//!
//! Every invocation goes through `python -m demucs` rather than a `demucs`
//! console script: the script is only on `PATH` if the install put it there
//! (frequently not on Windows, and never for a `--user` install), while
//! `-m` works whenever the package is importable at all.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::ffmpeg::hide_console;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemucsInfo {
    /// A usable Python was found (says nothing about demucs itself).
    pub python_found: bool,
    pub python_path: Option<String>,
    pub python_version: Option<String>,
    /// `demucs` imports in that Python.
    pub installed: bool,
    pub demucs_version: Option<String>,
    pub torch_version: Option<String>,
    /// "cuda" when torch reports a working GPU, else "cpu". Separation on CPU
    /// works but is roughly an order of magnitude slower, so the UI says so.
    pub device: Option<String>,
    pub gpu_name: Option<String>,
}

/// Candidate interpreters, best first. `py -3` is the Windows launcher and is
/// the most reliable way to reach a store/installer Python that never made it
/// onto `PATH`.
#[cfg(target_os = "windows")]
const PYTHON_CANDIDATES: &[(&str, &[&str])] =
    &[("py", &["-3"]), ("python", &[]), ("python3", &[])];
#[cfg(not(target_os = "windows"))]
const PYTHON_CANDIDATES: &[(&str, &[&str])] = &[("python3", &[]), ("python", &[])];

/// One resolved interpreter: the executable plus any leading arguments it
/// needs (`py -3`). Kept together because every call site needs both.
#[derive(Debug, Clone)]
pub struct Python {
    pub exe: String,
    pub args: Vec<String>,
}

impl Python {
    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.args(&self.args);
        hide_console(&mut cmd);
        cmd
    }

    pub fn display(&self) -> String {
        if self.args.is_empty() {
            self.exe.clone()
        } else {
            format!("{} {}", self.exe, self.args.join(" "))
        }
    }
}

/// The JSON probe. One short-lived Python process answers everything the UI
/// needs, rather than four separate launches — each one costs ~200ms of
/// interpreter startup, and on Windows a torch import costs far more.
const PROBE_SRC: &str = r#"
import json, sys
out = {"python": sys.version.split()[0]}
try:
    import demucs
    out["demucs"] = getattr(demucs, "__version__", "unknown")
except Exception:
    out["demucs"] = None
try:
    import torch
    out["torch"] = torch.__version__
    if torch.cuda.is_available():
        out["device"] = "cuda"
        out["gpu"] = torch.cuda.get_device_name(0)
    else:
        out["device"] = "cpu"
except Exception:
    out["torch"] = None
    out["device"] = None
print(json.dumps(out))
"#;

fn probe(py: &Python) -> Option<serde_json::Value> {
    let mut cmd = py.command();
    cmd.args(["-c", PROBE_SRC]);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // torch and friends like to print warnings before our JSON, so take the
    // last non-empty line rather than the whole of stdout.
    let line = text.lines().rev().find(|l| l.trim_start().starts_with('{'))?;
    serde_json::from_str(line).ok()
}

/// Finds an interpreter that at least runs. Prefers one that already has
/// demucs: a machine can easily have three Pythons, and installing into the
/// first one found when a later one is already set up would be both slow and
/// confusing.
pub fn find_python() -> Option<(Python, serde_json::Value)> {
    let mut fallback: Option<(Python, serde_json::Value)> = None;
    for (exe, args) in PYTHON_CANDIDATES {
        let py = Python {
            exe: exe.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        };
        let Some(info) = probe(&py) else { continue };
        if info.get("demucs").and_then(|v| v.as_str()).is_some() {
            return Some((py, info));
        }
        if fallback.is_none() {
            fallback = Some((py, info));
        }
    }
    fallback
}

#[tauri::command]
pub async fn demucs_info() -> DemucsInfo {
    tauri::async_runtime::spawn_blocking(|| match find_python() {
        Some((py, info)) => {
            let demucs_version = info.get("demucs").and_then(|v| v.as_str()).map(String::from);
            DemucsInfo {
                python_found: true,
                python_path: Some(py.display()),
                python_version: info.get("python").and_then(|v| v.as_str()).map(String::from),
                installed: demucs_version.is_some(),
                demucs_version,
                torch_version: info.get("torch").and_then(|v| v.as_str()).map(String::from),
                device: info.get("device").and_then(|v| v.as_str()).map(String::from),
                gpu_name: info.get("gpu").and_then(|v| v.as_str()).map(String::from),
            }
        }
        None => DemucsInfo {
            python_found: false,
            python_path: None,
            python_version: None,
            installed: false,
            demucs_version: None,
            torch_version: None,
            device: None,
            gpu_name: None,
        },
    })
    .await
    .unwrap_or(DemucsInfo {
        python_found: false,
        python_path: None,
        python_version: None,
        installed: false,
        demucs_version: None,
        torch_version: None,
        device: None,
        gpu_name: None,
    })
}

fn emit_line(app: &AppHandle, event: &str, phase: &str, line: &str) {
    let _ = app.emit(
        event,
        serde_json::json!({ "phase": phase, "line": line }),
    );
}

/// Streams a child's stdout+stderr line by line into `event`.
///
/// pip and demucs both report progress on stderr and can run for many
/// minutes; buffering until exit would leave the UI frozen with no output,
/// which for a ten-minute torch download is indistinguishable from a hang.
fn run_streaming(
    app: &AppHandle,
    mut cmd: Command,
    event: &str,
    phase: &str,
) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Python: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut tail: Vec<String> = Vec::new();

    std::thread::scope(|s| {
        if let Some(out) = stdout {
            let app = app.clone();
            let event = event.to_string();
            let phase = phase.to_string();
            s.spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    emit_line(&app, &event, &phase, &line);
                }
            });
        }
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                emit_line(app, event, phase, &line);
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    // The last meaningful stderr line is almost always the actual error;
    // the exit code on its own tells the user nothing.
    let detail = tail
        .iter()
        .rev()
        .find(|l| !l.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("exited with {status}"));
    Err(detail)
}

/// `pip install -U demucs` into the detected interpreter.
///
/// `--upgrade` rather than a pinned version: demucs pulls the torch build
/// that matches the platform, and pinning here would mean shipping a matrix
/// of "which demucs works with which torch on which CUDA" that goes stale.
#[tauri::command]
pub async fn install_demucs(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (py, _) = find_python()
            .ok_or_else(|| "No Python found. Install Python 3.9+ and try again.".to_string())?;
        let mut cmd = py.command();
        cmd.args(["-m", "pip", "install", "-U", "demucs"]);
        // Unbuffered, so pip's progress reaches us while it downloads rather
        // than in one burst at the end.
        cmd.env("PYTHONUNBUFFERED", "1");
        run_streaming(&app, cmd, "demucs-install-progress", "installing")
    })
    .await
    .map_err(|_| "The demucs install task panicked".to_string())?
}

/// Everything the Stems dialog can set. Defaults mirror demucs' own, so an
/// untouched dialog behaves exactly like running `demucs file.mp3`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemOptions {
    /// Pretrained model name, e.g. "htdemucs", "htdemucs_ft", "htdemucs_6s".
    pub model: String,
    /// `None` for all stems; `Some("vocals")` for a two-stem
    /// vocals/no-vocals split (the acapella + instrumental case).
    pub two_stems: Option<String>,
    /// "wav" | "mp3" | "flac".
    pub format: String,
    /// Only meaningful for mp3.
    pub mp3_bitrate: u32,
    /// Random-shift averaging passes. Better separation, linearly slower.
    pub shifts: u32,
    /// Overlap between processing windows, 0.0-0.99.
    pub overlap: f32,
    /// "cuda" or "cpu".
    pub device: String,
    /// Parallel jobs. Only helps on CPU; on GPU it mostly causes OOM.
    pub jobs: u32,
    /// Where stems are written. Empty means a `stems` folder beside the source.
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemOutcome {
    pub source: String,
    pub ok: bool,
    /// The folder demucs wrote this track's stems into, on success.
    pub output_dir: Option<String>,
    pub error: Option<String>,
}

/// Demucs writes to `<out>/<model>/<track name>/<stem>.<ext>`. The model and
/// track-name segments are demucs' own layout, not ours, so this mirrors
/// them rather than trying to control them.
fn expected_output_dir(out_root: &Path, model: &str, source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    out_root.join(model).join(stem)
}

fn build_args(opts: &StemOptions, out_root: &Path, source: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-m".into(),
        "demucs".into(),
        "-n".into(),
        opts.model.clone(),
        "-o".into(),
        out_root.to_string_lossy().to_string(),
    ];
    if let Some(stem) = opts.two_stems.as_ref().filter(|s| !s.is_empty()) {
        args.push(format!("--two-stems={stem}"));
    }
    match opts.format.as_str() {
        "mp3" => {
            args.push("--mp3".into());
            args.push("--mp3-bitrate".into());
            args.push(opts.mp3_bitrate.to_string());
        }
        "flac" => args.push("--flac".into()),
        _ => {} // wav is demucs' default
    }
    if opts.shifts > 0 {
        args.push("--shifts".into());
        args.push(opts.shifts.to_string());
    }
    if opts.overlap > 0.0 {
        args.push("--overlap".into());
        args.push(format!("{:.2}", opts.overlap));
    }
    if !opts.device.is_empty() {
        args.push("-d".into());
        args.push(opts.device.clone());
    }
    // -j only helps on CPU; on CUDA it multiplies VRAM use and reliably OOMs
    // on consumer cards, so it is simply not passed there.
    if opts.jobs > 1 && opts.device != "cuda" {
        args.push("-j".into());
        args.push(opts.jobs.to_string());
    }
    args.push(source.to_string());
    args
}

/// Separates each file in turn.
///
/// Sequential on purpose: demucs already saturates the GPU (or every core
/// with `-j`), so running two at once makes both slower and, on CUDA, tends
/// to run the card out of memory. One failure doesn't stop the run — a
/// corrupt track in a batch of thirty shouldn't cost the other twenty-nine.
#[tauri::command]
pub async fn separate_stems(
    app: AppHandle,
    paths: Vec<String>,
    options: StemOptions,
) -> Result<Vec<StemOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (py, info) = find_python()
            .ok_or_else(|| "No Python found. Install Python 3.9+ and try again.".to_string())?;
        if info.get("demucs").and_then(|v| v.as_str()).is_none() {
            return Err("Demucs is not installed — install it on the Components page first."
                .to_string());
        }

        let total = paths.len();
        let mut results = Vec::with_capacity(total);

        for (i, source) in paths.iter().enumerate() {
            let src_path = Path::new(source);
            let out_root = if options.output_dir.trim().is_empty() {
                src_path
                    .parent()
                    .map(|p| p.join("stems"))
                    .unwrap_or_else(|| PathBuf::from("stems"))
            } else {
                PathBuf::from(options.output_dir.trim())
            };

            let _ = app.emit(
                "stems-progress",
                serde_json::json!({
                    "done": i, "total": total, "file": source, "phase": "separating"
                }),
            );

            if let Err(e) = std::fs::create_dir_all(&out_root) {
                results.push(StemOutcome {
                    source: source.clone(),
                    ok: false,
                    output_dir: None,
                    error: Some(format!("Could not create the output folder: {e}")),
                });
                continue;
            }

            let mut cmd = py.command();
            cmd.args(build_args(&options, &out_root, source));
            cmd.env("PYTHONUNBUFFERED", "1");

            match run_streaming(&app, cmd, "stems-progress", "separating") {
                Ok(()) => {
                    let dir = expected_output_dir(&out_root, &options.model, src_path);
                    results.push(StemOutcome {
                        source: source.clone(),
                        ok: true,
                        output_dir: Some(dir.to_string_lossy().to_string()),
                        error: None,
                    });
                }
                Err(e) => results.push(StemOutcome {
                    source: source.clone(),
                    ok: false,
                    output_dir: None,
                    error: Some(e),
                }),
            }
        }

        let _ = app.emit(
            "stems-progress",
            serde_json::json!({
                "done": total, "total": total,
                "file": serde_json::Value::Null, "phase": "done"
            }),
        );
        Ok(results)
    })
    .await
    .map_err(|_| "The stem separation task panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> StemOptions {
        StemOptions {
            model: "htdemucs".into(),
            two_stems: None,
            format: "wav".into(),
            mp3_bitrate: 320,
            shifts: 0,
            overlap: 0.25,
            device: "cpu".into(),
            jobs: 1,
            output_dir: String::new(),
        }
    }

    #[test]
    fn default_options_produce_a_plain_demucs_invocation() {
        let args = build_args(&opts(), Path::new("C:/out"), "C:/m/a.mp3");
        assert_eq!(args[0], "-m");
        assert_eq!(args[1], "demucs");
        assert!(args.contains(&"-n".to_string()));
        assert!(args.contains(&"htdemucs".to_string()));
        assert_eq!(args.last().unwrap(), "C:/m/a.mp3");
        // wav is demucs' own default, so no format flag should be passed.
        assert!(!args.iter().any(|a| a.starts_with("--mp3") || a == "--flac"));
        // shifts 0 means "don't average", which is the absence of the flag.
        assert!(!args.contains(&"--shifts".to_string()));
    }

    #[test]
    fn two_stem_mode_becomes_a_single_equals_flag() {
        let mut o = opts();
        o.two_stems = Some("vocals".into());
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        assert!(args.contains(&"--two-stems=vocals".to_string()));
    }

    #[test]
    fn an_empty_two_stems_string_is_not_a_two_stem_run() {
        let mut o = opts();
        o.two_stems = Some(String::new());
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        assert!(!args.iter().any(|a| a.starts_with("--two-stems")));
    }

    #[test]
    fn mp3_carries_its_bitrate_and_flac_does_not() {
        let mut o = opts();
        o.format = "mp3".into();
        o.mp3_bitrate = 256;
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        assert!(args.contains(&"--mp3".to_string()));
        assert!(args.contains(&"256".to_string()));

        o.format = "flac".into();
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        assert!(args.contains(&"--flac".to_string()));
        assert!(!args.contains(&"--mp3-bitrate".to_string()));
    }

    /// `-j` multiplies VRAM use and reliably runs consumer cards out of
    /// memory, so it must never reach a CUDA run however the dialog is set.
    #[test]
    fn jobs_are_dropped_on_cuda_but_kept_on_cpu() {
        let mut o = opts();
        o.jobs = 4;
        o.device = "cuda".into();
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        assert!(!args.contains(&"-j".to_string()));

        o.device = "cpu".into();
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        assert!(args.contains(&"-j".to_string()));
        assert!(args.contains(&"4".to_string()));
    }

    #[test]
    fn output_dir_mirrors_the_layout_demucs_actually_writes() {
        let dir = expected_output_dir(Path::new("C:/out"), "htdemucs", Path::new("C:/m/Gravity.mp3"));
        assert_eq!(dir, Path::new("C:/out").join("htdemucs").join("Gravity"));
    }

    #[test]
    fn shifts_and_overlap_are_formatted_the_way_demucs_parses_them() {
        let mut o = opts();
        o.shifts = 2;
        o.overlap = 0.5;
        let args = build_args(&o, Path::new("C:/out"), "a.mp3");
        let i = args.iter().position(|a| a == "--shifts").unwrap();
        assert_eq!(args[i + 1], "2");
        let j = args.iter().position(|a| a == "--overlap").unwrap();
        assert_eq!(args[j + 1], "0.50");
    }
}
