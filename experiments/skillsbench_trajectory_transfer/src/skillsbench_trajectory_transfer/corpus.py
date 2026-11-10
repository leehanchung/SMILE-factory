"""Build matched, sanitized SkillsBench trajectory corpora.

The module contains provider adapters, leakage redaction, deterministic splitting and
matching, and assistant-only label construction. Importing it performs no network or
filesystem work. The command line consumes canonical trials that have already been
downloaded; model tokenizer loading is delayed until corpus construction starts.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol, TypedDict, cast

import yaml

JsonObject = dict[str, Any]

TOOL_TURN_BIN_EDGES = (5, 10, 20, 40)
CONTEXT_TOKEN_BIN_EDGES = (4096, 8192, 12288, 16384)
ASSISTANT_TOKEN_BIN_EDGES = (256, 512, 1024, 2048, 4096)
MATCHING_FIELDS = (
    "split",
    "domain",
    "difficulty",
    "source_model",
    "harness",
    "tool_turn_count_bin",
    "total_context_token_bin",
    "assistant_loss_token_bin",
)
REDACTION_MARKERS = (
    "[SKILL-DOCUMENT QUOTE REMOVED]",
    "[SKILL-PATH REFERENCE REMOVED]",
)
_SKILL_REFERENCE = re.compile(
    r"(?<![\w.-])\.?skills?(?:[/\\]|$)|SKILL\.md|effective_skills_dir|skills_sandbox_dir",
    re.IGNORECASE,
)
_THINK = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n(.*)\Z", re.DOTALL)
_CONTROL_TOKENS = ("<|im_start|>", "<|im_end|>")


class Tokenizer(Protocol):
    """Tokenizer surface used by this module (compatible with HF tokenizers)."""

    def apply_chat_template(self, conversation: list[JsonObject], **kwargs: Any) -> Any: ...

    def __call__(self, text: str, **kwargs: Any) -> Mapping[str, Any]: ...


class TaskMetadata(TypedDict):
    domain: str
    difficulty: str
    task_instruction: str


class UnsegmentableAssistantUnitError(ValueError):
    """An assistant action and its tool results cannot fit as one atomic unit."""


def canonical_json(value: Any) -> str:
    """Serialize JSON deterministically and compactly."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalize_text(text: str) -> str:
    """Case-fold text and collapse whitespace for leakage comparisons."""
    return " ".join(text.casefold().split())


def json_text(value: Any) -> str:
    """Extract visible text from common provider content shapes."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (json_text(item) for item in value)))
    if isinstance(value, dict):
        for key in ("text", "content"):
            if key in value:
                return json_text(value[key])
        return canonical_json(value)
    return str(value)


def strip_hidden_text(text: str) -> str:
    """Remove explicit thought blocks and neutralize injected template markers."""
    text = _THINK.sub("", text)
    for marker in _CONTROL_TOKENS:
        text = text.replace(marker, marker.replace("<|", "< |").replace("|>", "| >"))
    return text.strip()


def is_skill_reference(value: Any) -> bool:
    """Return whether a string or JSON value names a skill path/document."""
    probe = value if isinstance(value, str) else canonical_json(value)
    return bool(_SKILL_REFERENCE.search(probe))


def _arguments(value: Any) -> JsonObject:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {"raw": value}
    return value if isinstance(value, dict) else {"value": value}


def _call(name: str, arguments: Any, call_id: str) -> JsonObject:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": canonical_json(_arguments(arguments))},
    }


def _finish(call: Mapping[str, Any]) -> str:
    args = _arguments(cast(Mapping[str, Any], call.get("function", {})).get("arguments", {}))
    return strip_hidden_text(str(args.get("message") or args.get("summary") or ""))


def _normalized_tools(declarations: Iterable[Mapping[str, Any]]) -> list[JsonObject]:
    tools: list[JsonObject] = []
    for declaration in declarations:
        function = declaration.get("function", declaration)
        if not isinstance(function, Mapping) or not function.get("name"):
            continue
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": str(function["name"]),
                    "description": str(function.get("description", "")),
                    "parameters": function.get("parameters")
                    or function.get("parametersJsonSchema")
                    or {"type": "object", "properties": {}},
                },
            }
        )
    return tools


def normalize_openai_tools(raw: Any) -> list[JsonObject]:
    """Normalize OpenAI tool declarations to chat-template function tools."""
    return _normalized_tools(item for item in (raw or []) if isinstance(item, Mapping))


def normalize_bedrock_tools(raw: Any) -> list[JsonObject]:
    """Normalize Bedrock Converse tool declarations."""
    specs = []
    if isinstance(raw, Mapping):
        for item in raw.get("tools", []):
            if isinstance(item, Mapping) and isinstance(item.get("toolSpec"), Mapping):
                spec = dict(item["toolSpec"])
                schema = cast(Mapping[str, Any], spec.get("inputSchema", {})).get("json")
                spec["parameters"] = schema or {"type": "object", "properties": {}}
                specs.append(spec)
    return _normalized_tools(specs)


def normalize_gemini_tools(raw: Any) -> list[JsonObject]:
    """Normalize Gemini function declarations."""
    declarations: list[Mapping[str, Any]] = []
    for group in raw or []:
        if isinstance(group, Mapping):
            declarations.extend(
                group.get("functionDeclarations", []) or group.get("function_declarations", [])
            )
    return _normalized_tools(declarations)


def sanitize_openai_messages(raw_messages: Sequence[Mapping[str, Any]]) -> list[JsonObject]:
    """Convert OpenAI messages while dropping private roles and skill reads."""
    output: list[JsonObject] = []
    suppressed: set[str] = set()
    for raw in raw_messages:
        role = raw.get("role")
        if role in {"system", "developer"}:
            continue
        if role == "user":
            text = strip_hidden_text(json_text(raw.get("content")))
            if text:
                output.append({"role": "user", "content": text})
        elif role == "assistant":
            text = strip_hidden_text(json_text(raw.get("content")))
            calls: list[JsonObject] = []
            finals: list[str] = []
            for index, raw_call in enumerate(raw.get("tool_calls", []) or []):
                function = raw_call.get("function", {})
                name = str(function.get("name", ""))
                call_id = str(raw_call.get("id") or f"openai-{len(output)}-{index}")
                call = _call(name, function.get("arguments", {}), call_id)
                if name == "finish":
                    finals.append(_finish(call))
                elif is_skill_reference(call):
                    suppressed.add(call_id)
                else:
                    calls.append(call)
            text = "\n\n".join(filter(None, (text, *finals)))
            if text or calls:
                message: JsonObject = {"role": "assistant", "content": text}
                if calls:
                    message["tool_calls"] = calls
                output.append(message)
        elif role == "tool":
            call_id = str(raw.get("tool_call_id", ""))
            text = strip_hidden_text(json_text(raw.get("content")))
            if text and call_id not in suppressed and not is_skill_reference(text):
                message = {"role": "tool", "content": text}
                if call_id:
                    message["tool_call_id"] = call_id
                if raw.get("name"):
                    message["name"] = str(raw["name"])
                output.append(message)
    return output


def sanitize_gemini_messages(raw_contents: Sequence[Mapping[str, Any]]) -> list[JsonObject]:
    """Convert Gemini contents, excluding thoughts and skill call/result pairs."""
    output: list[JsonObject] = []
    suppressed: set[str] = set()
    pending: dict[str, list[str]] = defaultdict(list)
    for content_index, raw in enumerate(raw_contents):
        role = raw.get("role")
        parts = [part for part in (raw.get("parts") or []) if isinstance(part, Mapping)]
        if role == "model":
            texts: list[str] = []
            calls: list[JsonObject] = []
            for part_index, part in enumerate(parts):
                if (
                    "text" in part
                    and not part.get("thought")
                    and not any(key in part for key in ("thoughtSignature", "thought_signature"))
                ):
                    text = strip_hidden_text(str(part.get("text", "")))
                    if text:
                        texts.append(text)
                function = part.get("functionCall") or part.get("function_call")
                if isinstance(function, Mapping):
                    name = str(function.get("name", ""))
                    call_id = str(
                        function.get("id") or f"gemini-{content_index}-{part_index}-{name}"
                    )
                    call = _call(name, function.get("args", {}), call_id)
                    if name == "finish":
                        texts.append(_finish(call))
                    elif is_skill_reference(call):
                        suppressed.add(call_id)
                    else:
                        calls.append(call)
                        pending[name].append(call_id)
            if any(texts) or calls:
                message = {"role": "assistant", "content": "\n\n".join(filter(None, texts))}
                if calls:
                    message["tool_calls"] = calls
                output.append(message)
        elif role == "user":
            user_texts: list[str] = []
            results: list[JsonObject] = []
            for part in parts:
                if "text" in part:
                    text = strip_hidden_text(str(part.get("text", "")))
                    if text:
                        user_texts.append(text)
                response = part.get("functionResponse") or part.get("function_response")
                if isinstance(response, Mapping):
                    name = str(response.get("name", ""))
                    call_id = str(response.get("id", ""))
                    if not call_id and pending[name]:
                        call_id = pending[name].pop(0)
                    text = strip_hidden_text(json_text(response.get("response", {})))
                    if text and call_id not in suppressed and not is_skill_reference(text):
                        result: JsonObject = {"role": "tool", "content": text}
                        if call_id:
                            result["tool_call_id"] = call_id
                        if name:
                            result["name"] = name
                        results.append(result)
            if user_texts:
                output.append({"role": "user", "content": "\n\n".join(user_texts)})
            output.extend(results)
    return output


def sanitize_bedrock_messages(raw_messages: Sequence[Mapping[str, Any]]) -> list[JsonObject]:
    """Convert Bedrock Converse messages, excluding reasoning and skill reads."""
    output: list[JsonObject] = []
    suppressed: set[str] = set()
    for raw in raw_messages:
        role = raw.get("role")
        blocks = [block for block in (raw.get("content") or []) if isinstance(block, Mapping)]
        if role == "assistant":
            texts: list[str] = []
            calls: list[JsonObject] = []
            for index, block in enumerate(blocks):
                if "reasoningContent" in block or "redactedContent" in block:
                    continue
                if "text" in block:
                    text = strip_hidden_text(str(block.get("text", "")))
                    if text:
                        texts.append(text)
                use = block.get("toolUse")
                if isinstance(use, Mapping):
                    name = str(use.get("name", ""))
                    call_id = str(use.get("toolUseId") or f"bedrock-{len(output)}-{index}")
                    call = _call(name, use.get("input", {}), call_id)
                    if name == "finish":
                        texts.append(_finish(call))
                    elif is_skill_reference(call):
                        suppressed.add(call_id)
                    else:
                        calls.append(call)
            if any(texts) or calls:
                message = {"role": "assistant", "content": "\n\n".join(filter(None, texts))}
                if calls:
                    message["tool_calls"] = calls
                output.append(message)
        elif role == "user":
            user_texts: list[str] = []
            for block in blocks:
                if "text" in block:
                    text = strip_hidden_text(str(block.get("text", "")))
                    if text:
                        user_texts.append(text)
                    continue
                result = block.get("toolResult")
                if isinstance(result, Mapping):
                    if user_texts:
                        output.append({"role": "user", "content": "\n\n".join(user_texts)})
                        user_texts = []
                    call_id = str(result.get("toolUseId", ""))
                    text = strip_hidden_text(json_text(result.get("content")))
                    if text and call_id not in suppressed and not is_skill_reference(text):
                        message = {"role": "tool", "content": text}
                        if call_id:
                            message["tool_call_id"] = call_id
                        output.append(message)
            if user_texts:
                output.append({"role": "user", "content": "\n\n".join(user_texts)})
    return output


def validate_sanitized_messages(messages: Sequence[Mapping[str, Any]]) -> None:
    """Reject hidden-reasoning keys, private roles, and raw template markers."""
    forbidden = {
        "reasoning_content",
        "reasoningContent",
        "encrypted_content",
        "encrypted_reasoning",
        "thinking_blocks",
        "provider_specific_fields",
    }

    def keys(value: Any) -> Iterator[str]:
        if isinstance(value, Mapping):
            for key, child in value.items():
                yield str(key)
                yield from keys(child)
        elif isinstance(value, list):
            for child in value:
                yield from keys(child)

    for message in messages:
        if message.get("role") in {"system", "developer"}:
            raise ValueError("private-role message survived sanitization")
        leaked = forbidden.intersection(keys(message))
        if leaked:
            raise ValueError(f"hidden-reasoning keys survived: {sorted(leaked)}")
        serialized = canonical_json(message).casefold()
        if "<think>" in serialized or any(marker in serialized for marker in _CONTROL_TOKENS):
            raise ValueError("hidden text or chat-template control token survived")


def _completed_records(records: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [
        record
        for record in records
        if record.get("request", {}).get("method") == "POST"
        and isinstance(record.get("request", {}).get("body"), Mapping)
        and isinstance(record.get("response", {}).get("body"), Mapping)
    ]


def parse_trajectory_records(
    records: Sequence[Mapping[str, Any]],
) -> tuple[list[JsonObject], list[JsonObject], str, JsonObject]:
    """Parse canonical HTTP records using the final complete provider history."""
    completed = _completed_records(records)
    supported: list[tuple[str, Mapping[str, Any]]] = []
    for record in completed:
        path = str(record["request"].get("path", ""))
        response = record["response"]["body"]
        if path == "/v1/chat/completions" and "choices" in response:
            supported.append(("openai_chat_completions", record))
        elif path.endswith("/converse") and "output" in response:
            supported.append(("bedrock_converse", record))
        elif path.endswith(":generateContent") and "candidates" in response:
            supported.append(("gemini_generate_content", record))
    if not supported:
        raise ValueError("trajectory has no supported completed provider request")
    adapter, record = supported[-1]
    request = record["request"]["body"]
    response = record["response"]["body"]
    if adapter == "openai_chat_completions":
        history = list(request.get("messages") or [])
        choices = response.get("choices") or []
        if choices and isinstance(choices[0].get("message"), Mapping):
            history.append(choices[0]["message"])
        messages = sanitize_openai_messages(history)
        tools = normalize_openai_tools(request.get("tools"))
        length_key = "messages"
    elif adapter == "bedrock_converse":
        history = list(request.get("messages") or [])
        final = response.get("output", {}).get("message")
        if isinstance(final, Mapping):
            history.append(final)
        messages = sanitize_bedrock_messages(history)
        tools = normalize_bedrock_tools(request.get("toolConfig"))
        length_key = "messages"
    else:
        history = list(request.get("contents") or [])
        candidates = response.get("candidates") or []
        if candidates and isinstance(candidates[0].get("content"), Mapping):
            history.append(candidates[0]["content"])
        messages = sanitize_gemini_messages(history)
        cached_tools = None
        for earlier in completed:
            earlier_path = str(earlier["request"].get("path", ""))
            if earlier_path.endswith(":cachedContents"):
                cached_tools = earlier["request"]["body"].get("tools") or cached_tools
        tools = normalize_gemini_tools(request.get("tools") or cached_tools)
        length_key = "contents"
    if not messages or messages[0].get("role") != "user":
        raise ValueError("sanitized trajectory must begin with a user message")
    if not any(message.get("role") == "assistant" for message in messages):
        raise ValueError("sanitized trajectory has no assistant action")
    validate_sanitized_messages(messages)
    protocol = [pair for pair in supported if pair[0] == adapter]
    lengths = [len(pair[1]["request"]["body"].get(length_key, [])) for pair in protocol]
    decreases = sum(right < left for left, right in zip(lengths, lengths[1:], strict=False))
    audit: JsonObject = {
        "completed_model_calls": len(protocol),
        "history_lengths": lengths,
        "history_length_decreases": decreases,
        "history_compaction_suspected": bool(decreases),
        "sanitized_message_count": len(messages),
        "sanitized_assistant_message_count": sum(m.get("role") == "assistant" for m in messages),
    }
    return messages, tools, adapter, audit


def parse_llm_trajectory(path: Path) -> tuple[list[JsonObject], list[JsonObject], str, JsonObject]:
    """Read JSONL HTTP records and pass them to :func:`parse_trajectory_records`."""
    with path.open(encoding="utf-8") as handle:
        records = [json.loads(line) for line in handle if line.strip()]
    return parse_trajectory_records(records)


def parse_task_metadata(tasks_root: Path) -> dict[str, TaskMetadata]:
    """Read task frontmatter; ``tasks_root`` may be the tasks directory or its parent."""
    root = tasks_root / "tasks" if (tasks_root / "tasks").is_dir() else tasks_root
    output: dict[str, TaskMetadata] = {}
    for task_file in sorted(root.glob("*/task.md")):
        text = task_file.read_text(encoding="utf-8")
        match = _FRONTMATTER.match(text)
        frontmatter = yaml.safe_load(match.group(1)) if match else {}
        metadata = (frontmatter or {}).get("metadata", {})
        instruction = match.group(2).strip() if match else text.strip()
        output[task_file.parent.name] = {
            "domain": str(metadata.get("category", "unknown")),
            "difficulty": str(metadata.get("difficulty", "unknown")),
            "task_instruction": instruction,
        }
    return output


def _small_utf8(path: Path) -> str | None:
    if not path.is_file() or path.stat().st_size > 1_000_000:
        return None
    data = path.read_bytes()
    if b"\0" in data:
        return None
    try:
        return data.decode()
    except UnicodeDecodeError:
        return None


def load_skill_document_chunks(
    skills_root: Path,
    *,
    tasks_root: Path | None = None,
    chunk_chars: int = 160,
    stride_chars: int = 80,
) -> dict[str, list[str]]:
    """Load normalized skill chunks, subtracting text visible in ordinary task inputs."""
    if (skills_root / "tasks").is_dir():
        tasks_root = skills_root / "tasks"
        skill_dirs = {
            path.name: path / "environment" / "skills"
            for path in tasks_root.iterdir()
            if path.is_dir()
        }
    else:
        skill_dirs = {path.name: path for path in skills_root.iterdir() if path.is_dir()}
    task_base = None
    if tasks_root is not None:
        task_base = tasks_root / "tasks" if (tasks_root / "tasks").is_dir() else tasks_root
    output: dict[str, list[str]] = {}
    for task_id, directory in sorted(skill_dirs.items()):
        if not directory.is_dir():
            continue
        baseline_parts: list[str] = []
        if task_base is not None and (task_base / task_id).is_dir():
            task_dir = task_base / task_id
            for path in sorted(task_dir.glob("**/*")):
                if "skills" in path.parts:
                    continue
                text = _small_utf8(path)
                if text is not None:
                    baseline_parts.append(text)
        baseline = normalize_text("\n".join(baseline_parts))
        chunks: list[str] = []
        for path in sorted(directory.glob("**/*")):
            text = _small_utf8(path)
            if text is None:
                continue
            normalized = normalize_text(text)
            if len(normalized) < chunk_chars:
                candidates = [normalized] if len(normalized) >= 80 else []
            else:
                candidates = [
                    normalized[start : start + chunk_chars]
                    for start in range(0, len(normalized) - chunk_chars + 1, stride_chars)
                ]
            chunks.extend(chunk for chunk in candidates if chunk and chunk not in baseline)
        output[task_id] = list(dict.fromkeys(chunks))
    return output


def _string_fields(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        if value:
            yield value
    elif isinstance(value, Mapping):
        for key, child in value.items():
            yield str(key)
            yield from _string_fields(child)
    elif isinstance(value, list):
        for child in value:
            yield from _string_fields(child)


def _message_texts(message: Mapping[str, Any]) -> Iterator[str]:
    yield from _string_fields(message.get("content"))
    for call in message.get("tool_calls", []) or []:
        function = call.get("function", {})
        yield str(function.get("name", ""))
        yield from _string_fields(_arguments(function.get("arguments", "")))


def scan_retained_skill_text(
    messages: Sequence[Mapping[str, Any]], chunks: Sequence[str]
) -> dict[str, int]:
    """Count explicit path references and known verbatim skill chunks."""
    paths = 0
    chunk_hits = 0
    for message in messages:
        for text in _message_texts(message):
            paths += int(is_skill_reference(text))
            normalized = normalize_text(text)
            chunk_hits += sum(bool(chunk and chunk in normalized) for chunk in chunks)
    return {"path_reference_hits": paths, "known_skill_document_chunk_hits": chunk_hits}


def _redact_chunks(text: str, chunks: Sequence[str]) -> tuple[str, int]:
    # Work on whitespace-delimited spans so normalization differences do not erase context.
    words = list(re.finditer(r"\S+", text))
    normalized = normalize_text(text)
    ranges: list[tuple[int, int]] = []
    for chunk in chunks:
        start = normalized.find(chunk)
        while start >= 0:
            first_word = normalized[:start].count(" ")
            last_word = normalized[: start + len(chunk)].count(" ")
            if first_word < len(words):
                ranges.append(
                    (words[first_word].start(), words[min(last_word, len(words) - 1)].end())
                )
            start = normalized.find(chunk, start + 1)
    merged: list[list[int]] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    for start, end in reversed(merged):
        text = text[:start] + REDACTION_MARKERS[0] + text[end:]
    return text, len(merged)


def _redact_value(value: Any, chunks: Sequence[str]) -> tuple[Any, int]:
    if isinstance(value, str):
        return _redact_chunks(value, chunks)
    if isinstance(value, list):
        output, count = [], 0
        for child in value:
            child, hits = _redact_value(child, chunks)
            output.append(child)
            count += hits
        return output, count
    if isinstance(value, dict):
        output, count = {}, 0
        for key, child in value.items():
            child, hits = _redact_value(child, chunks)
            output[key] = child
            count += hits
        return output, count
    return value, 0


def _redact_path_lines(text: str) -> tuple[str, int]:
    lines = text.splitlines(keepends=True) or [text]
    hits = 0
    output: list[str] = []
    for line in lines:
        if is_skill_reference(line):
            hits += 1
            output.append(REDACTION_MARKERS[1] + ("\n" if line.endswith(("\n", "\r")) else ""))
        else:
            output.append(line)
    return "".join(output).strip(), hits


def remove_skill_leakage(
    messages: Sequence[Mapping[str, Any]], chunks: Sequence[str]
) -> tuple[list[JsonObject], dict[str, int]]:
    """Redact skill exposure while retaining unrelated assistant actions."""
    cleaned = copy.deepcopy(list(messages))
    dropped: set[str] = set()
    for message in cleaned:
        if message.get("role") == "assistant":
            for call in message.get("tool_calls", []) or []:
                if any(is_skill_reference(text) for text in _message_texts({"tool_calls": [call]})):
                    dropped.add(str(call.get("id", "")))
    audit: Counter[str] = Counter()
    output: list[JsonObject] = []
    for message in cleaned:
        role = str(message.get("role", ""))
        if role == "tool" and str(message.get("tool_call_id", "")) in dropped:
            audit["removed_tool_messages"] += 1
            continue
        calls = message.get("tool_calls") or []
        if role == "assistant" and calls:
            kept = [call for call in calls if str(call.get("id", "")) not in dropped]
            audit["removed_tool_calls"] += len(calls) - len(kept)
            for call in kept:
                function = call["function"]
                original = function.get("arguments", "")
                parsed = _arguments(original)
                redacted, hits = _redact_value(parsed, chunks)
                audit["skill_chunk_spans_redacted_tool_arguments"] += hits
                function["arguments"] = (
                    canonical_json(redacted) if isinstance(original, str) else redacted
                )
            if kept:
                message["tool_calls"] = kept
            else:
                message.pop("tool_calls", None)
        content, path_hits = _redact_path_lines(str(message.get("content", "")))
        content, chunk_hits = _redact_chunks(content, chunks)
        message["content"] = content
        audit[f"path_lines_redacted_{role}"] += path_hits
        audit[f"skill_chunk_spans_redacted_{role}"] += chunk_hits
        if not content and not message.get("tool_calls"):
            audit[f"removed_empty_{role}_messages"] += 1
            continue
        output.append(cast(JsonObject, message))
    audit["removed_call_result_pair_ids"] = len(dropped)
    return output, dict(audit)


def assign_task_splits(
    task_metadata: Mapping[str, TaskMetadata | Mapping[str, str]],
    seed: int,
    fractions: Mapping[str, float],
) -> dict[str, str]:
    """Assign whole tasks to deterministic domain/difficulty-stratified splits."""
    if set(fractions) != {"train", "validation", "audit"}:
        raise ValueError("fractions must define train, validation, and audit")
    if abs(sum(fractions.values()) - 1.0) > 1e-9:
        raise ValueError("split fractions must sum to one")
    strata: dict[tuple[str, str], list[str]] = defaultdict(list)
    for task_id, metadata in task_metadata.items():
        strata[(metadata["domain"], metadata["difficulty"])].append(task_id)
    result: dict[str, str] = {}
    for stratum, task_ids in sorted(strata.items()):
        ordered = sorted(
            task_ids, key=lambda item: hashlib.sha256(f"{seed}:{stratum}:{item}".encode()).digest()
        )
        count = len(ordered)
        train_count = round(count * fractions["train"])
        validation_count = round(count * fractions["validation"])
        if count >= 3:
            train_count = min(max(train_count, 1), count - 2)
            validation_count = min(max(validation_count, 1), count - train_count - 1)
        else:
            train_count = min(count, max(1, train_count))
            validation_count = min(count - train_count, validation_count)
        for index, task_id in enumerate(ordered):
            result[task_id] = (
                "train"
                if index < train_count
                else "validation"
                if index < train_count + validation_count
                else "audit"
            )
    return result


def fixed_bin(value: int, edges: Sequence[int]) -> str:
    """Map a non-negative integer into stable inclusive bins."""
    if value < 0:
        raise ValueError("bin values must be non-negative")
    lower = 0
    for edge in edges:
        if value <= edge:
            return f"{lower}-{edge}"
        lower = edge + 1
    return f"{lower}+"


def matching_key(row: Mapping[str, Any]) -> tuple[Any, ...]:
    """Return the fixed matching key used for both corpus conditions."""
    return tuple(row[field] for field in MATCHING_FIELDS)


def deterministic_order(row: Mapping[str, Any], seed: int) -> str:
    identity = f"{seed}:{row['source_path']}:{row['segment_index']}"
    return hashlib.sha256(identity.encode()).hexdigest()


def mask_row_to_budget(row: JsonObject, budget: int, seed: int) -> int:
    """Deterministically retain exactly ``budget`` supervised tokens in a row."""
    active = [index for index, label in enumerate(row["labels"]) if label != -100]
    if budget <= 0 or budget > len(active):
        raise ValueError(f"invalid budget {budget} for {len(active)} supervised tokens")
    if budget < len(active):
        identity = (
            f"{seed}:{row.get('condition')}:{row.get('source_path')}:{row.get('segment_index')}"
        )
        rng = random.Random(int(hashlib.sha256(identity.encode()).hexdigest()[:16], 16))
        keep = set(rng.sample(active, budget))
        for index in active:
            if index not in keep:
                row["labels"][index] = -100
    row["loss_tokens"] = budget
    return len(active) - budget


def mask_to_budget(rows: list[JsonObject], budget: int, seed: int = 17) -> int:
    """Distribute a token budget without creating zero-supervision rows."""
    counts = [sum(label != -100 for label in row["labels"]) for row in rows]
    if any(count == 0 for count in counts):
        raise ValueError("input contains a zero-supervision row")
    if budget < len(rows) or budget > sum(counts):
        raise ValueError("budget cannot retain at least one and at most all supervised tokens")
    quotas = [1] * len(rows)
    remaining = budget - len(rows)
    while remaining:
        for index, count in enumerate(counts):
            if remaining and quotas[index] < count:
                quotas[index] += 1
                remaining -= 1
    return sum(
        mask_row_to_budget(row, quota, seed) for row, quota in zip(rows, quotas, strict=True)
    )


def select_matched_rows(
    rows: list[JsonObject], seed: int, max_train_loss_tokens: int
) -> tuple[dict[str, list[JsonObject]], JsonObject]:
    """Match conditions on fixed bins and equalize pairwise supervision budgets."""
    grouped: dict[tuple[Any, ...], dict[str, list[JsonObject]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in rows:
        grouped[matching_key(row)][row["condition"]].append(row)
    pairs: dict[str, list[tuple[JsonObject, JsonObject]]] = defaultdict(list)
    unmatched: Counter[str] = Counter()
    for key, conditions in sorted(grouped.items(), key=lambda item: repr(item[0])):
        without = sorted(
            conditions.get("no_skill_success", []), key=lambda row: deterministic_order(row, seed)
        )
        with_skill = sorted(
            conditions.get("with_skill_success", []), key=lambda row: deterministic_order(row, seed)
        )
        size = min(len(without), len(with_skill))
        pairs[str(key[0])].extend(zip(without[:size], with_skill[:size], strict=True))
        unmatched["no_skill_success"] += len(without) - size
        unmatched["with_skill_success"] += len(with_skill) - size
    selected: dict[str, list[JsonObject]] = defaultdict(list)
    summaries: JsonObject = {}
    for split, split_pairs in sorted(pairs.items()):
        split_pairs.sort(
            key=lambda pair: hashlib.sha256(
                f"{seed}:{pair[0]['source_path']}:{pair[1]['source_path']}".encode()
            ).digest()
        )
        cap = max_train_loss_tokens if split == "train" else 2**63 - 1
        spent = 0
        masked: Counter[str] = Counter()
        for pair_index, pair in enumerate(split_pairs):
            pair_budget = min(int(pair[0]["loss_tokens"]), int(pair[1]["loss_tokens"]), cap - spent)
            if pair_budget <= 0:
                break
            pair_id = hashlib.sha256(
                f"{seed}:{split}:{pair_index}:{pair[0]['source_path']}:{pair[1]['source_path']}".encode()
            ).hexdigest()[:16]
            for condition, original in zip(
                ("no_skill_success", "with_skill_success"), pair, strict=True
            ):
                row = copy.deepcopy(original)
                masked[condition] += mask_row_to_budget(row, pair_budget, seed)
                row["match_pair_id"] = pair_id
                selected[f"{split}:{condition}"].append(row)
            spent += pair_budget
        if spent:
            summaries[split] = {
                "matched_pairs": len(selected[f"{split}:no_skill_success"]),
                "loss_token_budget_per_condition": spent,
                "budget_masked_tokens": dict(masked),
                "identical_row_counts": True,
                "pairwise_equal_supervision": True,
            }
    return dict(selected), {"unmatched_segments": dict(unmatched), "splits": summaries}


def _render_ids(
    tokenizer: Tokenizer, messages: Sequence[JsonObject], tools: Sequence[JsonObject]
) -> list[int]:
    rendered = tokenizer.apply_chat_template(
        list(messages),
        tools=list(tools) or None,
        tokenize=True,
        add_generation_prompt=False,
        enable_thinking=False,
    )
    if isinstance(rendered, Mapping):
        rendered = rendered["input_ids"]
    if hasattr(rendered, "tolist"):
        rendered = rendered.tolist()
    if rendered and isinstance(rendered[0], list):
        rendered = rendered[0]
    return list(rendered)


def _mask_redaction_placeholders(
    rendered: str, offsets: Sequence[tuple[int, int]], labels: list[int]
) -> int:
    spans = [
        (start, start + len(marker))
        for marker in REDACTION_MARKERS
        for start in _find_all(rendered, marker)
    ]
    masked = 0
    for index, (start, end) in enumerate(offsets):
        if labels[index] != -100 and any(start < right and end > left for left, right in spans):
            labels[index] = -100
            masked += 1
    return masked


def _find_all(text: str, needle: str) -> Iterator[int]:
    start = text.find(needle)
    while start >= 0:
        yield start
        start = text.find(needle, start + len(needle))


def tokenize_with_assistant_mask(
    tokenizer: Tokenizer, messages: Sequence[JsonObject], tools: Sequence[JsonObject]
) -> tuple[list[int], list[int], int]:
    """Tokenize Qwen-style chat and label only assistant bodies/end markers."""
    rendered = tokenizer.apply_chat_template(
        list(messages),
        tools=list(tools) or None,
        tokenize=False,
        add_generation_prompt=False,
        enable_thinking=False,
    )
    if not isinstance(rendered, str):
        raise TypeError("chat template did not render text")
    start_marker, end_marker = "<|im_start|>assistant\n", "<|im_end|>"
    spans: list[tuple[int, int]] = []
    cursor = 0
    for _ in range(sum(message.get("role") == "assistant" for message in messages)):
        start = rendered.find(start_marker, cursor)
        if start < 0:
            raise ValueError("assistant marker count does not match messages")
        start += len(start_marker)
        end = rendered.find(end_marker, start)
        if end < 0:
            raise ValueError("assistant turn lacks an end marker")
        spans.append((start, end + len(end_marker)))
        cursor = end + len(end_marker)
    if rendered.find(start_marker, cursor) >= 0:
        raise ValueError("rendered assistant marker count exceeds messages")
    encoded = tokenizer(rendered, add_special_tokens=False, return_offsets_mapping=True)
    input_ids = list(encoded["input_ids"])
    offsets = [tuple(pair) for pair in encoded["offset_mapping"]]
    if input_ids != _render_ids(tokenizer, messages, tools):
        raise ValueError("offset tokenization differs from template tokenization")
    labels = [-100] * len(input_ids)
    for index, (left, right) in enumerate(offsets):
        if right > left and any(left < end and right > start for start, end in spans):
            labels[index] = input_ids[index]
    masked = _mask_redaction_placeholders(rendered, offsets, labels)
    validate_assistant_token_mask(input_ids, labels)
    return input_ids, labels, masked


def validate_assistant_token_mask(input_ids: Sequence[int], labels: Sequence[int]) -> None:
    """Validate label shape, values, and presence of assistant supervision."""
    if len(input_ids) != len(labels):
        raise ValueError("input_ids and labels differ in length")
    if not labels or not any(label != -100 for label in labels):
        raise ValueError("assistant-only mask contains no supervised tokens")
    for token, label in zip(input_ids, labels, strict=True):
        if label not in (-100, token):
            raise ValueError("labels must equal their input token or -100")


def _read_trial_records(trial: Mapping[str, Any], input_dir: Path) -> list[JsonObject]:
    embedded = trial.get("trajectory") or trial.get("llm_trajectory")
    if isinstance(embedded, list):
        return cast(list[JsonObject], embedded)
    path_value = embedded
    if not path_value and isinstance(trial.get("canonical_files"), Mapping):
        path_value = trial["canonical_files"].get("trajectory/llm_trajectory.jsonl")
    if not isinstance(path_value, str):
        raise ValueError("trial lacks embedded trajectory records or a local trajectory path")
    path = Path(path_value)
    if not path.is_absolute():
        path = input_dir / path
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _load_tokenizer(config: Mapping[str, Any]) -> Tokenizer:
    # Optional training dependency stays import-free for --help and library users.
    from transformers import AutoTokenizer

    model = config.get("tokenizer") or config.get("model") or config.get("sources", {}).get("model")
    if isinstance(model, str):
        return cast(Tokenizer, AutoTokenizer.from_pretrained(model))
    if not isinstance(model, Mapping) or not (model.get("repo_id") or model.get("name")):
        raise ValueError("config must define tokenizer/model repo_id or name")
    return cast(
        Tokenizer,
        AutoTokenizer.from_pretrained(
            model.get("repo_id") or model["name"], revision=model.get("revision")
        ),
    )


def build_corpus(
    input_jsonl: Path,
    config_path: Path,
    tasks_root: Path,
    skills_root: Path,
    output_dir: Path,
    *,
    tokenizer: Tokenizer | None = None,
) -> JsonObject:
    """Build compact matched JSONL corpora from local canonical trial records."""
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    corpus_config = config.get("corpus", {})
    seed = int(config.get("experiment", {}).get("seed", config.get("seed", 17)))
    fractions = corpus_config.get("splits", {"train": 0.7, "validation": 0.15, "audit": 0.15})
    max_budget = int(corpus_config.get("max_loss_tokens_per_condition", 2**63 - 1))
    tokenizer = tokenizer or _load_tokenizer(config)
    metadata = parse_task_metadata(tasks_root)
    chunks = load_skill_document_chunks(skills_root, tasks_root=tasks_root)
    assignments = assign_task_splits(metadata, seed, fractions)
    trials = [
        json.loads(line)
        for line in input_jsonl.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    rows: list[JsonObject] = []
    sources: list[JsonObject] = []
    exclusions: list[JsonObject] = []
    for trial in trials:
        source_path = str(trial.get("source_path") or trial.get("path") or "")
        task_id = str(trial.get("task_id") or trial.get("task") or "")
        try:
            if task_id not in metadata:
                raise ValueError("missing task metadata")
            messages, tools, adapter, reconstruction = parse_trajectory_records(
                _read_trial_records(trial, input_jsonl.parent)
            )
            if reconstruction["history_compaction_suspected"]:
                raise ValueError("history compaction suspected")
            messages, redaction = remove_skill_leakage(messages, chunks.get(task_id, []))
            validate_sanitized_messages(messages)
            if any(scan_retained_skill_text(messages, chunks.get(task_id, [])).values()):
                raise ValueError("retained skill text")
            input_ids, labels, placeholders = tokenize_with_assistant_mask(
                tokenizer, messages, tools
            )
            condition = str(
                trial.get("condition")
                or ("with_skill_success" if trial.get("mode") == "with" else "no_skill_success")
            )
            loss_tokens = sum(label != -100 for label in labels)
            row: JsonObject = {
                "input_ids": input_ids,
                "attention_mask": [1] * len(input_ids),
                "labels": labels,
                "messages": messages,
                "tools": tools,
                "source_path": source_path,
                "task_id": task_id,
                "condition": condition,
                "source_model": str(trial.get("source_model") or trial.get("model") or "unknown"),
                "harness": str(
                    trial.get("harness") or trial.get("config", {}).get("agent") or "openhands"
                ),
                "split": assignments[task_id],
                "domain": metadata[task_id]["domain"],
                "difficulty": metadata[task_id]["difficulty"],
                "task_instruction": metadata[task_id]["task_instruction"],
                "context_tokens": len(input_ids),
                "loss_tokens": loss_tokens,
                "tool_turn_count": sum(bool(message.get("tool_calls")) for message in messages),
                "tool_turn_count_bin": fixed_bin(
                    sum(bool(message.get("tool_calls")) for message in messages),
                    TOOL_TURN_BIN_EDGES,
                ),
                "total_context_token_bin": fixed_bin(len(input_ids), CONTEXT_TOKEN_BIN_EDGES),
                "assistant_loss_token_bin": fixed_bin(loss_tokens, ASSISTANT_TOKEN_BIN_EDGES),
                "segment_index": int(trial.get("segment_index", 0)),
                "provider_adapter": adapter,
                "redaction_placeholder_tokens_masked": placeholders,
            }
            rows.append(row)
            sources.append(
                {
                    "source_path": source_path,
                    "task_id": task_id,
                    "condition": condition,
                    "provider_adapter": adapter,
                    "reconstruction_audit": reconstruction,
                    "redaction_audit": redaction,
                }
            )
        except (ValueError, KeyError, TypeError, OSError) as error:
            exclusions.append(
                {"source_path": source_path, "task_id": task_id, "reason": str(error)}
            )
    selected, matching = select_matched_rows(rows, seed, max_budget)
    output_dir.mkdir(parents=True, exist_ok=True)

    def write_jsonl(path: Path, values: Iterable[Mapping[str, Any]]) -> None:
        path.write_text("".join(canonical_json(value) + "\n" for value in values), encoding="utf-8")

    for key, values in selected.items():
        write_jsonl(output_dir / f"{key.replace(':', '__')}.jsonl", values)
    write_jsonl(output_dir / "source_manifest.jsonl", sources)
    write_jsonl(output_dir / "exclusion_manifest.jsonl", exclusions)
    (output_dir / "task_splits.json").write_text(
        json.dumps(assignments, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    summary: JsonObject = {
        "input_trials": len(trials),
        "parsed_trials": len(rows),
        "excluded_trials": len(exclusions),
        "selected_rows": {key: len(values) for key, values in selected.items()},
        "matching": matching,
        "fixed_bins": {
            "tool_turn_count": list(TOOL_TURN_BIN_EDGES),
            "total_context_tokens": list(CONTEXT_TOKEN_BIN_EDGES),
            "assistant_loss_tokens": list(ASSISTANT_TOKEN_BIN_EDGES),
        },
        "matching_fields": list(MATCHING_FIELDS),
    }
    (output_dir / "corpus_manifest.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return summary


def build_parser() -> argparse.ArgumentParser:
    """Create the local-only corpus CLI parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input-jsonl", type=Path, required=True, help="Local JSONL of canonical trials"
    )
    parser.add_argument("--config", type=Path, required=True, help="Corpus YAML configuration")
    parser.add_argument(
        "--tasks-root", type=Path, required=True, help="Local SkillsBench tasks root"
    )
    parser.add_argument(
        "--skills-root", type=Path, required=True, help="Local task-keyed skills root"
    )
    parser.add_argument(
        "--output-dir", type=Path, required=True, help="Directory for compact JSONL and manifests"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the corpus builder; parsing ``--help`` has no optional imports or I/O."""
    args = build_parser().parse_args(argv)
    build_corpus(args.input_jsonl, args.config, args.tasks_root, args.skills_root, args.output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
