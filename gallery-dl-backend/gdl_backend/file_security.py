from __future__ import annotations

import getpass
import os
import secrets
import subprocess
from pathlib import Path
from typing import IO


PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def _reject_symlink(path: Path) -> None:
    """拒绝应用管理路径任一现有组件的符号链接（含已断开的链接）。"""

    path = Path(os.path.abspath(os.fspath(path)))
    for candidate in (*reversed(path.parents), path):
        if candidate.is_symlink():
            raise ValueError(f"应用管理路径不能包含符号链接: {candidate}")


def reject_symlink_path(path: Path) -> None:
    """公开的 no-follow 前置检查，供其他私有文件组件复用。"""

    _reject_symlink(Path(path))


def _apply_windows_acl(path: Path) -> None:
    username = os.environ.get("USERNAME") or getpass.getuser()
    domain = os.environ.get("USERDOMAIN")
    identity = f"{domain}\\{username}" if domain and username else username
    if not identity:
        raise PermissionError("无法识别当前 Windows 用户，未放宽敏感路径权限")
    inherit = "(OI)(CI)" if path.is_dir() else ""
    grants = (
        f"{identity}:{inherit}(F)",
        f"*S-1-5-18:{inherit}(F)",
        f"*S-1-5-32-544:{inherit}(F)",
    )
    try:
        result = subprocess.run(
            ["icacls.exe", str(path), "/inheritance:r", "/grant:r", *grants],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PermissionError(f"设置 Windows 敏感路径 ACL 失败: {path}") from exc
    if result.returncode != 0:
        raise PermissionError(f"设置 Windows 敏感路径 ACL 失败: {path}")


def secure_private_path(path: Path) -> None:
    """把应用管理目录/文件限制为当前用户；绝不跟随路径组件符号链接。"""

    path = Path(path)
    _reject_symlink(path)
    if not path.exists():
        return
    mode = PRIVATE_DIRECTORY_MODE if path.is_dir() else PRIVATE_FILE_MODE
    try:
        os.chmod(path, mode)
    except OSError as exc:
        raise PermissionError(f"无法收紧应用管理路径权限: {path}") from exc
    if os.name == "nt":
        _apply_windows_acl(path)


def ensure_private_directory(path: Path, *, repair_existing: bool = True) -> Path:
    """安全创建目录；仅在明确管理时修复已存在目录的权限。"""

    path = Path(path)
    _reject_symlink(path)
    existed = path.exists()
    try:
        path.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
    except OSError as exc:
        raise PermissionError(f"无法创建应用管理目录: {path}") from exc
    _reject_symlink(path)
    if not path.is_dir():
        raise ValueError(f"应用管理路径不是目录: {path}")
    if not existed or repair_existing:
        secure_private_path(path)
    return path


def ensure_private_file(path: Path) -> Path:
    """校验并收紧一个已存在的应用管理文件。"""

    path = Path(path)
    _reject_symlink(path)
    if not path.is_file():
        raise ValueError(f"应用管理路径不是文件: {path}")
    secure_private_path(path)
    return path


def open_private_binary(path: Path, *, append: bool = False) -> IO[bytes]:
    """以 0600 和 O_NOFOLLOW（平台支持时）打开应用管理二进制文件。"""

    path = Path(path)
    ensure_private_directory(path.parent)
    _reject_symlink(path)
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else os.O_TRUNC)
    flags |= int(getattr(os, "O_NOFOLLOW", 0))
    try:
        descriptor = os.open(path, flags, PRIVATE_FILE_MODE)
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, PRIVATE_FILE_MODE)
        else:
            os.chmod(path, PRIVATE_FILE_MODE)
        if os.name == "nt":
            _apply_windows_acl(path)
    except (OSError, PermissionError) as exc:
        if "descriptor" in locals():
            os.close(descriptor)
        raise PermissionError(f"无法安全打开应用管理文件: {path}") from exc
    return os.fdopen(descriptor, "ab" if append else "wb")


def write_private_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """通过同目录 0600 临时文件原子写入敏感文本。"""

    path = Path(path)
    ensure_private_directory(path.parent)
    _reject_symlink(path)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
    )
    _reject_symlink(temporary)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | int(getattr(os, "O_NOFOLLOW", 0))
    created = False
    try:
        descriptor = os.open(temporary, flags, PRIVATE_FILE_MODE)
        created = True
        with os.fdopen(descriptor, "w", encoding=encoding, newline="\n") as handle:
            handle.write(text)
        if os.name == "nt":
            _apply_windows_acl(temporary)
        _reject_symlink(path)
        os.replace(temporary, path)
        created = False
        secure_private_path(path)
    finally:
        if created:
            temporary.unlink(missing_ok=True)


def secure_sqlite_files(path: Path) -> None:
    """收紧 SQLite 主文件及当前存在的 WAL/SHM sidecar。"""

    path = Path(path)
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        _reject_symlink(candidate)
        if candidate.exists():
            secure_private_path(candidate)
