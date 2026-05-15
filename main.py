import asyncio
import base64
import json
import mimetypes
import os
import re
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from astrbot.api import logger, star
from astrbot.api.event import AstrMessageEvent, filter
import astrbot.api.message_components as Comp


@star.register("gpt_image2_napcat_bot", "yvzhu", "AstrBot 画图插件，消息以 #画图、画图、#生图、生图 开头时触发，回复图片时走编辑，可供其它插件调用生成图片", "1.1.1")
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

        temporary_source_image_paths = []

        try:
            source_image_paths = []
            replied_image_path = await self._get_replied_image_path(event)
            if replied_image_path:
                source_image_paths.append(replied_image_path)

            request_prompt = prompt
            if not source_image_paths:
                temporary_source_image_paths = await self._get_mentioned_avatar_paths(event)
                if temporary_source_image_paths:
                    source_image_paths = temporary_source_image_paths
                    request_prompt = self._append_mentioned_avatar_hint(prompt, len(source_image_paths))

            image_path = await self.generate_image(request_prompt, resolution, source_image_paths)
            yield event.chain_result([
                Comp.Plain(f"你请求的 {prompt} 处理好了喵！"),
                Comp.Image.fromFileSystem(str(image_path)),
            ])
        except Exception as err:
            logger.error(f"draw failed: {err}")
            logger.error(traceback.format_exc())
            yield event.plain_result(f"图片处理失败了喵：{self._format_error(err)}")
        finally:
            for temporary_source_image_path in temporary_source_image_paths:
                Path(temporary_source_image_path).unlink(missing_ok=True)

    async def generate_image(self, prompt: str, resolution: str = "auto", source_image_paths: list[str] | None = None) -> Path:
        normalized_prompt = re.sub(r"\s+", " ", str(prompt or "")).strip()
        if not normalized_prompt:
            raise ValueError("Missing prompt.")

        return await asyncio.to_thread(
            self._create_image,
            normalized_prompt,
            resolution,
            source_image_paths or [],
        )

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

    async def _get_mentioned_avatar_paths(self, event: AstrMessageEvent) -> list[str]:
        user_ids = self._get_mentioned_user_ids(event)
        avatar_paths = []
        try:
            for user_id in user_ids:
                avatar_paths.append(await asyncio.to_thread(self._download_qq_avatar, user_id))
        except Exception:
            for avatar_path in avatar_paths:
                Path(avatar_path).unlink(missing_ok=True)
            raise
        return avatar_paths

    def _get_mentioned_user_ids(self, event: AstrMessageEvent) -> list[str]:
        user_ids = []
        seen_user_ids = set()
        self_user_id = self._get_self_user_id(event)
        for segment in event.get_messages():
            user_id = self._get_at_user_id(segment)
            if not user_id or user_id.lower() == "all":
                continue
            if self_user_id and user_id == self_user_id:
                continue
            if user_id in seen_user_ids:
                continue
            seen_user_ids.add(user_id)
            user_ids.append(user_id)
        return user_ids

    def _get_at_user_id(self, segment) -> str | None:
        class_name = segment.__class__.__name__.lower()
        segment_type = str(self._get_segment_value(segment, "type") or "").lower()
        if class_name != "at" and segment_type != "at":
            return None

        for key in ("qq", "user_id", "uin", "target"):
            user_id = self._normalize_user_id(self._get_segment_value(segment, key))
            if user_id:
                return user_id

        data = self._get_segment_value(segment, "data")
        if isinstance(data, dict):
            for key in ("qq", "user_id", "uin", "target"):
                user_id = self._normalize_user_id(data.get(key))
                if user_id:
                    return user_id
        return None

    def _get_self_user_id(self, event: AstrMessageEvent) -> str | None:
        for key in ("get_self_id", "get_bot_id", "get_self_user_id"):
            value = self._get_segment_value(event, key)
            user_id = self._normalize_user_id(value)
            if user_id:
                return user_id

        message_obj = self._get_segment_value(event, "message_obj")
        for key in ("self_id", "bot_id"):
            user_id = self._normalize_user_id(self._get_segment_value(message_obj, key))
            if user_id:
                return user_id

        raw_message = self._get_segment_value(message_obj, "raw_message")
        if isinstance(raw_message, dict):
            for key in ("self_id", "bot_id"):
                user_id = self._normalize_user_id(raw_message.get(key))
                if user_id:
                    return user_id
        return None

    def _get_segment_value(self, target, key: str):
        if target is None:
            return None
        value = getattr(target, key, None)
        if callable(value):
            try:
                return value()
            except TypeError:
                return None
        return value

    def _normalize_user_id(self, value) -> str | None:
        if value in (None, ""):
            return None
        normalized = str(value).strip()
        return normalized or None

    def _download_qq_avatar(self, user_id: str) -> str:
        if not re.fullmatch(r"\d{5,20}", user_id):
            raise ValueError("Invalid mentioned QQ user id.")

        request = urllib.request.Request(
            url=f"https://q1.qlogo.cn/g?b=qq&nk={user_id}&s=640",
            headers={"User-Agent": "Mozilla/5.0"},
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            content_type = response.headers.get("Content-Type", "")
            image_bytes = response.read()

        if content_type and "image" not in content_type.lower():
            raise RuntimeError("Mentioned user avatar response is not an image.")
        if not image_bytes:
            raise RuntimeError("Mentioned user avatar is empty.")

        suffix = ".png" if "png" in content_type.lower() else ".jpg"
        with tempfile.NamedTemporaryFile(prefix=f"qq-avatar-{user_id}-", suffix=suffix, delete=False) as avatar_file:
            avatar_file.write(image_bytes)
            return avatar_file.name

    def _append_mentioned_avatar_hint(self, prompt: str, avatar_count: int) -> str:
        return f"{prompt}\n已提供 {avatar_count} 张参考图，依次对应消息中被 @ 的非机器人用户头像。如果这些参考图可以看作同一个形象，就使用这个形象；如果不是同一个形象，就分别作为熊猫表情包中的熊猫头参考。"

    def _create_image(self, prompt: str, resolution: str, source_image_paths: list[str] | None = None) -> Path:
        image_base64 = self._request_image_edit(prompt, source_image_paths) if source_image_paths else self._request_image_generation(prompt, resolution)
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

    def _request_image_edit(self, prompt: str, source_image_paths: list[str]) -> str:
        if not source_image_paths:
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
            source_image_paths,
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

    def _build_multipart_body(self, fields: dict[str, str | int], file_field_name: str, file_paths: list[str]) -> tuple[bytes, str]:
        boundary = f"----ClaudeCodeBoundary{uuid.uuid4().hex}"
        body = bytearray()

        for name, value in fields.items():
            body.extend(f"--{boundary}\r\n".encode("utf-8"))
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
            body.extend(str(value).encode("utf-8"))
            body.extend(b"\r\n")

        for file_path in file_paths:
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
