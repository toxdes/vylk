#!/usr/bin/env python3
import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

TARGETS = (
    ("linux", "amd64", ""),
    ("linux", "arm64", ""),
    ("darwin", "amd64", ""),
    ("darwin", "arm64", ""),
    ("windows", "amd64", ".exe"),
)
ARCHIVE_TARGETS = {
    ("darwin", "amd64"): ("macos", "amd64", "vylk"),
    ("darwin", "arm64"): ("macos", "arm64", "vylk"),
    ("windows", "amd64"): ("windows", "amd64", "vylk.exe"),
}


def build_binary(os_name, arch, version, output, upx):
    """Build one target binary and return its path."""
    if (os_name, arch) not in {(target[0], target[1]) for target in TARGETS}:
        raise ValueError(f"unsupported target combination: {os_name}/{arch}")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["GOOS"] = os_name
    env["GOARCH"] = arch
    env["CGO_ENABLED"] = "0"
    ldflags = f"-s -w -X vylk/internal/server.version={version}"
    cmd = [
        "go",
        "build",
        "-trimpath",
        "-ldflags",
        ldflags,
        "-o",
        str(output),
        "./cmd/vylk",
    ]
    print(f"building {output.name}...", end=" ", flush=True)
    result = subprocess.run(
        cmd, env=env, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        print("FAILED")
        print(result.stderr)
        raise SystemExit(1)
    print("ok")

    if upx and os_name == "linux":
        temporary = output.with_name(output.name + ".tmp")
        print("  compressing...", end=" ", flush=True)
        subprocess.run([upx, "-q", "-o", str(temporary), str(output)], check=True)
        os.replace(temporary, output)
        size = output.stat().st_size
        print(f"{size // 1024}K")
    return output


def archive_binary(binary, platform, arch, member, version, output_dir):
    """Place one binary in a Homebrew/direct-download-friendly ZIP."""
    archive = output_dir / f"vylk-{version}-{platform}-{arch}.zip"
    print(f"archiving {archive.name}...", end=" ", flush=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as file:
        file.write(binary, arcname=member)
    print("ok")


def build_all(version, output_dir, upx):
    """Build every supported target and archive non-Linux binaries."""
    output_dir.mkdir(parents=True, exist_ok=True)
    binaries = {}
    for os_name, arch, _extension in TARGETS:
        name = f"vylk_{os_name}_{arch}_{version}"
        if os_name == "windows":
            name += ".exe"
        binaries[(os_name, arch)] = build_binary(
            os_name, arch, version, output_dir / name, upx
        )

    for (os_name, arch), (platform, archive_arch, member) in ARCHIVE_TARGETS.items():
        archive_binary(
            binaries[(os_name, arch)],
            platform,
            archive_arch,
            member,
            version,
            output_dir,
        )
        if os_name == "darwin":
            binaries[(os_name, arch)].unlink()


def target_output(args, version):
    """Return the requested single-target output path."""
    if args.output:
        return Path(args.output)
    extension = ".exe" if args.target_os == "windows" else ""
    name = f"vylk_{args.target_os}_{args.target_arch}_{version}{extension}"
    return Path(args.output_dir) / name


def project_version():
    """Use Docker's VERSION argument when supplied, otherwise VERSION file."""
    return os.environ.get("VERSION") or Path("VERSION").read_text().strip()


def main():
    parser = argparse.ArgumentParser(
        description="Build Vylk binaries and direct-download archives."
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Build every supported target (the default).",
    )
    parser.add_argument(
        "--target-os",
        choices=sorted({target[0] for target in TARGETS}),
        help="Build one target OS for a packaging stage.",
    )
    parser.add_argument(
        "--target-arch",
        choices=sorted({target[1] for target in TARGETS}),
        help="Build one target architecture for a packaging stage.",
    )
    parser.add_argument(
        "--output-dir",
        default="dist",
        help="Directory for all-target output (default: dist).",
    )
    parser.add_argument(
        "--output",
        help="Output path for single-target mode.",
    )
    parser.add_argument(
        "--upx",
        choices=("auto", "never", "required"),
        default="auto",
        help="UPX policy for Linux binaries (default: auto).",
    )
    args = parser.parse_args()

    if bool(args.target_os) != bool(args.target_arch):
        parser.error("--target-os and --target-arch must be provided together")
    if args.all and args.target_os:
        parser.error("--all cannot be combined with single-target options")
    if args.output and not args.target_os:
        parser.error("--output requires single-target options")

    version = project_version()
    upx = None if args.upx == "never" else shutil.which("upx")
    if args.upx == "required" and not upx:
        parser.error("--upx required but UPX was not found")
    if args.target_os:
        if (args.target_os, args.target_arch) not in {
            (target[0], target[1]) for target in TARGETS
        }:
            parser.error(
                f"unsupported target combination: {args.target_os}/{args.target_arch}"
            )
        build_binary(
            args.target_os,
            args.target_arch,
            version,
            target_output(args, version),
            upx,
        )
    else:
        build_all(version, Path(args.output_dir), upx)


if __name__ == "__main__":
    sys.exit(main())
