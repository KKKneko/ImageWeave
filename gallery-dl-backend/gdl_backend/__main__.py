from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from .app import create_app
from .config import AppSettings, PROJECT_DIR


def main() -> None:
    parser = argparse.ArgumentParser(description="gallery-dl + native proxy backend")
    parser.add_argument("--config", help="JSON 配置文件路径")
    parser.add_argument("--host", help="覆盖监听地址")
    parser.add_argument("--port", type=int, help="覆盖监听端口")
    args = parser.parse_args()
    requested_config = args.config or os.environ.get("GDL_BACKEND_CONFIG")
    config_path = (
        Path(requested_config).expanduser().resolve()
        if requested_config
        else (PROJECT_DIR / "config.json")
    )
    if not config_path.is_file():
        parser.error(
            f"配置文件不存在：{config_path}；请先从仓库根目录运行 "
            "./scripts/setup-linux.sh --device cpu，或复制 config.example.json 后用 --config 指定"
        )
    settings = AppSettings.load(config_path)
    if args.host:
        settings.server.host = args.host
    if args.port:
        settings.server.port = args.port
    settings.validate()
    uvicorn.run(
        create_app(settings),
        host=settings.server.host,
        port=settings.server.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
