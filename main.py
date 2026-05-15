import asyncio
import base64
import json
import mimetypes
import os
import re
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from astrbot.api import logger, star
from astrbot.api.event import AstrMessageEvent, filter
import astrbot.api.message_components as Comp


@star.register("gpt_image2_napcat_bot", "yvzhu", "AstrBot 画图插件，消息以 #画图、画图、#生图、生图 开头时触发，回复图片时走编辑", "1.1.0")
class Main(star.Star):
    def __init__(self, context: star.Context, config=None) -> None:
        super().__init__(context)
        self.context = context
        self.config = config or {}

    @filter.regex(r"^(#画图|画图|#生图|生图)")
    async def draw(self, event: AstrMessageEvent):
        text = (event.message_str or "").strip()
        if not re.match(r"^(#画图|画图|#生图|生图)", text):
            return

        prompt, resolution = self._parse_prompt(text)
        if not prompt:
            yield event.plain_result("请在触发词后输入提示词。")
            return

        source_image_path = await self._get_replied_image_path(event)

        try:
            image_path = await asyncio.to_thread(
                self._create_image,
                prompt,
                resolution,
                source_image_path,
            )
            yield event.chain_result([
                Comp.Plain(f"你请求的 {prompt} 处理好了喵！"),
                Comp.Image.fromFileSystem(str(image_path)),
            ])
        except Exception as err:
            logger.error(f"draw failed: {err}")
            logger.error(traceback.format_exc())
            yield event.plain_result(f"图片处理失败了喵：{self._format_error(err)}")

    def _parse_prompt(self, text: str) -> tuple[str, str]:
        content = re.sub(r"^(#画图|画图|#生图|生图)", "", text, count=1).strip()
        resolution = "auto"
        lowered = content.lower()
        if "3k_v" in lowered:
            resolution = "1728x3072"
        elif "3k_h" in lowered:
            resolution = "3072x1728"

        prompt = re.sub(r"\b3k_[hv]\b", "", content, flags=re.IGNORECASE)
        prompt = re.sub(r"\s+", " ", prompt).strip()
        return prompt, resolution

    async def _get_replied_image_path(self, event: AstrMessageEvent) -> str | None:
        for segment in event.get_messages():
            if not isinstance(segment, Comp.Reply):
                continue

            for reply_segment in segment.chain or []:
                if isinstance(reply_segment, Comp.Image):
                    return await reply_segment.convert_to_file_path()

        return None

    def _create_image(self, prompt: str, resolution: str, source_image_path: str | None = None) -> Path:
        image_base64 = self._request_image_edit(prompt, source_image_path) if source_image_path else self._request_image_generation(prompt, resolution)
        if not image_base64:
            raise RuntimeError("No final image returned from image endpoint.")

        image_format = self._sanitize_extension(self._get_config("image_format", "IMAGE_FORMAT", "png"))
        output_dir = self._resolve_output_dir(self._get_config("output_dir", "OUTPUT_DIR", "data/gpt-image2-output"))
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"generated-{int(time.time() * 1000)}.{image_format}"
        output_path.write_bytes(base64.b64decode(self._normalize_base64(image_base64)))
        return output_path

    def _request_image_generation(self, prompt: str, resolution: str) -> str:
        api_key = self._get_config("openai_api_key", "OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError("Missing OPENAI_API_KEY or plugin config openai_api_key.")

        base_url = self._get_config("openai_base_url", "OPENAI_BASE_URL", "http://127.0.0.1:8317/v1").rstrip("/")
        image_model = self._get_config("image_model", "IMAGE_MODEL", "gpt-image-2")
        image_quality = self._get_config("image_quality", "IMAGE_QUALITY", "high")
        image_background = self._get_config("image_background", "IMAGE_BACKGROUND", "opaque")
        timeout_seconds = int(self._get_config("request_timeout", "IMAGE_REQUEST_TIMEOUT", 600))

        payload = {
            "model": image_model,
            "prompt": prompt,
            "n": 1,
            "quality": image_quality,
            "response_format": "b64_json",
            "background": image_background,
        }
        if resolution != "auto":
            payload["size"] = resolution

        request = urllib.request.Request(
            url=f"{base_url}/images/generations",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                response_body = response.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            error_body = err.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {err.code} {error_body}") from err

        response_json = json.loads(response_body)
        image_base64 = response_json.get("data", [{}])[0].get("b64_json") or response_json.get("data", [{}])[0].get("b64")
        if not image_base64:
            raise RuntimeError("No image base64 returned from /images/generations.")
        return image_base64

    def _request_image_edit(self, prompt: str, source_image_path: str | None) -> str:
        if not source_image_path:
            raise ValueError("Missing source image for edit request.")

        api_key = self._get_config("openai_api_key", "OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError("Missing OPENAI_API_KEY or plugin config openai_api_key.")

        base_url = self._get_config("openai_base_url", "OPENAI_BASE_URL", "http://127.0.0.1:8317/v1").rstrip("/")
        image_model = self._get_config("image_model", "IMAGE_MODEL", "gpt-image-2")
        timeout_seconds = int(self._get_config("request_timeout", "IMAGE_REQUEST_TIMEOUT", 600))

        body, content_type = self._build_multipart_body(
            {
                "model": image_model,
                "prompt": prompt,
                "n": 1,
                "response_format": "b64_json",
            },
            "image",
            source_image_path,
        )

        request = urllib.request.Request(
            url=f"{base_url}/images/edits",
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": content_type,
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                response_body = response.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            error_body = err.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {err.code} {error_body}") from err

        response_json = json.loads(response_body)
        image_base64 = response_json.get("data", [{}])[0].get("b64_json") or response_json.get("data", [{}])[0].get("b64")
        if not image_base64:
            raise RuntimeError("No image base64 returned from /images/edits.")
        return image_base64

    def _build_multipart_body(self, fields: dict[str, str | int], file_field_name: str, file_path: str) -> tuple[bytes, str]:
        boundary = f"----ClaudeCodeBoundary{uuid.uuid4().hex}"
        body = bytearray()

        for name, value in fields.items():
            body.extend(f"--{boundary}\r\n".encode("utf-8"))
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
            body.extend(str(value).encode("utf-8"))
            body.extend(b"\r\n")

        filename = Path(file_path).name.replace('"', '') or "image.png"
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        file_bytes = Path(file_path).read_bytes()

        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{file_field_name}"; filename="{filename}"\r\n'.encode("utf-8")
        )
        body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"))
        body.extend(file_bytes)
        body.extend(b"\r\n")
        body.extend(f"--{boundary}--\r\n".encode("utf-8"))

        return bytes(body), f"multipart/form-data; boundary={boundary}"

    def _get_config(self, config_key: str, env_key: str, default):
        value = None
        if isinstance(self.config, dict):
            value = self.config.get(config_key)
        if value in (None, ""):
            value = os.getenv(env_key)
        if value in (None, ""):
            return default
        return value

    def _resolve_output_dir(self, output_dir: str) -> Path:
        output_path = Path(output_dir)
        if output_path.is_absolute():
            return output_path
        return Path.cwd() / output_path

    def _sanitize_extension(self, value: str) -> str:
        normalized = str(value or "png").strip().lower()
        if re.fullmatch(r"[a-z0-9]+", normalized):
            return normalized
        return "png"

    def _normalize_base64(self, value: str) -> str:
        return re.sub(r"^data:image/[a-zA-Z0-9+.-]+;base64,", "", value).strip()

    def _format_error(self, err: Exception, max_length: int = 220) -> str:
        message = re.sub(r"\s+", " ", str(err or "未知错误")).strip()
        if len(message) <= max_length:
            return message
        return f"{message[:max_length]}..."
